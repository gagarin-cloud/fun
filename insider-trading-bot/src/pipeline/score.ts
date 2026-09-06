import { logger } from '../logger.js'
import { getDb } from '../db/index.js'
import { Repo } from '../db/repo.js'
import type { CallRow, CallStatus } from '../db/repo.js'
import { getFinnhub } from '../sources/finnhub.js'
import { formatRecap } from '../telegram/format.js'
import { postMessage } from '../telegram/publisher.js'

/** A call is a win or a loss beyond this move; inside it, the thesis just didn't play out. */
export const WIN_THRESHOLD_PCT = 8
export const LOSS_THRESHOLD_PCT = -8

/**
 * Signed return in the direction of the call, so a short that fell 10% is +10%.
 * This is what makes wins and losses comparable across directions.
 */
export function returnPct(
  direction: 'long' | 'short',
  entry: number,
  current: number,
): number {
  const raw = ((current - entry) / entry) * 100
  return direction === 'long' ? raw : -raw
}

export function classify(signedReturn: number): CallStatus {
  if (signedReturn >= WIN_THRESHOLD_PCT) return 'won'
  if (signedReturn <= LOSS_THRESHOLD_PCT) return 'lost'
  return 'expired'
}

export interface ScoreResult {
  due: number
  resolved: number
  unscoreable: number
  posted: boolean
}

/**
 * Weekly job. Resolves every open call whose catalyst window has closed, then
 * posts a recap. This is the only feedback loop in the system — without it there
 * is no way to know whether the prompts are doing anything.
 */
export async function runScoring(opts: { postRecap?: boolean } = {}): Promise<ScoreResult> {
  const repo = new Repo(getDb())
  const now = new Date()
  const today = now.toISOString().slice(0, 10)

  const due = await repo.openCallsDueBy(today)
  const result: ScoreResult = { due: due.length, resolved: 0, unscoreable: 0, posted: false }

  for (const call of due) {
    if (call.entry_price == null || call.entry_price <= 0) {
      // No entry snapshot means it can never be scored. Retire it rather than
      // leaving it to be re-examined every week forever.
      await repo.resolveCall(call.id, 'expired', 0, 0, now.toISOString())
      result.unscoreable++
      logger.warn({ id: call.id, ticker: call.ticker }, 'call has no entry price — retiring')
      continue
    }

    const quote = await safeQuote(call.ticker)
    if (!quote) {
      // Leave it open; next week's run will try again. A delisting will keep
      // failing, but an open row is more honest than a fabricated result.
      logger.warn({ ticker: call.ticker }, 'no quote — leaving call open')
      continue
    }

    const signed = returnPct(call.direction, call.entry_price, quote.price)
    const status = classify(signed)
    await repo.resolveCall(call.id, status, quote.price, signed, now.toISOString())
    result.resolved++
    logger.info(
      { ticker: call.ticker, status, returnPct: signed.toFixed(1) },
      'call resolved',
    )
  }

  if (opts.postRecap !== false) {
    const weekAgo = new Date(now.getTime() - 7 * 86_400_000).toISOString()
    const resolved = await repo.resolvedSince(weekAgo)
    const stillOpen = await repo.countOpenCalls()
    const label = `week to ${today}`
    const messageId = await postMessage(formatRecap(resolved, stillOpen, label))
    result.posted = messageId !== null
  }

  logger.info(result, 'scoring complete')
  return result
}

async function safeQuote(ticker: string) {
  try {
    return await getFinnhub().quote(ticker)
  } catch (err) {
    logger.warn({ err, ticker }, 'scoring quote failed')
    return null
  }
}
