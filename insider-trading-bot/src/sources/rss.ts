import Parser from 'rss-parser'
import { logger } from '../logger.js'
import type { RawEvent, Source } from './types.js'
import { eventId } from './dedupe.js'

/**
 * Free press-release wires. These matter more than they look: a partnership or
 * customer-win announcement hits PR Newswire / Business Wire / GlobeNewswire
 * minutes-to-hours before it appears in any paid news API, and the wire copy
 * carries the deal specifics (named counterparty, contract size, term) that the
 * thesis stage needs for its asymmetry test.
 *
 * Parsing goes through `rss-parser` per the SDK directive — no hand-written XML.
 */

interface FeedSpec {
  name: string
  url: string
}

/**
 * Verified live 2026-08-14. Two findings worth keeping in mind:
 *
 * - PR Newswire appears to ignore its own category slugs — `financial-services`,
 *   `general-business`, `health` and `energy` all returned identical items. Only
 *   the combined list and the earnings list are actually distinct, so subscribing
 *   to more categories adds duplicates, not coverage.
 * - The Business Wire `feed.businesswire.com/rss/home` URL returns **0 items** and
 *   had been contributing nothing since day one. Removed rather than left in to
 *   look like coverage we don't have.
 */
const FEEDS: FeedSpec[] = [
  // Broad public-company news — the important addition. Carries earnings reports,
  // guidance, regulatory news and product announcements, none of which could reach
  // triage while this pipeline subscribed only to deal-specific subject codes.
  {
    name: 'GlobeNewswire',
    url: 'https://www.globenewswire.com/RssFeed/orgclass/1/feedTitle/GlobeNewswire%20-%20News%20about%20Public%20Companies',
  },
  // Deal-specific GlobeNewswire subject codes, kept for depth on those categories.
  // They are now one input among several rather than the whole pipeline.
  {
    name: 'GlobeNewswire',
    url: 'https://www.globenewswire.com/RssFeed/subjectcode/22-Partnership%20Agreements/feedTitle/GlobeNewswire%20-%20Partnership%20Agreements',
  },
  {
    name: 'GlobeNewswire',
    url: 'https://www.globenewswire.com/RssFeed/subjectcode/9-Contracts/feedTitle/GlobeNewswire%20-%20Contracts',
  },
  {
    name: 'GlobeNewswire',
    url: 'https://www.globenewswire.com/RssFeed/subjectcode/21-Mergers%20and%20Acquisitions/feedTitle/GlobeNewswire%20-%20Mergers%20and%20Acquisitions',
  },
  // PR Newswire, combined release list.
  { name: 'PR Newswire', url: 'https://www.prnewswire.com/rss/news-releases-list.rss' },
  // PR Newswire earnings — distinct content, and the cheapest route to earnings
  // surprises and guidance changes. Headlines carry the numbers ("Revenue Surges
  // 100%"), which an 8-K item description never does.
  {
    name: 'PR Newswire',
    url: 'https://www.prnewswire.com/rss/financial-services-latest-news/earnings-list.rss',
  },
]

/**
 * Noise EXCLUSION, not signal inclusion.
 *
 * This filter previously listed the vocabulary of deals — partnership, contract,
 * award, acquisition — and admitted only headlines matching it. That silently made
 * whole categories unreachable: an earnings surprise, a guidance cut, a verdict or
 * a CEO resignation matched none of those words and never reached triage, even
 * though the triage taxonomy claimed to cover them.
 *
 * Inverted deliberately. Everything now reaches triage unless it is unmistakably a
 * non-event. Keep this list conservative: a false positive here costs a fraction of
 * a cent in triage tokens, whereas a false negative silently removes a whole class
 * of signal and is invisible in the logs.
 */
const NON_EVENT = new RegExp(
  [
    // Conferences, webinars, investor-day logistics.
    'to (present|speak|participate|attend)( at| in)',
    'will (present|host|attend)',
    'webinar|fireside chat|investor (day|conference|summit)',
    'conference (call|presentation) (details|announcement)',
    'to (ring|open) the (closing|opening) bell',
    // Awards, rankings, certifications.
    'named (to|one of|among)|ranked (no|#|among)',
    'great place to work|inc\\. ?5000|fastest.growing|best places to work',
    // Loose gap: real headlines read "wins National Murrow Award", not "wins award".
    'wins? .{0,40}(award|prize|recognition)|award.winning|honou?red (with|as|by)',
    'certified by|receives certification',
    // Routine governance notices.
    'notice (for|of) .{0,30}general meeting|extraordinary general meeting',
    'annual general meeting|proxy statement|notice of annual meeting',
    // Marketing, CSR, human interest.
    'celebrat|anniversary|donat|charity|scholarship|sponsorship of',
    'appoints? .{0,30}(advisory board|brand ambassador)',
    'thought leader|white ?paper|survey (finds|reveals|shows)',
    // Non-company science and general-interest wire content.
    'study (finds|shows|reveals)|researchers (find|discover)',
  ].join('|'),
  'i',
)

const parser = new Parser({
  timeout: 20_000,
  headers: {
    // Some wires reject requests without a browser-ish UA.
    'user-agent': 'insider-bot/0.1 (+news aggregation)',
  },
})

async function fetchFeed(spec: FeedSpec): Promise<RawEvent[]> {
  try {
    const feed = await parser.parseURL(spec.url)
    return (feed.items ?? []).flatMap((item) => {
      const headline = item.title?.trim()
      if (!headline) return []
      const body = stripHtml(item.contentSnippet ?? item.content ?? item.summary ?? '')
      // Judge on the headline only. Matching the body too would reject a real
      // event whose boilerplate happens to mention an award or a conference.
      if (NON_EVENT.test(headline)) return []
      const url = item.link ?? null
      return [
        {
          id: eventId({ url, headline, ticker: null }),
          source: 'rss' as const,
          headline,
          body,
          url,
          publishedAt: item.isoDate
            ? new Date(item.isoDate).toISOString()
            : new Date().toISOString(),
          // Wires don't tag tickers; the triage stage resolves the company.
          ticker: null,
          publisher: spec.name,
        },
      ]
    })
  } catch (err) {
    // One dead feed must not fail the cycle.
    logger.warn({ err, feed: spec.url }, 'rss feed failed')
    return []
  }
}

function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export const rssSource: Source = {
  name: 'rss',
  async fetch(): Promise<RawEvent[]> {
    const results = await Promise.all(FEEDS.map(fetchFeed))
    return results.flat()
  },
}
