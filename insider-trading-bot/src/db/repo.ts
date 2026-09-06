import type { Pool } from 'pg'

export type TriageVerdict = 'pass' | 'reject'
export type CallStatus = 'open' | 'won' | 'lost' | 'expired'
export type Direction = 'long' | 'short'

export interface SeenEventRow {
  id: string
  source: string
  url: string | null
  headline: string
  ticker: string | null
  /** ISO8601 UTC — see the TIMESTAMPTZ parser in db/index.ts. */
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
  /** Date-only, `YYYY-MM-DD`. */
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

type NewSeenEvent = Pick<
  SeenEventRow,
  'id' | 'source' | 'url' | 'headline' | 'ticker' | 'published_at'
>

/**
 * All SQL lives here so the pipeline modules stay free of query strings and the
 * schema has exactly one consumer.
 *
 * Every method is async because the driver is: the queries themselves are as
 * cheap as they look, but each one is a network round trip rather than a local
 * file read.
 */
export class Repo {
  constructor(private readonly db: Pool) {}

  // ---------- seen_events ----------

  /** Ids not yet recorded, so a cycle can skip the rest before spending any tokens. */
  async filterUnseen(ids: readonly string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set()
    // `= ANY($1)` takes the whole batch as a single array parameter, so there is
    // no placeholder limit to chunk around the way the SQLite version had to.
    const { rows } = await this.db.query<{ id: string }>(
      `SELECT id FROM seen_events WHERE id = ANY($1::text[])`,
      [ids],
    )
    const seen = new Set(rows.map((r) => r.id))
    return new Set(ids.filter((id) => !seen.has(id)))
  }

  async recordSeen(events: readonly NewSeenEvent[], now: string): Promise<void> {
    if (events.length === 0) return
    // One statement for the whole batch: the columns go down as parallel arrays
    // and `unnest` zips them back into rows. Atomic on its own, so the explicit
    // transaction the SQLite version needed is gone. ON CONFLICT DO NOTHING also
    // covers duplicate ids *within* the batch, not just against existing rows.
    await this.db.query(
      `INSERT INTO seen_events
         (id, source, url, headline, ticker, published_at, first_seen_at)
       SELECT id, source, url, headline, ticker, published_at, $7::timestamptz
         FROM unnest($1::text[], $2::text[], $3::text[],
                     $4::text[], $5::text[], $6::timestamptz[])
           AS e(id, source, url, headline, ticker, published_at)
       ON CONFLICT (id) DO NOTHING`,
      [
        events.map((e) => e.id),
        events.map((e) => e.source),
        events.map((e) => e.url),
        events.map((e) => e.headline),
        events.map((e) => e.ticker),
        events.map((e) => e.published_at),
        now,
      ],
    )
  }

  async countSeenEvents(): Promise<number> {
    const { rows } = await this.db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM seen_events`)
    return rows[0]?.n ?? 0
  }

  async countCalls(): Promise<number> {
    const { rows } = await this.db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM calls`)
    return rows[0]?.n ?? 0
  }

  async recordTriage(
    id: string,
    verdict: TriageVerdict,
    reason: string,
    eventType?: string,
  ): Promise<void> {
    await this.db.query(
      `UPDATE seen_events
          SET triage_verdict = $1, triage_reason = $2, event_type = $3
        WHERE id = $4`,
      [verdict, reason, eventType ?? null, id],
    )
  }

  /** Retention: events are only useful for dedupe while they are recent news. */
  async pruneSeenEvents(olderThanIso: string): Promise<number> {
    const res = await this.db.query(`DELETE FROM seen_events WHERE first_seen_at < $1`, [
      olderThanIso,
    ])
    return res.rowCount ?? 0
  }

  // ---------- calls ----------

  async insertCall(call: NewCall): Promise<number> {
    const { rows } = await this.db.query<{ id: number }>(
      `INSERT INTO calls (
         ticker, company, direction, conviction, thesis, second_order_chain,
         catalyst, catalyst_by, key_risk, event_id, source_url,
         entry_price, entry_at, posted_message_id
       ) VALUES (
         $1, $2, $3, $4, $5, $6,
         $7, $8::date, $9, $10, $11,
         $12, $13::timestamptz, $14
       )
       RETURNING id`,
      [
        call.ticker,
        call.company,
        call.direction,
        call.conviction,
        call.thesis,
        call.second_order_chain,
        call.catalyst,
        call.catalyst_by,
        call.key_risk,
        call.event_id,
        call.source_url,
        call.entry_price,
        call.entry_at,
        call.posted_message_id,
      ],
    )
    const id = rows[0]?.id
    if (id === undefined) throw new Error('insertCall returned no id')
    return id
  }

  /**
   * Attach the channel post to a call that is already recorded.
   *
   * `posted_message_id` stays NULL when the announcement never landed — Telegram
   * was down, the message was rejected, or the worker is in DRY_RUN. That is a
   * missing notification, not a missing call.
   */
  async setPostedMessageId(id: number, messageId: number): Promise<void> {
    await this.db.query(`UPDATE calls SET posted_message_id = $1 WHERE id = $2`, [messageId, id])
  }

  /** Open calls whose catalyst window has passed — the scoring job's input. */
  async openCallsDueBy(isoDate: string): Promise<CallRow[]> {
    const { rows } = await this.db.query<CallRow>(
      `SELECT * FROM calls
        WHERE status = 'open' AND catalyst_by IS NOT NULL AND catalyst_by <= $1::date
        ORDER BY catalyst_by`,
      [isoDate],
    )
    return rows
  }

  async resolveCall(
    id: number,
    status: CallStatus,
    price: number,
    returnPct: number,
    at: string,
  ): Promise<void> {
    await this.db.query(
      `UPDATE calls
          SET status = $1, resolved_price = $2, return_pct = $3, resolved_at = $4::timestamptz
        WHERE id = $5`,
      [status, price, returnPct, at, id],
    )
  }

  async countOpenCalls(): Promise<number> {
    const { rows } = await this.db.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM calls WHERE status = 'open'`,
    )
    return rows[0]?.n ?? 0
  }

  async resolvedSince(iso: string): Promise<CallRow[]> {
    const { rows } = await this.db.query<CallRow>(
      `SELECT * FROM calls
        WHERE status <> 'open' AND resolved_at >= $1::timestamptz
        ORDER BY return_pct DESC`,
      [iso],
    )
    return rows
  }

  async hasOpenCall(ticker: string, direction: Direction): Promise<boolean> {
    const { rows } = await this.db.query<{ ok: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM calls
          WHERE status = 'open' AND ticker = $1 AND direction = $2
       ) AS ok`,
      [ticker, direction],
    )
    return rows[0]?.ok ?? false
  }

  async countCallsSince(iso: string): Promise<number> {
    const { rows } = await this.db.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM calls WHERE entry_at >= $1::timestamptz`,
      [iso],
    )
    return rows[0]?.n ?? 0
  }

  // ---------- cooldown ----------

  async lastPostedAt(ticker: string): Promise<string | null> {
    const { rows } = await this.db.query<{ last_posted_at: string }>(
      `SELECT last_posted_at FROM ticker_cooldown WHERE ticker = $1`,
      [ticker],
    )
    return rows[0]?.last_posted_at ?? null
  }

  async touchCooldown(ticker: string, at: string): Promise<void> {
    await this.db.query(
      `INSERT INTO ticker_cooldown (ticker, last_posted_at) VALUES ($1, $2::timestamptz)
       ON CONFLICT (ticker) DO UPDATE SET last_posted_at = excluded.last_posted_at`,
      [ticker, at],
    )
  }
}
