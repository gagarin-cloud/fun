import { beforeEach, describe, expect, it, vi } from "vitest";
import { Api } from "telegram";
import { LoginError, LoginSessions, describeDelivery } from "../src/telegram/login.js";
import { QR_TOKEN, SENT_CODE_APP, fakeTelegramClient, silentLogger, testConfig } from "./helpers.js";

vi.mock("telegram/Password.js", () => ({
  computeCheck: vi.fn().mockResolvedValue({ className: "InputCheckPasswordSRP" }),
}));

function subject(client: ReturnType<typeof fakeTelegramClient> = fakeTelegramClient(), overrides: Record<string, string> = {}, now = () => Date.now()) {
  const logins = new LoginSessions(testConfig(overrides), silentLogger, () => client, now);
  return { logins, client };
}

describe("describeDelivery", () => {
  // GramJS reports these as "auth.SentCodeTypeApp" and so on: the namespace is
  // part of the name, and matching without it silently describes every code as
  // "unknown".
  it("says where each kind of code actually went", () => {
    const kindOf = (name: string) => describeDelivery({ type: { className: `auth.${name}` } });
    expect(kindOf("SentCodeTypeApp")).toMatchObject({
      kind: "app",
      message: expect.stringMatching(/chat called Telegram/),
    });
    expect(kindOf("SentCodeTypeApp").message).toMatch(/second account/);
    // Third-party api_ids cannot receive SMS codes at all, so the page must not
    // send somebody off to watch an inbox that will stay empty.
    expect(kindOf("SentCodeTypeApp").message).toMatch(/does not send SMS codes to third-party apps/);
    expect(kindOf("SentCodeTypeSms").kind).toBe("sms");
    expect(kindOf("SentCodeTypeCall").kind).toBe("call");
    expect(kindOf("SentCodeTypeMissedCall")).toMatchObject({ kind: "missed_call", message: /last digits/ as never });
    expect(kindOf("SentCodeTypeFlashCall").kind).toBe("missed_call");
    expect(kindOf("SentCodeTypeFragmentSms")).toMatchObject({
      kind: "fragment",
      message: expect.stringMatching(/fragment\.com/),
    });
    expect(kindOf("SentCodeTypeEmailCode").kind).toBe("email");
    expect(kindOf("SentCodeTypeSmsWord")).toMatchObject({ kind: "words", message: expect.stringMatching(/single word/) });
    expect(kindOf("SentCodeTypeSmsPhrase").kind).toBe("words");
  });

  // The bug this guards against: the table was keyed on "SentCodeTypeApp" while
  // GramJS emits "auth.SentCodeTypeApp", so every real code was described as
  // unknown. Asserting against constructors from the library rather than against
  // hand-written strings is what makes that impossible to get wrong again.
  it("describes the objects GramJS actually constructs", () => {
    expect(
      describeDelivery({
        type: new Api.auth.SentCodeTypeApp({ length: 5 }),
        nextType: new Api.auth.SentCodeTypeSms({ length: 5 }),
        timeout: 60,
      }),
    ).toMatchObject({ kind: "app", nextKind: "sms", retryAfterSeconds: 60 });

    expect(describeDelivery({ type: new Api.auth.SentCodeTypeSms({ length: 5 }) }).kind).toBe("sms");
    expect(describeDelivery({ type: new Api.auth.SentCodeTypeCall({ length: 5 }) }).kind).toBe("call");
    expect(
      describeDelivery({ type: new Api.auth.SentCodeTypeFragmentSms({ url: "https://fragment.com", length: 5 }) }).kind,
    ).toBe("fragment");
    expect(describeDelivery({ type: new Api.auth.SentCodeTypeApp({ length: 5 }) }).message).toMatch(
      /chat called Telegram/,
    );
  });

  // Guards the whole set, including types added by a future GramJS: a name this
  // table has never heard of makes the page shrug at the user instead of telling
  // them where to look.
  it("has an answer for every sent-code type GramJS knows about", () => {
    const types = Object.keys(Api.auth).filter((name) => name.startsWith("SentCodeType"));
    expect(types.length).toBeGreaterThan(8);
    const unknown = types.filter(
      (name) => describeDelivery({ type: { className: `auth.${name}` } }).kind === "unknown",
    );
    expect(unknown).toEqual([]);
  });

  it("matches whether or not the name carries its namespace", () => {
    expect(describeDelivery({ type: { className: "auth.SentCodeTypeSms" } }).kind).toBe("sms");
    expect(describeDelivery({ type: { className: "SentCodeTypeSms" } }).kind).toBe("sms");
  });

  it("does not pretend to know a method it has never seen", () => {
    const delivery = describeDelivery({ type: { className: "auth.SentCodeTypeQuantumPigeon" } });
    expect(delivery.kind).toBe("unknown");
    expect(delivery.message).toContain("auth.SentCodeTypeQuantumPigeon");
  });

  it("carries the retry timer and what a resend would use", () => {
    expect(describeDelivery(SENT_CODE_APP)).toMatchObject({ retryAfterSeconds: 60, nextKind: "sms" });
    expect(describeDelivery({ type: { className: "auth.SentCodeTypeSms" } }).nextKind).toBeUndefined();
  });
});

