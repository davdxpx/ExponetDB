import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  forgetRecentTargets,
  pruneRecentTargets,
  RECENT_TARGETS_MAX,
  RECENT_TARGETS_PREFIX,
  readRecentTargets,
  rememberTarget,
} from '../../src/features/target/recent.ts'

const ME = 'idn_01JZ0000000000000000000001'
const OTHER = 'idn_01JZ0000000000000000000002'

beforeEach(() => window.localStorage.clear())
afterEach(() => {
  vi.restoreAllMocks()
  window.localStorage.clear()
})

describe('the recent databases kept in this browser', () => {
  it('puts the newest first, once each, and keeps five', () => {
    for (const env of ['a', 'b', 'c', 'd', 'e', 'f']) rememberTarget(ME, `shop/platform/${env}`)
    expect(readRecentTargets(ME)).toEqual([
      'shop/platform/f',
      'shop/platform/e',
      'shop/platform/d',
      'shop/platform/c',
      'shop/platform/b',
    ])
    expect(readRecentTargets(ME)).toHaveLength(RECENT_TARGETS_MAX)
    rememberTarget(ME, 'shop/platform/c')
    expect(readRecentTargets(ME)[0]).toBe('shop/platform/c')
    expect(new Set(readRecentTargets(ME)).size).toBe(5)
  })

  it('keeps one list per person, under the key of that person', () => {
    rememberTarget(ME, 'shop/platform/staging')
    rememberTarget(OTHER, 'billing/api/production')
    expect(readRecentTargets(ME)).toEqual(['shop/platform/staging'])
    expect(readRecentTargets(OTHER)).toEqual(['billing/api/production'])
    expect(window.localStorage.getItem(`${RECENT_TARGETS_PREFIX}${ME}`)).toBe(
      '["shop/platform/staging"]',
    )
  })

  it('stores a path only when it is three slugs', () => {
    for (const path of [
      '',
      'shop',
      '<script>',
      'shop/platform/staging/extra',
      'Shop/a/b',
      '../x/y',
    ]) {
      rememberTarget(ME, path)
    }
    expect(readRecentTargets(ME)).toEqual([])
    expect(window.localStorage.length).toBe(0)
  })

  it('refuses an identity that could change the shape of the key', () => {
    rememberTarget('idn_x.shop', 'shop/platform/staging')
    rememberTarget('', 'shop/platform/staging')
    rememberTarget('a'.repeat(200), 'shop/platform/staging')
    expect(window.localStorage.length).toBe(0)
    expect(readRecentTargets('idn_x.shop')).toEqual([])
  })

  it('reads back only valid paths from storage that holds anything else', () => {
    const key = `${RECENT_TARGETS_PREFIX}${ME}`
    window.localStorage.setItem(
      key,
      JSON.stringify(['shop/platform/staging', 7, null, '<img src=x>', 'shop/platform/staging']),
    )
    expect(readRecentTargets(ME)).toEqual(['shop/platform/staging'])
    window.localStorage.setItem(key, '{"not":"a list"}')
    expect(readRecentTargets(ME)).toEqual([])
    window.localStorage.setItem(key, 'not json')
    expect(readRecentTargets(ME)).toEqual([])
  })

  it('forgets every list of any person on sign-out, and nothing else', () => {
    rememberTarget(ME, 'shop/platform/staging')
    rememberTarget(OTHER, 'billing/api/production')
    window.localStorage.setItem('exdb.sidebar.mode', 'open')
    window.localStorage.setItem(`exdb.sql.tabs.${ME}.tgt_1`, '{}')
    forgetRecentTargets()
    expect(readRecentTargets(ME)).toEqual([])
    expect(readRecentTargets(OTHER)).toEqual([])
    expect(window.localStorage.getItem('exdb.sidebar.mode')).toBe('open')
    expect(window.localStorage.getItem(`exdb.sql.tabs.${ME}.tgt_1`)).toBe('{}')
  })

  it('prunes the lists of every other person and keeps the own', () => {
    rememberTarget(ME, 'shop/platform/staging')
    rememberTarget(OTHER, 'billing/api/production')
    pruneRecentTargets(ME)
    expect(readRecentTargets(ME)).toEqual(['shop/platform/staging'])
    expect(readRecentTargets(OTHER)).toEqual([])
  })

  it('tolerates storage that throws, and shows nothing', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('full')
    })
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    expect(() => rememberTarget(ME, 'shop/platform/staging')).not.toThrow()
    expect(readRecentTargets(ME)).toEqual([])
    expect(() => forgetRecentTargets()).not.toThrow()
    expect(() => pruneRecentTargets(ME)).not.toThrow()
  })

  it('tolerates storage that cannot be reached at all', () => {
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new Error('SecurityError')
    })
    expect(() => rememberTarget(ME, 'shop/platform/staging')).not.toThrow()
    expect(readRecentTargets(ME)).toEqual([])
    expect(() => forgetRecentTargets()).not.toThrow()
  })
})
