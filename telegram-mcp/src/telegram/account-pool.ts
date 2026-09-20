import { createHash } from "node:crypto";
import { Api, TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import { GramJsTelegram } from "./gramjs-telegram.js";
import { RateLimiter } from "./rate-limit.js";
import type { Telegram } from "./types.js";

export class SessionRevokedError extends Error {
  constructor(cause: string) {
    super(
      `This Telegram sign-in is no longer valid (${cause}). It was probably revoked from the Telegram app ` +
        `under Settings -> Devices. Reconnect this server to sign in again.`,
    );
    this.name = "SessionRevokedError";
  }
}

const REVOKED = ["AUTH_KEY_UNREGISTERED", "AUTH_KEY_INVALID", "SESSION_REVOKED", "SESSION_EXPIRED", "USER_DEACTIVATED"];

function isRevoked(error: unknown): string | undefined {
  const text = String((error as { errorMessage?: string })?.errorMessage ?? (error as Error)?.message ?? "");
  return REVOKED.find((code) => text.includes(code));
}

interface Entry {
  client: TelegramClient;
  telegram: Telegram;
  limiter: RateLimiter;
  lastUsed: number;
  connecting?: Promise<TelegramClient>;
}

/**
 * One connected Telegram client per signed-in account, kept warm between
 * requests — an MTProto handshake costs about a second, and an agent makes
 * dozens of calls in a row. Accounts that go quiet are disconnected, and each
 * account gets its own rate limiter, since Telegram's limits are per account.
 */
export class AccountPool {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly config: Config,
    private readonly logger: Logger,
    private readonly createClient: (session: string) => TelegramClient = (session) =>
      new TelegramClient(new StringSession(session), config.TELEGRAM_API_ID, config.TELEGRAM_API_HASH, {
        connectionRetries: 5,
        retryDelay: 1000,
        autoReconnect: true,
        useWSS: false,
      }),
    private readonly now: () => number = Date.now,
  ) {}

  private key(session: string): string {
    return createHash("sha256").update(session).digest("hex").slice(0, 32);
  }

  private limiterFor(): RateLimiter {
    return new RateLimiter({
      buckets: {
        default: this.config.RATE_LIMIT_DEFAULT,
        send: this.config.RATE_LIMIT_SEND,
        join: this.config.RATE_LIMIT_JOIN,
        search: this.config.RATE_LIMIT_SEARCH,
        download: this.config.RATE_LIMIT_DOWNLOAD,
      },
      maxFloodWaitSeconds: this.config.MAX_FLOOD_WAIT_SECONDS,
      floodWaitRetries: this.config.FLOOD_WAIT_RETRIES,
      onFloodWait: (category, seconds) => this.logger.warn({ category, seconds }, "telegram flood wait"),
    });
  }

  /** The Telegram surface for one signed-in account. */
  telegramFor(session: string): Telegram {
    this.evictIdle();
    const key = this.key(session);
    const existing = this.entries.get(key);
    if (existing) {
      existing.lastUsed = this.now();
      return existing.telegram;
    }
    this.evictOverflow();

    const entry: Entry = {
      client: this.createClient(session),
      limiter: this.limiterFor(),
      lastUsed: this.now(),
      telegram: undefined as unknown as Telegram,
    };
    entry.telegram = new GramJsTelegram(async () => {
      entry.lastUsed = this.now();
      return this.connected(key, entry);
    }, entry.limiter);
    this.entries.set(key, entry);
    return entry.telegram;
  }

  private async connected(key: string, entry: Entry): Promise<TelegramClient> {
    if (entry.client.connected) return entry.client;
    entry.connecting ??= this.connect(key, entry).finally(() => {
      entry.connecting = undefined;
    });
    return entry.connecting;
  }

  private async connect(key: string, entry: Entry): Promise<TelegramClient> {
    try {
      await entry.client.connect();
      if (!(await entry.client.isUserAuthorized())) throw new Error("AUTH_KEY_UNREGISTERED");
    } catch (error) {
      await this.drop(key, "connect failed");
      const revoked = isRevoked(error);
      if (revoked) throw new SessionRevokedError(revoked);
      throw error;
    }
    this.logger.info({ account: key }, "telegram account connected");
    return entry.client;
  }

  /** Ends the Telegram session for good — the account's own "log out this device". */
  async logout(session: string): Promise<void> {
    const key = this.key(session);
    const entry = this.entries.get(key) ?? {
      client: this.createClient(session),
      limiter: this.limiterFor(),
      lastUsed: this.now(),
      telegram: undefined as unknown as Telegram,
    };
    try {
      await this.connected(key, entry as Entry);
      await entry.client.invoke(new Api.auth.LogOut());
    } catch (error) {
      // A session that is already gone is the outcome we wanted anyway.
      this.logger.info({ err: (error as Error).message }, "log out of an already invalid session");
    } finally {
      await this.drop(key, "logged out");
    }
  }

  private async drop(key: string, reason: string): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    await entry.client.disconnect().catch(() => undefined);
    this.logger.info({ account: key, reason }, "telegram account released");
  }

  evictIdle(): void {
    const cutoff = this.now() - this.config.ACCOUNT_IDLE_MINUTES * 60_000;
    for (const [key, entry] of this.entries) {
      if (entry.lastUsed <= cutoff) void this.drop(key, "idle");
    }
  }

  private evictOverflow(): void {
    while (this.entries.size >= this.config.MAX_ACCOUNTS) {
      const oldest = [...this.entries.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
      if (!oldest) return;
      void this.drop(oldest[0], "pool full");
    }
  }

  get size(): number {
    return this.entries.size;
  }

  async shutdown(): Promise<void> {
    for (const key of [...this.entries.keys()]) await this.drop(key, "shutting down");
  }
}
