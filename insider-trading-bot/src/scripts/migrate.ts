import { getDb, closeDb } from '../db/index.js'
import { logger } from '../logger.js'

// `npm run migrate` — create/upgrade the database without booting the worker.
getDb()
closeDb()
logger.info('migrations applied')
