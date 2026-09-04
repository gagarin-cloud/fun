import Parser from 'rss-parser'
import { loadConfig } from '../config.js'
import { logger } from '../logger.js'
import type { RawEvent, Source } from './types.js'
import { eventId } from './dedupe.js'

/**
 * HAND-ROLLED BY NECESSITY — the SEC publishes no Node SDK for EDGAR, only
 * documented HTTP endpoints. This is the second of the two permitted exceptions
 * to the project's SDK directive (see `marketaux.ts` for the first).
 *
 * Where a library does exist we use it: the "current filings" feed is Atom, so it
 * goes through `rss-parser` rather than hand-written XML parsing.
 *
 * The feed's per-entry `<summary>` already lists the 8-K item codes and their
 * descriptions, so one request covers the whole cycle — no need to fetch each
 * filing's index page. That keeps us far inside SEC's 10 req/s fair-access limit
 * and makes the source essentially free.
 *
 * SEC requires a descriptive User-Agent with contact info on every request or it
 * returns 403 and eventually blocks the IP — hence the mandatory SEC_USER_AGENT.
 */

const CURRENT_8K_FEED =
  'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=8-K&dateb=&owner=include&count=100&output=atom'

const TICKER_MAP_URL = 'https://www.sec.gov/files/company_tickers.json'

/**
 * 8-K items worth acting on. 1.01 (entry into a material definitive agreement) is
 * the authoritative form of "X announced a partnership with Y" — the exact signal
 * this bot exists to catch.
 *
 * Deliberately excluded: 2.02 (results of operations) is routine earnings, 9.01
 * (financial statements and exhibits) is an attachment manifest, and both appear
 * on nearly every filing. A filing whose *only* interesting items are those is
 * dropped rather than triaged.
 */
const ITEMS_OF_INTEREST = new Set([
  '1.01', // entry into a material definitive agreement
  '1.02', // termination of a material definitive agreement
  '2.01', // completion of acquisition or disposition of assets
  '2.03', // creation of a direct financial obligation
  '3.02', // unregistered sales of equity securities (dilution)
  '5.02', // departure/election of directors or officers
  '7.01', // Regulation FD disclosure — supporting only, see below
  '8.01', // other events
])

/**
 * Items that are only interesting *alongside* another qualifying item. Measured
 * 2026-08-14: Item 7.01 (Regulation FD) on its own is almost always earnings
 * slides or an investor deck, and produced ~10 triage rejections reading "routine
 * results and Regulation FD disclosure" for zero passes. Paired with 8.01 or 1.01
 * it is still picked up, since the qualifying item carries the filing.
 */
const ITEMS_SUPPORTING_ONLY = new Set(['7.01'])

/**
 * Items where the item code alone tells us nothing actionable. "Entry into a
 * Material Definitive Agreement" doesn't name the counterparty or the size of the
 * deal, which is exactly what the asymmetry test needs — so for these we spend one
 * extra request to pull the filing text. The other items (a director departure, a
 * dilution notice) are fully described by their code.
 */
const NEEDS_BODY = new Set(['1.01', '1.02', '2.01', '8.01'])

/** Cap on filings enriched per cycle, so a busy filing day can't fan out. */
const MAX_ENRICH_PER_CYCLE = 15

interface CikTickerEntry {
  cik_str: number
  ticker: string
  title: string
}

let tickerMap: Map<number, string> | undefined
let tickerMapFetchedAt = 0
const TICKER_MAP_TTL_MS = 24 * 60 * 60 * 1000

/**
 * Only the User-Agent. Notably we do *not* set `accept-encoding` — `rss-parser`
 * uses node's http module, which will not decompress a gzipped body, so asking
 * SEC for gzip makes the Atom parse die on "Non-whitespace before first tag".
 * `fetch` negotiates and decompresses on its own, so nothing needs it.
 */
function secHeaders(): Record<string, string> {
  return { 'user-agent': loadConfig().SEC_USER_AGENT }
}

