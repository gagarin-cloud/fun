import { fetchAllEvents } from '../sources/index.js'
import { triage } from '../llm/triage.js'
import { logger } from '../logger.js'

/**
 * `npm run triage:dry` — fetch live events, run stage 1, print every verdict.
 * No thesis calls, no database writes, no posting.
 *
 * Read the rejections as carefully as the passes: this is the cheapest place to
 * find prompt bugs, and a filter that rejects the right things for the wrong
 * reasons will fail differently tomorrow.
 */

const events = await fetchAllEvents()
const results = await triage(events)

const byId = new Map(events.map((e) => [e.id, e]))
const passes = results.filter((r) => r.verdict === 'pass')
const rejects = results.filter((r) => r.verdict === 'reject')

console.log(`\n=== ${passes.length} PASSED ===\n`)
for (const r of passes) {
  const e = byId.get(r.id)
  console.log(`${r.primary_ticker ?? '??'}  [${r.event_type ?? 'unclassified'}]`)
  console.log(`  ${e?.headline ?? '(unknown)'}`)
  console.log(`  why: ${r.reason}`)
  if (r.beneficiary_reasoning) console.log(`  beneficiary: ${r.beneficiary_reasoning}`)
  console.log(`  ${e?.url ?? ''}`)
  console.log()
}

console.log(`\n=== ${rejects.length} REJECTED ===\n`)
for (const r of rejects) {
  const e = byId.get(r.id)
  console.log(`  ${r.reason.padEnd(46).slice(0, 46)} | ${e?.headline.slice(0, 90) ?? ''}`)
}

// Watch the absolute pass count more than the rate. Since the noisiest feeds were
// removed from ingest (see FINNHUB_NEWS_ENABLED), the denominator is already
// pre-filtered, so a rate around 10-15% is healthy — it was ~3% against the raw
// feed. A pass count above ~15/cycle means the filter is too loose.
const rate = events.length ? ((passes.length / events.length) * 100).toFixed(1) : '0'
logger.info({ events: events.length, passed: passes.length, passRate: `${rate}%` }, 'triage dry run complete')
