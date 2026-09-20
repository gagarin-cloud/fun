import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const base = {
  TELEGRAM_API_ID: "12345",
  TELEGRAM_API_HASH: "abcdef0123456789",
  ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
};

describe("loadConfig", () => {
  it("applies defaults and coerces types", () => {
    const config = loadConfig(base as NodeJS.ProcessEnv);
    expect(config.TELEGRAM_API_ID).toBe(12345);
    expect(config.PORT).toBe(8080);
    expect(config.RATE_LIMIT_SEND).toEqual({ capacity: 10, perMinute: 20 });
    expect(config.MAX_FLOOD_WAIT_SECONDS).toBe(60);
  });

  it("defaults the pool and token lifetimes", () => {
    const config = loadConfig(base as NodeJS.ProcessEnv);
    expect(config.ACCOUNT_IDLE_MINUTES).toBe(15);
    expect(config.MAX_ACCOUNTS).toBe(25);
    expect(config.ACCESS_TOKEN_TTL_HOURS).toBe(24);
    expect(config.REFRESH_TOKEN_TTL_DAYS).toBe(365);
  });

  it("rejects a short encryption key", () => {
    expect(() => loadConfig({ ...base, ENCRYPTION_KEY: "too-short" } as NodeJS.ProcessEnv)).toThrow(
      /at least 32 characters/,
    );
  });

  it("parses custom rate limit buckets", () => {
    const config = loadConfig({ ...base, RATE_LIMIT_JOIN: "1/2" } as NodeJS.ProcessEnv);
    expect(config.RATE_LIMIT_JOIN).toEqual({ capacity: 1, perMinute: 2 });
  });

  it("rejects a malformed bucket", () => {
    expect(() => loadConfig({ ...base, RATE_LIMIT_JOIN: "lots" } as NodeJS.ProcessEnv)).toThrow(/RATE_LIMIT_JOIN/);
  });

  it("lists every problem at once", () => {
    let message = "";
    try {
      loadConfig({ ENCRYPTION_KEY: "short" } as NodeJS.ProcessEnv);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/TELEGRAM_API_ID/);
    expect(message).toMatch(/TELEGRAM_API_HASH/);
    expect(message).toMatch(/at least 32 characters/);
  });
});
