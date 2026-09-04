import { z } from 'zod'
import { loadConfig } from '../config.js'
import { logger } from '../logger.js'
import type { RawEvent } from '../sources/types.js'
import type { CompanyContext } from '../sources/finnhub.js'
import { structured } from './client.js'
import { prompt } from './prompts.js'
import type { TriageResult } from './triage.js'

/**
 * Every field required-and-nullable: strict structured outputs forbid optional
 * properties. Reject paths return nulls in the write-up fields.
 */
const thesisSchema = z.object({
  publish: z.boolean(),
  ticker: z.string().nullable(),
  company: z.string().nullable(),
  direction: z.enum(['long', 'short']).nullable(),
  conviction: z.number().int().min(1).max(10).nullable(),
  thesis: z.string().nullable(),
  second_order_chain: z.string().nullable(),
  catalyst: z.string().nullable(),
  /** ISO date, <= ~100 days out. */
  catalyst_by: z.string().nullable(),
  key_risk: z.string().nullable(),
  /** Which gate failed, when publish is false. */
  reject_reason: z.string().nullable(),
  /**
   * The gate-1 magnitude, kept for prompt tuning even when we publish. Gate 1 uses
   * a different yardstick per event category, so the number is meaningless without
   * `revenue_impact_basis` alongside it.
   */
  revenue_impact_pct: z.number().nullable(),
  revenue_impact_basis: z
    .enum([
      'revenue', // added revenue ÷ revenue — contracts, partnerships, disruption
      'market_cap', // value ÷ market cap — M&A, approvals, litigation, buybacks
      'guidance', // change ÷ prior guidance
      'consensus', // beat/miss vs expectation — earnings surprises
      'float', // stake ÷ float — activist and ownership events
      'asset_base', // capex ÷ existing assets — capacity expansion
      'not_estimable', // no defensible basis; must accompany a rejection
    ])
    .nullable(),
  /** Whether the magnitude came from the source or was reasoned. */
  impact_source: z.enum(['disclosed', 'estimated']).nullable(),
})

export type ThesisRaw = z.infer<typeof thesisSchema>

/** A thesis that passed the model's own gates and is structurally complete. */
export interface Thesis {
  ticker: string
  company: string | null
  direction: 'long' | 'short'
  conviction: number
  thesis: string
  secondOrderChain: string | null
  catalyst: string | null
  catalystBy: string | null
  keyRisk: string | null
}

export async function analyse(
  event: RawEvent,
  triage: TriageResult,
  context: CompanyContext | null,
): Promise<{ thesis: Thesis | null; raw: ThesisRaw | null }> {
  const { THESIS_MODEL } = loadConfig()

  const raw = await structured({
    model: THESIS_MODEL,
    schemaName: 'trade_thesis',
    schema: thesisSchema,
    system: prompt('thesis'),
    user: render(event, triage, context),
    label: `thesis:${triage.primary_ticker ?? '?'}`,
  })

  if (!raw) return { thesis: null, raw: null }

  if (!raw.publish) {
    logger.info(
      { ticker: triage.primary_ticker, reason: raw.reject_reason },
      'thesis rejected by model',
    )
    return { thesis: null, raw }
  }

  // The model can set publish:true and still omit a required field. Rather than
  // publishing a half-formed post, treat that as a rejection.
  const ticker = raw.ticker?.trim().toUpperCase()
  if (!ticker || !raw.direction || raw.conviction == null || !raw.thesis?.trim()) {
    logger.warn({ raw }, 'thesis marked publish but is incomplete — dropping')
    return { thesis: null, raw }
  }

  return {
    thesis: {
      ticker,
      company: raw.company ?? null,
      direction: raw.direction,
      conviction: raw.conviction,
      thesis: raw.thesis.trim(),
      secondOrderChain: raw.second_order_chain ?? null,
      catalyst: raw.catalyst ?? null,
      catalystBy: normalizeCatalystDate(raw.catalyst_by),
      keyRisk: raw.key_risk ?? null,
    },
    raw,
  }
}

/**
 * The scoring job keys off `catalyst_by`, so a malformed or absurd date would
 * either never resolve or resolve immediately. Clamp it into the 1–3 month window
 * the whole pipeline is built around.
 */
