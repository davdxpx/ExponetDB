/**
 * Time formatting for `TimestampInfo` without a date library: `Date` for the instant,
 * `Intl.DateTimeFormat` for the zone arithmetic and `Intl.RelativeTimeFormat` for ages.
 * Every function is pure; "now" is always an argument, so a test never depends on the clock.
 */

export type InstantInput = string | number | Date

/** How much of the time a label shows. */
export type TimestampPrecision = 'date' | 'minute' | 'second'

const NO_ZONE_DESIGNATOR = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/

/**
 * The instant a value stands for, or `undefined` when it is none. A string is ISO 8601; one
 * without a zone designator is read as UTC (the contracts carry UTC instants), never as the
 * viewer's local time. A number is epoch milliseconds.
 */
export function parseInstant(value: InstantInput): Date | undefined {
  let date: Date
  if (value instanceof Date) {
    date = new Date(value.getTime())
  } else if (typeof value === 'number') {
    date = new Date(value)
  } else {
    const text = value.trim()
    date = new Date(NO_ZONE_DESIGNATOR.test(text) ? `${text.replace(' ', 'T')}Z` : text)
  }
  return Number.isNaN(date.getTime()) ? undefined : date
}

/** True when `Intl` knows the IANA time zone. */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone })
    return true
  } catch {
    return false
  }
}

/** The viewer's own IANA time zone. */
export function browserTimeZone(): string {
  return new Intl.DateTimeFormat().resolvedOptions().timeZone
}

/** The zone to render in: the one asked for when `Intl` knows it, else the viewer's own. */
export function resolveTimeZone(requested: string | undefined): string {
  return requested !== undefined && isValidTimeZone(requested) ? requested : browserTimeZone()
}

/**
 * `13 Oct 2026 14:03:22` in the zone, with a 24-hour clock. The parts are assembled here
 * because the separators `Intl` puts between them differ between ICU versions.
 */
export function formatAbsolute(
  date: Date,
  timeZone: string,
  precision: TimestampPrecision = 'second',
): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? ''
  const day = `${part('day')} ${part('month')} ${part('year')}`
  if (precision === 'date') return day
  const minutes = `${day} ${part('hour')}:${part('minute')}`
  return precision === 'minute' ? minutes : `${minutes}:${part('second')}`
}

const RELATIVE_UNITS: readonly (readonly [Intl.RelativeTimeFormatUnit, number])[] = [
  ['year', 365 * 86_400],
  ['month', 30 * 86_400],
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60],
]

/** "4 minutes ago", "in 2 hours", "now": whole units, truncated toward zero. */
export function formatRelative(date: Date, now: Date): string {
  const formatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })
  const seconds = Math.trunc((date.getTime() - now.getTime()) / 1000)
  const magnitude = Math.abs(seconds)
  for (const [unit, size] of RELATIVE_UNITS) {
    if (magnitude >= size) return formatter.format(Math.trunc(seconds / size), unit)
  }
  return formatter.format(seconds, 'second')
}
