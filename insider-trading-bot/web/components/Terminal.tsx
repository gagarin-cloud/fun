import Link from 'next/link'

import { Nav } from './Nav'
import { fmtPct } from '@/lib/format'
import { getOpenCalls, getScoreboard, type CallWithEvent } from '@/lib/queries'
import { read } from '@/lib/read'

/**
 * The terminal chrome: the status bar and the tape, on every page.
 *
 * Both halves come from one `read()` rather than two, so a page costs the same
 * number of round trips as it did before the chrome existed. It renders around a
 * database failure instead of through it — the tape says the book is unavailable
 * and the page below explains why properly, which is better than a header that
 * throws and takes the explanation with it.
 */
export async function TerminalHeader() {
  const result = await read(async () => {
    const [calls, numbers] = await Promise.all([getOpenCalls(), getScoreboard()])
    return { calls, numbers }
  })

  const calls = result.ok ? result.data.calls : []
  const numbers = result.ok ? result.data.numbers : null
  const hitRate =
    numbers && numbers.resolved > 0 ? Math.round((numbers.won / numbers.resolved) * 100) : null

  // The page is server-rendered per request, so this is genuinely the moment the
  // rows were read — which is the only honest thing an "as of" can mean here.
  const asOf = new Date().toISOString().slice(11, 16)

  return (
    <>
      <header className="term-head">
        <div className="term-head__bar">
          <p className="term-head__mark">
            <Link href="/">Insider Terminal</Link>
          </p>

          <div className="term-head__status">
            <span>
              Open <b>{numbers ? numbers.open : '—'}</b>
            </span>
            <span aria-hidden="true">│</span>
            <span>
              Hit <b>{hitRate === null ? '—' : `${hitRate}%`}</b>
            </span>
            <span aria-hidden="true">│</span>
            <span>
              Mean{' '}
              <b className={toneOf(numbers?.meanReturn ?? null)}>
                {fmtPct(numbers?.meanReturn ?? null)}
              </b>
            </span>
            <span aria-hidden="true">│</span>
            <span>As of {asOf} UTC</span>
          </div>

          <span className="term-head__spacer" />
          <Nav />
        </div>
      </header>

      <Tape calls={calls} available={result.ok} />
    </>
  )
}

/**
 * The open book, running.
 *
 * The one piece of unprompted motion on the site, and the only element that
 * shows every position at once — a tape is what this product would be if it were
 * a physical instrument, so here the motion is the subject rather than
 * decoration. `prefers-reduced-motion` stops it and lets it be scrolled by hand
 * instead (globals.css).
 */
function Tape({ calls, available }: { calls: CallWithEvent[]; available: boolean }) {
  if (calls.length === 0) {
    return (
      <div className="tape">
        <span className="tape__empty">{available ? 'No open positions' : 'Book unavailable'}</span>
      </div>
    )
  }

  // How wide one pass of the book is, roughly — enough to decide two things that
  // cannot be known from CSS alone.
  //
  // A tape of seven tickers is narrower than a desktop viewport, so animating a
  // single duplicate would drag a visible empty stretch across the screen once
  // per cycle. Instead the list is repeated until several copies together
  // out-measure any plausible screen, and the keyframe travels exactly one copy.
  // The duration is derived from the same width so the tape moves at a constant
  // speed whether the book holds two positions or twenty.
  const passWidth = calls.reduce((w, c) => w + c.ticker.length * 10 + 64, 0)
  const copies = Math.max(2, Math.ceil(3200 / Math.max(passWidth, 1)) + 1)
  const seconds = Math.max(12, Math.round(passWidth / 40))

  const items = calls.map((call) => (
    <span className="tape__item" key={call.id}>
      <span className="tape__ticker">{call.ticker}</span>
      <span className={call.direction === 'long' ? 'up' : 'down'}>
        {call.direction === 'long' ? '▲' : '▼'}
        <span className="visually-hidden"> {call.direction}, </span>
      </span>
      <span className="tape__conv">
        {call.conviction}
        <span className="visually-hidden"> out of 10 conviction</span>
      </span>
    </span>
  ))

  return (
    <div className="tape">
      {/*
        The book, repeated. Only the first copy is exposed to assistive
        technology — a screen reader should hear the positions once.
      */}
      <div
        className="tape__track"
        style={
          {
            '--tape-copies': copies,
            animationDuration: `${seconds}s`,
          } as React.CSSProperties
        }
      >
        {Array.from({ length: copies }, (_, i) => (
          // Only the first pass is read out; the rest are the same book again.
          <span key={i} style={{ display: 'inline-flex' }} aria-hidden={i > 0 || undefined}>
            {items}
          </span>
        ))}
      </div>
    </div>
  )
}

function toneOf(pct: number | null): string | undefined {
  if (pct === null) return undefined
  return pct > 0 ? 'up' : pct < 0 ? 'down' : undefined
}
