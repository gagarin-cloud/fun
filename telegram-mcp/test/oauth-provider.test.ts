import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Response } from "express";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { SealedClientsStore } from "../src/auth/clients.js";
import { TelegramOAuthProvider } from "../src/auth/provider.js";
import { Sealer } from "../src/auth/sealed.js";
import type { AccountPool } from "../src/telegram/account-pool.js";
import { ENCRYPTION_KEY, testConfig } from "./helpers.js";

const sealer = new Sealer(ENCRYPTION_KEY);

function registration(): Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at"> {
  return { redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], client_name: "Claude" };
}

describe("SealedClientsStore", () => {
  const store = new SealedClientsStore(sealer);

  it("registers a client and reads it back from the id alone", async () => {
    const client = await store.registerClient(registration());
    expect(client.client_id).toBeTruthy();
    const read = await store.getClient(client.client_id);
    expect(read).toMatchObject({ client_name: "Claude", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] });
  });

  it("survives a restart, because the id carries the registration", async () => {
    const client = await store.registerClient(registration());
    const afterRestart = new SealedClientsStore(new Sealer(ENCRYPTION_KEY));
    expect(await afterRestart.getClient(client.client_id)).toMatchObject({ client_name: "Claude" });
  });

  it("does not recognise an id from another server", async () => {
    const elsewhere = new SealedClientsStore(new Sealer("fedcba9876543210fedcba9876543210"));
    const client = await elsewhere.registerClient(registration());
    expect(await store.getClient(client.client_id)).toBeUndefined();
    expect(await store.getClient("not-an-id")).toBeUndefined();
  });
});

