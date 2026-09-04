import { fetchAllEvents } from '../sources/index.js'
import { triage } from '../llm/triage.js'
import { analyse } from '../llm/thesis.js'
import { getFinnhub } from '../sources/finnhub.js'
import { formatSuggestion } from '../telegram/format.js'
import { logger } from '../logger.js'

/**
 * `npm run thesis:dry` — full pipeline through the thesis stage, printing the
 * rendered Telegram message to stdout. Nothing is posted and nothing is written to
 * the database.
 *
 *   npm run thesis:dry              analyse everything that passes triage
 *   npm run thesis:dry -- --limit 3 analyse only the first 3
 */

const limitArg = process.argv.indexOf('--limit')
const limit = limitArg !== -1 ? Number(process.argv[limitArg + 1]) : Infinity

const events = await fetchAllEvents()
const verdicts = await triage(events)
const byId = new Map(events.map((e) => [e.id, e]))

const passed = verdicts
  .filter((v) => v.verdict === 'pass' && v.primary_ticker)
  .slice(0, Number.isFinite(limit) ? limit : undefined)

console.log(`\n${passed.length} events passed triage; analysing…\n`)

let published = 0

for (const v of passed) {
  const event = byId.get(v.id)
  if (!event) continue

  const ticker = v.primary_ticker!
  let context = null
  try {
    context = await getFinnhub().companyContext(ticker)
  } catch (err) {
    logger.warn({ err, ticker }, 'context unavailable')
  }

  const { thesis, raw } = await analyse(event, v, context)

  console.log('─'.repeat(78))
  console.log(`${ticker}  ${event.headline.slice(0, 100)}`)
  if (raw?.revenue_impact_pct != null) {
    console.log(
      `  gate 1 impact estimate: ${raw.revenue_impact_pct}% of ${raw.revenue_impact_basis ?? 'revenue'}`,
    )
  } else if (raw) {
    console.log(`  gate 1 impact estimate: none (${raw.revenue_impact_basis ?? 'unstated'})`)
  }

  if (!thesis) {
    console.log(`  REJECTED: ${raw?.reject_reason ?? 'no output from model'}`)
    console.log()
    continue
  }

  published++
  console.log(`  PUBLISHABLE (conviction ${thesis.conviction}/10)\n`)
  console.log(formatSuggestion(thesis, event.url))
  console.log()
}

logger.info(
  { analysed: passed.length, publishable: published },
  'thesis dry run complete (nothing posted)',
)
