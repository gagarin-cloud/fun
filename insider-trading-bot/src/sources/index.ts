import { loadConfig } from '../config.js'
import { logger } from '../logger.js'
import { finnhubSource } from './finnhub.js'
import { marketauxSource } from './marketaux.js'
import { rssSource } from './rss.js'
import { edgarSource } from './edgar.js'
import { dedupeBatch } from './dedupe.js'
import type { RawEvent, Source } from './types.js'

/**
 * Active news sources, in descending order of measured value. Finnhub's news feed
 * is opt-in — see FINNHUB_NEWS_ENABLED in config.ts for the measurement. Finnhub
 * is still always used for quotes and fundamentals.
 */
export function activeSources(): Source[] {
  const sources: Source[] = [rssSource, edgarSource, marketauxSource]
  if (loadConfig().FINNHUB_NEWS_ENABLED) sources.push(finnhubSource)
  return sources
}

/**
 * Fan out across every source, drop anything too old to trade, and collapse
 * duplicates. Sources never reject, so one failing provider degrades coverage
 * for the cycle rather than killing it.
 */
export async function fetchAllEvents(): Promise<RawEvent[]> {
  const { MAX_EVENT_AGE_HOURS } = loadConfig()
  const cutoff = Date.now() - MAX_EVENT_AGE_HOURS * 60 * 60 * 1000

  const settled = await Promise.all(
    activeSources().map(async (s) => {
      const started = Date.now()
      const events = await s.fetch()
      logger.debug({ source: s.name, count: events.length, ms: Date.now() - started }, 'source done')
      return events
    }),
  )

  const all = settled.flat().filter((e) => {
    const t = Date.parse(e.publishedAt)
    // Keep items with unparseable dates rather than silently discarding them.
    return Number.isNaN(t) || t >= cutoff
  })

  const deduped = dedupeBatch(all)
  logger.info(
    { fetched: settled.flat().length, fresh: all.length, deduped: deduped.length },
    'ingest fetch complete',
  )
  return deduped
}

export type { RawEvent, Source } from './types.js'
