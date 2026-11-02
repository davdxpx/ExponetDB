import { describe, expect, it } from 'vitest'
import { baselineSetHint } from './support/visual-hint.ts'

/** TC-054 (VC-131): a pixel difference against the default set is not read as a regression. */
describe('the hint of a failing visual comparison', () => {
  it('says the default set matches only the machine that recorded it, and how to get a real set', () => {
    const hint = baselineSetHint('local', false)
    expect(hint).toContain('default `local`')
    expect(hint).toContain('only the machine that recorded it')
    expect(hint).toContain('EXDB_VISUAL_BASELINE_SET=ci-ubuntu-24.04')
    expect(hint).toContain('EXDB_UPDATE_VISUAL=1')
  })

  it('only names the set when the person chose it', () => {
    expect(baselineSetHint('ci-ubuntu-24.04', true)).toBe(
      'Compared against the baseline set `ci-ubuntu-24.04`.',
    )
  })
})
