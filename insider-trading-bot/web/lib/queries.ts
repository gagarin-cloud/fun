import 'server-only'

import { cache } from 'react'

import { getDb } from './db'

/**
 * Every read this site performs.
 *
 * The row types mirror `src/db/repo.ts` in the bot, which is the only writer.
 * They are restated rather than imported: the bot is a separate npm project with
 * its own tsconfig and its own build, and reaching across into its `src` would
 * make this app's Docker context the whole repository. The schema they both
 * describe lives in `src/db/migrate.ts`.
 */

export type Direction = 'long' | 'short'
export type CallStatus = 'open' | 'won' | 'lost' | 'expired'

export interface Call {
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
  source_url: string | null
  /** ISO8601 UTC. */
  entry_at: string
  status: CallStatus
  resolved_at: string | null
  return_pct: number | null
}

/**
 * The news item that set a call off, joined in from `seen_events`.
 *
 * Every field is nullable twice over: the join misses when the event has aged
 * out of the dedupe table (the bot prunes it, the call outlives it), and the
 * columns themselves are nullable for sources that do not supply them.
 */
export interface EventContext {
  headline: string | null
  source: string | null
  url: string | null
  published_at: string | null
  event_type: string | null
  triage_reason: string | null
}

export type CallWithEvent = Call & EventContext

export interface Scoreboard {
  open: number
  resolved: number
  won: number
  lost: number
  expired: number
  /** Mean return across resolved calls, in percent. Null until one resolves. */
  meanReturn: number | null
  /** ISO8601 of the earliest call, i.e. how long there has been a record. */
  firstCallAt: string | null
}

export interface Intake {
  seen: number
  passed: number
}

/**
 * Columns shared by both call queries. `calls` is SELECT *-ed nowhere here: the
 * table carries `entry_price` and `resolved_price`, which the bot records for
 * its own scoring and deliberately never publishes. Naming the columns means
 * adding one to the schema does not silently put it on the internet.
 */
const CALL_COLUMNS = `
  c.id, c.ticker, c.company, c.direction, c.conviction, c.thesis,
  c.second_order_chain, c.catalyst, c.catalyst_by, c.key_risk,
  c.source_url, c.entry_at, c.status, c.resolved_at, c.return_pct`

const EVENT_COLUMNS = `
  e.headline, e.source, e.url, e.published_at, e.event_type, e.triage_reason`

/*
 * Four of the reads below are wrapped in React's `cache()`, which memoises for
 * the duration of one request and forgets afterwards — deduplication rather than
 * caching, so there is no staleness to reason about.
 *
 * They are the ones a single page asks for more than once. `generateMetadata`
 * and the page body both want the call; the layout's header and the page body
 * both want the book and the scoreboard; and `read()` asks whether the schema
 * exists before each of them. Without this, rendering one memo page would be
 * seven round trips for three distinct queries.
 */

/**
 * Whether the bot has ever run against this database.
 *
 * `to_regclass` answers NULL for a table that does not exist instead of raising,
 * so this is safe to ask first — which matters on a fresh project, where the web
 * service can win the race to boot and would otherwise greet its first visitor
 * with a 500 about a relation that simply is not there yet.
 */
export const schemaReady = cache(async (): Promise<boolean> => {
  const { rows } = await getDb().query<{ ready: boolean }>(
    `SELECT to_regclass('public.calls') IS NOT NULL AS ready`,
  )
  return rows[0]?.ready ?? false
})

/** Open calls, newest first — the same order they were posted to the channel. */
export const getOpenCalls = cache(async (): Promise<CallWithEvent[]> => {
  const { rows } = await getDb().query<CallWithEvent>(
    `SELECT ${CALL_COLUMNS}, ${EVENT_COLUMNS}
       FROM calls c
       LEFT JOIN seen_events e ON e.id = c.event_id
      WHERE c.status = 'open'
      ORDER BY c.entry_at DESC`,
  )
  return rows
})

/** Resolved calls, most recently settled first. */
export async function getResolvedCalls(limit = 100): Promise<CallWithEvent[]> {
  const { rows } = await getDb().query<CallWithEvent>(
    `SELECT ${CALL_COLUMNS}, ${EVENT_COLUMNS}
       FROM calls c
       LEFT JOIN seen_events e ON e.id = c.event_id
      WHERE c.status <> 'open'
      ORDER BY c.resolved_at DESC NULLS LAST
      LIMIT $1`,
    [limit],
  )
  return rows
}

export const getCall = cache(async (id: number): Promise<CallWithEvent | null> => {
  const { rows } = await getDb().query<CallWithEvent>(
    `SELECT ${CALL_COLUMNS}, ${EVENT_COLUMNS}
       FROM calls c
       LEFT JOIN seen_events e ON e.id = c.event_id
      WHERE c.id = $1`,
    [id],
  )
  return rows[0] ?? null
})

/** Every other call on the same ticker — the bot's history of an opinion. */
export async function getTickerHistory(ticker: string, excludeId: number): Promise<Call[]> {
  const { rows } = await getDb().query<Call>(
    `SELECT ${CALL_COLUMNS}
       FROM calls c
      WHERE c.ticker = $1 AND c.id <> $2
      ORDER BY c.entry_at DESC`,
    [ticker, excludeId],
  )
  return rows
}

/**
 * One pass over `calls` for every headline number on the site.
 *
 * `count(*) FILTER` is Postgres doing five counts in one sequential scan, which
 * is cheaper than five queries and, more usefully, gives numbers that are all
 * true at the same instant. `avg` of an empty set is NULL, not zero — hence
 * `meanReturn` being nullable rather than a misleading 0.0%.
 */
export const getScoreboard = cache(async (): Promise<Scoreboard> => {
  const { rows } = await getDb().query<{
    open: number
    resolved: number
    won: number
    lost: number
    expired: number
    mean_return: number | null
    first_call_at: string | null
  }>(
    `SELECT count(*) FILTER (WHERE status = 'open')     AS open,
            count(*) FILTER (WHERE status <> 'open')    AS resolved,
            count(*) FILTER (WHERE status = 'won')      AS won,
            count(*) FILTER (WHERE status = 'lost')     AS lost,
            count(*) FILTER (WHERE status = 'expired')  AS expired,
            avg(return_pct) FILTER (WHERE status <> 'open') AS mean_return,
            min(entry_at)                               AS first_call_at
       FROM calls`,
  )
  const r = rows[0]
  return {
    open: r?.open ?? 0,
    resolved: r?.resolved ?? 0,
    won: r?.won ?? 0,
    lost: r?.lost ?? 0,
    expired: r?.expired ?? 0,
    meanReturn: r?.mean_return ?? null,
    firstCallAt: r?.first_call_at ?? null,
  }
})

/**
 * How much news the bot read in the last week and how little of it survived
 * triage. Worth showing: the ratio is the whole reason the channel is quiet.
 */
export async function getIntake(): Promise<Intake> {
  const { rows } = await getDb().query<{ seen: number; passed: number }>(
    `SELECT count(*)                                        AS seen,
            count(*) FILTER (WHERE triage_verdict = 'pass') AS passed
       FROM seen_events
      WHERE first_seen_at >= now() - interval '7 days'`,
  )
  return { seen: rows[0]?.seen ?? 0, passed: rows[0]?.passed ?? 0 }
}
