import type { Repo, Direction } from '../db/repo.js'
import type { Config } from '../config.js'

export interface GateInput {
  ticker: string
  direction: Direction
  conviction: number
}

export type GateDecision = { ok: true } | { ok: false; reason: string }

export interface GateDeps {
  repo: Pick<Repo, 'lastPostedAt' | 'hasOpenCall' | 'countCallsSince'>
  config: Pick<Config, 'MIN_CONVICTION' | 'TICKER_COOLDOWN_HOURS' | 'MAX_POSTS_PER_DAY'>
  now: Date
}

/**
 * The last line of defence between the model and the channel. Everything here is
 * about restraint: the model will happily produce a dozen 7s on a busy news day,
 * and a channel that posts a dozen ideas a day carries no signal at all.
 *
 * Pure function of (input, repo state, clock) so it is fully unit-testable.
 */
export function checkGate(input: GateInput, deps: GateDeps): GateDecision {
  const { repo, config, now } = deps

  if (input.conviction < config.MIN_CONVICTION) {
    return {
      ok: false,
      reason: `conviction ${input.conviction} below floor ${config.MIN_CONVICTION}`,
    }
  }

  // Never stack two live calls on the same ticker in the same direction — that is
  // one idea, posted twice, and it double-counts in the scorecard.
  if (repo.hasOpenCall(input.ticker, input.direction)) {
    return { ok: false, reason: `an open ${input.direction} call on ${input.ticker} already exists` }
  }

  const last = repo.lastPostedAt(input.ticker)
  if (last) {
    const elapsedH = (now.getTime() - Date.parse(last)) / 3_600_000
    if (Number.isFinite(elapsedH) && elapsedH < config.TICKER_COOLDOWN_HOURS) {
      return {
        ok: false,
        reason: `${input.ticker} posted ${elapsedH.toFixed(1)}h ago, cooldown is ${config.TICKER_COOLDOWN_HOURS}h`,
      }
    }
  }

  // Rolling 24h rather than calendar-day, so the cap can't be sidestepped by
  // posting three at 23:50 and three more at 00:10.
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()
  const recent = repo.countCallsSince(dayAgo)
  if (recent >= config.MAX_POSTS_PER_DAY) {
    return {
      ok: false,
      reason: `daily cap reached (${recent}/${config.MAX_POSTS_PER_DAY} in the last 24h)`,
    }
  }

  return { ok: true }
}

/**
 * When several theses clear the gate in one cycle we can only post a few, so rank
 * by conviction and let the cap take the top. `Array.prototype.sort` is stable, so
 * equal convictions keep their input order.
 */
export function rankByConviction<T extends { thesis: { conviction: number } }>(
  items: readonly T[],
): T[] {
  return [...items].sort((a, b) => b.thesis.conviction - a.thesis.conviction)
}
