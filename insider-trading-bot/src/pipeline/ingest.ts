import { loadConfig } from '../config.js'
import { logger } from '../logger.js'
import { getDb } from '../db/index.js'
import { Repo } from '../db/repo.js'
import { fetchAllEvents } from '../sources/index.js'
import { getFinnhub } from '../sources/finnhub.js'
import type { CompanyContext } from '../sources/finnhub.js'
import { triage } from '../llm/triage.js'
import { analyse } from '../llm/thesis.js'
import type { Thesis } from '../llm/thesis.js'
import { checkGate, rankByConviction } from './gate.js'
import { formatSuggestion } from '../telegram/format.js'
import { postMessage } from '../telegram/publisher.js'
import type { RawEvent } from '../sources/types.js'

/** How many surviving events we run the expensive thesis stage on per cycle. */
const MAX_THESES_PER_CYCLE = 12

/**
 * How many market-cap lookups we spend screening candidates. One Finnhub request
 * each, against a 60/min free-tier limit shared with the thesis stage's context
 * fetches, so this is bounded well below it.
 */
const MAX_CAP_LOOKUPS_PER_CYCLE = 30

const SEEN_RETENTION_DAYS = 30

export interface CycleResult {
  fetched: number
  newEvents: number
  passedTriage: number
  analysed: number
  published: number
}

/**
 * One full ingest cycle. Ordering matters:
 *
 *   1. Record every event as seen *before* triaging, so a crash mid-cycle can't
 *      cause the same batch to be re-triaged (and re-paid for) on the next run.
 *   2. Triage everything new, cheaply.
 *   3. Enrich + analyse only what passed, expensively.
 *   4. Gate, then post, then persist — the call row is written only after Telegram
 *      confirms delivery, so the channel and the database can't disagree.
 */
export async function runCycle(): Promise<CycleResult> {
  const config = loadConfig()
  const repo = new Repo(getDb())
  const now = new Date()
  const result: CycleResult = {
    fetched: 0,
    newEvents: 0,
    passedTriage: 0,
    analysed: 0,
    published: 0,
  }

  const events = await fetchAllEvents()
  result.fetched = events.length
  if (events.length === 0) return result

  const unseenIds = repo.filterUnseen(events.map((e) => e.id))
  const fresh = events.filter((e) => unseenIds.has(e.id))
  result.newEvents = fresh.length
  if (fresh.length === 0) {
    logger.info('no new events this cycle')
    return result
  }

  repo.recordSeen(
    fresh.map((e) => ({
      id: e.id,
      source: e.source,
      url: e.url,
      headline: e.headline,
      ticker: e.ticker,
      published_at: e.publishedAt,
    })),
    now.toISOString(),
  )

  const verdicts = await triage(fresh)
  for (const v of verdicts) {
    repo.recordTriage(v.id, v.verdict, v.reason, v.event_type ?? undefined)
  }

  const byId = new Map(fresh.map((e) => [e.id, e]))
  const passed = verdicts.filter(
    (v): v is typeof v & { primary_ticker: string } =>
      v.verdict === 'pass' && Boolean(v.primary_ticker),
  )
  result.passedTriage = passed.length

  const ordered = [...passed].sort(
    (a, b) => eventTypeRank(b.event_type) - eventTypeRank(a.event_type),
  )

  /**
   * Apply the tradability floor BEFORE the thesis cap.
   *
   * The floor used to run inside the analysis loop, after the cap had already been
   * taken — so on a broad cycle nine of twelve slots were spent on micro-caps that
   * were then skipped, leaving three real analyses while eleven eligible events were
   * never looked at. Filtering first means the cap is spent only on tradable names.
   *
   * One request each (market cap only), rather than the three a full context costs.
   */
  const eligible: typeof ordered = []
  for (const v of ordered.slice(0, MAX_CAP_LOOKUPS_PER_CYCLE)) {
    const cap = await getFinnhub().marketCap(v.primary_ticker)
    if (cap != null && cap < config.MIN_MARKET_CAP_USD) {
      logger.info(
        { ticker: v.primary_ticker, marketCap: cap },
        'below market cap floor — skipping thesis',
      )
      repo.recordTriage(
        v.id,
        'reject',
        `below market cap floor ($${Math.round(cap / 1e6)}M)`,
        v.event_type ?? undefined,
      )
      continue
    }
    // A null cap means Finnhub had no data; let the thesis prompt handle it.
    eligible.push(v)
  }

  const toAnalyse = eligible.slice(0, MAX_THESES_PER_CYCLE)
  if (eligible.length > toAnalyse.length) {
    logger.warn(
      { notAnalysed: eligible.length - toAnalyse.length, cap: MAX_THESES_PER_CYCLE },
      'thesis cap reached — some eligible events were not analysed this cycle',
    )
  }

  const candidates: { thesis: Thesis; event: RawEvent }[] = []
  for (const v of toAnalyse) {
    const event = byId.get(v.id)
    if (!event) continue
    const context = await safeContext(v.primary_ticker)
    const { thesis } = await analyse(event, v, context)
    result.analysed++
    if (thesis) candidates.push({ thesis, event })
  }

  // Post the strongest first so the daily cap is spent on the best ideas.
  for (const { thesis, event } of rankByConviction(candidates)) {
    const decision = checkGate(
      { ticker: thesis.ticker, direction: thesis.direction, conviction: thesis.conviction },
      { repo, config, now: new Date() },
    )
    if (!decision.ok) {
      logger.info({ ticker: thesis.ticker, reason: decision.reason }, 'gate blocked suggestion')
      continue
    }

    // Snapshot the price for scoring only — it is deliberately not published.
    const quote = await safeQuote(thesis.ticker)

    const messageId = await postMessage(formatSuggestion(thesis, event.url))
    if (messageId === null) continue

    const at = new Date().toISOString()
    repo.insertCall({
      ticker: thesis.ticker,
      company: thesis.company,
      direction: thesis.direction,
      conviction: thesis.conviction,
      thesis: thesis.thesis,
      second_order_chain: thesis.secondOrderChain,
      catalyst: thesis.catalyst,
      catalyst_by: thesis.catalystBy,
      key_risk: thesis.keyRisk,
      event_id: event.id,
      source_url: event.url,
      entry_price: quote?.price ?? null,
      entry_at: at,
      posted_message_id: messageId,
    })
    repo.touchCooldown(thesis.ticker, at)
    result.published++
    logger.info(
      { ticker: thesis.ticker, conviction: thesis.conviction, messageId },
      'suggestion published',
    )
  }

  const cutoff = new Date(now.getTime() - SEEN_RETENTION_DAYS * 86_400_000).toISOString()
  const pruned = repo.pruneSeenEvents(cutoff)
  if (pruned > 0) logger.debug({ pruned }, 'pruned old seen_events')

  logger.info(result, 'cycle complete')
  return result
}

