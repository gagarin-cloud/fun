import 'server-only'

import { schemaReady } from './queries'

/**
 * The two ways reading can fail, as values rather than exceptions.
 *
 * Both are ordinary states of a correctly deployed site, not bugs, and both
 * deserve a written answer rather than a stack trace:
 *
 *   `no-schema` — the bot has never booted against this database, so its tables
 *     do not exist. Expected on a fresh project, where nothing stops the web
 *     service winning the race to start.
 *   `unreachable` — the database refused, timed out, or DB_URL is missing. On
 *     gagarin the usual cause is a missing dependency edge, and an undeclared
 *     call is dropped rather than refused — so this surfaces as a timeout.
 */
export type Read<T> =
  | { ok: true; data: T }
  | { ok: false; reason: 'no-schema' }
  | { ok: false; reason: 'unreachable'; detail: string }

export async function read<T>(load: () => Promise<T>): Promise<Read<T>> {
  try {
    if (!(await schemaReady())) return { ok: false, reason: 'no-schema' }
    return { ok: true, data: await load() }
  } catch (err) {
    // Logged in full for `gg logs`; the page shows only the message, which for
    // pg is the connection error and never the connection string.
    console.error('database read failed', err)
    return {
      ok: false,
      reason: 'unreachable',
      detail: err instanceof Error ? err.message : String(err),
    }
  }
}
