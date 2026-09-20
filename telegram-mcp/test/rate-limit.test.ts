import { describe, expect, it, vi } from "vitest";
import {
  FloodWaitTooLongError,
  RateLimiter,
  TokenBucket,
  floodWaitSeconds,
  type Clock,
} from "../src/telegram/rate-limit.js";

/** A clock the test drives: sleeping advances virtual time instead of waiting. */
function fakeClock(): Clock & { advance(ms: number): void; slept: number[] } {
  let now = 1_000_000;
  const slept: number[] = [];
  return {
    slept,
    now: () => now,
    advance(ms) {
      now += ms;
    },
    async sleep(ms) {
      slept.push(ms);
      now += ms;
    },
  };
}

describe("floodWaitSeconds", () => {
  it("reads the seconds off a GramJS FloodWaitError", () => {
    expect(floodWaitSeconds({ errorMessage: "FLOOD_WAIT_42", seconds: 42 })).toBe(42);
  });

  it("parses the seconds out of the message when the field is missing", () => {
    expect(floodWaitSeconds(new Error("FLOOD_WAIT_17"))).toBe(17);
    expect(floodWaitSeconds({ errorMessage: "FLOOD_PREMIUM_WAIT_9" })).toBe(9);
  });

  it("ignores unrelated errors", () => {
    expect(floodWaitSeconds(new Error("CHAT_WRITE_FORBIDDEN"))).toBeUndefined();
    expect(floodWaitSeconds(undefined)).toBeUndefined();
    expect(floodWaitSeconds("nope")).toBeUndefined();
  });
});

describe("TokenBucket", () => {
  it("spends its burst capacity, then refuses", () => {
    const clock = fakeClock();
    const bucket = new TokenBucket({ capacity: 3, perMinute: 60 }, clock);
    expect(bucket.tryTake()).toBe(true);
    expect(bucket.tryTake()).toBe(true);
    expect(bucket.tryTake()).toBe(true);
    expect(bucket.tryTake()).toBe(false);
  });

  it("refills at the configured rate and never past capacity", () => {
    const clock = fakeClock();
    const bucket = new TokenBucket({ capacity: 2, perMinute: 60 }, clock);
    bucket.tryTake();
    bucket.tryTake();
    clock.advance(1000);
    expect(bucket.tryTake()).toBe(true);
    clock.advance(600_000);
    expect(bucket.available()).toBe(2);
  });

  it("reports how long until the next token", () => {
    const clock = fakeClock();
    const bucket = new TokenBucket({ capacity: 1, perMinute: 60 }, clock);
    expect(bucket.msUntilAvailable()).toBe(0);
    bucket.tryTake();
    expect(bucket.msUntilAvailable()).toBe(1000);
  });

  it("waits for a token rather than failing", async () => {
    const clock = fakeClock();
    const bucket = new TokenBucket({ capacity: 1, perMinute: 60 }, clock);
    await bucket.take();
    await bucket.take();
    expect(clock.slept).toEqual([1000]);
  });
});

function limiter(clock: Clock, overrides: Partial<ConstructorParameters<typeof RateLimiter>[0]> = {}) {
  return new RateLimiter({
    buckets: { default: { capacity: 2, perMinute: 60 }, send: { capacity: 1, perMinute: 60 } },
    maxFloodWaitSeconds: 60,
    floodWaitRetries: 2,
    clock,
    ...overrides,
  });
}

describe("RateLimiter", () => {
  it("runs the work and returns its value", async () => {
    await expect(limiter(fakeClock()).run("default", async () => "done")).resolves.toBe("done");
  });

  it("falls back to the default bucket for unknown categories", async () => {
    await expect(limiter(fakeClock()).run("mystery", async () => 1)).resolves.toBe(1);
  });

  it("throws when there is no bucket at all", async () => {
    const bare = new RateLimiter({ buckets: {}, maxFloodWaitSeconds: 60, floodWaitRetries: 0, clock: fakeClock() });
    await expect(bare.run("default", async () => 1)).rejects.toThrow(/No rate-limit bucket/);
  });

  it("queues calls past the bucket capacity instead of firing them all", async () => {
    const clock = fakeClock();
    const rl = limiter(clock);
    const order: number[] = [];
    await Promise.all([1, 2, 3].map((n) => rl.run("send", async () => void order.push(n))));
    expect(order).toEqual([1, 2, 3]);
    expect(clock.slept.length).toBe(2);
  });

  it("sleeps through a short flood wait and retries", async () => {
    const clock = fakeClock();
    const rl = limiter(clock);
    const work = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("FLOOD_WAIT_5"), { seconds: 5 }))
      .mockResolvedValueOnce("second try");
    await expect(rl.run("default", work)).resolves.toBe("second try");
    expect(work).toHaveBeenCalledTimes(2);
    expect(clock.slept).toContain(5000);
  });

  it("reports a long flood wait instead of sleeping through it", async () => {
    const clock = fakeClock();
    const rl = limiter(clock);
    const work = vi.fn().mockRejectedValue(Object.assign(new Error("FLOOD_WAIT_600"), { seconds: 600 }));
    await expect(rl.run("default", work)).rejects.toBeInstanceOf(FloodWaitTooLongError);
    expect(work).toHaveBeenCalledTimes(1);
  });

  it("gives up after the configured number of retries", async () => {
    const clock = fakeClock();
    const rl = limiter(clock, { floodWaitRetries: 1 });
    const work = vi.fn().mockRejectedValue(Object.assign(new Error("FLOOD_WAIT_2"), { seconds: 2 }));
    await expect(rl.run("default", work)).rejects.toBeInstanceOf(FloodWaitTooLongError);
    expect(work).toHaveBeenCalledTimes(2);
  });

  it("puts the whole client in a cooldown other categories observe", async () => {
    const clock = fakeClock();
    const onFloodWait = vi.fn();
    const rl = limiter(clock, { onFloodWait });
    await rl
      .run("send", async () => {
        throw Object.assign(new Error("FLOOD_WAIT_30"), { seconds: 30 });
      })
      .catch(() => undefined);
    expect(onFloodWait).toHaveBeenCalledWith("send", 30);
    expect(rl.cooldownRemaining()).toBeGreaterThan(0);
    await rl.run("default", async () => "later");
    expect(rl.cooldownRemaining()).toBe(0);
  });

  it("rethrows errors that are not flood waits", async () => {
    await expect(
      limiter(fakeClock()).run("default", async () => {
        throw new Error("CHAT_WRITE_FORBIDDEN");
      }),
    ).rejects.toThrow("CHAT_WRITE_FORBIDDEN");
  });
});