/**
 * Higher is analysed first when the per-cycle thesis cap bites.
 *
 * Ranked by how sharply the category tends to reprice a stock inside 1–3 months —
 * deliberately *not* by category family. An earlier version ranked partnerships and
 * contracts top, which meant that on a busy cycle deal news crowded out earnings
 * surprises and regulatory decisions entirely.
 */
function eventTypeRank(t: string | null): number {
  switch (t) {
    // Hard, dated, and usually large.
    case 'regulatory_decision':
    case 'clinical_or_trial_result':
    case 'guidance_change':
    case 'earnings_surprise':
      return 5
    // Concrete transactions with disclosed or estimable economics.
    case 'acquisition_or_stake':
    case 'contract_award':
    case 'partnership_or_customer_win':
    case 'litigation_outcome':
      return 4
    // Real, slightly slower to show up in the numbers.
    case 'operational_disruption':
    case 'restructuring_or_spinoff':
    case 'activist_or_ownership':
    case 'supply_agreement':
      return 3
    case 'product_launch':
    case 'capacity_expansion':
    case 'capital_structure':
      return 2
    // Weakest signal individually.
    case 'insider_activity':
    case 'estimate_revision':
    case 'management_change':
      return 1
    default:
      return 1
  }
}

async function safeContext(ticker: string): Promise<CompanyContext | null> {
  try {
    return await getFinnhub().companyContext(ticker)
  } catch (err) {
    // The thesis prompt is told to reject when context is missing, so this is a
    // safe degradation rather than a silent one.
    logger.warn({ err, ticker }, 'company context unavailable')
    return null
  }
}

async function safeQuote(ticker: string) {
  try {
    return await getFinnhub().quote(ticker)
  } catch (err) {
    logger.warn({ err, ticker }, 'entry quote unavailable — call will be unscoreable')
    return null
  }
}
