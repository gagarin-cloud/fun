import { chainSteps } from '@/lib/format'

/**
 * The second-order chain: the news event, the mechanism, then the company the
 * bot actually took a position in.
 *
 * This is the whole claim the project rests on, so it gets the one piece of
 * visual structure on the page — a ladder, each rung one remove further from the
 * story everyone already read, with only the last term lit. Run inline with
 * arrows between, the final term orphans onto its own line the moment the text
 * wraps, which reads as an accident rather than as the point.
 *
 * The model writes the chain either as arrows or as a sentence. Rendering a
 * one-step "chain" as a ladder would be a diagram of nothing, so prose stays
 * prose.
 */
export function Chain({ chain }: { chain: string | null }) {
  const steps = chainSteps(chain)
  if (steps.length === 0) return null

  if (steps.length === 1) {
    return <p className="chain chain--prose">{steps[0]}</p>
  }

  return (
    <ol className="chain">
      {steps.map((step, i) => (
        <li key={i} className="chain__link" style={{ marginLeft: `${i * 1.1}rem` }}>
          {i > 0 ? (
            <span className="chain__rule" aria-hidden="true">
              └▸
            </span>
          ) : null}
          <span>{step}</span>
        </li>
      ))}
    </ol>
  )
}
