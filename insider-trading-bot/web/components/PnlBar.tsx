/**
 * A diverging bar: gain right of the centre line, loss left.
 *
 * Two things make it readable rather than decorative. It is drawn on a scale
 * shared by every row (`max`, the largest absolute return in the table), so the
 * rows compare against each other rather than each against itself. And the
 * signed number always sits beside it in text — the bar adds magnitude to a fact
 * the reader already has, so nothing is carried by colour alone, which is what
 * makes a red/green pair defensible at all.
 */
export function PnlBar({ pct, max }: { pct: number | null; max: number }) {
  if (pct === null || max <= 0) return <span className="pnl" aria-hidden="true" />

  // Half the track is one pole, so a full-scale return fills 50% of the width.
  const extent = Math.min(50, (Math.abs(pct) / max) * 50)
  const gain = pct >= 0

  return (
    <span className="pnl" aria-hidden="true">
      <span className="pnl__axis" />
      <span
        className="pnl__fill"
        style={{
          background: gain ? 'var(--up)' : 'var(--down)',
          left: gain ? '50%' : `${50 - extent}%`,
          width: `${extent}%`,
        }}
      />
    </span>
  )
}
