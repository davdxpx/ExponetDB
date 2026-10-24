import { describe, expect, it } from 'vitest'
import {
  dayString,
  HISTORY_MAX_DAYS,
  HISTORY_MAX_MS,
  HISTORY_RANGES,
  historyWindow,
  parseDay,
  pickableDays,
  selectionKey,
} from '../../src/features/target-overview/history-range.ts'

// A fixed moment in the local time zone of the machine: 2026-10-20 12:30:45.678.
const NOW = new Date(2026, 9, 20, 12, 30, 45, 678).getTime()
const HOUR = 3_600_000
const DAY = 24 * HOUR

describe('the presets', () => {
  it('end now, in whole seconds, and reach back the hours or days they name', () => {
    const second = Math.floor(NOW / 1_000) * 1_000
    expect(HISTORY_RANGES).toEqual(['1h', '6h', '24h', '7d', '14d'])
    for (const [range, ms] of [
      ['1h', HOUR],
      ['6h', 6 * HOUR],
      ['24h', DAY],
      ['7d', 7 * DAY],
      ['14d', 14 * DAY],
    ] as const) {
      const window = historyWindow({ kind: 'preset', range }, NOW)
      expect(window?.to.getTime()).toBe(second)
      expect(window?.from.getTime()).toBe(second - ms)
      expect(window?.clamped).toBe(false)
    }
  })

  it('never ends in the future, which the server refuses', () => {
    const window = historyWindow({ kind: 'preset', range: '1h' }, NOW)
    expect(window?.to.getTime()).toBeLessThanOrEqual(NOW)
  })

  it('stay within the 60 days the server serves', () => {
    for (const range of HISTORY_RANGES) {
      const window = historyWindow({ kind: 'preset', range }, NOW)
      expect((window?.to.getTime() ?? 0) - (window?.from.getTime() ?? 0)).toBeLessThanOrEqual(
        HISTORY_MAX_MS,
      )
    }
  })
})

describe('a custom range of whole days', () => {
  const custom = (fromDay: string, toDay: string) => ({ kind: 'custom', fromDay, toDay }) as const

  it('starts at the beginning of the first day and ends at the end of the last, in the local time zone', () => {
    const window = historyWindow(custom('2026-10-14', '2026-10-16'), NOW)
    expect(window?.from.getTime()).toBe(new Date(2026, 9, 14).getTime())
    expect(window?.to.getTime()).toBe(new Date(2026, 9, 17).getTime())
    expect(window?.clamped).toBe(false)
  })

  it('ends now when the last day is today, never later', () => {
    const second = Math.floor(NOW / 1_000) * 1_000
    const window = historyWindow(custom('2026-10-19', '2026-10-20'), NOW)
    expect(window?.from.getTime()).toBe(new Date(2026, 9, 19).getTime())
    expect(window?.to.getTime()).toBe(second)
  })

  it('is one day when the first and the last day are the same', () => {
    const window = historyWindow(custom('2026-10-10', '2026-10-10'), NOW)
    expect((window?.to.getTime() ?? 0) - (window?.from.getTime() ?? 0)).toBe(DAY)
  })

  it('is clamped to what the server serves, and says so', () => {
    const window = historyWindow(custom('2026-01-01', '2026-10-20'), NOW)
    expect(window?.clamped).toBe(true)
    const second = Math.floor(NOW / 1_000) * 1_000
    // Not further back than 60 days, with a margin for a clock that is a little behind.
    expect(second - (window?.from.getTime() ?? 0)).toBeLessThan(HISTORY_MAX_MS)
    expect(second - (window?.from.getTime() ?? 0)).toBeGreaterThan(HISTORY_MAX_MS - 10 * 60_000)
    expect((window?.to.getTime() ?? 0) - (window?.from.getTime() ?? 0)).toBeLessThanOrEqual(
      HISTORY_MAX_MS,
    )
  })

  it('is empty, and not sent, when the whole range lies before what the server serves', () => {
    expect(historyWindow(custom('2026-01-01', '2026-01-05'), NOW)).toBeUndefined()
  })

  it('is empty when it names a day that does not exist or ends before it starts', () => {
    expect(historyWindow(custom('2026-02-30', '2026-10-01'), NOW)).toBeUndefined()
    expect(historyWindow(custom('2026-10-16', '2026-10-14'), NOW)).toBeUndefined()
    expect(historyWindow(custom('yesterday', '2026-10-14'), NOW)).toBeUndefined()
    expect(historyWindow(custom('2026-10-14', '2026-10-14T00:00:00Z'), NOW)).toBeUndefined()
    // A day in the future is a range of nothing.
    expect(historyWindow(custom('2026-11-01', '2026-11-02'), NOW)).toBeUndefined()
  })
})

describe('days and keys', () => {
  it('writes and reads a local calendar day exactly', () => {
    expect(dayString(new Date(2026, 9, 5))).toBe('2026-10-05')
    expect(parseDay('2026-10-05')?.getTime()).toBe(new Date(2026, 9, 5).getTime())
    expect(parseDay('2026-13-05')).toBeUndefined()
    expect(parseDay('2026-10-5')).toBeUndefined()
    expect(parseDay('2024-02-29')).toBeDefined()
    expect(parseDay('2026-02-29')).toBeUndefined()
  })

  it('offers today and the days back within the limit, and no day after today', () => {
    const { min, max } = pickableDays(NOW)
    expect(max.getTime()).toBe(new Date(2026, 9, 20).getTime())
    expect(min.getTime()).toBe(new Date(2026, 9, 20 - (HISTORY_MAX_DAYS - 1)).getTime())
  })

  it('keys a choice by its kind and values', () => {
    expect(selectionKey({ kind: 'preset', range: '6h' })).toBe('preset:6h')
    expect(selectionKey({ kind: 'custom', fromDay: '2026-10-14', toDay: '2026-10-16' })).toBe(
      'custom:2026-10-14:2026-10-16',
    )
  })
})
