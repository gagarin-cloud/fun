import { describe, it, expect } from 'vitest'
import { returnPct, classify, WIN_THRESHOLD_PCT, LOSS_THRESHOLD_PCT } from './score.js'

describe('returnPct', () => {
  it('measures a long in the obvious direction', () => {
    expect(returnPct('long', 100, 110)).toBeCloseTo(10)
    expect(returnPct('long', 100, 90)).toBeCloseTo(-10)
  })

  it('inverts for a short, so a falling stock is a positive return', () => {
    expect(returnPct('short', 100, 90)).toBeCloseTo(10)
    expect(returnPct('short', 100, 110)).toBeCloseTo(-10)
  })

  it('handles non-round entry prices', () => {
    expect(returnPct('long', 37.5, 41.25)).toBeCloseTo(10)
  })
})

describe('classify', () => {
  it('marks a win at or above the threshold', () => {
    expect(classify(WIN_THRESHOLD_PCT)).toBe('won')
    expect(classify(25)).toBe('won')
  })

  it('marks a loss at or below the threshold', () => {
    expect(classify(LOSS_THRESHOLD_PCT)).toBe('lost')
    expect(classify(-30)).toBe('lost')
  })

  it('marks anything in between as expired rather than a win or loss', () => {
    expect(classify(0)).toBe('expired')
    expect(classify(7.9)).toBe('expired')
    expect(classify(-7.9)).toBe('expired')
  })
})
