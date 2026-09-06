import { initDb, closeDb } from '../db/index.js'
import { logger } from '../logger.js'

// `npm run migrate` — create/upgrade the schema without booting the worker.
const info = await initDb()
await closeDb()
logger.info({ database: info.database, existedAtBoot: info.existedAtBoot }, 'migrations applied')