function normalizeCatalystDate(value: string | null): string | null {
  if (!value) return null
  const t = Date.parse(value)
  if (Number.isNaN(t)) return null
  const now = Date.now()
  const min = now + 7 * 24 * 60 * 60 * 1000
  const max = now + 100 * 24 * 60 * 60 * 1000
  const clamped = Math.min(Math.max(t, min), max)
  return new Date(clamped).toISOString().slice(0, 10)
}

function render(
  event: RawEvent,
  triage: TriageResult,
  context: CompanyContext | null,
): string {
  const lines: string[] = [
    `Today is ${new Date().toISOString().slice(0, 10)}.`,
    '',
    '## Event',
    `Published: ${event.publishedAt} (${hoursAgo(event.publishedAt)}h ago)`,
    `Source: ${event.source}${event.publisher ? ` — ${event.publisher}` : ''}`,
    `Headline: ${event.headline}`,
    '',
    event.body ? `Body:\n${event.body.slice(0, 6000)}` : '(no body text available)',
    '',
    '## Triage notes',
    `Candidate ticker: ${triage.primary_ticker ?? 'unresolved'}`,
    `Event type: ${triage.event_type ?? 'unclassified'}`,
    triage.beneficiary_reasoning
      ? `Beneficiary reasoning: ${triage.beneficiary_reasoning}`
      : '',
    '',
    '## Market context',
  ]

  if (!context) {
    lines.push(
      'Unavailable. You have no market-cap or price data for this company.',
      'Gates 1, 3 and 7 depend on it, so you must reject unless the event body',
      "itself discloses both a contract value and the company's revenue scale.",
    )
  } else {
    lines.push(
      `Ticker: ${context.ticker}`,
      `Name: ${context.name ?? 'unknown'}`,
      `Industry: ${context.industry ?? 'unknown'}`,
      `Market cap: ${fmtUsd(context.marketCap)}`,
      // Called out explicitly: Finnhub reports 0 for clinical-stage biotech and
      // other pre-revenue names, and gate 1 must switch denominators rather than
      // read "0% of revenue" as a rejection.
      context.revenueTtm != null && context.revenueTtm < 1_000_000
        ? `TTM revenue: ${fmtUsd(context.revenueTtm)} — PRE-REVENUE, use the market-cap denominator for gate 1`
        : `TTM revenue: ${fmtUsd(context.revenueTtm)}`,
      `Price change, last 13 weeks: ${fmtPct(context.change13Week)}`,
      `Price change, last 52 weeks: ${fmtPct(context.change52Week)}`,
      `52-week range: ${context.low52Week ?? '?'} – ${context.high52Week ?? '?'}`,
    )

    if (context.earnings.length > 0) {
      lines.push(
        '',
        'Reported EPS vs consensus (most recent first). Use this for the earnings-',
        'surprise test rather than the press release\'s own framing — companies',
        'headline revenue growth while missing consensus.',
        ...context.earnings.map(
          (e) =>
            `  ${e.period}: actual ${e.actual ?? '?'} vs estimate ${e.estimate ?? '?'}` +
            ` (${e.surprisePercent == null ? 'surprise unknown' : `${fmtPct(e.surprisePercent)} surprise`})`,
        ),
      )
    } else {
      lines.push('', 'No EPS-vs-consensus history available for this ticker.')
    }

    if (context.nextEarnings) {
      const est =
        context.nextEarnings.epsEstimate == null
          ? 'no consensus yet'
          : `consensus EPS ${context.nextEarnings.epsEstimate}`
      lines.push(
        '',
        `Next scheduled earnings report: ${context.nextEarnings.date}` +
          ` (${context.nextEarnings.quarter}, ${est}).`,
        'This is a real, datable event and is available to you as a gate 4 catalyst.',
      )
    } else {
      lines.push(
        '',
        'No scheduled earnings date is available inside the trade window. Do not',
        'invent one — find another datable catalyst or reject on gate 4.',
      )
    }
  }

  lines.push(
    '',
    'Work through gates 1–7 in order and return the structured verdict.',
  )

  return lines.filter((l) => l !== '').join('\n')
}

function hoursAgo(iso: string): number {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return -1
  return Math.round((Date.now() - t) / 3_600_000)
}

function fmtUsd(v: number | null): string {
  if (v == null) return 'unknown'
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`
  return `$${Math.round(v).toLocaleString('en-US')}`
}

function fmtPct(v: number | null): string {
  return v == null ? 'unknown' : `${v > 0 ? '+' : ''}${v.toFixed(1)}%`
}