describe("LoginSessions", () => {
  let client: ReturnType<typeof fakeTelegramClient>;

  beforeEach(() => {
    client = fakeTelegramClient();
  });

  it("sends a code and hands back an id for the conversation", async () => {
    const { logins } = subject(client);
    const started = await logins.start("+15551234567");
    expect(started).toMatchObject({
      step: "code_sent",
      loginId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      phone: "+15551234567",
      delivery: { kind: "app", nextKind: "sms", retryAfterSeconds: 60 },
    });
    expect(started.step === "code_sent" && started.delivery.message).toMatch(/chat called Telegram/);
    expect(client.invoke.mock.calls[0]?.[0]).toMatchObject({
      className: "auth.SendCode",
      phoneNumber: "+15551234567",
      apiId: 1,
      apiHash: "hash",
    });
    expect(logins.size).toBe(1);
  });

  it("keeps sign-ins apart, so two people can sign in at once", async () => {
    const first = fakeTelegramClient();
    const second = fakeTelegramClient({ session: { save: () => "second-session" } });
    let next = first;
    const logins = new LoginSessions(testConfig(), silentLogger, () => next);

    const a = await logins.start("+15551111111");
    next = second;
    const b = await logins.start("+15552222222");
    if (a.step !== "code_sent" || b.step !== "code_sent") throw new Error("expected both to send a code");
    expect(a.loginId).not.toBe(b.loginId);
    expect(logins.size).toBe(2);

    const done = await logins.submitCode(b.loginId, "12345");
    expect(done).toMatchObject({ step: "authenticated", session: "second-session" });
    expect(logins.size).toBe(1);
  });

  it("returns the session and the account once the code is accepted", async () => {
    const { logins } = subject(client);
    const { loginId } = (await logins.start("+15551234567")) as { loginId: string };
    const result = await logins.submitCode(loginId, "12345");
    expect(result).toEqual({
      step: "authenticated",
      session: "session-string",
      user: { id: "7", kind: "user", displayName: "Ada", firstName: "Ada", username: "ada", link: "https://t.me/ada" },
    });
    // The login's own connection is closed; the pool opens its own on first use.
    expect(client.destroy).toHaveBeenCalled();
    expect(logins.size).toBe(0);
  });

  it("asks for the two-factor password and keeps the sign-in alive", async () => {
    const twoFactor = fakeTelegramClient({ rpcErrors: { "auth.SignIn": "SESSION_PASSWORD_NEEDED" } });
    const { logins } = subject(twoFactor);
    const { loginId } = (await logins.start("+15551234567")) as { loginId: string };
    await expect(logins.submitCode(loginId, "12345")).resolves.toEqual({ step: "password_needed" });
    expect(logins.size).toBe(1);
    await expect(logins.submitPassword(loginId, "hunter2")).resolves.toMatchObject({ step: "authenticated" });
  });

  it("translates Telegram's login errors into something a human can act on", async () => {
    const rejecting = fakeTelegramClient({ rpcErrors: { "auth.SendCode": "PHONE_NUMBER_INVALID" } });
    const { logins } = subject(rejecting);
    await expect(logins.start("+1")).rejects.toThrow(/does not recognise that phone number/);
    expect(rejecting.destroy).toHaveBeenCalled();
    expect(logins.size).toBe(0);
  });

  it("passes an unknown Telegram error code through rather than inventing a reason", async () => {
    const rejecting = fakeTelegramClient({ rpcErrors: { "auth.SendCode": "SOME_NEW_ERROR" } });
    await expect(subject(rejecting).logins.start("+15551234567")).rejects.toThrow(/SOME_NEW_ERROR/);
  });

  it("reports a wrong code and a wrong password", async () => {
    const wrongCode = fakeTelegramClient({ rpcErrors: { "auth.SignIn": "PHONE_CODE_INVALID" } });
    const a = subject(wrongCode);
    const first = (await a.logins.start("+15551234567")) as { loginId: string };
    await expect(a.logins.submitCode(first.loginId, "00000")).rejects.toThrow(/That code is not right/);

    const wrongPassword = fakeTelegramClient({ rpcErrors: { "auth.CheckPassword": "PASSWORD_HASH_INVALID" } });
    const b = subject(wrongPassword);
    const second = (await b.logins.start("+15551234567")) as { loginId: string };
    await expect(b.logins.submitPassword(second.loginId, "wrong")).rejects.toThrow(/not right/);
  });

  it("refuses a code or password for a sign-in it does not know", async () => {
    const { logins } = subject(client);
    await expect(logins.submitCode("nobody", "12345")).rejects.toBeInstanceOf(LoginError);
    await expect(logins.submitPassword("nobody", "hunter2")).rejects.toThrow(/expired. Start again/);
  });

  it("expires a sign-in nobody finished", async () => {
    let now = 1_000_000;
    const { logins } = subject(client, {}, () => now);
    const { loginId } = (await logins.start("+15551234567")) as { loginId: string };
    now += 11 * 60_000;
    expect(logins.size).toBe(0);
    await expect(logins.submitCode(loginId, "12345")).rejects.toThrow(/expired/);
    expect(client.destroy).toHaveBeenCalled();
  });

  it("refuses to hold more sign-ins than it was configured for", async () => {
    const logins = new LoginSessions(testConfig({ MAX_PENDING_LOGINS: "1" }), silentLogger, () =>
      fakeTelegramClient(),
    );
    await logins.start("+15551111111");
    await expect(logins.start("+15552222222")).rejects.toThrow(/Too many sign-ins/);
  });

  it("asks Telegram to send the code another way", async () => {
    const resending = fakeTelegramClient({
      rpcResults: {
        "auth.ResendCode": {
          className: "auth.SentCode",
          phoneCodeHash: "hash-456",
          type: { className: "auth.SentCodeTypeSms" },
          timeout: 120,
        },
      },
    });
    const { logins } = subject(resending);
    const { loginId } = (await logins.start("+15551234567")) as { loginId: string };
    await expect(logins.resend(loginId)).resolves.toMatchObject({ kind: "sms", retryAfterSeconds: 120 });
    expect(resending.invoke.mock.lastCall?.[0]).toMatchObject({
      className: "auth.ResendCode",
      phoneNumber: "+15551234567",
      phoneCodeHash: "hash-123",
    });

    // The new hash replaces the old one, or the code that arrives will not verify.
    await logins.submitCode(loginId, "12345");
    const signIn = resending.invoke.mock.calls.find((call) => call[0]?.className === "auth.SignIn");
    expect(signIn?.[0]).toMatchObject({ phoneCodeHash: "hash-456" });
  });

  it("refuses to resend for a sign-in it does not know", async () => {
    await expect(subject(client).logins.resend("nobody")).rejects.toBeInstanceOf(LoginError);
  });

  it("reports Telegram refusing an early resend", async () => {
    const tooSoon = fakeTelegramClient({ rpcErrors: { "auth.ResendCode": "SEND_CODE_UNAVAILABLE" } });
    const { logins } = subject(tooSoon);
    const { loginId } = (await logins.start("+15551234567")) as { loginId: string };
    await expect(logins.resend(loginId)).rejects.toThrow(/SEND_CODE_UNAVAILABLE/);
  });

  it("finishes immediately when Telegram signs the caller in instead of sending a code", async () => {
    const instant = fakeTelegramClient({
      rpcResults: { "auth.SendCode": { className: "auth.SentCodeSuccess", authorization: {} } },
    });
    const { logins } = subject(instant);
    await expect(logins.start("+15551234567")).resolves.toMatchObject({
      step: "authenticated",
      session: "session-string",
    });
    expect(logins.size).toBe(0);
  });

  it("retries once when Telegram asks for a restart", async () => {
    let calls = 0;
    const restarting = fakeTelegramClient();
    const original = restarting.invoke;
    restarting.invoke = vi.fn(async (request: { className?: string }) => {
      if (request?.className === "auth.SendCode" && calls++ === 0) {
        throw Object.assign(new Error(), { errorMessage: "AUTH_RESTART" });
      }
      return original(request as never);
    }) as never;
    const { logins } = subject(restarting);
    await expect(logins.start("+15551234567")).resolves.toMatchObject({ step: "code_sent" });
    expect(calls).toBe(2);
  });

  it("can be cancelled and shut down", async () => {
    const { logins } = subject(client);
    const { loginId } = (await logins.start("+15551234567")) as { loginId: string };
    logins.cancel(loginId);
    expect(logins.size).toBe(0);
    logins.cancel("already-gone");
    await expect(logins.shutdown()).resolves.toBeUndefined();
  });
});

