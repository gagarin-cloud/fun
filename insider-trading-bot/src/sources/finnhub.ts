// @ts-expect-error -- the official `finnhub` client ships no type declarations.
import { DefaultApi } from 'finnhub'
import { loadConfig } from '../config.js'
import { logger } from '../logger.js'
import type { RawEvent, Source } from './types.js'
import { eventId } from './dedupe.js'

/**
 * Thin adapter over the official `finnhub` client.
 *
 * We use the vendor client rather than hand-rolling HTTP (it owns the base URL,
 * token handling and endpoint surface), but it is a generated callback-style
 * client with no types, so this module supplies: promisification, result typing,
 * and a retry policy for Finnhub's 429s. Nothing here re-implements the client.
 */

type Callback<T> = (err: unknown, data: T | null, res: unknown) => void

interface FinnhubClient {
  quote(symbol: string, cb: Callback<QuoteRaw>): void
  companyNews(symbol: string, from: string, to: string, cb: Callback<CompanyNewsRaw[]>): void
  companyProfile2(opts: { symbol: string }, cb: Callback<ProfileRaw>): void
  companyBasicFinancials(symbol: string, metric: string, cb: Callback<BasicFinancialsRaw>): void
  companyEarnings(symbol: string, opts: Record<string, unknown>, cb: Callback<EarningsRaw[]>): void
  earningsCalendar(
    opts: { from: string; to: string; symbol: string },
    cb: Callback<{ earningsCalendar?: CalendarRaw[] }>,
  ): void
  marketNews(category: string, opts: { minId?: number }, cb: Callback<CompanyNewsRaw[]>): void
}

interface QuoteRaw {
  c?: number // current
  d?: number // change
  dp?: number // percent change
  h?: number
  l?: number
  o?: number
  pc?: number // previous close
}

interface CompanyNewsRaw {
  id?: number
  category?: string
  datetime?: number // unix seconds
  headline?: string
  image?: string
  related?: string
  source?: string
  summary?: string
  url?: string
}

interface ProfileRaw {
  name?: string
  ticker?: string
  marketCapitalization?: number // in millions, USD
  shareOutstanding?: number
  finnhubIndustry?: string
  country?: string
  exchange?: string
  weburl?: string
}

interface BasicFinancialsRaw {
  metric?: Record<string, number | null | undefined>
}

interface CalendarRaw {
  symbol?: string
  date?: string
  hour?: string
  quarter?: number
  year?: number
  epsEstimate?: number | null
  epsActual?: number | null
  revenueEstimate?: number | null
  revenueActual?: number | null
}

interface EarningsRaw {
  period?: string
  estimate?: number
  actual?: number
  surprise?: number
  surprisePercent?: number
}

// ---------- public shapes ----------

export interface Quote {
  price: number
  percentChange: number
  previousClose: number
}

/** One reported quarter, actual against consensus. */
export interface EarningsSurprise {
  period: string
  estimate: number | null
  actual: number | null
  surprisePercent: number | null
}

export interface CompanyContext {
  ticker: string
  name: string | null
  /** USD. Finnhub reports millions; normalised here. */
  marketCap: number | null
  industry: string | null
  /** Trailing-twelve-month revenue in USD, when available. */
  revenueTtm: number | null
  /** Percent change over the trailing 13 weeks — the priced-in check. */
  change13Week: number | null
  change52Week: number | null
  /** 52-week high/low, for judging where in the range the event lands. */
  high52Week: number | null
  low52Week: number | null
  /**
   * Recent quarters, actual EPS against consensus. Without this the thesis stage
   * cannot judge an earnings surprise at all — it would be reasoning from the
   * press release's own framing, which always sounds good. Measured case: a company
   * headlining "revenue grew 146%" had in fact missed EPS consensus by 174%.
   */
  earnings: EarningsSurprise[]
  /**
   * The next scheduled earnings report inside the trade window.
   *
   * Gate 4 requires a specific datable catalyst, and for an earnings-driven idea
   * that catalyst *is* the next report — but the model cannot invent the date.
   * Measured case: an RLX thesis cleared materiality on a 68.2% EPS miss and then
   * failed gate 4 purely because no report date was supplied.
   */
  nextEarnings: { date: string; epsEstimate: number | null; quarter: string } | null
}

