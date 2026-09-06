import Link from 'next/link'

import { Chain } from './Chain'
import { Conviction } from './Conviction'
import { Dte } from './Dte'
import { ago, fmtTerm, hostOf } from '@/lib/format'
import type { CallWithEvent } from '@/lib/queries'

/**
 * One open position.
 *
 * Read top to bottom it is: the name, the claim, what the claim rests on, the
 * argument, and the two facts that decide it. The thesis is not first — the
 * chain is the reason this bot exists, and it is short enough to take the top.
 */
export function CallEntry({ call }: { call: CallWithEvent }) {
  return (
    <li className="pos">
      <header className="pos__head">
        <span className="pos__ticker">
          <Link href={`/calls/${call.id}`}>{call.ticker}</Link>
        </span>
        <span className={`pos__side ${call.direction === 'long' ? 'up' : 'down'}`}>
          {call.direction}
        </span>
        {call.company ? <span className="pos__company">{call.company}</span> : null}
        <span className="pos__spacer" />
        <Conviction value={call.conviction} />
      </header>

      <div className="pos__body">
        <dl className="rows">
          <dt className="field">Chain</dt>
          <dd>
            <Chain chain={call.second_order_chain} />
          </dd>

          {call.headline ? (
            <>
              <dt className="field">Source</dt>
              <dd>
                <SourceLine call={call} />
              </dd>
            </>
          ) : null}

          <dt className="field">Thesis</dt>
          <dd className="prose">{call.thesis}</dd>

          {call.catalyst ? (
            <>
              <dt className="field">Catalyst</dt>
              <dd>
                {call.catalyst}
                {call.catalyst_by ? (
                  <>
                    {' — '}
                    <Dte day={call.catalyst_by} />
                  </>
                ) : null}
              </dd>
            </>
          ) : null}

          {call.key_risk ? (
            <>
              <dt className="field">Risk</dt>
              <dd>{call.key_risk}</dd>
            </>
          ) : null}
        </dl>
      </div>

      <footer className="pos__foot">
        <span>
          Opened {fmtTerm(call.entry_at)} · {ago(call.entry_at)}
        </span>
        <Link href={`/calls/${call.id}`}>Full memo</Link>
      </footer>
    </li>
  )
}

/**
 * The news item the position came out of.
 *
 * Nullable throughout: the bot prunes `seen_events` on a retention window, so a
 * call outlives the event that produced it and the join comes back empty. The
 * caller checks `headline` before rendering this at all — an absent source is
 * not worth a row saying it is absent.
 */
function SourceLine({ call }: { call: CallWithEvent }) {
  const host = hostOf(call.url ?? call.source_url)
  const url = call.url ?? call.source_url

  return (
    <figure className="source">
      <blockquote className="source__headline">{call.headline}</blockquote>
      <figcaption className="source__meta">
        {call.source ?? host ?? 'unattributed'}
        {call.published_at ? ` · ${fmtTerm(call.published_at)}` : null}
        {url ? (
          <>
            {' · '}
            <a href={url} rel="noopener noreferrer nofollow" target="_blank">
              open
            </a>
          </>
        ) : null}
      </figcaption>
    </figure>
  )
}
