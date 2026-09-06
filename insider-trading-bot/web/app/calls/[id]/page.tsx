import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'

import { Chain } from '@/components/Chain'
import { Conviction } from '@/components/Conviction'
import { Dte } from '@/components/Dte'
import { StateNote } from '@/components/StateNote'
import { ago, catalystWindow, fmtPct, fmtTerm, hostOf } from '@/lib/format'
import { getCall, getTickerHistory, type Call, type CallWithEvent } from '@/lib/queries'
import { read } from '@/lib/read'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

/** `/calls/12abc` and `/calls/-1` are 404s, not queries. */
function parseId(raw: string): number | null {
  return /^\d+$/.test(raw) ? Number(raw) : null
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const id = parseId((await params).id)
  if (id === null) return { title: 'Not found' }

  const result = await read(() => getCall(id))
  if (!result.ok || !result.data) return { title: 'Not found' }

  const call = result.data
  return {
    title: `${call.ticker} ${call.direction}`,
    description: call.thesis.slice(0, 200),
  }
}

export default async function CallPage({ params }: Params) {
  const id = parseId((await params).id)
  if (id === null) notFound()

  const result = await read(async () => {
    const call = await getCall(id)
    if (!call) return null
    return { call, history: await getTickerHistory(call.ticker, call.id) }
  })

  if (!result.ok) return <StateNote result={result} />
  if (!result.data) notFound()

  const { call, history } = result.data
  const open = call.status === 'open'

  return (
    <article>
      <p className="memo__crumb">
        <Link href={open ? '/' : '/record'}>{open ? 'Open book' : 'Settled positions'}</Link>
      </p>

      <header className="memo__head">
        <h1 className="memo__ticker">{call.ticker}</h1>
        <span className={`pos__side ${call.direction === 'long' ? 'up' : 'down'}`}>
          {call.direction}
        </span>
        {call.company ? <p className="memo__company">{call.company}</p> : null}
        <span className="pos__spacer" />
        <Conviction value={call.conviction} />
      </header>

      <section className="panel">
        <h2>Why this company</h2>
        <div className="panel__body">
          <Chain chain={call.second_order_chain} />
          <p style={{ marginTop: '0.9rem' }}>{call.thesis}</p>
        </div>
      </section>

      {call.catalyst || call.key_risk ? (
        <section className="panel">
          <h2>What decides it</h2>
          <div className="panel__body">
            <dl className="rows">
              {call.catalyst ? (
                <>
                  <dt className="field">Catalyst</dt>
                  <dd>
                    {call.catalyst}
                    {call.catalyst_by ? (
                      <>
                        {' — '}
                        <Dte day={call.catalyst_by} settled={!open} />
                      </>
                    ) : null}
                  </dd>
                </>
              ) : null}
              {call.key_risk ? (
                <>
                  <dt className="field">Kill switch</dt>
                  <dd>{call.key_risk}</dd>
                </>
              ) : null}
            </dl>
          </div>
        </section>
      ) : null}

      <TheNews call={call} />

      <section className="panel">
        <h2>{open ? 'Position status' : 'Outcome'}</h2>
        <div className="panel__body">
          <Outcome call={call} />
        </div>
      </section>

      {history.length > 0 ? (
        <section className="panel">
          <h2>Prior calls on {call.ticker}</h2>
          <div className="panel__body">
            <dl className="rows">
              {history.map((prior) => (
                <PriorCall key={prior.id} call={prior} />
              ))}
            </dl>
          </div>
        </section>
      ) : null}
    </article>
  )
}

/**
 * The event the position came out of, plus the triage note.
 *
 * `triage_reason` is the model's own one-line explanation for letting the story
 * through, written before it knew what the thesis would be. It is the most
 * interesting field in the database and half the reason this page exists.
 *
 * The whole section disappears when the join came back empty — `seen_events` is
 * pruned on a retention window, so an old position outlives its source row.
 */
function TheNews({ call }: { call: CallWithEvent }) {
  if (!call.headline && !call.source_url) return null

  const url = call.source_url ?? call.url
  const host = hostOf(url)

  return (
    <section className="panel">
      <h2>The news it came from</h2>
      <div className="panel__body">
        <dl className="rows">
          {call.headline ? (
            <>
              <dt className="field">Headline</dt>
              <dd>
                <figure className="source">
                  <blockquote className="source__headline">{call.headline}</blockquote>
                  <figcaption className="source__meta">
                    {[call.source, humanise(call.event_type)].filter(Boolean).join(' · ') ||
                      'unattributed'}
                    {call.published_at ? ` · ${fmtTerm(call.published_at)}` : null}
                  </figcaption>
                </figure>
              </dd>
            </>
          ) : null}

          {call.triage_reason ? (
            <>
              <dt className="field">Triage</dt>
              <dd>{call.triage_reason}</dd>
            </>
          ) : null}

          {url ? (
            <>
              <dt className="field">Source</dt>
              <dd>
                <a href={url} rel="noopener noreferrer nofollow" target="_blank">
                  {host || 'open the original'}
                </a>
              </dd>
            </>
          ) : null}
        </dl>
      </div>
    </section>
  )
}

function Outcome({ call }: { call: CallWithEvent }) {
  if (call.status === 'open') {
    const window = catalystWindow(call.catalyst_by)
    return (
      <p>
        Opened {fmtTerm(call.entry_at)}, {ago(call.entry_at)}.{' '}
        {window.state === 'past'
          ? 'Its catalyst date has passed; the weekly scoring job settles it on the next run.'
          : 'It is scored once its catalyst date passes.'}
      </p>
    )
  }

  const verdict =
    call.status === 'won'
      ? 'It went the way the thesis said.'
      : call.status === 'lost'
        ? 'It went the other way.'
        : 'The window shut and the price went nowhere.'

  return (
    <p>
      {verdict} Settled {fmtTerm(call.resolved_at)} at{' '}
      <span className={call.status === 'won' ? 'up' : call.status === 'lost' ? 'down' : 'flat'}>
        {fmtPct(call.return_pct)}
      </span>{' '}
      from the price on the day it was opened.
    </p>
  )
}

function PriorCall({ call }: { call: Call }) {
  return (
    <>
      <dt className="field">{fmtTerm(call.entry_at)}</dt>
      <dd>
        <Link href={`/calls/${call.id}`}>{call.direction}</Link>
        {' — '}
        {call.status === 'open' ? (
          <span className="flat">still open</span>
        ) : (
          <span
            className={
              call.status === 'won' ? 'up' : call.status === 'lost' ? 'down' : 'flat'
            }
          >
            {fmtPct(call.return_pct)}
          </span>
        )}
      </dd>
    </>
  )
}

/**
 * `event_type` is a snake_case enum the triage model picks — 'product_launch',
 * 'trial_result'. It is written for the pipeline, so it is unwritten here.
 */
function humanise(value: string | null): string | null {
  return value ? value.replace(/_/g, ' ') : null
}
