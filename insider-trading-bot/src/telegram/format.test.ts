import { describe, it, expect } from 'vitest'
import { esc, truncate, formatSuggestion, formatRecap, formatDeployNotice } from './format.js'
import type { Thesis } from '../llm/thesis.js'
import type { CallRow } from '../db/repo.js'

describe('esc', () => {
  it('escapes the three characters Telegram HTML cares about', () => {
    expect(esc('Procter & Gamble')).toBe('Procter &amp; Gamble')
    expect(esc('<1% dilution')).toBe('&lt;1% dilution')
    expect(esc('a > b')).toBe('a &gt; b')
  })

  it('escapes the ampersand first, so entities are not double-escaped', () => {
    expect(esc('&lt;')).toBe('&amp;lt;')
  })
})

function thesis(over: Partial<Thesis> = {}): Thesis {
  return {
    ticker: 'ACME',
    company: 'Acme & Co',
    direction: 'long',
    conviction: 8,
    thesis: 'A deal worth <5% of revenue.',
    secondOrderChain: 'Event → Acme supplies the parts → revenue up.',
    catalyst: 'Q3 earnings',
    catalystBy: '2026-10-15',
    keyRisk: 'The contract may be cancelled.',
    ...over,
  }
}

describe('formatSuggestion', () => {
  it('escapes every interpolated field', () => {
    const out = formatSuggestion(thesis(), 'https://x.com/a?b=1&c=2')
    expect(out).toContain('Acme &amp; Co')
    expect(out).toContain('&lt;5% of revenue')
    expect(out).toContain('b=1&amp;c=2')
  })

  it('never leaks a price level into the message', () => {
    const out = formatSuggestion(thesis(), null)
    expect(out).not.toMatch(/entry|target|stop.loss|\$\d/i)
  })

  it('always carries the disclaimer', () => {
    expect(formatSuggestion(thesis(), null)).toContain('Not financial advice')
  })

  it('omits optional sections cleanly when they are absent', () => {
    const out = formatSuggestion(
      thesis({ secondOrderChain: null, catalyst: null, keyRisk: null }),
      null,
    )
    expect(out).not.toContain('Why this company')
    expect(out).not.toContain('Catalyst')
    expect(out).not.toContain('Main risk')
    expect(out).toContain('Conviction')
  })

  it('marks direction for a short', () => {
    expect(formatSuggestion(thesis({ direction: 'short' }), null)).toContain('SHORT')
  })

  it('stays within the Telegram length limit', () => {
    const out = formatSuggestion(thesis({ thesis: 'x'.repeat(9000) }), null)
    expect(out.length).toBeLessThanOrEqual(4096)
  })
})

describe('truncate', () => {
  it('leaves short messages untouched', () => {
    expect(truncate('hello', 100)).toBe('hello')
  })

  it('does not cut inside a tag', () => {
    const out = truncate('aaaa<b>bold</b>', 8)
    expect(out).not.toMatch(/<[^>]*$/)
  })

  it('does not cut inside an entity', () => {
    const out = truncate('aaaaaa&amp;bbb', 10)
    expect(out).not.toMatch(/&[a-z]*$/)
  })

  it('closes tags left open by the cut', () => {
    const out = truncate('<b>' + 'x'.repeat(50) + '</b>', 20)
    // Every opening tag must have a matching close.
    const opens = [...out.matchAll(/<b>/g)].length
    const closes = [...out.matchAll(/<\/b>/g)].length
    expect(opens).toBe(closes)
  })

  it('closes nested tags innermost-first', () => {
    const out = truncate('<b><i>' + 'x'.repeat(50), 20)
    expect(out.endsWith('</i></b>')).toBe(true)
  })
})

function call(over: Partial<CallRow>): CallRow {
  return {
    id: 1,
    ticker: 'ACME',
    company: null,
    direction: 'long',
    conviction: 8,
    thesis: 't',
    second_order_chain: null,
    catalyst: null,
    catalyst_by: '2026-09-01',
    key_risk: null,
    event_id: null,
    source_url: null,
    entry_price: 100,
    entry_at: '2026-07-01T00:00:00.000Z',
    posted_message_id: 1,
    status: 'won',
    resolved_at: '2026-09-02T00:00:00.000Z',
    resolved_price: 120,
    return_pct: 20,
    ...over,
  }
}

describe('formatRecap', () => {
  it('handles a period with nothing resolved', () => {
    const out = formatRecap([], 4, 'week to 2026-08-14')
    expect(out).toContain('No calls resolved')
    expect(out).toContain('4 still open')
  })

  it('reports hit rate and mean return', () => {
    const out = formatRecap(
      [
        call({ id: 1, status: 'won', return_pct: 20 }),
        call({ id: 2, status: 'lost', return_pct: -10 }),
      ],
      1,
      'week to 2026-08-14',
    )
    expect(out).toContain('won 1')
    expect(out).toContain('lost 1')
    expect(out).toContain('50%')
    expect(out).toContain('+5.0%')
  })

  it('escapes tickers in best/worst lines', () => {
    const out = formatRecap(
      [
        call({ id: 1, ticker: 'A&B', return_pct: 20, status: 'won' }),
        call({ id: 2, ticker: 'C<D', return_pct: -15, status: 'lost' }),
      ],
      0,
      'p',
    )
    expect(out).toContain('A&amp;B')
    expect(out).toContain('C&lt;D')
  })
})

describe('formatDeployNotice', () => {
  const base = {
    commit: null,
    freshDatabase: false,
    seenEvents: 412,
    openCalls: 3,
    dryRun: false,
  }

  it('reports the row counts when the database already had a schema', () => {
    const out = formatDeployNotice(base)
    expect(out).toContain('storage ok')
    expect(out).toContain('412 events seen')
    expect(out).toContain('3 open calls')
  })

  it('flags a database that had no schema before this boot', () => {
    const out = formatDeployNotice({ ...base, freshDatabase: true })
    expect(out).toContain('fresh database')
    // The counts are zero and meaningless here; saying "storage ok" alongside
    // them would read as confirmation that the history survived.
    expect(out).not.toContain('storage ok')
  })

  it('includes a short commit and the dry-run marker', () => {
    const out = formatDeployNotice({ ...base, commit: 'abcdef1234567890', dryRun: true })
    expect(out).toContain('<code>abcdef1</code>')
    expect(out).toContain('dry run')
  })
})
