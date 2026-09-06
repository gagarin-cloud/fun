import 'server-only'

import pg from 'pg'

/**
 * The read side of the bot's database.
 *
 * This app never writes and never migrates. The bot owns the schema and applies
 * it on every boot (`src/db/migrate.ts`); a second process running CREATE
 * statements against the same database would be a second opinion about the
 * schema, and the first one to be wrong wins. So everything here is a SELECT,
 * and a missing table is a state to render rather than one to repair — see
 * `schemaReady()` in ./queries.
 *
 * `server-only` is imported for its single side effect: importing this file
 * from a Client Component becomes a build error naming the file, rather than a
 * connection string in a browser bundle.
 */

/**
 * Type parsers, copied from the bot's src/db/index.ts on purpose.
 *
 * These are process-global in `pg`, so they have to be restated in every process
 * that reads these tables — they do not travel with the schema. Keeping them
 * identical is what makes a row read here the same shape as the row the bot
 * wrote: BIGINT as a number rather than a string, TIMESTAMPTZ as the ISO string
 * that was written, and DATE left as 'YYYY-MM-DD' instead of becoming a JS Date
 * at local midnight — which west of UTC renders as the day before.
 */
pg.types.setTypeParser(pg.types.builtins.INT8, Number)
pg.types.setTypeParser(pg.types.builtins.TIMESTAMPTZ, (v) => new Date(v).toISOString())
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v)

/**
 * One pool per process, parked on globalThis.
 *
 * A module-level `let` is per module instance, and `next dev` throws the module
 * graph away on every edit — which would leak a pool per hot reload until
 * Postgres refused the next connection. In production the module is evaluated
 * once and this is simply the same pool.
 */
const globalForDb = globalThis as unknown as { insiderPool?: pg.Pool }

export function getDb(): pg.Pool {
  if (globalForDb.insiderPool) return globalForDb.insiderPool

  const url = process.env.DB_URL
  if (!url) {
    // Thrown at the first query rather than at import: `next build` evaluates
    // this module while collecting page data, and the build machine has no
    // database. Every page that reads is `force-dynamic`, so nothing calls this
    // until a real request arrives with the injected environment.
    throw new Error(
      'DB_URL is not set. It is injected by gagarin when the service reaches the ' +
        'postgres resource — check `gg deps ls <project>/web`.',
    )
  }

  const pool = new pg.Pool({
    connectionString: url,
    // Sized for a page that runs two or three small SELECTs per request. The bot
    // itself holds up to four, and there is one database behind both.
    max: 4,
    idleTimeoutMillis: 30_000,
    // Short, because this is user-facing: a database that is not answering
    // should become an error state on the page inside a few seconds, not a
    // request that hangs until the browser gives up.
    connectionTimeoutMillis: 5_000,
    statement_timeout: 5_000,
    keepAlive: true,
  })

  // An error on an idle pooled client is an unhandled 'error' event on an
  // EventEmitter, which would take the server down. The pool discards the client
  // and the next query gets a fresh one, so logging it is the right response.
  pool.on('error', (err) => console.warn('idle database client error — discarded', err))

  globalForDb.insiderPool = pool
  return pool
}
