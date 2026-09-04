import type { Database } from 'better-sqlite3'

/**
 * Idempotent schema setup. Every statement is CREATE ... IF NOT EXISTS, so this
 * runs unconditionally on every boot. Additive changes can just be appended;
 * anything destructive needs a real migration and a bump here.
 */
export function migrate(db: Database): void {
  db.exec(`
    -- The dedupe spine. The same story reaches us via RSS, Marketaux and EDGAR
    -- within minutes of each other, so every event is recorded here (whether or
    -- not it survives triage) and re-seen ids are skipped.
    CREATE TABLE IF NOT EXISTS seen_events (
      id              TEXT PRIMARY KEY,
      source          TEXT NOT NULL,
      url             TEXT,
      headline        TEXT NOT NULL,
      ticker          TEXT,
      published_at    TEXT,
      first_seen_at   TEXT NOT NULL,
      triage_verdict  TEXT,        -- 'pass' | 'reject' | NULL (not yet triaged)
      triage_reason   TEXT,
      event_type      TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_seen_events_first_seen
      ON seen_events (first_seen_at);
    CREATE INDEX IF NOT EXISTS idx_seen_events_verdict
      ON seen_events (triage_verdict);

    -- One row per published suggestion. entry_price is recorded for internal
    -- scoring only; it is deliberately never rendered into the channel post.
    CREATE TABLE IF NOT EXISTS calls (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      ticker             TEXT NOT NULL,
      company            TEXT,
      direction          TEXT NOT NULL CHECK (direction IN ('long', 'short')),
      conviction         INTEGER NOT NULL CHECK (conviction BETWEEN 1 AND 10),
      thesis             TEXT NOT NULL,
      second_order_chain TEXT,
      catalyst           TEXT,
      catalyst_by        TEXT,
      key_risk           TEXT,
      event_id           TEXT,
      source_url         TEXT,
      entry_price        REAL,
      entry_at           TEXT NOT NULL,
      posted_message_id  INTEGER,
      status             TEXT NOT NULL DEFAULT 'open'
                         CHECK (status IN ('open', 'won', 'lost', 'expired')),
      resolved_at        TEXT,
      resolved_price     REAL,
      return_pct         REAL
    );

    CREATE INDEX IF NOT EXISTS idx_calls_status ON calls (status);
    CREATE INDEX IF NOT EXISTS idx_calls_ticker ON calls (ticker);
    CREATE INDEX IF NOT EXISTS idx_calls_entry_at ON calls (entry_at);

    CREATE TABLE IF NOT EXISTS ticker_cooldown (
      ticker          TEXT PRIMARY KEY,
      last_posted_at  TEXT NOT NULL
    );
  `)
}
