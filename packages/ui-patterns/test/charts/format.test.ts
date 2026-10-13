import { describe, expect, it } from 'vitest'
import {
  formatAge,
  formatCompact,
  formatDateTime,
  formatNumber,
  formatTick,
  isDrawable,
  parseTime,
  sourceLabel,
  withoutClosingPeriod,
} from '../../src/charts/format.ts'

describe('parseTime', () => {
  it('reads ISO 8601 times with an explicit offset', () => {
    expect(parseTime('2026-10-13T09:05:00Z')).toBe(Date.UTC(2026, 9, 13, 9, 5))
    expect(parseTime('2026-10-13T11:05:00+02:00')).toBe(Date.UTC(2026, 9, 13, 9, 5))
    expect(parseTime('2026-10-13T09:05:00.250Z')).toBe(Date.UTC(2026, 9, 13, 9, 5, 0, 250))
  })

  it('refuses a time without an offset instead of reading it as local time', () => {
    expect(parseTime('2026-10-13T09:05:00')).toBeNaN()
    expect(parseTime('2026-10-13')).toBeNaN()
    expect(parseTime('yesterday')).toBeNaN()
    expect(parseTime('')).toBeNaN()
  })
})

describe('numbers', () => {
  it('groups digits and keeps at most two decimals', () => {
    expect(formatNumber(1234567.891)).toBe('1,234,567.89')
    expect(formatNumber(0)).toBe('0')
  })

  it('shortens large numbers for axes', () => {
    expect(formatCompact(1200)).toBe('1.2K')
    expect(formatCompact(3_400_000)).toBe('3.4M')
  })

  it('draws only finite numbers', () => {
    expect(isDrawable(0)).toBe(true)
    expect(isDrawable(-3)).toBe(true)
    expect(isDrawable(null)).toBe(false)
    expect(isDrawable(undefined)).toBe(false)
    expect(isDrawable(Number.NaN)).toBe(false)
    expect(isDrawable(Number.POSITIVE_INFINITY)).toBe(false)
  })
})

describe('times', () => {
  const at = Date.UTC(2026, 9, 13, 9, 41)

  it('formats a time with its zone', () => {
    expect(formatDateTime(at, 'UTC')).toBe('Oct 13, 09:41 UTC')
  })

  it('applies another zone when asked', () => {
    expect(formatDateTime(at, 'Europe/Berlin')).toMatch(/^Oct 13, 11:41 /)
  })

  it('falls back to UTC for a zone it does not know', () => {
    expect(formatDateTime(at, 'Not/AZone')).toBe('Oct 13, 09:41 UTC')
  })

  it('labels ticks with the clock for a short span and the day for a long one', () => {
    expect(formatTick(at, 60 * 60 * 1000, 'UTC')).toBe('09:41')
    expect(formatTick(at, 3 * 24 * 60 * 60 * 1000, 'UTC')).toBe('Oct 13')
  })
})

describe('formatAge', () => {
  const now = Date.UTC(2026, 9, 13, 10, 0, 0)

  it('says how long ago something was observed', () => {
    expect(formatAge(now - 3_000, now)).toBe('just now')
    expect(formatAge(now - 30_000, now)).toBe('30 seconds ago')
    expect(formatAge(now - 60_000, now)).toBe('1 minute ago')
    expect(formatAge(now - 4 * 60_000, now)).toBe('4 minutes ago')
    expect(formatAge(now - 3 * 3_600_000, now)).toBe('3 hours ago')
    expect(formatAge(now - 3 * 86_400_000, now)).toBe('3 days ago')
  })

  it('never reports a time in the future', () => {
    expect(formatAge(now + 60_000, now)).toBe('just now')
  })
})

describe('words', () => {
  it('names every source', () => {
    expect(sourceLabel('live')).toBe('Read just now')
    expect(sourceLabel('sampled')).toBe('Sampled')
    expect(sourceLabel('cached')).toBe('Cached')
    expect(sourceLabel('agent_reported')).toBe('Reported by the node agent')
    expect(sourceLabel('inferred')).toBe('Inferred from other observations')
  })

  it('drops the closing period of a catalog message', () => {
    expect(withoutClosingPeriod('The agent did not answer.')).toBe('The agent did not answer')
    expect(withoutClosingPeriod('The agent did not answer')).toBe('The agent did not answer')
    expect(withoutClosingPeriod('Timed out...  ')).toBe('Timed out')
  })
})
