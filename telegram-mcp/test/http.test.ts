import { createHash, randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../src/http/app.js";
import { TelegramOAuthProvider } from "../src/auth/provider.js";
import { Sealer } from "../src/auth/sealed.js";
import { AccountPool } from "../src/telegram/account-pool.js";
import { LoginSessions } from "../src/telegram/login.js";
import { ENCRYPTION_KEY, fakeTelegramClient, silentLogger, testConfig } from "./helpers.js";

vi.mock("telegram/Password.js", () => ({
  computeCheck: vi.fn().mockResolvedValue({ className: "InputCheckPasswordSRP" }),
}));

const REDIRECT_URI = "https://claude.ai/api/mcp/auth_callback";
const VERIFIER = "a-code-verifier-long-enough-for-pkce-0123456789";
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");

let app: Express;
let loginClients: ReturnType<typeof fakeTelegramClient>[];
let poolClients: ReturnType<typeof fakeTelegramClient>[];
let provider: TelegramOAuthProvider;

function build(overrides: Record<string, string> = {}, loginClient?: () => ReturnType<typeof fakeTelegramClient>) {
  const config = testConfig({ PUBLIC_URL: "https://tg.example.org", ...overrides });
  loginClients = [];
  poolClients = [];
  const pool = new AccountPool(config, silentLogger, () => {
    const client = fakeTelegramClient();
    poolClients.push(client);
    return client;
  });
  const logins = new LoginSessions(config, silentLogger, () => {
    const client = loginClient ? loginClient() : fakeTelegramClient();
    loginClients.push(client);
    return client;
  });
  provider = new TelegramOAuthProvider(config, new Sealer(ENCRYPTION_KEY), pool);
  app = createApp({ config, logger: silentLogger, provider, logins, pool });
}

beforeEach(() => build());

interface RegisteredClient {
  clientId: string;
  clientSecret?: string;
}

/** Registers the way Claude does: a public client that proves itself with PKCE. */
async function registerClient(name = "Claude", authMethod = "none"): Promise<RegisteredClient> {
  const response = await request(app)
    .post("/register")
    .send({ redirect_uris: [REDIRECT_URI], client_name: name, token_endpoint_auth_method: authMethod })
    .expect(201);
  return { clientId: response.body.client_id, clientSecret: response.body.client_secret };
}

async function sealedRequestFor({ clientId }: RegisteredClient, state = "opaque-state"): Promise<string> {
  const response = await request(app)
    .get("/authorize")
    .query({
      client_id: clientId,
      response_type: "code",
      redirect_uri: REDIRECT_URI,
      code_challenge: CHALLENGE,
      code_challenge_method: "S256",
      state,
      scope: "telegram",
    })
    .expect(302);
  return new URL(`http://x${response.headers.location}`).searchParams.get("request")!;
}

/** Drives the whole flow to a usable access token, exactly as a client would. */
async function accessToken(client?: RegisteredClient): Promise<{ token: string; refresh: string; client: RegisteredClient }> {
  const registered = client ?? (await registerClient());
  const sealed = await sealedRequestFor(registered);
  const started = await request(app).post("/api/login/start").send({ request: sealed, phone: "+15551234567" }).expect(200);
  const signedIn = await request(app)
    .post("/api/login/code")
    .send({ request: sealed, loginId: started.body.loginId, code: "12345" })
    .expect(200);
  const code = new URL(signedIn.body.redirectTo).searchParams.get("code")!;
  const tokens = await request(app)
    .post("/token")
    .type("form")
    .send({
      grant_type: "authorization_code",
      code,
      code_verifier: VERIFIER,
      client_id: registered.clientId,
      client_secret: registered.clientSecret,
      redirect_uri: REDIRECT_URI,
    });
  if (tokens.status !== 200) throw new Error(`token endpoint ${tokens.status}: ${JSON.stringify(tokens.body)}`);
  return { token: tokens.body.access_token, refresh: tokens.body.refresh_token, client: registered };
}

const mcp = (token: string, body: unknown) =>
  request(app)
    .post("/mcp")
    .set("authorization", `Bearer ${token}`)
    .set("accept", "application/json, text/event-stream")
    .send(body as object);

describe("public endpoints", () => {
  it("serves health with what the server is currently holding", async () => {
    const response = await request(app).get("/health").expect(200);
    expect(response.body).toEqual({ status: "ok", service: "telegram-mcp", accounts: 0, pendingLogins: 0 });
  });

  it("redirects the root to the login page", async () => {
    await request(app).get("/").expect(302).expect("location", "/login");
  });

  it("tells a human who wandered in where sign-in actually starts", async () => {
    const response = await request(app).get("/login").expect(200);
    expect(response.text).toContain("Nothing to sign in to");
    expect(response.text).toContain("custom connector");
  });

  it("404s anything else as JSON", async () => {
    await request(app).get("/nope").expect(404, { error: "not_found" });
  });
});

describe("OAuth discovery", () => {
  it("advertises the authorization server at its configured address", async () => {
    const response = await request(app).get("/.well-known/oauth-authorization-server").expect(200);
    expect(response.body).toMatchObject({
      issuer: "https://tg.example.org/",
      authorization_endpoint: "https://tg.example.org/authorize",
      token_endpoint: "https://tg.example.org/token",
      registration_endpoint: "https://tg.example.org/register",
      revocation_endpoint: "https://tg.example.org/revoke",
      code_challenge_methods_supported: ["S256"],
    });
    expect(response.body.grant_types_supported).toContain("refresh_token");
  });

  it("advertises the protected resource next to the MCP endpoint", async () => {
    const response = await request(app).get("/.well-known/oauth-protected-resource/mcp").expect(200);
    expect(response.body).toMatchObject({
      resource: "https://tg.example.org/mcp",
      authorization_servers: ["https://tg.example.org/"],
      scopes_supported: ["telegram"],
      resource_name: "Telegram",
    });
  });

  it("points an unauthenticated MCP call at that metadata", async () => {
    const response = await request(app).post("/mcp").send({ jsonrpc: "2.0", id: 1, method: "tools/list" }).expect(401);
    expect(response.headers["www-authenticate"]).toContain(
      'resource_metadata="https://tg.example.org/.well-known/oauth-protected-resource/mcp"',
    );
  });

  it("rejects a token it did not issue", async () => {
    await request(app).post("/mcp").set("authorization", "Bearer made-up").expect(401);
  });
});

describe("registration and authorization", () => {
  it("hands back a client_id that identifies the client on every later call", async () => {
    const { clientId } = await registerClient("Claude");
    const client = await provider.clientsStore.getClient(clientId);
    expect(client).toMatchObject({ client_id: clientId, client_name: "Claude" });
  });

  it("refuses a code issued to a different client", async () => {
    const claude = await registerClient("Claude");
    const other = await registerClient("Someone Else");
    const sealed = await sealedRequestFor(claude);
    const started = await request(app).post("/api/login/start").send({ request: sealed, phone: "+15551234567" });
    const signedIn = await request(app)
      .post("/api/login/code")
      .send({ request: sealed, loginId: started.body.loginId, code: "12345" });
    const code = new URL(signedIn.body.redirectTo).searchParams.get("code")!;
    const response = await request(app)
      .post("/token")
      .type("form")
      .send({ grant_type: "authorization_code", code, code_verifier: VERIFIER, client_id: other.clientId })
      .expect(400);
    expect(response.body.error).toBe("invalid_grant");
  });

  it("registers a client dynamically", async () => {
    const response = await request(app)
      .post("/register")
      .send({ redirect_uris: [REDIRECT_URI], client_name: "Claude" })
      .expect(201);
    expect(response.body.client_id).toBeTruthy();
    expect(response.body.redirect_uris).toEqual([REDIRECT_URI]);
    expect(response.body.client_secret_expires_at).toBe(0);
  });

  it("sends the human to a sign-in page naming the app that asked", async () => {
    const sealed = await sealedRequestFor(await registerClient("Claude"));
    const page = await request(app).get("/login").query({ request: sealed }).expect(200);
    expect(page.text).toContain("Claude wants to use your Telegram");
    expect(page.text).toContain("claude.ai");
  });

  it("escapes a client name rather than rendering it", async () => {
    const sealed = await sealedRequestFor(await registerClient("<img src=x onerror=alert(1)>"));
    const page = await request(app).get("/login").query({ request: sealed }).expect(200);
    expect(page.text).not.toContain("<img src=x");
    expect(page.text).toContain("&lt;img src=x");
  });

  it("refuses an unregistered redirect_uri", async () => {
    const { clientId } = await registerClient();
    const response = await request(app)
      .get("/authorize")
      .query({
        client_id: clientId,
        response_type: "code",
        redirect_uri: "https://evil.example/callback",
        code_challenge: CHALLENGE,
        code_challenge_method: "S256",
      })
      .expect(400);
    expect(JSON.stringify(response.body)).toMatch(/Unregistered redirect_uri/);
  });

  it("shows a dead sign-in link as a dead end, not a form", async () => {
    const page = await request(app).get("/login").query({ request: "garbage" }).expect(400);
    expect(page.text).toContain("This link will not work");
    expect(page.text).not.toContain("Phone number");
  });
});

describe("signing in to Telegram", () => {
  it("will not start a sign-in without a valid authorization request", async () => {
    const response = await request(app)
      .post("/api/login/start")
      .send({ request: "garbage", phone: "+15551234567" })
      .expect(400);
    expect(response.body.message).toMatch(/not valid/);
    expect(loginClients).toHaveLength(0);
  });

  it("validates the phone number, the code and the password before calling Telegram", async () => {
    const sealed = await sealedRequestFor(await registerClient());
    await request(app).post("/api/login/start").send({ request: sealed, phone: "nope" }).expect(400);
    await request(app).post("/api/login/code").send({ request: sealed, loginId: "x", code: "abc" }).expect(400);
    await request(app).post("/api/login/password").send({ request: sealed, loginId: "x", password: "" }).expect(400);
    expect(loginClients).toHaveLength(0);
  });

  it("normalises the phone number on its way to Telegram", async () => {
    const sealed = await sealedRequestFor(await registerClient());
    await request(app).post("/api/login/start").send({ request: sealed, phone: "+1 (555) 123-4567" }).expect(200);
    expect(loginClients[0]!.invoke.mock.calls[0]?.[0]).toMatchObject({
      className: "auth.SendCode",
      phoneNumber: "+15551234567",
    });
  });

  it("tells the browser where Telegram actually sent the code", async () => {
    const sealed = await sealedRequestFor(await registerClient());
    const response = await request(app)
      .post("/api/login/start")
      .send({ request: sealed, phone: "+15551234567" })
      .expect(200);
    expect(response.body).toMatchObject({
      step: "code_sent",
      // Echoed back normalised, so a mistyped number is visible on screen.
      phone: "+15551234567",
      delivery: { kind: "app", nextKind: "sms", retryAfterSeconds: 60 },
    });
    expect(response.body.delivery.message).toMatch(/chat called Telegram/);
  });

  it("resends the code on request, and not without a valid authorization request", async () => {
    const sealed = await sealedRequestFor(await registerClient());
    const started = await request(app).post("/api/login/start").send({ request: sealed, phone: "+15551234567" });
    const resent = await request(app)
      .post("/api/login/resend")
      .send({ request: sealed, loginId: started.body.loginId })
      .expect(200);
    expect(resent.body.delivery.kind).toBe("app");
    expect(loginClients[0]!.invoke.mock.lastCall?.[0]?.className).toBe("auth.ResendCode");

    await request(app)
      .post("/api/login/resend")
      .send({ request: "garbage", loginId: started.body.loginId })
      .expect(400);
  });

  it("finishes the whole flow when Telegram signs the caller straight in", async () => {
    build({}, () =>
      fakeTelegramClient({ rpcResults: { "auth.SendCode": { className: "auth.SentCodeSuccess", authorization: {} } } }),
    );
    const sealed = await sealedRequestFor(await registerClient());
    const response = await request(app)
      .post("/api/login/start")
      .send({ request: sealed, phone: "+15551234567" })
      .expect(200);
    expect(response.body.step).toBe("authenticated");
    expect(response.body.redirectTo).toContain(`${REDIRECT_URI}?code=`);
  });

  it("carries a two-factor prompt back to the browser, then finishes", async () => {
    build({}, () => fakeTelegramClient({ rpcErrors: { "auth.SignIn": "SESSION_PASSWORD_NEEDED" } }));
    const sealed = await sealedRequestFor(await registerClient());
    const started = await request(app).post("/api/login/start").send({ request: sealed, phone: "+15551234567" });
    await request(app)
      .post("/api/login/code")
      .send({ request: sealed, loginId: started.body.loginId, code: "12345" })
      .expect(200, { step: "password_needed" });

    const done = await request(app)
      .post("/api/login/password")
      .send({ request: sealed, loginId: started.body.loginId, password: "hunter2" })
      .expect(200);
    expect(done.body.step).toBe("authenticated");
    expect(done.body.redirectTo).toContain(`${REDIRECT_URI}?code=`);
  });

  it("reports a wrong code as a 400 with Telegram's reason", async () => {
    build({}, () => fakeTelegramClient({ rpcErrors: { "auth.SignIn": "PHONE_CODE_INVALID" } }));
    const sealed = await sealedRequestFor(await registerClient());
    const started = await request(app).post("/api/login/start").send({ request: sealed, phone: "+15551234567" });
    const response = await request(app)
      .post("/api/login/code")
      .send({ request: sealed, loginId: started.body.loginId, code: "00000" })
      .expect(400);
    expect(response.body).toEqual({ error: "PHONE_CODE_INVALID", message: expect.stringMatching(/not right/) });
  });

  it("redirects back to the client with the code and the original state", async () => {
    const sealed = await sealedRequestFor(await registerClient(), "state-123");
    const started = await request(app).post("/api/login/start").send({ request: sealed, phone: "+15551234567" });
    const done = await request(app)
      .post("/api/login/code")
      .send({ request: sealed, loginId: started.body.loginId, code: "12345" })
      .expect(200);
    const url = new URL(done.body.redirectTo);
    expect(url.origin + url.pathname).toBe(REDIRECT_URI);
    expect(url.searchParams.get("state")).toBe("state-123");
  });
});

describe("signing in by QR", () => {
  const scan = () => loginClients[0]!.emit({ className: "UpdateLoginToken" });

  it("hands the browser a QR code and then waits", async () => {
    const sealed = await sealedRequestFor(await registerClient());
    const started = await request(app).post("/api/login/qr/start").send({ request: sealed }).expect(200);
    expect(started.body.qr.url).toMatch(/^tg:\/\/login\?token=/);
    expect(started.body.qr.svg).toContain("<svg");

    await request(app)
      .post("/api/login/qr/poll")
      .send({ request: sealed, loginId: started.body.loginId })
      .expect(200, { step: "waiting" });
  });

  it("finishes the OAuth flow once the code is scanned", async () => {
    const sealed = await sealedRequestFor(await registerClient());
    const started = await request(app).post("/api/login/qr/start").send({ request: sealed }).expect(200);
    scan();
    loginClients[0]!.invoke.mockImplementationOnce(async () => ({
      className: "auth.LoginTokenSuccess",
      authorization: {},
    }));
    const done = await request(app)
      .post("/api/login/qr/poll")
      .send({ request: sealed, loginId: started.body.loginId })
      .expect(200);
    expect(done.body.step).toBe("authenticated");
    expect(done.body.redirectTo).toContain(`${REDIRECT_URI}?code=`);
  });

  it("needs a valid authorization request for both steps", async () => {
    await request(app).post("/api/login/qr/start").send({ request: "garbage" }).expect(400);
    await request(app).post("/api/login/qr/poll").send({ request: "garbage", loginId: "x" }).expect(400);
    expect(loginClients).toHaveLength(0);
  });

  it("offers the QR route on the sign-in page", async () => {
    const sealed = await sealedRequestFor(await registerClient());
    const page = await request(app).get("/login").query({ request: sealed }).expect(200);
    expect(page.text).toContain("Scan a QR code instead");
    expect(page.text).toContain("Link Desktop Device");
    expect(page.text).toContain('id="qr"');
  });
});

describe("the connector's icon", () => {
  it("is served as a PNG at every name a client might try", async () => {
    for (const path of ["/icon.png", "/icon-64.png", "/favicon.ico", "/favicon.png"]) {
      const response = await request(app).get(path).expect(200);
      expect(response.headers["content-type"]).toContain("image/png");
      // A real PNG, not an error page: the signature is the first eight bytes.
      expect(Buffer.from(response.body).subarray(0, 8)).toEqual(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      );
    }
  });

  it("is declared in the MCP handshake, pointing at this deployment", async () => {
    const { token } = await accessToken();
    const response = await mcp(token, {
      jsonrpc: "2.0",
      id: 9,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
    }).expect(200);
    expect(response.body.result.serverInfo).toMatchObject({
      name: "telegram-mcp",
      title: "Telegram",
      websiteUrl: "https://tg.example.org",
      icons: [
        { src: "https://tg.example.org/icon.png", mimeType: "image/png", sizes: ["256x256"] },
        { src: "https://tg.example.org/icon-64.png", mimeType: "image/png", sizes: ["64x64"] },
      ],
    });
  });
});

describe("the token endpoint", () => {
  it("exchanges the code for tokens, with PKCE enforced", async () => {
    const { token, refresh } = await accessToken();
    expect(token).toBeTruthy();
    expect(refresh).toBeTruthy();
  });

  it("refuses the wrong code verifier", async () => {
    const client = await registerClient();
    const sealed = await sealedRequestFor(client);
    const started = await request(app).post("/api/login/start").send({ request: sealed, phone: "+15551234567" });
    const signedIn = await request(app)
      .post("/api/login/code")
      .send({ request: sealed, loginId: started.body.loginId, code: "12345" });
    const code = new URL(signedIn.body.redirectTo).searchParams.get("code")!;
    const response = await request(app)
      .post("/token")
      .type("form")
      .send({ grant_type: "authorization_code", code, code_verifier: "wrong-verifier", client_id: client.clientId })
      .expect(400);
    expect(response.body.error).toBe("invalid_grant");
  });

  it("refreshes an access token", async () => {
    const { refresh, client } = await accessToken();
    const response = await request(app)
      .post("/token")
      .type("form")
      .send({ grant_type: "refresh_token", refresh_token: refresh, client_id: client.clientId })
      .expect(200);
    expect(response.body.access_token).toBeTruthy();
  });

  it("revokes by ending the Telegram session", async () => {
    const { token, client } = await accessToken();
    await mcp(token, { jsonrpc: "2.0", id: 1, method: "tools/list" }).expect(200);
    await request(app).post("/revoke").type("form").send({ token, client_id: client.clientId }).expect(200);
    expect(poolClients.some((client) => client.invoke.mock.calls.some((call) => call[0]?.className === "auth.LogOut"))).toBe(
      true,
    );
  });
});

describe("the MCP endpoint", () => {
  it("lists tools for an authorized account", async () => {
    const { token } = await accessToken();
    const response = await mcp(token, { jsonrpc: "2.0", id: 1, method: "tools/list" }).expect(200);
    expect(response.body.result.tools.map((tool: { name: string }) => tool.name)).toContain("search_messages");
  });

  it("acts as the account that signed in", async () => {
    const { token } = await accessToken();
    const response = await mcp(token, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "account_status", arguments: {} },
    }).expect(200);
    expect(response.body.result.content[0].text).toContain('"displayName": "Ada"');
    expect(poolClients).toHaveLength(1);
  });

  it("initializes", async () => {
    const { token } = await accessToken();
    const response = await mcp(token, {
      jsonrpc: "2.0",
      id: 3,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
    }).expect(200);
    expect(response.body.result.serverInfo).toMatchObject({ name: "telegram-mcp" });
  });

  it("refuses GET, since the server keeps no session", async () => {
    const { token } = await accessToken();
    const response = await request(app).get("/mcp").set("authorization", `Bearer ${token}`).expect(405);
    expect(response.body.error.message).toMatch(/stateless/);
  });
});

