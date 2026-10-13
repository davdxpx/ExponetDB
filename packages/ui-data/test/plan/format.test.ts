import { describe, expect, it } from 'vitest'

import {
  expiryStatus,
  formatRemaining,
  formatSeconds,
  knownNumber,
  knownText,
  planActionAvailability,
} from '../../src/plan/format.ts'

describe('knownText', () => {
  it('treats missing, empty and the server word unknown as not known', () => {
    expect(knownText(null)).toBeUndefined()
    expect(knownText(undefined)).toBeUndefined()
    expect(knownText('')).toBeUndefined()
    expect(knownText('unknown')).toBeUndefined()
    expect(knownText('additive')).toBe('additive')
  })
})

describe('knownNumber', () => {
  it('keeps finite, non-negative numbers only', () => {
    expect(knownNumber(0)).toBe(0)
    expect(knownNumber(12)).toBe(12)
    expect(knownNumber(null)).toBeUndefined()
    expect(knownNumber(-1)).toBeUndefined()
    expect(knownNumber(Number.NaN)).toBeUndefined()
    expect(knownNumber(Number.POSITIVE_INFINITY)).toBeUndefined()
  })
})

describe('formatRemaining', () => {
  it('shows hours, minutes and seconds in a fixed shape', () => {
    expect(formatRemaining(3_900_000)).toBe('1 h 05 min')
    expect(formatRemaining(270_000)).toBe('4 min 30 s')
    expect(formatRemaining(45_000)).toBe('45 s')
    expect(formatRemaining(400)).toBe('less than 1 s')
  })
})

describe('formatSeconds', () => {
  it('uses the largest whole unit', () => {
    expect(formatSeconds(300)).toBe('5 min')
    expect(formatSeconds(90)).toBe('90 s')
    expect(formatSeconds(7_200)).toBe('2 h')
    expect(formatSeconds(-1)).toBe('not known')
  })
})

describe('expiryStatus', () => {
  const expires = '2026-10-13T14:15:00.000Z'

  it('is open before the expiry with the time remaining', () => {
    expect(expiryStatus(expires, '2026-10-13T14:10:30.000Z')).toEqual({
      kind: 'open',
      atMs: Date.parse(expires),
      remainingMs: 270_000,
    })
  })

  it('is expired at the expiry instant and after it', () => {
    expect(expiryStatus(expires, expires).kind).toBe('expired')
    expect(expiryStatus(expires, '2026-10-13T15:00:00.000Z').kind).toBe('expired')
  })

  it('is unknown without an expiry, with an unreadable one or with an unreadable clock', () => {
    expect(expiryStatus(null, 0).kind).toBe('unknown')
    expect(expiryStatus('soon', 0).kind).toBe('unknown')
    expect(expiryStatus(expires, 'not a date').kind).toBe('unknown')
  })
})

describe('planActionAvailability', () => {
  const open = expiryStatus('2026-10-13T14:15:00.000Z', '2026-10-13T14:00:00.000Z')
  const expired = expiryStatus('2026-10-13T14:15:00.000Z', '2026-10-13T14:15:00.000Z')

  it('offers the actions only for an active plan before its expiry from a current read', () => {
    expect(planActionAvailability({ state: 'active', expiry: open, stale: false })).toEqual({
      offered: true,
    })
  })

  it.each([
    ['consumed', /accepted/],
    ['expired', /expired/],
    ['invalidated', /stale/],
    ['denied', /denied/],
    ['withdrawn', /withdrawn/],
  ])('withholds the actions of a %s plan', (state, reason) => {
    const result = planActionAvailability({ state, expiry: open, stale: false })
    expect(result.offered).toBe(false)
    expect(result.offered ? '' : result.reason).toMatch(reason)
  })

  it('fails closed on an expired, unknown or stale plan', () => {
    expect(planActionAvailability({ state: 'active', expiry: expired, stale: false }).offered).toBe(
      false,
    )
    expect(
      planActionAvailability({ state: 'active', expiry: { kind: 'unknown' }, stale: false })
        .offered,
    ).toBe(false)
    expect(planActionAvailability({ state: null, expiry: open, stale: false }).offered).toBe(false)
    expect(planActionAvailability({ state: 'paused', expiry: open, stale: false }).offered).toBe(
      false,
    )
    expect(planActionAvailability({ state: 'active', expiry: open, stale: true }).offered).toBe(
      false,
    )
  })
})
