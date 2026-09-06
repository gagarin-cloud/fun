import pg from 'pg'
import { loadConfig } from '../config.js'
import { logger } from '../logger.js'
import { migrate } from './migrate.js'

export type Db = pg.Pool

/**
 * Type parsers, set once for the process.
 *
 * The point of all three is that the row shapes in repo.ts stay exactly what the
 * rest of the app already expects — ISO strings and JS numbers — while the schema
 * gets real Postgres types that index and compare correctly.
 */

// `calls.id` is an identity BIGINT and COUNT(*) is bigint too. Left alone, pg
// hands both back as strings, so `id` would silently become a string in CallRow
// and every count would fail a `>` comparison in a way that still typechecks.
pg.types.setTypeParser(pg.types.builtins.INT8, Number)

// TIMESTAMPTZ comes back as '2026-08-14 12:00:00+00', which is neither what the
// app writes nor what Date.parse in gate.ts and score.ts is written against.
// Normalise on the way out so a timestamp read is byte-identical to the ISO
// string that was written.
pg.types.setTypeParser(pg.types.builtins.TIMESTAMPTZ, (v) => new Date(v).toISOString())

// DATE is already 'YYYY-MM-DD' on the wire, which is exactly the shape
// `catalyst_by` is normalised to and rendered from. The default parser would turn
// it into a JS Date at *local* midnight, which west of UTC displays as the day
// before — so keep the string.
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v)

/**
 * What the boot-time storage check found.
 *
 * `existedAtBoot` is the one fact worth reporting: it says whether the schema was
 * already there before migrate() ran. False on a genuine first deploy, and false
 * again if a deploy has been pointed at the wrong (empty) database.
 */
export interface DbInfo {
  /** host:port, for the log line. Never the password. */
  server: string
  database: string
  /** e.g. '17.2'. */
  serverVersion: string
  existedAtBoot: boolean
}

let pool: pg.Pool | undefined
let info: DbInfo | undefined

export function getDbInfo(): DbInfo | undefined {
  return info
}

/**
 * The connection pool. Creating it opens nothing — pg connects lazily on the
 * first query — so this stays synchronous and the pipeline modules can keep
 * doing `new Repo(getDb())` per call.
 */
export function getDb(): Db {
  if (pool) return pool
  const { DB_URL } = loadConfig()

  pool = new pg.Pool({
    connectionString: DB_URL,
    // This worker sleeps for three hours between cycles. A small pool is ample,
    // and a short idle timeout means those hours are spent holding no connection
    // at all rather than nursing one a NAT or the server will drop anyway.
    max: 4,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    keepAlive: true,
    // Generous compared to a request-serving API: nothing here is user-facing and
    // the batch inserts are the slowest thing we run. Still bounded, so a wedged
    // query cannot hold a cycle open forever.
    statement_timeout: 30_000,
  })

  // Without this, an error on an *idle* pooled client is an unhandled 'error'
  // event on an EventEmitter, which takes the whole worker down. The pool
  // discards the client and the next query gets a fresh one, so a log is the
  // right response.
  pool.on('error', (err) => logger.warn({ err }, 'idle database client error — discarded'))

  return pool
}

/**
 * Connect, record what we found, and apply the schema. Call this once at startup
 * (or at the top of a one-shot script) before anything builds a Repo.
 *
 * Retries, because on a fresh gagarin project the worker and its postgres are
 * created together and the pod can win the race to boot. Crash-looping until
 * Kubernetes backs off would work too, but it buries a real credential error
 * under a minute of noise that looks identical.
 */
export async function initDb(): Promise<DbInfo> {
  const db = getDb()
  const backoffMs = [1_000, 2_000, 4_000, 8_000, 15_000, 15_000, 15_000]

  for (let attempt = 0; ; attempt++) {
    try {
      info = await inspect(db)
      break
    } catch (err) {
      const wait = backoffMs[attempt]
      if (wait === undefined) throw err
      logger.warn({ err, attempt: attempt + 1, retryInMs: wait }, 'database not reachable yet')
      await new Promise((r) => setTimeout(r, wait))
    }
  }

  await migrate(db)
  logger.debug({ database: info.database }, 'database ready')
  return info
}

/**
 * A single round trip that answers "are we connected, to what, and was anything
 * here already". `to_regclass` returns NULL rather than throwing for a table that
 * does not exist, so this is safe to run before migrate().
 */
async function inspect(db: Db): Promise<DbInfo> {
  const { rows } = await db.query<{
    database: string
    version: string
    existed: boolean
  }>(
    `SELECT current_database()                      AS database,
            current_setting('server_version')       AS version,
            to_regclass('public.calls') IS NOT NULL AS existed`,
  )
  const row = rows[0]
  if (!row) throw new Error('database inspection returned no rows')
  return {
    server: serverLabel(loadConfig().DB_URL),
    database: row.database,
    serverVersion: row.version,
    existedAtBoot: row.existed,
  }
}

/** host:port from the connection string, with the credentials left out of it. */
function serverLabel(url: string): string {
  try {
    const u = new URL(url)
    return u.port ? `${u.hostname}:${u.port}` : u.hostname
  } catch {
    return '(unparseable DB_URL)'
  }
}

export async function closeDb(): Promise<void> {
  if (!pool) return
  const p = pool
  pool = undefined
  await p.end()
}