/** CIK -> primary ticker. Cached for a day; the file is ~1MB. */
async function getTickerMap(): Promise<Map<number, string>> {
  if (tickerMap && Date.now() - tickerMapFetchedAt < TICKER_MAP_TTL_MS) return tickerMap
  try {
    const res = await fetch(TICKER_MAP_URL, {
      headers: secHeaders(),
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) throw new Error(`status ${res.status}`)
    const json = (await res.json()) as Record<string, CikTickerEntry>
    const map = new Map<number, string>()
    for (const entry of Object.values(json)) {
      // First occurrence wins — the file lists the primary ticker first.
      if (!map.has(entry.cik_str)) map.set(entry.cik_str, entry.ticker.toUpperCase())
    }
    tickerMap = map
    tickerMapFetchedAt = Date.now()
    logger.debug({ size: map.size }, 'edgar ticker map loaded')
    return map
  } catch (err) {
    logger.error({ err }, 'edgar ticker map fetch failed')
    return tickerMap ?? new Map()
  }
}

/** `8-K - ACME CORP (0000123456) (Filer)` -> company + CIK. */
function parseEntryTitle(title: string): { company: string; cik: number } | null {
  const m = /^8-K(?:\/A)?\s*-\s*(.+?)\s*\((\d{4,10})\)/.exec(title)
  const company = m?.[1]
  const cik = m?.[2]
  if (!company || !cik) return null
  return { company, cik: Number(cik) }
}

/**
 * The summary is HTML like:
 *   <b>Filed:</b> 2026-08-14 <b>AccNo:</b> ... <br>Item 2.02: Results of ...
 * Returns the item code -> description pairs.
 */
function parseItems(summaryHtml: string): { code: string; description: string }[] {
  const text = summaryHtml
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')

  const out: { code: string; description: string }[] = []
  for (const line of text.split('\n')) {
    const m = /Item\s+(\d\.\d{2})\s*:\s*(.+?)\s*$/.exec(line.trim())
    const code = m?.[1]
    const description = m?.[2]
    if (code && description) out.push({ code, description })
  }
  return out
}

/**
 * `rss-parser` takes custom headers at the top level. (Putting them under
 * `requestOptions` silently sends none, which EDGAR answers with a 403.)
 */
function makeParser(): Parser {
  return new Parser({ timeout: 20_000, headers: secHeaders() })
}

function stripHtml(html: string): string {
  return (
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      // EDGAR filings are dense with numeric entities — &#160; especially, which
      // appears hundreds of times per document and reads as noise to the model.
      .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => codePoint(parseInt(hex, 16)))
      .replace(/&#(\d+);/g, (_, dec: string) => codePoint(Number(dec)))
      .replace(/&nbsp;/g, ' ')
      .replace(/&(amp|lt|gt|quot|apos|rsquo|lsquo|ldquo|rdquo|mdash|ndash);/g, (_, name: string) =>
        NAMED_ENTITIES[name] ?? ' ',
      )
      .replace(/\s+/g, ' ')
      .trim()
  )
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
  mdash: '—',
  ndash: '–',
}

function codePoint(n: number): string {
  if (!Number.isFinite(n) || n < 32) return ' '
  // Non-breaking space and its relatives become plain spaces.
  if (n === 160 || (n >= 0x2000 && n <= 0x200a) || n === 0x202f) return ' '
  try {
    return String.fromCodePoint(n)
  } catch {
    return ' '
  }
}

/**
 * 8-K documents open with an XBRL blob and the cover page (registrant address,
 * Commission file number, a block of check-box legalese) before any narrative.
 * The first `Item N.NN` string in the raw text is usually inside that preamble, so
 * anchor past the cover page first, then take the narrative from the item heading.
 */
function trimToNarrative(text: string): string {
  // The cover page always ends after the check-box legalese; these markers are
  // the last things before the body across every filing agent's template.
  const coverEnd = Math.max(
    text.search(/Emerging growth company/i),
    text.search(/Securities registered pursuant to Section 12\(b\)/i),
    text.search(/Commission File Number/i),
  )
  const searchFrom = coverEnd > 0 ? coverEnd : 0
  const rel = text.slice(searchFrom).search(/Item\s+\d\.\d{2}/)
  if (rel >= 0) return text.slice(searchFrom + rel)
  // No narrative heading found — fall back to skipping the XBRL preamble only.
  const firstItem = text.search(/Item\s+\d\.\d{2}/)
  return firstItem > 0 ? text.slice(firstItem) : text
}

/**
 * Pull the narrative text of a filing. The accession directory's `index.json`
 * lists its documents; the primary 8-K document is the one whose name looks like
 * `form8-k.htm` (exhibits are `ex99-1.htm`, XBRL viewer fragments are `R1.htm`).
 *
 * Returns null on any failure — a missing body degrades the event to its item
 * descriptions rather than dropping it.
 */
async function fetchFilingBody(indexUrl: string): Promise<string | null> {
  try {
    const dir = indexUrl.slice(0, indexUrl.lastIndexOf('/'))
    const idxRes = await fetch(`${dir}/index.json`, {
      headers: secHeaders(),
      signal: AbortSignal.timeout(15_000),
    })
    if (!idxRes.ok) return null
    const idx = (await idxRes.json()) as {
      directory?: { item?: { name: string; size?: string }[] }
    }
    const files = (idx.directory?.item ?? []).filter((f) => /\.htm$/i.test(f.name))
    const primary =
      files.find((f) => /^form\s*8-?k/i.test(f.name)) ??
      files.find((f) => /8-?k/i.test(f.name) && !/-index/i.test(f.name)) ??
      files.find((f) => !/^(ex|r\d+)/i.test(f.name) && !/-index/i.test(f.name))
    if (!primary) return null

    const docRes = await fetch(`${dir}/${primary.name}`, {
      headers: secHeaders(),
      signal: AbortSignal.timeout(20_000),
    })
    if (!docRes.ok) return null
    return trimToNarrative(stripHtml(await docRes.text())).slice(0, 4000)
  } catch (err) {
    logger.debug({ err, indexUrl }, 'edgar filing body fetch failed')
    return null
  }
}

export const edgarSource: Source = {
  name: 'edgar',
  async fetch(): Promise<RawEvent[]> {
    try {
      const [feed, tickers] = await Promise.all([
        makeParser().parseURL(CURRENT_8K_FEED),
        getTickerMap(),
      ])

      // `needsBody` marks filings that need the extra text fetch below.
      const events: (RawEvent & { needsBody: boolean })[] = []

      for (const item of feed.items ?? []) {
        const parsed = parseEntryTitle(item.title ?? '')
        if (!parsed || !item.link) continue

        // Only filers we can map to a listed ticker are tradable ideas.
        const ticker = tickers.get(parsed.cik)
        if (!ticker) continue

        const summary = item.summary ?? item.content ?? item.contentSnippet ?? ''
        const items = parseItems(summary)
        const relevant = items.filter((i) => ITEMS_OF_INTEREST.has(i.code))
        if (relevant.length === 0) continue

        // A filing carried only by a supporting item (7.01 Reg FD) isn't an event.
        const headlineItems = relevant.filter((i) => !ITEMS_SUPPORTING_ONLY.has(i.code))
        if (headlineItems.length === 0) continue

        const descriptions = headlineItems
          .map((i) => `Item ${i.code}: ${i.description}`)
          .join('; ')
        const headline = `${parsed.company} filed an 8-K — ${descriptions}`

        events.push({
          id: eventId({ url: item.link, headline, ticker }),
          source: 'edgar',
          headline,
          // All items, so the model can see the full context of the filing.
          body: items.map((i) => `Item ${i.code}: ${i.description}`).join('\n'),
          url: item.link,
          publishedAt: item.isoDate
            ? new Date(item.isoDate).toISOString()
            : new Date().toISOString(),
          ticker,
          publisher: 'SEC EDGAR',
          needsBody: relevant.some((i) => NEEDS_BODY.has(i.code)),
        })
      }

      // Enrich the filings whose item codes alone are uninformative. Serialised on
      // purpose: two requests each, comfortably inside SEC's 10 req/s limit.
      const toEnrich = events.filter((e) => e.needsBody).slice(0, MAX_ENRICH_PER_CYCLE)
      for (const e of toEnrich) {
        if (!e.url) continue
        const body = await fetchFilingBody(e.url)
        if (body) e.body = `${e.body}\n\n${body}`
      }
      logger.debug({ total: events.length, enriched: toEnrich.length }, 'edgar cycle')

      // `needsBody` is an internal ingest concern; strip it from what we return.
      return events.map(({ needsBody: _needsBody, ...e }) => e)
    } catch (err) {
      logger.error({ err }, 'edgar source failed')
      return []
    }
  },
}
