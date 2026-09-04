import { fetchAllEvents, activeSources } from '../sources/index.js'
import { logger } from '../logger.js'

/**
 * `npm run ingest:dry` — fetch every source, print normalised + deduped events.
 * No LLM calls, no database writes, no posting. This is the first thing to run
 * after setting up keys: it proves the feeds return usable content before any
 * tokens are spent.
 */

const perSource = await Promise.all(
  activeSources().map(async (s) => [s.name, (await s.fetch()).length] as const),
)

const events = await fetchAllEvents()

console.log('\n=== per-source counts (pre-dedupe) ===')
for (const [name, count] of perSource) console.log(`  ${name.padEnd(10)} ${count}`)

console.log(`\n=== ${events.length} deduped events ===\n`)
for (const e of events.slice(0, 60)) {
  console.log(`[${e.source}] ${e.publishedAt}  ${e.ticker ?? '—'}`)
  console.log(`  ${e.headline}`)
  if (e.body) console.log(`  body: ${e.body.slice(0, 180).replace(/\s+/g, ' ')}…`)
  console.log(`  ${e.url ?? '(no url)'}  id=${e.id}`)
  console.log()
}

if (events.length > 60) console.log(`… ${events.length - 60} more`)

const withoutTicker = events.filter((e) => !e.ticker).length
logger.info(
  { total: events.length, withoutTicker, withBody: events.filter((e) => e.body).length },
  'ingest dry run complete',
)
