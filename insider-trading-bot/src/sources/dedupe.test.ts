import { describe, it, expect } from 'vitest'
import { normalizeUrl, headlineKey, eventId, dedupeBatch } from './dedupe.js'
import type { RawEvent } from './types.js'

describe('normalizeUrl', () => {
  it('drops scheme, www and trailing slash', () => {
    expect(normalizeUrl('https://www.Example.com/News/Item/')).toBe('example.com/news/item')
    expect(normalizeUrl('http://example.com/news/item')).toBe('example.com/news/item')
  })

  it('strips tracking params but keeps meaningful ones', () => {
    expect(normalizeUrl('https://example.com/a?utm_source=x&id=7&fbclid=z')).toBe(
      'example.com/a?id=7',
    )
  })

  it('sorts retained params so order does not affect the key', () => {
    expect(normalizeUrl('https://example.com/a?b=2&a=1')).toBe(
      normalizeUrl('https://example.com/a?a=1&b=2'),
    )
  })

  it('returns null on unparseable input', () => {
    expect(normalizeUrl('not a url')).toBeNull()
  })
})

describe('headlineKey', () => {
  it('ignores punctuation and casing', () => {
    expect(headlineKey('Acme, Inc. Wins $5M Deal!', 'ACME')).toBe(
      headlineKey('acme inc wins 5m deal', 'acme'),
    )
  })

  it('separates the same headline under different tickers', () => {
    expect(headlineKey('Big deal', 'AAA')).not.toBe(headlineKey('Big deal', 'BBB'))
  })
})

describe('eventId', () => {
  it('is stable across syndicated URL variants of one story', () => {
    const a = eventId({ url: 'https://www.wire.com/x/?utm_source=rss', headline: 'H', ticker: null })
    const b = eventId({ url: 'http://wire.com/x', headline: 'H', ticker: null })
    expect(a).toBe(b)
  })

  it('falls back to the headline hash when there is no URL', () => {
    const id = eventId({ url: null, headline: 'Acme wins deal', ticker: 'ACME' })
    expect(id.startsWith('h_')).toBe(true)
  })

  it('is not namespaced by source, so cross-source copies collapse', () => {
    const url = 'https://wire.com/story'
    expect(eventId({ url, headline: 'A', ticker: 'X' })).toBe(
      eventId({ url, headline: 'B', ticker: 'Y' }),
    )
  })
})

function ev(over: Partial<RawEvent>): RawEvent {
  return {
    id: 'i',
    source: 'rss',
    headline: 'Acme partners with Beta',
    body: '',
    url: null,
    publishedAt: '2026-08-14T10:00:00.000Z',
    ticker: null,
    publisher: null,
    ...over,
  }
}

describe('dedupeBatch', () => {
  it('collapses the same story from two sources, keeping the longer body', () => {
    const out = dedupeBatch([
      ev({ source: 'rss', body: 'short' }),
      ev({ source: 'marketaux', body: 'a much longer body with the deal terms' }),
    ])
    expect(out).toHaveLength(1)
    expect(out[0]?.body).toContain('deal terms')
  })

  it('keeps the earliest publish time when collapsing', () => {
    const out = dedupeBatch([
      ev({ publishedAt: '2026-08-14T12:00:00.000Z', body: 'longer body here' }),
      ev({ publishedAt: '2026-08-14T09:00:00.000Z', body: 'x' }),
    ])
    expect(out[0]?.publishedAt).toBe('2026-08-14T09:00:00.000Z')
  })

  it('leaves genuinely different stories alone', () => {
    const out = dedupeBatch([ev({ headline: 'Acme wins deal' }), ev({ headline: 'Beta loses suit' })])
    expect(out).toHaveLength(2)
  })
})
