import type { Pool } from 'pg'

/**
 * Idempotent schema setup. Every statement is CREATE ... IF NOT EXISTS, so this
 * runs unconditionally on every boot. Additive changes can just be appended;
 * anything destructive needs a real migration and a bump here.
 *
 * Sent as one multi-statement simple query, which Postgres wraps in an implicit
 * transaction — so a schema that half-applies is not a state this can reach.
 */
export async function migrate(db: Pool): Promise<void> {
  await db.query(`
    -- The dedupe spine. The same story reaches us via RSS, Marketaux and EDGAR
    -- within minutes of each other, so every event is recorded here (whether or
    -- not it survives triage) and re-seen ids are skipped.
    CREATE TABLE IF NOT EXISTS seen_events (
      id              TEXT PRIMARY KEY,
      source          TEXT NOT NULL,
      url             TEXT,
      headline        TEXT NOT NULL,
      ticker          TEXT,
      published_at    TIMESTAMPTZ,
      first_seen_at   TIMESTAMPTZ NOT NULL,
      -- NULL until triaged; CHECK permits NULL, so the third state needs no
      -- sentinel value.
      triage_verdict  TEXT CHECK (triage_verdict IN ('pass', 'reject')),
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
      id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      ticker             TEXT NOT NULL,
      company            TEXT,
      direction          TEXT NOT NULL CHECK (direction IN ('long', 'short')),
      conviction         INTEGER NOT NULL CHECK (conviction BETWEEN 1 AND 10),
      thesis             TEXT NOT NULL,
      second_order_chain TEXT,
      catalyst           TEXT,
      -- A real DATE: the scoring job compares it against today, and the thesis
      -- stage already clamps it to a YYYY-MM-DD inside a 1-3 month window.
      catalyst_by        DATE,
      key_risk           TEXT,
      event_id           TEXT,
      source_url         TEXT,
      entry_price        DOUBLE PRECISION,
      entry_at           TIMESTAMPTZ NOT NULL,
      posted_message_id  BIGINT,
      status             TEXT NOT NULL DEFAULT 'open'
                         CHECK (status IN ('open', 'won', 'lost', 'expired')),
      resolved_at        TIMESTAMPTZ,
      resolved_price     DOUBLE PRECISION,
      return_pct         DOUBLE PRECISION
    );

    CREATE INDEX IF NOT EXISTS idx_calls_status ON calls (status);
    CREATE INDEX IF NOT EXISTS idx_calls_ticker ON calls (ticker);
    CREATE INDEX IF NOT EXISTS idx_calls_entry_at ON calls (entry_at);

    CREATE TABLE IF NOT EXISTS ticker_cooldown (
      ticker          TEXT PRIMARY KEY,
      last_posted_at  TIMESTAMPTZ NOT NULL
    );
  `)
}
