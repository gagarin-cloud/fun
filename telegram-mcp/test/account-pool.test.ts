import { describe, expect, it, vi } from "vitest";
import { AccountPool, SessionRevokedError } from "../src/telegram/account-pool.js";
import { fakeTelegramClient, silentLogger, testConfig } from "./helpers.js";

function pool(overrides: Record<string, string> = {}, clients: (() => ReturnType<typeof fakeTelegramClient>) | undefined = undefined) {
  const made: ReturnType<typeof fakeTelegramClient>[] = [];
  let now = 1_000_000;
  const factory = () => {
    const client = clients ? clients() : fakeTelegramClient();
    made.push(client);
    return client;
  };
  const subject = new AccountPool(testConfig(overrides), silentLogger, factory, () => now);
  return {
    pool: subject,
    made,
    advance(ms: number) {
      now += ms;
    },
  };
}

describe("AccountPool", () => {
  it("connects an account on first use and keeps it warm", async () => {
    const { pool: subject, made } = pool();
    const telegram = subject.telegramFor("session-a");
    await telegram.status();
    await telegram.status();
    expect(made).toHaveLength(1);
    expect(made[0]!.connect).toHaveBeenCalledTimes(1);
    expect(subject.size).toBe(1);
  });

  it("gives the same account the same client, and different accounts their own", async () => {
    const { pool: subject, made } = pool();
    await subject.telegramFor("session-a").status();
    await subject.telegramFor("session-a").status();
    await subject.telegramFor("session-b").status();
    expect(made).toHaveLength(2);
    expect(subject.size).toBe(2);
  });

  it("rate limits each account separately", async () => {
    const { pool: subject } = pool({ RATE_LIMIT_DEFAULT: "1/60" });
    const a = subject.telegramFor("session-a");
    const b = subject.telegramFor("session-b");
    // One token each: both go through immediately rather than queueing behind
    // a single shared bucket.
    await Promise.all([a.status(), b.status()]);
    expect(subject.size).toBe(2);
  });

  it("reports a revoked session in terms of what the human did", async () => {
    const { pool: subject } = pool({}, () => fakeTelegramClient({ isUserAuthorized: vi.fn().mockResolvedValue(false) }));
    await expect(subject.telegramFor("stale").status()).rejects.toBeInstanceOf(SessionRevokedError);
    await expect(subject.telegramFor("stale").status()).rejects.toThrow(/Settings -> Devices/);
    expect(subject.size).toBe(0);
  });

  it("passes a connection failure that is not a revocation straight through", async () => {
    const { pool: subject } = pool({}, () =>
      fakeTelegramClient({ connect: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) }),
    );
    await expect(subject.telegramFor("session-a").status()).rejects.toThrow("ECONNREFUSED");
  });

  it("disconnects accounts that have gone quiet", async () => {
    const { pool: subject, made, advance } = pool({ ACCOUNT_IDLE_MINUTES: "5" });
    await subject.telegramFor("session-a").status();
    advance(6 * 60_000);
    subject.evictIdle();
    expect(subject.size).toBe(0);
    expect(made[0]!.disconnect).toHaveBeenCalled();
  });

  it("evicts the least recently used account when it is full", async () => {
    const { pool: subject, advance } = pool({ MAX_ACCOUNTS: "2" });
    await subject.telegramFor("a").status();
    advance(1000);
    await subject.telegramFor("b").status();
    advance(1000);
    await subject.telegramFor("c").status();
    expect(subject.size).toBe(2);
  });

  it("logs an account out of Telegram and forgets it", async () => {
    const { pool: subject, made } = pool();
    await subject.telegramFor("session-a").status();
    await subject.logout("session-a");
    expect(made[0]!.invoke.mock.lastCall?.[0]?.className).toBe("auth.LogOut");
    expect(made[0]!.disconnect).toHaveBeenCalled();
    expect(subject.size).toBe(0);
  });

  it("logs out a session it was never holding, and tolerates one already gone", async () => {
    const { pool: subject, made } = pool();
    await subject.logout("never-used");
    expect(made[0]!.invoke).toHaveBeenCalled();

    const broken = pool({}, () => fakeTelegramClient({ isUserAuthorized: vi.fn().mockResolvedValue(false) }));
    await expect(broken.pool.logout("already-revoked")).resolves.toBeUndefined();
  });

  it("closes every connection on shutdown", async () => {
    const { pool: subject, made } = pool();
    await subject.telegramFor("a").status();
    await subject.telegramFor("b").status();
    await subject.shutdown();
    expect(subject.size).toBe(0);
    for (const client of made) expect(client.disconnect).toHaveBeenCalled();
  });
});
