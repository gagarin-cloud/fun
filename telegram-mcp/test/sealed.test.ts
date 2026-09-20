import { describe, expect, it } from "vitest";
import { ReplayGuard, SealError, Sealer, constantTimeEquals } from "../src/auth/sealed.js";
import { ENCRYPTION_KEY } from "./helpers.js";

const other = "fedcba9876543210fedcba9876543210";

describe("Sealer", () => {
  const sealer = new Sealer(ENCRYPTION_KEY);

  it("refuses a key that is too short to be a key", () => {
    expect(() => new Sealer("short")).toThrow(/at least 32 characters/);
  });

  it("round-trips a payload", () => {
    const blob = sealer.seal("oauth/access", { session: "s", userId: "7" });
    expect(sealer.unseal("oauth/access", blob)).toEqual({ session: "s", userId: "7" });
  });

  it("never exposes the payload in the blob", () => {
    expect(sealer.seal("oauth/access", { session: "super-secret-session" })).not.toContain("super-secret-session");
  });

  it("produces a different blob every time", () => {
    expect(sealer.seal("p", { a: 1 })).not.toBe(sealer.seal("p", { a: 1 }));
  });

  it("refuses a blob sealed for another purpose", () => {
    const blob = sealer.seal("oauth/refresh", { session: "s" });
    expect(() => sealer.unseal("oauth/access", blob)).toThrow(SealError);
  });

  it("refuses a blob sealed with another key", () => {
    const blob = new Sealer(other).seal("p", { a: 1 });
    expect(() => sealer.unseal("p", blob)).toThrow(/not valid for this server/);
  });

  it("refuses tampering and malformed input", () => {
    const parts = sealer.seal("p", { a: 1 }).split(".");
    parts[3] = Buffer.from("tampered").toString("base64url");
    expect(() => sealer.unseal("p", parts.join("."))).toThrow(SealError);
    expect(() => sealer.unseal("p", "nonsense")).toThrow(/Malformed/);
    expect(() => sealer.unseal("p", "v2.a.b.c")).toThrow(/Malformed/);
  });

  it("expires a blob once its ttl has passed", () => {
    let now = 1_000_000_000_000;
    const clocked = new Sealer(ENCRYPTION_KEY, () => now);
    const blob = clocked.seal("p", { a: 1 }, 60);
    expect(clocked.unseal("p", blob)).toEqual({ a: 1 });
    now += 61_000;
    expect(() => clocked.unseal("p", blob)).toThrow(/expired/);
  });

  it("reports the sealed expiry, and none when there is no ttl", () => {
    let now = 1_000_000_000_000;
    const clocked = new Sealer(ENCRYPTION_KEY, () => now);
    expect(clocked.expiryOf("p", clocked.seal("p", { a: 1 }, 60))).toBe(Math.floor(now / 1000) + 60);
    expect(clocked.expiryOf("p", clocked.seal("p", { a: 1 }))).toBeUndefined();
  });
});

describe("ReplayGuard", () => {
  it("lets an id through exactly once", () => {
    const guard = new ReplayGuard();
    expect(guard.claim("abc", 60)).toBe(true);
    expect(guard.claim("abc", 60)).toBe(false);
  });

  it("forgets an id after its window and does not grow forever", () => {
    let now = 1_000;
    const guard = new ReplayGuard(() => now);
    guard.claim("abc", 60);
    expect(guard.size).toBe(1);
    now += 61_000;
    expect(guard.size).toBe(0);
    expect(guard.claim("abc", 60)).toBe(true);
  });
});

describe("constantTimeEquals", () => {
  it("compares equal and unequal values of any length", () => {
    expect(constantTimeEquals("abc", "abc")).toBe(true);
    expect(constantTimeEquals("abc", "abd")).toBe(false);
    expect(constantTimeEquals("abc", "abcd")).toBe(false);
  });
});
