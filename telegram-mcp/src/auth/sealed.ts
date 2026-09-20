import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const VERSION = "v1";
const IV_LENGTH = 12;
// A fixed salt is safe here because ENCRYPTION_KEY is required to be long and
// random; deriving per-seal would mean a scrypt run on every request instead.
const SALT = Buffer.from("telegram-mcp/sealed/v1");

export class SealError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SealError";
  }
}

interface Envelope<T> {
  d: T;
  exp?: number;
}

/**
 * Authenticated encryption for the values this server hands out: OAuth client
 * registrations, authorization codes and tokens. Each is bound to a purpose, so
 * a refresh token cannot be presented as an access token, and carries its own
 * expiry — which is what lets the server keep no token database at all.
 */
export class Sealer {
  private readonly key: Buffer;

  constructor(
    secret: string,
    private readonly now: () => number = Date.now,
  ) {
    if (secret.length < 32) throw new SealError("The encryption key must be at least 32 characters");
    this.key = scryptSync(secret, SALT, 32);
  }

  seal<T>(purpose: string, payload: T, ttlSeconds?: number): string {
    const envelope: Envelope<T> = { d: payload };
    if (ttlSeconds !== undefined) envelope.exp = Math.floor(this.now() / 1000) + ttlSeconds;
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(`${VERSION}:${purpose}`));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(envelope), "utf8"), cipher.final()]);
    return [VERSION, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(
      ".",
    );
  }

  private open<T>(purpose: string, blob: string): Envelope<T> {
    const [version, iv, tag, ciphertext] = blob.split(".");
    if (version !== VERSION || !iv || !tag || !ciphertext) throw new SealError("Malformed value");
    let plaintext: string;
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64url"));
      decipher.setAAD(Buffer.from(`${VERSION}:${purpose}`));
      decipher.setAuthTag(Buffer.from(tag, "base64url"));
      plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString(
        "utf8",
      );
    } catch {
      // Either the key changed, the value was tampered with, or it was sealed
      // for a different purpose. None of them are worth telling apart.
      throw new SealError("Value is not valid for this server");
    }
    const envelope = JSON.parse(plaintext) as Envelope<T>;
    if (envelope.exp !== undefined && envelope.exp * 1000 <= this.now()) throw new SealError("Value has expired");
    return envelope;
  }

  unseal<T>(purpose: string, blob: string): T {
    return this.open<T>(purpose, blob).d;
  }

  /** The expiry that was sealed in, in seconds since the epoch, if there was one. */
  expiryOf(purpose: string, blob: string): number | undefined {
    return this.open<unknown>(purpose, blob).exp;
  }
}

export function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Remembers which one-time values have been spent, so an authorization code
 * cannot be replayed within its short life. Entries fall out on their own.
 */
export class ReplayGuard {
  private readonly seen = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  /** True the first time an id is seen, false every time after. */
  claim(id: string, ttlSeconds: number): boolean {
    this.sweep();
    if (this.seen.has(id)) return false;
    this.seen.set(id, this.now() + ttlSeconds * 1000);
    return true;
  }

  private sweep(): void {
    const now = this.now();
    for (const [id, expires] of this.seen) if (expires <= now) this.seen.delete(id);
  }

  get size(): number {
    this.sweep();
    return this.seen.size;
  }
}
