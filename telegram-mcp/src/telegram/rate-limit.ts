import type { BucketConfig } from "../config.js";

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** Thrown when Telegram asks us to back off for longer than we are willing to sleep. */
export class FloodWaitTooLongError extends Error {
  constructor(readonly seconds: number) {
    super(
      `Telegram rate-limited this account for ${seconds}s (FLOOD_WAIT). ` +
        `Retry after ${new Date(Date.now() + seconds * 1000).toISOString()}.`,
    );
    this.name = "FloodWaitTooLongError";
  }
}

/** Extracts the wait in seconds out of whatever shape GramJS threw at us. */
export function floodWaitSeconds(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const err = error as { seconds?: unknown; errorMessage?: unknown; message?: unknown };
  const text = String(err.errorMessage ?? err.message ?? "");
  if (!/FLOOD_(PREMIUM_)?WAIT/.test(text) && err.seconds === undefined) return undefined;
  if (typeof err.seconds === "number" && Number.isFinite(err.seconds)) return err.seconds;
  const match = /FLOOD_(?:PREMIUM_)?WAIT_(\d+)/.exec(text);
  return match ? Number(match[1]) : undefined;
}

/**
 * A continuously refilling token bucket. Capacity is the burst an idle server
 * may spend at once; perMinute is the sustained rate it refills at.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly config: BucketConfig,
    private readonly clock: Clock = systemClock,
  ) {
    this.tokens = config.capacity;
    this.lastRefill = clock.now();
  }

  private refill(): void {
    const now = this.clock.now();
    const elapsed = Math.max(0, now - this.lastRefill);
    this.lastRefill = now;
    this.tokens = Math.min(this.config.capacity, this.tokens + (elapsed * this.config.perMinute) / 60_000);
  }

  available(): number {
    this.refill();
    return this.tokens;
  }

  tryTake(): boolean {
    this.refill();
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  /** Milliseconds until one token exists. 0 when a token is available now. */
  msUntilAvailable(): number {
    this.refill();
    if (this.tokens >= 1) return 0;
    return Math.ceil(((1 - this.tokens) / this.config.perMinute) * 60_000);
  }

  async take(): Promise<void> {
    // Loop rather than sleep-once: another waiter may have taken the token.
    for (;;) {
      if (this.tryTake()) return;
      await this.clock.sleep(this.msUntilAvailable());
    }
  }
}

export interface RateLimiterOptions {
  buckets: Record<string, BucketConfig>;
  defaultCategory?: string;
  maxFloodWaitSeconds: number;
  floodWaitRetries: number;
  clock?: Clock;
  onFloodWait?: (category: string, seconds: number) => void;
}

/**
 * Every call into Telegram goes through here. Two mechanisms:
 *   1. a token bucket per category, so we stay under the limits by construction;
 *   2. a global cooldown installed whenever Telegram does flood-wait us, so a
 *      burst of concurrent calls backs off together instead of each finding out
 *      the hard way.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, TokenBucket>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly clock: Clock;
  private cooldownUntil = 0;

  constructor(private readonly options: RateLimiterOptions) {
    this.clock = options.clock ?? systemClock;
    for (const [name, config] of Object.entries(options.buckets)) {
      this.buckets.set(name, new TokenBucket(config, this.clock));
    }
  }

  private bucketFor(category: string): TokenBucket {
    const fallback = this.options.defaultCategory ?? "default";
    const bucket = this.buckets.get(category) ?? this.buckets.get(fallback);
    if (!bucket) throw new Error(`No rate-limit bucket for "${category}" and no "${fallback}" fallback`);
    return bucket;
  }

  /** Seconds the whole client is currently backing off for. */
  cooldownRemaining(): number {
    return Math.max(0, Math.ceil((this.cooldownUntil - this.clock.now()) / 1000));
  }

  private async acquire(category: string): Promise<void> {
    // Serialise acquisition per category so waiters do not all wake on the
    // same token and blow through the bucket.
    const previous = this.queues.get(category) ?? Promise.resolve();
    const mine = previous.then(() => this.bucketFor(category).take());
    this.queues.set(
      category,
      mine.catch(() => undefined),
    );
    await mine;
  }

  private async waitOutCooldown(): Promise<void> {
    const remaining = this.cooldownRemaining();
    if (remaining === 0) return;
    if (remaining > this.options.maxFloodWaitSeconds) throw new FloodWaitTooLongError(remaining);
    await this.clock.sleep(remaining * 1000);
  }

  async run<T>(category: string, fn: () => Promise<T>): Promise<T> {
    let attempt = 0;
    for (;;) {
      await this.waitOutCooldown();
      await this.acquire(category);
      try {
        return await fn();
      } catch (error) {
        const seconds = floodWaitSeconds(error);
        if (seconds === undefined) throw error;
        this.cooldownUntil = this.clock.now() + seconds * 1000;
        this.options.onFloodWait?.(category, seconds);
        if (seconds > this.options.maxFloodWaitSeconds) throw new FloodWaitTooLongError(seconds);
        if (attempt >= this.options.floodWaitRetries) throw new FloodWaitTooLongError(seconds);
        attempt += 1;
      }
    }
  }
}
