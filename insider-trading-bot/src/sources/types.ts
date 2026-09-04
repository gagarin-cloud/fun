export type SourceName = 'finnhub' | 'marketaux' | 'rss' | 'edgar'

/** A normalised news item, before any LLM has looked at it. */
export interface RawEvent {
  /** Stable dedupe key — see `eventId()`. */
  id: string
  source: SourceName
  headline: string
  /** Article body / summary. May be empty; triage works on headlines alone. */
  body: string
  url: string | null
  /** ISO8601 UTC. */
  publishedAt: string
  /** Ticker as tagged by the source, when it provides one. Often absent or wrong. */
  ticker: string | null
  /** Publisher name, for the model's provenance weighting. */
  publisher: string | null
}

export interface Source {
  readonly name: SourceName
  /** Fetch recent items. Must resolve (never reject) — return [] on failure. */
  fetch(): Promise<RawEvent[]>
}
