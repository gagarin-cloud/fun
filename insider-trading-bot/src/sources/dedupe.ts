import { createHash } from 'node:crypto'
import type { RawEvent } from './types.js'

/** Query params that identify a tracking campaign rather than a document. */
const TRACKING_PARAMS = /^(utm_|ref$|ref_|source$|fbclid$|gclid$|mc_cid$|mc_eid$|__twitter)/i

/**
 * Canonical URL form: host + path, lowercased, no scheme, no `www.`, no trailing
 * slash, tracking params stripped. The same press release is syndicated under
 * several URLs that differ only in these respects.
 */
export function normalizeUrl(raw: string): string | null {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, '')
  const path = u.pathname.replace(/\/+$/, '').toLowerCase()
  const kept = [...u.searchParams.entries()]
    .filter(([k]) => !TRACKING_PARAMS.test(k))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
  return `${host}${path}${kept.length ? `?${kept.join('&')}` : ''}`
}

/**
 * Headline fingerprint, used when a source gives us no usable URL and as the
 * cross-source collapse key. Punctuation and casing differ between a PR wire and
 * a news API rewrite of the same announcement; the word sequence usually doesn't.
 */
export function headlineKey(headline: string, ticker: string | null): string {
  const words = headline
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
  return `${ticker?.toUpperCase() ?? '-'}:${words.join(' ')}`
}

function sha1(s: string): string {
  return createHash('sha1').update(s).digest('hex').slice(0, 20)
}

/**
 * Dedupe id for an event: the normalised URL when we have one, otherwise a hash
 * of the headline fingerprint. Deliberately **not** namespaced by source, so the
 * same story arriving via RSS and Marketaux collapses to one id.
 */
export function eventId(e: Pick<RawEvent, 'url' | 'headline' | 'ticker'>): string {
  const url = e.url ? normalizeUrl(e.url) : null
  return url ? `u_${sha1(url)}` : `h_${sha1(headlineKey(e.headline, e.ticker))}`
}

/**
 * Collapse a batch in memory before it reaches the database. URL-keyed and
 * headline-keyed views of one story survive `eventId` as distinct ids, so this
 * second pass also folds by headline fingerprint, keeping the richest copy —
 * the one with the longest body, since triage quality depends on it.
 */
export function dedupeBatch(events: readonly RawEvent[]): RawEvent[] {
  const byHeadline = new Map<string, RawEvent>()
  for (const e of events) {
    const key = headlineKey(e.headline, e.ticker)
    const existing = byHeadline.get(key)
    if (!existing) {
      byHeadline.set(key, e)
      continue
    }
    // Prefer the copy with more body text; tie-break toward the earlier publish
    // time so `publishedAt` reflects when the news actually broke.
    const better = e.body.length > existing.body.length ? e : existing
    const earliest =
      e.publishedAt < existing.publishedAt ? e.publishedAt : existing.publishedAt
    byHeadline.set(key, { ...better, publishedAt: earliest })
  }
  return [...byHeadline.values()]
}
