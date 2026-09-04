import Database from 'better-sqlite3'
import { dirname, resolve } from 'node:path'
import { mkdirSync, existsSync, statfsSync } from 'node:fs'
import { loadConfig } from '../config.js'
import { logger } from '../logger.js'
import { migrate } from './migrate.js'

export type Db = Database.Database

/**
 * Whether the database file already existed when this process opened it.
 *
 * This is the single fact that distinguishes "persistent storage is working" from
 * "we are silently writing to the container filesystem and losing everything on
 * redeploy". The failure is invisible otherwise: the app creates the file, every
 * query succeeds, and the data evaporates at the next deploy.
 */
export interface DbInfo {
  path: string
  resolvedPath: string
  existedAtBoot: boolean
  /** Bytes free on the filesystem holding the database, when obtainable. */
  freeBytes: number | null
}

let cached: Db | undefined
let info: DbInfo | undefined

export function getDbInfo(): DbInfo | undefined {
  return info
}

export function getDb(): Db {
  if (cached) return cached
  const { DB_PATH } = loadConfig()

  // The bind-mounted ./data may exist but a nested path might not.
  mkdirSync(dirname(DB_PATH), { recursive: true })

  // Must be sampled before opening — better-sqlite3 creates the file on open.
  info = {
    path: DB_PATH,
    resolvedPath: resolve(DB_PATH),
    existedAtBoot: existsSync(DB_PATH),
    freeBytes: freeBytesFor(dirname(DB_PATH)),
  }

  const db = new Database(DB_PATH)
  // WAL gives us a reader (a local SQLite browser) alongside the writing worker
  // without lock contention. Fine on a normal filesystem; not on a network share.
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  // If the weekly scoring job overlaps a write, wait rather than throw SQLITE_BUSY.
  db.pragma('busy_timeout = 5000')

  migrate(db)
  cached = db
  logger.debug({ path: DB_PATH }, 'database ready')
  return db
}

/**
 * Free space on the filesystem holding the database. A Railway volume reports the
 * volume's own capacity, whereas the container root reports the much larger image
 * filesystem — so a suspiciously large number here is itself a hint that the mount
 * is not in effect. Best effort: statfs is not available everywhere.
 */
function freeBytesFor(dir: string): number | null {
  try {
    const s = statfsSync(dir)
    return Number(s.bsize) * Number(s.bavail)
  } catch {
    return null
  }
}

export function closeDb(): void {
  if (!cached) return
  // Fold the WAL back into the main file so the artifact on the host is a single
  // self-contained .sqlite that a local browser opens cleanly.
  try {
    cached.pragma('wal_checkpoint(TRUNCATE)')
  } catch {
    // Best effort; a failed checkpoint must not block shutdown.
  }
  cached.close()
  cached = undefined
}