describe("TelegramOAuthProvider", () => {
  let pool: { logout: ReturnType<typeof vi.fn> };
  let provider: TelegramOAuthProvider;
  let client: OAuthClientInformationFull;

  beforeEach(async () => {
    pool = { logout: vi.fn().mockResolvedValue(undefined) };
    provider = new TelegramOAuthProvider(testConfig(), sealer, pool as unknown as AccountPool);
    client = await provider.clientsStore.registerClient(registration());
  });

  const params = {
    redirectUri: "https://claude.ai/api/mcp/auth_callback",
    codeChallenge: "challenge-value",
    state: "opaque-state",
    scopes: ["telegram"],
  };

  function fakeResponse() {
    return { redirect: vi.fn() } as unknown as Response & { redirect: ReturnType<typeof vi.fn> };
  }

  async function authorizeAndSignIn(): Promise<{ code: string; redirectTo: string }> {
    const res = fakeResponse();
    await provider.authorize(client, params, res);
    const sealedRequest = new URL(`http://x${(res.redirect as ReturnType<typeof vi.fn>).mock.calls[0]![1]}`).searchParams.get(
      "request",
    )!;
    const { redirectTo } = provider.completeAuthorization(sealedRequest, "telegram-session-string", "7");
    return { code: new URL(redirectTo).searchParams.get("code")!, redirectTo };
  }

  it("sends the human to the login page carrying the sealed request", async () => {
    const res = fakeResponse();
    await provider.authorize(client, params, res);
    const [status, location] = res.redirect.mock.calls[0]!;
    expect(status).toBe(302);
    expect(location).toMatch(/^\/login\?request=/);
    const sealed = new URL(`http://x${location}`).searchParams.get("request")!;
    expect(provider.readAuthRequest(sealed)).toMatchObject({
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: "challenge-value",
      state: "opaque-state",
    });
  });

  it("explains an expired or forged sign-in link in words a human can act on", () => {
    expect(() => provider.readAuthRequest("garbage")).toThrow(/not valid.*Start again/s);
    const shortLived = new TelegramOAuthProvider(
      testConfig(),
      new Sealer(ENCRYPTION_KEY, () => Date.now() + 3_600_000),
      pool as unknown as AccountPool,
    );
    const blob = sealer.seal("oauth/request", { clientId: "x" }, 60);
    expect(() => shortLived.readAuthRequest(blob)).toThrow(/expired.*Start again/s);
  });

  it("redirects back to the client with a code and the original state", async () => {
    const { redirectTo } = await authorizeAndSignIn();
    const url = new URL(redirectTo);
    expect(url.origin + url.pathname).toBe(params.redirectUri);
    expect(url.searchParams.get("state")).toBe("opaque-state");
    expect(url.searchParams.get("code")).toBeTruthy();
  });

  it("hands the PKCE challenge back for the code it issued", async () => {
    const { code } = await authorizeAndSignIn();
    await expect(provider.challengeForAuthorizationCode(client, code)).resolves.toBe("challenge-value");
  });

  it("exchanges a code for tokens that carry the Telegram session", async () => {
    const { code } = await authorizeAndSignIn();
    const tokens = await provider.exchangeAuthorizationCode(client, code, "verifier", params.redirectUri);
    expect(tokens).toMatchObject({ token_type: "Bearer", expires_in: 24 * 3600, scope: "telegram" });
    const auth = await provider.verifyAccessToken(tokens.access_token);
    expect(auth).toMatchObject({ clientId: client.client_id, scopes: ["telegram"] });
    expect(auth.extra).toEqual({ session: "telegram-session-string", telegramUserId: "7" });
    expect(auth.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("refuses to spend the same code twice", async () => {
    const { code } = await authorizeAndSignIn();
    await provider.exchangeAuthorizationCode(client, code, "verifier");
    await expect(provider.exchangeAuthorizationCode(client, code, "verifier")).rejects.toThrow(/already been used/);
  });

  it("refuses a code presented by a different client, or with a different redirect_uri", async () => {
    const { code } = await authorizeAndSignIn();
    const other = await provider.clientsStore.registerClient({
      redirect_uris: ["https://evil.example/cb"],
      client_name: "Not Claude",
    });
    await expect(provider.exchangeAuthorizationCode(other, code, "verifier")).rejects.toThrow(/another client/);
    await expect(
      provider.exchangeAuthorizationCode(client, code, "verifier", "https://evil.example/cb"),
    ).rejects.toThrow(/redirect_uri does not match/);
  });

  it("refuses a forged or expired code", async () => {
    await expect(provider.exchangeAuthorizationCode(client, "garbage", "v")).rejects.toThrow(/invalid or has expired/);
    await expect(provider.challengeForAuthorizationCode(client, "garbage")).rejects.toThrow(/invalid or has expired/);
  });

  it("refreshes into a new access token for the same account", async () => {
    const { code } = await authorizeAndSignIn();
    const first = await provider.exchangeAuthorizationCode(client, code, "verifier");
    const second = await provider.exchangeRefreshToken(client, first.refresh_token!);
    const auth = await provider.verifyAccessToken(second.access_token);
    expect(auth.extra).toMatchObject({ session: "telegram-session-string" });
    expect(second.refresh_token).toBeTruthy();
  });

  it("refuses a refresh token from another client, and a forged one", async () => {
    const { code } = await authorizeAndSignIn();
    const tokens = await provider.exchangeAuthorizationCode(client, code, "verifier");
    const other = await provider.clientsStore.registerClient(registration());
    await expect(provider.exchangeRefreshToken(other, tokens.refresh_token!)).rejects.toThrow(/another client/);
    await expect(provider.exchangeRefreshToken(client, "garbage")).rejects.toThrow(/invalid or has expired/);
  });

  it("will not accept a refresh token as an access token", async () => {
    const { code } = await authorizeAndSignIn();
    const tokens = await provider.exchangeAuthorizationCode(client, code, "verifier");
    await expect(provider.verifyAccessToken(tokens.refresh_token!)).rejects.toThrow(/invalid or has expired/);
    await expect(provider.verifyAccessToken(code)).rejects.toThrow(/invalid or has expired/);
  });

  it("revokes by ending the Telegram session itself", async () => {
    const { code } = await authorizeAndSignIn();
    const tokens = await provider.exchangeAuthorizationCode(client, code, "verifier");
    await provider.revokeToken(client, { token: tokens.access_token });
    expect(pool.logout).toHaveBeenCalledWith("telegram-session-string");

    await provider.revokeToken(client, { token: tokens.refresh_token! });
    expect(pool.logout).toHaveBeenCalledTimes(2);
  });

  it("ignores a revocation of something it did not issue, or of another client's token", async () => {
    const { code } = await authorizeAndSignIn();
    const tokens = await provider.exchangeAuthorizationCode(client, code, "verifier");
    const other = await provider.clientsStore.registerClient(registration());
    await expect(provider.revokeToken(client, { token: "garbage" })).resolves.toBeUndefined();
    await provider.revokeToken(other, { token: tokens.access_token });
    expect(pool.logout).not.toHaveBeenCalled();
  });
});
