import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  readTargetsPreferences,
  TARGETS_SORT_KEY,
  TARGETS_VIEW_KEY,
  writeTargetsPreferences,
} from '../../src/lib/preferences/targets.ts'

afterEach(() => {
  vi.restoreAllMocks()
  window.localStorage.clear()
})

describe('the remembered view and sort of the targets list', () => {
  it('reads nothing from an empty browser', () => {
    expect(readTargetsPreferences()).toEqual({ view: undefined, sort: undefined })
  })

  it('writes what it is given and reads it back', () => {
    expect(writeTargetsPreferences({ view: 'grid' })).toEqual({ view: 'grid', sort: undefined })
    expect(writeTargetsPreferences({ sort: 'health' })).toEqual({ view: 'grid', sort: 'health' })
    expect(window.localStorage.getItem(TARGETS_VIEW_KEY)).toBe('grid')
    expect(window.localStorage.getItem(TARGETS_SORT_KEY)).toBe('health')
  })

  it('ignores a stored value that is not a known word', () => {
    window.localStorage.setItem(TARGETS_VIEW_KEY, 'iframe')
    window.localStorage.setItem(TARGETS_SORT_KEY, '__proto__')
    expect(readTargetsPreferences()).toEqual({ view: undefined, sort: undefined })
  })

  it('never throws when storage throws, and reports what the browser still holds', () => {
    window.localStorage.setItem(TARGETS_VIEW_KEY, 'grid')
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    expect(writeTargetsPreferences({ view: 'table', sort: 'tier' })).toEqual({
      view: 'grid',
      sort: undefined,
    })
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    expect(readTargetsPreferences()).toEqual({ view: undefined, sort: undefined })
  })
})