describe("LoginSessions, signing in by QR", () => {
  const scan = (client: ReturnType<typeof fakeTelegramClient>) => client.emit({ className: "UpdateLoginToken" });

  it("hands out a scannable tg://login code as an inline SVG", async () => {
    const { logins } = subject();
    const { loginId, qr } = await logins.startQr();
    expect(loginId).toMatch(/^[0-9a-f-]{36}$/);
    expect(qr.url).toBe(`tg://login?token=${Buffer.from("qr-token-bytes").toString("base64url")}`);
    expect(qr.svg).toMatch(/^<\?xml|^<svg/);
    expect(qr.svg).toContain("</svg>");
    expect(qr.expiresInSeconds).toBeGreaterThan(20);
  });

  it("does not pester Telegram while nobody has scanned", async () => {
    const client = fakeTelegramClient();
    const { logins } = subject(client);
    const { loginId } = await logins.startQr();
    const exportsAfterStart = client.invoke.mock.calls.filter((c) => c[0]?.className === "auth.ExportLoginToken").length;
    await expect(logins.pollQr(loginId)).resolves.toEqual({ step: "waiting" });
    await expect(logins.pollQr(loginId)).resolves.toEqual({ step: "waiting" });
    expect(client.invoke.mock.calls.filter((c) => c[0]?.className === "auth.ExportLoginToken")).toHaveLength(
      exportsAfterStart,
    );
  });

  it("issues a fresh code once the old one has aged out", async () => {
    let now = Date.now();
    const client = fakeTelegramClient();
    const logins = new LoginSessions(testConfig(), silentLogger, () => client, () => now);
    const { loginId, qr } = await logins.startQr();
    now += (qr.expiresInSeconds + 1) * 1000;
    const polled = await logins.pollQr(loginId);
    expect(polled.step).toBe("waiting");
    expect(polled.step === "waiting" && polled.qr?.svg).toContain("<svg");
  });

  it("completes the sign-in once the code is scanned", async () => {
    const client = fakeTelegramClient();
    const { logins } = subject(client);
    const { loginId } = await logins.startQr();
    scan(client);
    client.invoke.mockImplementationOnce(async () => ({ className: "auth.LoginTokenSuccess", authorization: {} }));
    await expect(logins.pollQr(loginId)).resolves.toMatchObject({
      step: "authenticated",
      session: "session-string",
      user: { displayName: "Ada" },
    });
    expect(logins.size).toBe(0);
  });

  it("follows the account to its own data centre", async () => {
    const client = fakeTelegramClient();
    const { logins } = subject(client);
    const { loginId } = await logins.startQr();
    scan(client);
    client.invoke
      .mockImplementationOnce(async () => ({ className: "auth.LoginTokenMigrateTo", dcId: 4, token: QR_TOKEN }))
      .mockImplementationOnce(async () => ({ className: "auth.LoginTokenSuccess", authorization: {} }));
    await expect(logins.pollQr(loginId)).resolves.toMatchObject({ step: "authenticated" });
    expect(client._switchDC).toHaveBeenCalledWith(4);
    expect(client.invoke.mock.calls.some((c) => c[0]?.className === "auth.ImportLoginToken")).toBe(true);
  });

  it("asks for the two-factor password after a scan, then finishes", async () => {
    const client = fakeTelegramClient();
    const { logins } = subject(client);
    const { loginId } = await logins.startQr();
    scan(client);
    client.invoke.mockImplementationOnce(async () => {
      throw Object.assign(new Error(), { errorMessage: "SESSION_PASSWORD_NEEDED" });
    });
    await expect(logins.pollQr(loginId)).resolves.toEqual({ step: "password_needed" });
    await expect(logins.submitPassword(loginId, "hunter2")).resolves.toMatchObject({ step: "authenticated" });
    expect(logins.size).toBe(0);
  });

  it("keeps waiting when the scan has not been confirmed on the phone yet", async () => {
    const client = fakeTelegramClient();
    const { logins } = subject(client);
    const { loginId } = await logins.startQr();
    scan(client);
    // Telegram answers with another plain token: seen, not yet approved.
    const polled = await logins.pollQr(loginId);
    expect(polled.step).toBe("waiting");
    expect(polled.step === "waiting" && polled.qr).toBeDefined();
  });

  it("refuses to poll a sign-in it does not know", async () => {
    await expect(subject().logins.pollQr("nobody")).rejects.toBeInstanceOf(LoginError);
  });

  it("reports Telegram refusing to hand out a code", async () => {
    const client = fakeTelegramClient({ rpcResults: { "auth.ExportLoginToken": { className: "auth.LoginTokenSuccess" } } });
    await expect(subject(client).logins.startQr()).rejects.toThrow(/did not hand out a login code/);
    expect(client.destroy).toHaveBeenCalled();
  });
});
