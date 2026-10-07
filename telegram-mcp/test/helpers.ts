import { vi } from "vitest";
import type { TelegramClient } from "telegram";
import { loadConfig, type Config } from "../src/config.js";
import type { Logger } from "../src/logger.js";

export const ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef";

export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    TELEGRAM_API_ID: "1",
    TELEGRAM_API_HASH: "hash",
    ENCRYPTION_KEY,
    ...overrides,
  } as NodeJS.ProcessEnv);
}

export const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;

export const ME = { className: "User", id: 7, firstName: "Ada", username: "ada" };

export interface FakeClientOptions extends Record<string, unknown> {
  /** Telegram error string to throw for a given request, keyed by className. */
  rpcErrors?: Record<string, string>;
  /** Canned reply for a given request className. */
  rpcResults?: Record<string, unknown>;
}

export const QR_TOKEN = Buffer.from("qr-token-bytes");

export function loginToken(secondsFromNow = 30) {
  return {
    className: "auth.LoginToken",
    token: QR_TOKEN,
    expires: Math.floor(Date.now() / 1000) + secondsFromNow,
  };
}

export const SENT_CODE_APP = {
  className: "auth.SentCode",
  phoneCodeHash: "hash-123",
  type: { className: "auth.SentCodeTypeApp" },
  nextType: { className: "auth.SentCodeTypeSms" },
  timeout: 60,
};

/**
 * A stand-in for a GramJS client. `invoke` answers by request class, so a test
 * can make one call fail without replacing the whole transport.
 */
export function fakeTelegramClient(options: FakeClientOptions = {}) {
  const { rpcErrors = {}, rpcResults = {}, ...overrides } = options;
  const answer = vi.fn(async (request: { className?: string }) => {
    const name = request?.className ?? "";
    const failure = rpcErrors[name];
    if (failure) throw Object.assign(new Error(failure), { errorMessage: failure });
    if (name in rpcResults) return rpcResults[name];
    if (name === "auth.SendCode" || name === "auth.ResendCode") return SENT_CODE_APP;
    if (name === "auth.ExportLoginToken") return loginToken();
    return {};
  });
  const client = {
    connected: false,
    connect: vi.fn().mockImplementation(async function (this: { connected: boolean }) {
      this.connected = true;
    }),
    disconnect: vi.fn().mockImplementation(async function (this: { connected: boolean }) {
      this.connected = false;
    }),
    destroy: vi.fn().mockImplementation(async function (this: { connected: boolean }) {
      this.connected = false;
    }),
    isUserAuthorized: vi.fn().mockResolvedValue(true),
    invoke: answer,
    getMe: vi.fn().mockResolvedValue(ME),
    session: { save: () => "session-string" },
    addEventHandler: vi.fn(),
    _switchDC: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  /** Pretends Telegram pushed an update down this connection. */
  (client as Record<string, unknown>).emit = (update: unknown) => {
    for (const [handler] of client.addEventHandler.mock.calls) (handler as (u: unknown) => void)(update);
  };
  return client as unknown as TelegramClient & typeof client & { emit(update: unknown): void };
}
