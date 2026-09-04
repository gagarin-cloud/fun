import { z } from 'zod'

/**
 * All runtime configuration comes from the environment. Parsing happens once at
 * startup so a missing key fails the container immediately rather than three
 * hours later, mid-cycle, when a source is first reached.
 */
const schema = z.object({
  // --- credentials ---
  OPENAI_API_KEY: z.string().min(1),
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  /** Channel to post into: `@publicname` or a numeric id like `-1001234567890`. */
  TELEGRAM_CHANNEL_ID: z.string().min(1),
  FINNHUB_API_KEY: z.string().min(1),
  MARKETAUX_API_KEY: z.string().min(1),
  /**
   * SEC requires a descriptive User-Agent with contact info on every EDGAR
   * request. Without it they return 403 and will block the IP on repeat.
   * Format: "Company Name contact@example.com"
   */
  SEC_USER_AGENT: z.string().min(5),

  // --- models ---
  TRIAGE_MODEL: z.string().default('gpt-5.6-luna'),
  THESIS_MODEL: z.string().default('gpt-5.6'),

  // --- storage ---
  DB_PATH: z.string().default('./data/insider.sqlite'),

  // --- gate tuning ---
  /** Minimum conviction (1-10) required to publish. */
  MIN_CONVICTION: z.coerce.number().int().min(1).max(10).default(7),
  /** No second post on the same ticker inside this window. */
  TICKER_COOLDOWN_HOURS: z.coerce.number().int().positive().default(72),
  /** Hard cap; a channel posting 20 ideas a day carries no signal. */
  MAX_POSTS_PER_DAY: z.coerce.number().int().positive().default(3),
  /** Events older than this are not worth triaging. */
  MAX_EVENT_AGE_HOURS: z.coerce.number().int().positive().default(72),
  /**
   * Skip the thesis stage entirely below this market cap (USD).
   *
   * Mirrors gate 7 in the thesis prompt, but enforced in code because it is a
   * hard numeric fact we already have from Finnhub before the expensive call.
   * Measured 2026-08-14: three of the first six production theses were sub-$50M
   * shells (SLXN at $0.49M, NGTF at $11.8M) that gate 7 rejected anyway — this
   * catches them for free instead. Only applied when market cap is actually known.
   */
  MIN_MARKET_CAP_USD: z.coerce.number().positive().default(50_000_000),
  /**
   * Whether to ingest Finnhub's general news feed.
   *
   * Off by default, measured 2026-08-14: that feed is Reuters *world* news — macro,
   * commodities and geopolitics — not company events. It contributed 68 of 174
   * triage rejections and zero passes, i.e. ~38% of the triage token spend for no
   * signal. Finnhub is still used for quotes and fundamentals regardless of this
   * flag; this only controls the news feed.
   */
  FINNHUB_NEWS_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  // --- schedules (node-cron expressions, evaluated under TZ) ---
  INGEST_CRON: z.string().default('7 */3 * * *'),
  SCORE_CRON: z.string().default('0 14 * * 1'),

  // --- misc ---
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
  /** When true, run the full pipeline but log messages instead of sending. */
  DRY_RUN: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
})

export type Config = z.infer<typeof schema>

let cached: Config | undefined

export function loadConfig(): Config {
  if (cached) return cached
  const parsed = schema.safeParse(process.env)
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n')
    throw new Error(`Invalid environment configuration:\n${issues}`)
  }
  cached = parsed.data
  return cached
}
