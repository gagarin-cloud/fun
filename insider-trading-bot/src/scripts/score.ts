import { runScoring } from '../pipeline/score.js'
import { initDb, closeDb } from '../db/index.js'
import { logger } from '../logger.js'

/**
 * `npm run score` — run the scoring job once, off-schedule.
 *
 *   npm run score               resolve due calls and post the recap
 *   npm run score -- --no-post  resolve only, print nothing to the channel
 */
const post = !process.argv.includes('--no-post')

// The worker normally does this at boot; a one-shot script has to do it itself,
// or the first query runs against a database with no schema.
await initDb()

const result = await runScoring({ postRecap: post })
logger.info(result, 'manual scoring run finished')
await closeDb()