const RETRYABLE_STATUS = /\b(429|500|502|503|504)\b/

export class FinnhubClientWrapper {
  private readonly api: FinnhubClient

  constructor(apiKey: string) {
    this.api = new DefaultApi(apiKey) as FinnhubClient
  }

  /**
   * Promisify one callback call. Finnhub's free tier is 60 req/min; on a 429 we
   * back off rather than dropping the enrichment, since a thesis without price
   * context can't run the priced-in check.
   */
  private call<T>(fn: (cb: Callback<T>) => void, attempt = 0): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      fn((err, data) => {
        if (err) {
          const msg = typeof err === 'string' ? err : JSON.stringify(err)
          if (attempt < 3 && RETRYABLE_STATUS.test(msg)) {
            const waitMs = 2 ** attempt * 1500
            logger.warn({ err: msg, attempt, waitMs }, 'finnhub retrying')
            setTimeout(
              () => this.call(fn, attempt + 1).then(resolve, reject),
              waitMs,
            )
            return
          }
          reject(new Error(`finnhub: ${msg}`))
          return
        }
        if (data === null || data === undefined) {
          reject(new Error('finnhub: empty response'))
          return
        }
        resolve(data)
      })
    })
  }

  async quote(symbol: string): Promise<Quote | null> {
    const raw = await this.call<QuoteRaw>((cb) => this.api.quote(symbol, cb))
    // Finnhub answers unknown symbols with an all-zero object rather than a 404.
    if (!raw.c || raw.c === 0) return null
    return {
      price: raw.c,
      percentChange: raw.dp ?? 0,
      previousClose: raw.pc ?? raw.c,
    }
  }

  /**
   * Market cap only — one request. Used as a cheap pre-filter so the tradability
   * floor can be applied to every candidate without paying for the full context
   * (three requests) on names that are about to be discarded anyway.
   */
  async marketCap(symbol: string): Promise<number | null> {
    try {
      const p = await this.call<ProfileRaw>((cb) => this.api.companyProfile2({ symbol }, cb))
      return typeof p.marketCapitalization === 'number'
        ? p.marketCapitalization * 1_000_000
        : null
    } catch (err) {
      logger.debug({ symbol, err }, 'finnhub market cap unavailable')
      return null
    }
  }

  /**
   * Company + price context for the thesis stage. Individual sub-calls are
   * allowed to fail; a partial context is more useful than none.
   */
  async companyContext(symbol: string): Promise<CompanyContext> {
    const ctx: CompanyContext = {
      ticker: symbol,
      name: null,
      marketCap: null,
      industry: null,
      revenueTtm: null,
      change13Week: null,
      change52Week: null,
      high52Week: null,
      low52Week: null,
      earnings: [],
      nextEarnings: null,
    }

    const today = new Date()
    const from = today.toISOString().slice(0, 10)
    const to = new Date(today.getTime() + 110 * 86_400_000).toISOString().slice(0, 10)

    const [profile, financials, earnings, calendar] = await Promise.allSettled([
      this.call<ProfileRaw>((cb) => this.api.companyProfile2({ symbol }, cb)),
      this.call<BasicFinancialsRaw>((cb) =>
        this.api.companyBasicFinancials(symbol, 'all', cb),
      ),
      this.call<EarningsRaw[]>((cb) => this.api.companyEarnings(symbol, {}, cb)),
      this.call<{ earningsCalendar?: CalendarRaw[] }>((cb) =>
        this.api.earningsCalendar({ from, to, symbol }, cb),
      ),
    ])

    if (calendar.status === 'fulfilled') {
      // The window includes today, so a just-reported quarter can appear here too.
      // Only a date strictly in the future is a forward catalyst.
      const upcoming = (calendar.value.earningsCalendar ?? [])
        .filter((c) => c.date && c.date > from && c.epsActual == null)
        .sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''))
      const next = upcoming[0]
      if (next?.date) {
        ctx.nextEarnings = {
          date: next.date,
          epsEstimate: num(next.epsEstimate),
          quarter: next.year && next.quarter ? `Q${next.quarter} ${next.year}` : 'next quarter',
        }
      }
    } else {
      logger.debug({ symbol, err: calendar.reason }, 'finnhub earnings calendar unavailable')
    }

    if (earnings.status === 'fulfilled' && Array.isArray(earnings.value)) {
      ctx.earnings = earnings.value.slice(0, 4).map((e) => ({
        period: e.period ?? 'unknown',
        estimate: num(e.estimate),
        actual: num(e.actual),
        surprisePercent: num(e.surprisePercent),
      }))
    } else if (earnings.status === 'rejected') {
      logger.debug({ symbol, err: earnings.reason }, 'finnhub earnings unavailable')
    }

    if (profile.status === 'fulfilled') {
      ctx.name = profile.value.name ?? null
      ctx.industry = profile.value.finnhubIndustry ?? null
      ctx.marketCap =
        typeof profile.value.marketCapitalization === 'number'
          ? profile.value.marketCapitalization * 1_000_000
          : null
    } else {
      logger.debug({ symbol, err: profile.reason }, 'finnhub profile unavailable')
    }

    if (financials.status === 'fulfilled') {
      const m = financials.value.metric ?? {}
      ctx.change13Week = num(m['13WeekPriceReturnDaily'])
      ctx.change52Week = num(m['52WeekPriceReturnDaily'])
      ctx.high52Week = num(m['52WeekHigh'])
      ctx.low52Week = num(m['52WeekLow'])
      // `revenuePerShareTTM` x shares outstanding is the most reliably populated
      // route to TTM revenue on the free tier.
      const rps = num(m['revenuePerShareTTM'])
      const shares =
        profile.status === 'fulfilled' ? num(profile.value.shareOutstanding) : null
      if (rps !== null && shares !== null) ctx.revenueTtm = rps * shares * 1_000_000
    } else {
      logger.debug({ symbol, err: financials.reason }, 'finnhub financials unavailable')
    }

    return ctx
  }

  async companyNews(symbol: string, from: string, to: string): Promise<CompanyNewsRaw[]> {
    return this.call<CompanyNewsRaw[]>((cb) => this.api.companyNews(symbol, from, to, cb))
  }

  async marketNews(category = 'general'): Promise<CompanyNewsRaw[]> {
    return this.call<CompanyNewsRaw[]>((cb) => this.api.marketNews(category, {}, cb))
  }
}

