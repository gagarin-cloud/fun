import { describe, it, expect } from 'vitest'
import { checkGate, rankByConviction } from './gate.js'
import type { GateDeps } from './gate.js'

const NOW = new Date('2026-08-14T12:00:00.000Z')

function deps(over: {
  lastPostedAt?: string | null
  hasOpenCall?: boolean
  countCallsSince?: number
  minConviction?: number
  cooldownHours?: number
  maxPerDay?: number
}): GateDeps {
  return {
    repo: {
      // The real repo is async now, so the doubles are too — a synchronous stub
      // would make every `await` in checkGate a no-op and hide an unawaited call.
      lastPostedAt: async () => over.lastPostedAt ?? null,
      hasOpenCall: async () => over.hasOpenCall ?? false,
      countCallsSince: async () => over.countCallsSince ?? 0,
    },
    config: {
      MIN_CONVICTION: over.minConviction ?? 7,
      TICKER_COOLDOWN_HOURS: over.cooldownHours ?? 72,
      MAX_POSTS_PER_DAY: over.maxPerDay ?? 3,
    },
    now: NOW,
  }
}

const input = { ticker: 'ACME', direction: 'long' as const, conviction: 8 }

describe('checkGate', () => {
  it('passes a clean high-conviction call', async () => {
    expect(await checkGate(input, deps({}))).toEqual({ ok: true })
  })

  it('blocks below the conviction floor', async () => {
    const d = await checkGate({ ...input, conviction: 6 }, deps({}))
    expect(d.ok).toBe(false)
    expect(d.ok === false && d.reason).toContain('below floor')
  })

  it('allows exactly the floor', async () => {
    expect((await checkGate({ ...input, conviction: 7 }, deps({ minConviction: 7 }))).ok).toBe(true)
  })

  it('blocks a duplicate open call in the same direction', async () => {
    const d = await checkGate(input, deps({ hasOpenCall: true }))
    expect(d.ok).toBe(false)
    expect(d.ok === false && d.reason).toContain('already exists')
  })

  it('blocks inside the ticker cooldown', async () => {
    // 10h ago, cooldown 72h.
    const d = await checkGate(input, deps({ lastPostedAt: '2026-08-14T02:00:00.000Z' }))
    expect(d.ok).toBe(false)
    expect(d.ok === false && d.reason).toContain('cooldown')
  })

  it('allows once the cooldown has elapsed', async () => {
    // 80h ago.
    expect((await checkGate(input, deps({ lastPostedAt: '2026-08-11T04:00:00.000Z' }))).ok).toBe(
      true,
    )
  })

  it('blocks at the daily cap', async () => {
    const d = await checkGate(input, deps({ countCallsSince: 3, maxPerDay: 3 }))
    expect(d.ok).toBe(false)
    expect(d.ok === false && d.reason).toContain('daily cap')
  })

  it('allows one below the daily cap', async () => {
    expect((await checkGate(input, deps({ countCallsSince: 2, maxPerDay: 3 }))).ok).toBe(true)
  })

  it('ignores an unparseable last-posted timestamp rather than blocking forever', async () => {
    expect((await checkGate(input, deps({ lastPostedAt: 'not-a-date' }))).ok).toBe(true)
  })
})

describe('rankByConviction', () => {
  it('orders highest conviction first', () => {
    const items = [
      { thesis: { conviction: 7 }, tag: 'a' },
      { thesis: { conviction: 9 }, tag: 'b' },
      { thesis: { conviction: 8 }, tag: 'c' },
    ]
    expect(rankByConviction(items).map((i) => i.tag)).toEqual(['b', 'c', 'a'])
  })

  it('is stable for equal convictions', () => {
    const items = [
      { thesis: { conviction: 8 }, tag: 'first' },
      { thesis: { conviction: 8 }, tag: 'second' },
    ]
    expect(rankByConviction(items).map((i) => i.tag)).toEqual(['first', 'second'])
  })

  it('does not mutate the input', () => {
    const items = [{ thesis: { conviction: 1 } }, { thesis: { conviction: 9 } }]
    const copy = [...items]
    rankByConviction(items)
    expect(items).toEqual(copy)
  })
})
