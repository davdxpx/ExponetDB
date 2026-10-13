import { describe, expect, it } from 'vitest'

import { formatAge, formatCount, formatUtc, toIso, toMillis } from '../../src/states/format.ts'

const NOW = Date.parse('2026-10-13T14:10:00Z')

describe('toMillis', () => {
  it('accepts a number, a Date and a string', () => {
    expect(toMillis(5)).toBe(5)
    expect(toMillis(new Date(7))).toBe(7)
    expect(toMillis('2026-10-13T14:10:00Z')).toBe(NOW)
  })

  it('returns NaN for text that is not a date', () => {
    expect(Number.isNaN(toMillis('not a date'))).toBe(true)
  })
})

describe('formatAge', () => {
  it('says "just now" below a minute', () => {
    expect(formatAge('2026-10-13T14:09:30Z', NOW)).toBe('just now')
    expect(formatAge('2026-10-13T14:10:00Z', NOW)).toBe('just now')
  })

  it('counts minutes, hours and days, rounding down', () => {
    expect(formatAge('2026-10-13T14:06:00Z', NOW)).toBe('4 min ago')
    expect(formatAge('2026-10-13T14:06:59Z', NOW)).toBe('3 min ago')
    expect(formatAge('2026-10-13T12:10:00Z', NOW)).toBe('2 h ago')
    expect(formatAge('2026-10-10T14:10:00Z', NOW)).toBe('3 d ago')
  })

  it('shows seconds when asked', () => {
    expect(formatAge('2026-10-13T14:09:48Z', NOW, { seconds: true })).toBe('12 s ago')
    expect(formatAge('2026-10-13T14:09:58Z', NOW, { seconds: true })).toBe('just now')
    expect(formatAge('2026-10-13T14:08:00Z', NOW, { seconds: true })).toBe('2 min ago')
  })

  it('does not hide a time far in the future behind "just now"', () => {
    expect(formatAge('2026-10-13T14:12:00Z', NOW)).toBe('just now')
    expect(formatAge('2026-10-13T15:10:00Z', NOW)).toBe('dated in the future')
  })

  it('returns undefined when either time is not a date', () => {
    expect(formatAge('yesterday', NOW)).toBeUndefined()
    expect(formatAge('2026-10-13T14:10:00Z', 'now')).toBeUndefined()
  })
})

describe('formatUtc and toIso', () => {
  it('writes a fixed UTC shape', () => {
    expect(formatUtc('2026-10-13T14:03:22.500Z')).toBe('2026-10-13 14:03 UTC')
    expect(formatUtc('2026-10-13T16:03:00+02:00')).toBe('2026-10-13 14:03 UTC')
    expect(toIso('2026-10-13T16:03:00+02:00')).toBe('2026-10-13T14:03:00.000Z')
  })

  it('returns undefined for text that is not a date', () => {
    expect(formatUtc('soon')).toBeUndefined()
    expect(toIso('')).toBeUndefined()
  })

  it('returns undefined for a year outside 0000 to 9999', () => {
    expect(formatUtc('+275760-09-13T00:00:00.000Z')).toBeUndefined()
    expect(toIso('+275760-09-13T00:00:00.000Z')).toBeUndefined()
  })
})

describe('formatCount', () => {
  it('groups thousands', () => {
    expect(formatCount(1204)).toBe('1,204')
    expect(formatCount(0)).toBe('0')
  })

  it('says unknown for a value that is not a finite number', () => {
    expect(formatCount(Number.NaN)).toBe('unknown')
    expect(formatCount(Number.POSITIVE_INFINITY)).toBe('unknown')
  })
})
