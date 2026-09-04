import { z } from 'zod'
import { loadConfig } from '../config.js'
import { logger } from '../logger.js'
import type { RawEvent } from '../sources/types.js'
import { structured } from './client.js'
import { prompt } from './prompts.js'

/**
 * The catalyst taxonomy, grouped by family. This deliberately spans more than deal
 * events: the earlier list nominally included guidance and litigation but the
 * source filters made those unreachable, so in practice only the deal categories
 * ever fired.
 */
export const EVENT_TYPES = [
  // --- fundamental catalysts ---
  'earnings_surprise', // reported results materially above/below expectations
  'guidance_change', // raise, cut, or first-time guidance
  'regulatory_decision', // approval, rejection, clearance, licence, CE mark
  'clinical_or_trial_result', // readouts, endpoints met or missed
  'product_launch', // a launch with disclosed economics or a major platform shift
  'litigation_outcome', // verdict, settlement, injunction, patent ruling
  'restructuring_or_spinoff', // spin-off, divestiture, major cost programme, bankruptcy
  'operational_disruption', // recall, outage, plant loss, supply shock, cyber incident
  'capacity_expansion', // new plant, mine, or major capex with named economics

  // --- deal events ---
  'partnership_or_customer_win',
  'contract_award',
  'acquisition_or_stake',
  'supply_agreement',

  // --- ownership and flow ---
  'activist_or_ownership', // 13D stake, activist campaign, strategic investor
  'insider_activity', // meaningful insider buying or selling clusters
  'capital_structure', // buyback with scale, major offering, index inclusion, dilution

  // --- analyst and estimate dynamics ---
  'estimate_revision', // a shift in the consensus revision cycle tied to a catalyst

  // --- other ---
  'management_change', // CEO/CFO change that signals a turnaround or a problem
] as const

/**
 * Note the shape: every field is required and nullable rather than optional.
 * Strict structured outputs do not allow optional properties, so "absent" is
 * expressed as null.
 */
const verdictSchema = z.object({
  id: z.string(),
  verdict: z.enum(['pass', 'reject']),
  reason: z.string(),
  event_type: z.enum(EVENT_TYPES).nullable(),
  primary_ticker: z.string().nullable(),
  beneficiary_reasoning: z.string().nullable(),
})

const batchSchema = z.object({
  verdicts: z.array(verdictSchema),
})

export type TriageResult = z.infer<typeof verdictSchema>

/** Items per request. Small enough that one bad batch is cheap to lose. */
const BATCH_SIZE = 25

/**
 * Stage 1. Cheap, high-recall filtering over the whole day's news flow. Returns
 * one verdict per input event; events the model omits are treated as rejected so
 * a truncated response can never leak an unfiltered item downstream.
 */
export async function triage(events: readonly RawEvent[]): Promise<TriageResult[]> {
  if (events.length === 0) return []
  const { TRIAGE_MODEL } = loadConfig()

  const batches: RawEvent[][] = []
  for (let i = 0; i < events.length; i += BATCH_SIZE) {
    batches.push(events.slice(i, i + BATCH_SIZE))
  }

  const settled = await Promise.all(
    batches.map(async (batch, i) => {
      const res = await structured({
        model: TRIAGE_MODEL,
        schemaName: 'triage_batch',
        schema: batchSchema,
        system: prompt('triage'),
        user: renderBatch(batch),
        label: `triage[${i}]`,
      })
      if (!res) return []
      // Only keep verdicts whose id we actually sent — the model occasionally
      // invents or reformats ids, and a stray id would poison the DB.
      const known = new Set(batch.map((e) => e.id))
      return res.verdicts.filter((v) => known.has(v.id))
    }),
  )

  const byId = new Map(settled.flat().map((v) => [v.id, v]))

  const results = events.map<TriageResult>(
    (e) =>
      byId.get(e.id) ?? {
        id: e.id,
        verdict: 'reject',
        reason: 'no verdict returned by triage',
        event_type: null,
        primary_ticker: null,
        beneficiary_reasoning: null,
      },
  )

  const passed = results.filter((r) => r.verdict === 'pass').length
  logger.info({ in: events.length, passed, batches: batches.length }, 'triage complete')
  return results
}

function renderBatch(batch: readonly RawEvent[]): string {
  const items = batch.map((e) => {
    const lines = [
      `ID: ${e.id}`,
      `SOURCE: ${e.source}${e.publisher ? ` (${e.publisher})` : ''}`,
      `PUBLISHED: ${e.publishedAt}`,
      `TAGGED_TICKER: ${e.ticker ?? 'none'}`,
      `HEADLINE: ${e.headline}`,
    ]
    // Bodies are truncated hard — triage decides on the gist, and the thesis
    // stage re-reads the full text for anything that survives.
    if (e.body) lines.push(`BODY: ${e.body.slice(0, 700)}`)
    return lines.join('\n')
  })
  return [
    `Today is ${new Date().toISOString().slice(0, 10)}.`,
    `Triage these ${batch.length} items. Return exactly one verdict per ID.`,
    '',
    items.join('\n\n---\n\n'),
  ].join('\n')
}
