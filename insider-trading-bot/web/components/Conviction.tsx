/**
 * Conviction, 1-10, as ten filled blocks.
 *
 * A percentage bar would read as a probability. It is not one: it is the model's
 * own ordinal score out of ten, and ten discrete blocks say so — you can count
 * them, and counting is the honest gesture for a number this soft.
 */
export function Conviction({ value }: { value: number }) {
  const filled = Math.max(0, Math.min(10, Math.round(value)))
  return (
    <span className="gauge">
      <span className="field">Conv</span>
      <span className="gauge__blocks" aria-hidden="true">
        {'█'.repeat(filled)}
        <span className="off">{'█'.repeat(10 - filled)}</span>
      </span>
      <span className="gauge__value">
        {value}<span aria-hidden="true">/10</span>
        <span className="visually-hidden"> out of 10</span>
      </span>
    </span>
  )
}
