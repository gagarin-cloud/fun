import { runScoring } from '../pipeline/score.js'
import { closeDb } from '../db/index.js'
import { logger } from '../logger.js'

/**
 * `npm run score` — run the scoring job once, off-schedule.
 *
 *   npm run score               resolve due calls and post the recap
 *   npm run score -- --no-post  resolve only, print nothing to the channel
 */
const post = !process.argv.includes('--no-post')

const result = await runScoring({ postRecap: post })
logger.info(result, 'manual scoring run finished')
closeDb()
