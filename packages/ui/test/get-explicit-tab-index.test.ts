import { describe, expect, it } from 'vitest'

import { getExplicitTabIndex } from '../src/lib/get-explicit-tab-index.ts'

describe('getExplicitTabIndex', () => {
  it('puts an enabled control in the tab order', () => {
    expect(getExplicitTabIndex(undefined)).toBe(0)
    expect(getExplicitTabIndex(undefined, false)).toBe(0)
    expect(getExplicitTabIndex(undefined, null)).toBe(0)
  })

  it('takes a disabled control out of the tab order', () => {
    expect(getExplicitTabIndex(undefined, true)).toBe(-1)
  })

  it('lets an explicit tabIndex win, also zero on a disabled control', () => {
    expect(getExplicitTabIndex(-1, false)).toBe(-1)
    expect(getExplicitTabIndex(3, true)).toBe(3)
    expect(getExplicitTabIndex(0, true)).toBe(0)
  })
})