function num(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

let cached: FinnhubClientWrapper | undefined

export function getFinnhub(): FinnhubClientWrapper {
  if (!cached) cached = new FinnhubClientWrapper(loadConfig().FINNHUB_API_KEY)
  return cached
}

/**
 * Finnhub as a news source: the general market feed. Company-specific news needs
 * a watchlist of symbols to iterate, which burns the rate limit fast; the general
 * feed plus RSS and EDGAR gives better coverage per request.
 */
export const finnhubSource: Source = {
  name: 'finnhub',
  async fetch(): Promise<RawEvent[]> {
    try {
      const items = await getFinnhub().marketNews('general')
      return items.flatMap(toRawEvent)
    } catch (err) {
      logger.error({ err }, 'finnhub source failed')
      return []
    }
  },
}

function toRawEvent(item: CompanyNewsRaw): RawEvent[] {
  if (!item.headline || !item.datetime) return []
  const url = item.url ?? null
  const ticker = item.related?.split(',')[0]?.trim().toUpperCase() || null
  const headline = item.headline
  return [
    {
      id: eventId({ url, headline, ticker }),
      source: 'finnhub',
      headline,
      body: item.summary ?? '',
      url,
      publishedAt: new Date(item.datetime * 1000).toISOString(),
      ticker,
      publisher: item.source ?? null,
    },
  ]
}
