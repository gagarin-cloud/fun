import { z } from "zod";

const bucket = (fallback: string) =>
  z
    .string()
    .regex(/^\d+\/\d+$/, "expected <capacity>/<refill per minute>, e.g. 20/60")
    .default(fallback)
    .transform((raw) => {
      const [capacity, perMinute] = raw.split("/").map(Number) as [number, number];
      return { capacity, perMinute };
    });

const schema = z.object({
  TELEGRAM_API_ID: z.coerce.number().int().positive(),
  TELEGRAM_API_HASH: z.string().min(1),
  ENCRYPTION_KEY: z
    .string()
    .min(32, "ENCRYPTION_KEY must be at least 32 characters — generate one with `openssl rand -hex 32`"),
  PORT: z.coerce.number().int().positive().default(8080),
  // Only used for the URLs shown to humans. Left unset, they are derived from
  // the request, which is right behind any proxy that sets X-Forwarded-*.
  PUBLIC_URL: z.string().optional(),
  // How long a signed-in account is kept connected between calls, how many may
  // be connected at once, and how long a half-finished sign-in waits for its code.
  ACCOUNT_IDLE_MINUTES: z.coerce.number().int().positive().default(15),
  MAX_ACCOUNTS: z.coerce.number().int().positive().default(25),
  MAX_PENDING_LOGINS: z.coerce.number().int().positive().default(20),
  LOGIN_TIMEOUT_MINUTES: z.coerce.number().int().positive().default(10),
  ACCESS_TOKEN_TTL_HOURS: z.coerce.number().int().positive().default(24),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(365),
  RATE_LIMIT_DEFAULT: bucket("20/60"),
  RATE_LIMIT_SEND: bucket("10/20"),
  RATE_LIMIT_JOIN: bucket("3/6"),
  RATE_LIMIT_SEARCH: bucket("10/30"),
  RATE_LIMIT_DOWNLOAD: bucket("5/20"),
  MAX_FLOOD_WAIT_SECONDS: z.coerce.number().int().nonnegative().default(60),
  FLOOD_WAIT_RETRIES: z.coerce.number().int().nonnegative().default(2),
  LOG_LEVEL: z.string().default("info"),
});

export type BucketConfig = { capacity: number; perMinute: number };
export type Config = z.infer<typeof schema>;

/**
 * Parses the environment. Throws with every missing/bad key listed at once,
 * because a half-configured deployment is the most common way this fails.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${lines.join("\n")}\n\nSee .env.example.`);
  }
  return parsed.data;
}
