import type { Database } from 'better-sqlite3'

export type TriageVerdict = 'pass' | 'reject'
export type CallStatus = 'open' | 'won' | 'lost' | 'expired'
export type Direction = 'long' | 'short'

export interface SeenEventRow {
  id: string
  source: string
  url: string | null
  headline: string
  ticker: string | null
  published_at: string | null
  first_seen_at: string
  triage_verdict: TriageVerdict | null
  triage_reason: string | null
  event_type: string | null
}

export interface CallRow {
  id: number
  ticker: string
  company: string | null
  direction: Direction
  conviction: number
  thesis: string
  second_order_chain: string | null
  catalyst: string | null
  catalyst_by: string | null
  key_risk: string | null
  event_id: string | null
  source_url: string | null
  entry_price: number | null
  entry_at: string
  posted_message_id: number | null
  status: CallStatus
  resolved_at: string | null
  resolved_price: number | null
  return_pct: number | null
}

export type NewCall = Omit<CallRow, 'id' | 'status' | 'resolved_at' | 'resolved_price' | 'return_pct'>

/**
 * All SQL lives here so the pipeline modules stay free of query strings and the
 * schema has exactly one consumer.
 */
export class Repo {
  constructor(private readonly db: Database) {}

  // ---------- seen_events ----------

  /** Ids already recorded, so a cycle can skip them before spending any tokens. */
  filterUnseen(ids: readonly string[]): Set<string> {
    if (ids.length === 0) return new Set()
    const seen = new Set<string>()
    // Chunked to stay well under SQLITE_MAX_VARIABLE_NUMBER on large cycles.
    for (let i = 0; i < ids.length; i += 400) {
      const chunk = ids.slice(i, i + 400)
      const placeholders = chunk.map(() => '?').join(',')
      const rows = this.db
        .prepare<string[], { id: string }>(
          `SELECT id FROM seen_events WHERE id IN (${placeholders})`,
        )
        .all(...chunk)
      for (const r of rows) seen.add(r.id)
    }
    return new Set(ids.filter((id) => !seen.has(id)))
  }

  recordSeen(
    events: readonly Pick<
      SeenEventRow,
      'id' | 'source' | 'url' | 'headline' | 'ticker' | 'published_at'
    >[],
    now: string,
  ): void {
    const stmt = this.db.prepare(`
      INSERT INTO seen_events (id, source, url, headline, ticker, published_at, first_seen_at)
      VALUES (@id, @source, @url, @headline, @ticker, @published_at, @first_seen_at)
      ON CONFLICT(id) DO NOTHING
    `)
    const tx = this.db.transaction((batch: typeof events) => {
      for (const e of batch) stmt.run({ ...e, first_seen_at: now })
    })
    tx(events)
  }

  countSeenEvents(): number {
    const row = this.db
      .prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM seen_events`)
      .get()
    return row?.n ?? 0
  }

  countCalls(): number {
    const row = this.db.prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM calls`).get()
    return row?.n ?? 0
  }

  recordTriage(id: string, verdict: TriageVerdict, reason: string, eventType?: string): void {
    this.db
      .prepare(
        `UPDATE seen_events
            SET triage_verdict = ?, triage_reason = ?, event_type = ?
          WHERE id = ?`,
      )
      .run(verdict, reason, eventType ?? null, id)
  }

  /** Retention: events are only useful for dedupe while they are recent news. */
  pruneSeenEvents(olderThanIso: string): number {
    return this.db.prepare(`DELETE FROM seen_events WHERE first_seen_at < ?`).run(olderThanIso)
      .changes
  }

  // ---------- calls ----------

  insertCall(call: NewCall): number {
    const info = this.db
      .prepare(
        `INSERT INTO calls (
           ticker, company, direction, conviction, thesis, second_order_chain,
           catalyst, catalyst_by, key_risk, event_id, source_url,
           entry_price, entry_at, posted_message_id
         ) VALUES (
           @ticker, @company, @direction, @conviction, @thesis, @second_order_chain,
           @catalyst, @catalyst_by, @key_risk, @event_id, @source_url,
           @entry_price, @entry_at, @posted_message_id
         )`,
      )
      .run(call)
    return Number(info.lastInsertRowid)
  }

  /** Open calls whose catalyst window has passed — the scoring job's input. */
  openCallsDueBy(iso: string): CallRow[] {
    return this.db
      .prepare<string[], CallRow>(
        `SELECT * FROM calls
          WHERE status = 'open' AND catalyst_by IS NOT NULL AND catalyst_by <= ?
          ORDER BY catalyst_by`,
      )
      .all(iso)
  }

  resolveCall(id: number, status: CallStatus, price: number, returnPct: number, at: string): void {
    this.db
      .prepare(
        `UPDATE calls
            SET status = ?, resolved_price = ?, return_pct = ?, resolved_at = ?
          WHERE id = ?`,
      )
      .run(status, price, returnPct, at, id)
  }

  countOpenCalls(): number {
    const row = this.db
      .prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM calls WHERE status = 'open'`)
      .get()
    return row?.n ?? 0
  }

  resolvedSince(iso: string): CallRow[] {
    return this.db
      .prepare<string[], CallRow>(
        `SELECT * FROM calls WHERE status != 'open' AND resolved_at >= ? ORDER BY return_pct DESC`,
      )
      .all(iso)
  }

  hasOpenCall(ticker: string, direction: Direction): boolean {
    const row = this.db
      .prepare<[string, string], { n: number }>(
        `SELECT COUNT(*) AS n FROM calls
          WHERE status = 'open' AND ticker = ? AND direction = ?`,
      )
      .get(ticker, direction)
    return (row?.n ?? 0) > 0
  }

  countCallsSince(iso: string): number {
    const row = this.db
      .prepare<[string], { n: number }>(`SELECT COUNT(*) AS n FROM calls WHERE entry_at >= ?`)
      .get(iso)
    return row?.n ?? 0
  }

  // ---------- cooldown ----------

  lastPostedAt(ticker: string): string | null {
    const row = this.db
      .prepare<[string], { last_posted_at: string }>(
        `SELECT last_posted_at FROM ticker_cooldown WHERE ticker = ?`,
      )
      .get(ticker)
    return row?.last_posted_at ?? null
  }

  touchCooldown(ticker: string, at: string): void {
    this.db
      .prepare(
        `INSERT INTO ticker_cooldown (ticker, last_posted_at) VALUES (?, ?)
         ON CONFLICT(ticker) DO UPDATE SET last_posted_at = excluded.last_posted_at`,
      )
      .run(ticker, at)
  }
}
