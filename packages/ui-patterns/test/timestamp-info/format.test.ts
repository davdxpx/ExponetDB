import { describe, expect, it } from 'vitest'

import {
  formatAbsolute,
  formatRelative,
  isValidTimeZone,
  parseInstant,
  resolveTimeZone,
} from '../../src/timestamp-info/format.ts'

describe('parseInstant', () => {
  it('reads an ISO 8601 string with a zone designator', () => {
    expect(parseInstant('2026-10-13T14:03:22Z')?.toISOString()).toBe('2026-10-13T14:03:22.000Z')
    expect(parseInstant('2026-10-13T16:03:22+02:00')?.toISOString()).toBe(
      '2026-10-13T14:03:22.000Z',
    )
  })

  it('reads a string without a zone designator as UTC, never as local time', () => {
    expect(parseInstant('2026-10-13T14:03:22')?.toISOString()).toBe('2026-10-13T14:03:22.000Z')
    expect(parseInstant('2026-10-13 14:03:22.5')?.toISOString()).toBe('2026-10-13T14:03:22.500Z')
    expect(parseInstant('2026-10-13T14:03')?.toISOString()).toBe('2026-10-13T14:03:00.000Z')
  })

  it('reads a number as epoch milliseconds and keeps a Date as it is', () => {
    expect(parseInstant(1_760_364_202_000)?.toISOString()).toBe('2025-10-13T14:03:22.000Z')
    const date = new Date('2026-01-01T00:00:00Z')
    expect(parseInstant(date)?.getTime()).toBe(date.getTime())
  })

  it('returns undefined for a value that is no instant', () => {
    expect(parseInstant('yesterday')).toBeUndefined()
    expect(parseInstant('')).toBeUndefined()
    expect(parseInstant(Number.NaN)).toBeUndefined()
    expect(parseInstant(new Date('nope'))).toBeUndefined()
  })
})

describe('time zones', () => {
  it('knows valid IANA zones and refuses others', () => {
    expect(isValidTimeZone('Europe/Berlin')).toBe(true)
    expect(isValidTimeZone('UTC')).toBe(true)
    expect(isValidTimeZone('Mars/Olympus')).toBe(false)
  })

  it('resolves a requested zone, or the viewer zone for a zone Intl does not know', () => {
    expect(resolveTimeZone('Asia/Tokyo')).toBe('Asia/Tokyo')
    const fallback = resolveTimeZone('Mars/Olympus')
    expect(isValidTimeZone(fallback)).toBe(true)
    expect(resolveTimeZone(undefined)).toBe(fallback)
  })
})

describe('formatAbsolute', () => {
  const instant = new Date('2026-10-13T14:03:22Z')

  it('formats day, month name, year and a 24-hour clock', () => {
    expect(formatAbsolute(instant, 'UTC')).toBe('13 Oct 2026 14:03:22')
  })

  it('moves the instant into the zone, including daylight saving time', () => {
    expect(formatAbsolute(instant, 'Europe/Berlin')).toBe('13 Oct 2026 16:03:22')
    expect(formatAbsolute(new Date('2026-01-13T14:03:22Z'), 'Europe/Berlin')).toBe(
      '13 Jan 2026 15:03:22',
    )
    expect(formatAbsolute(instant, 'Asia/Tokyo')).toBe('13 Oct 2026 23:03:22')
  })

  it('rolls the date over with the zone', () => {
    expect(formatAbsolute(new Date('2026-10-13T23:30:00Z'), 'Asia/Tokyo')).toBe(
      '14 Oct 2026 08:30:00',
    )
  })

  it('writes midnight as 00, not 24', () => {
    expect(formatAbsolute(new Date('2026-10-13T00:05:09Z'), 'UTC')).toBe('13 Oct 2026 00:05:09')
  })

  it('cuts the label to the precision asked for', () => {
    expect(formatAbsolute(instant, 'UTC', 'minute')).toBe('13 Oct 2026 14:03')
    expect(formatAbsolute(instant, 'UTC', 'date')).toBe('13 Oct 2026')
  })
})

describe('formatRelative', () => {
  const now = new Date('2026-10-13T14:00:00Z')
  const ago = (seconds: number) => new Date(now.getTime() - seconds * 1000)

  it('says now for the same second', () => {
    expect(formatRelative(now, now)).toBe('now')
  })

  it('counts whole units back, truncated', () => {
    expect(formatRelative(ago(5), now)).toBe('5 seconds ago')
    expect(formatRelative(ago(59), now)).toBe('59 seconds ago')
    expect(formatRelative(ago(60), now)).toBe('1 minute ago')
    expect(formatRelative(ago(4 * 60 + 50), now)).toBe('4 minutes ago')
    expect(formatRelative(ago(3_599), now)).toBe('59 minutes ago')
    expect(formatRelative(ago(3 * 3_600), now)).toBe('3 hours ago')
    expect(formatRelative(ago(86_400), now)).toBe('yesterday')
    expect(formatRelative(ago(5 * 86_400), now)).toBe('5 days ago')
    expect(formatRelative(ago(45 * 86_400), now)).toBe('last month')
    expect(formatRelative(ago(2 * 365 * 86_400), now)).toBe('2 years ago')
  })

  it('counts forward for an instant in the future', () => {
    expect(formatRelative(new Date(now.getTime() + 2 * 3_600_000), now)).toBe('in 2 hours')
  })
})
