import { z } from 'zod'
import { loadConfig } from '../config.js'
import { logger } from '../logger.js'
import type { RawEvent, Source } from './types.js'
import { eventId } from './dedupe.js'

/**
 * HAND-ROLLED BY NECESSITY — Marketaux publishes no Node/TypeScript SDK (only
 * REST docs and community wrappers). Per the project's SDK directive this is one
 * of exactly two permitted exceptions; the other is `edgar.ts`. If Marketaux ever
 * ships an official client, replace this module with it.
 *
 * Kept deliberately minimal: one endpoint, a zod-validated response, no retry
 * cleverness. The free tier is 100 requests/day, so the ingest cycle makes one
 * call and takes what it gets.
 *
 * MEASURED 2026-08-14: the free plan returns at most **3 articles per request**
 * and silently ignores `limit`. `meta.found` reports millions, but `data` has 3
 * entries whatever you ask for. So this source contributes ~3 events/cycle against
 * RSS's ~23 and EDGAR's ~65 — a marginal contributor, kept because it is free and
 * adds ticker-tagged international coverage the others lack.
 *
 * `limit=50` is left in place deliberately: it is harmless on the free plan and
 * starts working the moment the plan is upgraded.
 */

const BASE_URL = 'https://api.marketaux.com/v1/news/all'

const entitySchema = z.object({
  symbol: z.string().optional(),
  name: z.string().optional(),
  type: z.string().optional(),
  /** Marketaux's own sentiment, -1..1. Used only as a weak prior. */
  sentiment_score: z.number().nullish(),
})

const articleSchema = z.object({
  uuid: z.string(),
  title: z.string(),
  description: z.string().nullish(),
  snippet: z.string().nullish(),
  url: z.string().nullish(),
  source: z.string().nullish(),
  published_at: z.string(),
  entities: z.array(entitySchema).default([]),
})

const responseSchema = z.object({
  data: z.array(articleSchema).default([]),
  // Marketaux returns 200 with an `error` object on quota exhaustion.
  error: z.object({ code: z.string().optional(), message: z.string() }).optional(),
})

export const marketauxSource: Source = {
  name: 'marketaux',
  async fetch(): Promise<RawEvent[]> {
    const { MARKETAUX_API_KEY } = loadConfig()
    const url = new URL(BASE_URL)
    url.searchParams.set('api_token', MARKETAUX_API_KEY)
    url.searchParams.set('language', 'en')
    // Only items tagged to a tradable entity are useful to us.
    url.searchParams.set('must_have_entities', 'true')
    url.searchParams.set('filter_entities', 'true')
    url.searchParams.set('exchanges', 'NYSE,NASDAQ,AMEX')
    url.searchParams.set('limit', '50')
    // Last 24h; the cycle runs every 15m so overlap is expected and deduped.
    url.searchParams.set('published_after', isoMinutesAgo(24 * 60))

    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(20_000),
        headers: { accept: 'application/json' },
      })
      if (!res.ok) {
        logger.error({ status: res.status }, 'marketaux http error')
        return []
      }
      const parsed = responseSchema.safeParse(await res.json())
      if (!parsed.success) {
        logger.error({ err: parsed.error.issues }, 'marketaux unexpected response shape')
        return []
      }
      if (parsed.data.error) {
        logger.error({ err: parsed.data.error }, 'marketaux api error (likely quota)')
        return []
      }
      return parsed.data.data.flatMap(toRawEvent)
    } catch (err) {
      logger.error({ err }, 'marketaux source failed')
      return []
    }
  },
}

function toRawEvent(a: z.infer<typeof articleSchema>): RawEvent[] {
  // Prefer an equity entity; Marketaux also tags currencies and indices.
  const equity =
    a.entities.find((e) => e.type === 'equity' && e.symbol) ?? a.entities.find((e) => e.symbol)
  const ticker = equity?.symbol?.toUpperCase() ?? null
  const url = a.url ?? null
  const body = [a.description, a.snippet].filter(Boolean).join('\n\n')
  return [
    {
      id: eventId({ url, headline: a.title, ticker }),
      source: 'marketaux',
      headline: a.title,
      body,
      url,
      publishedAt: new Date(a.published_at).toISOString(),
      ticker,
      publisher: a.source ?? null,
    },
  ]
}

function isoMinutesAgo(minutes: number): string {
  // Marketaux wants `YYYY-MM-DDTHH:MM`, not a full ISO string with seconds/zone.
  return new Date(Date.now() - minutes * 60_000).toISOString().slice(0, 16)
}
