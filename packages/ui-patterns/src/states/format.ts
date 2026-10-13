/**
 * Small formatting helpers of the state, badge and record components. They are
 * pure and take the current time as an argument, so a render is deterministic
 * (a component passes a `now` prop or the shared clock of `use-now.ts`).
 */

/** A point in time: a `Date`, epoch milliseconds or an ISO 8601 string. */
export type NowInput = Date | number | string

const SECOND = 1_000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** Epoch milliseconds of a `NowInput`; `NaN` for text that is not a date. */
export function toMillis(input: NowInput): number {
  if (typeof input === 'number') return input
  if (input instanceof Date) return input.getTime()
  return Date.parse(input)
}

export interface AgeOptions {
  /** Show seconds below one minute ("12 s ago") instead of "just now". Default false. */
  readonly seconds?: boolean
}

/**
 * How long ago something was observed, in the short form the UI shows next to
 * a source ("4 min ago"). Returns `undefined` when either time is not a date,
 * so the caller can say the time is unknown instead of inventing one. A time
 * more than five minutes ahead of the clock is reported as such (a device
 * clock that is wrong must not be hidden as "just now").
 */
export function formatAge(
  observedAt: string,
  now: NowInput,
  options: AgeOptions = {},
): string | undefined {
  const observed = Date.parse(observedAt)
  const current = toMillis(now)
  if (Number.isNaN(observed) || Number.isNaN(current)) return undefined
  const diff = current - observed
  if (diff < -5 * MINUTE) return 'dated in the future'
  if (diff < (options.seconds === true ? 5 * SECOND : MINUTE)) return 'just now'
  if (diff < MINUTE) return `${Math.floor(diff / SECOND)} s ago`
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} min ago`
  if (diff < DAY) return `${Math.floor(diff / HOUR)} h ago`
  return `${Math.floor(diff / DAY)} d ago`
}

/**
 * An absolute time in UTC, `2026-10-13 14:03 UTC`, or `undefined` when the text
 * is not a date in the years 0000 to 9999. UTC and a fixed shape keep the text
 * stable across locales and test runs.
 */
export function formatUtc(observedAt: string): string | undefined {
  const parsed = Date.parse(observedAt)
  if (Number.isNaN(parsed)) return undefined
  const iso = new Date(parsed).toISOString()
  if (!/^\d{4}-/.test(iso)) return undefined
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`
}

/** The normalized ISO 8601 text for a `<time dateTime>` attribute, or `undefined`. */
export function toIso(observedAt: string): string | undefined {
  const parsed = Date.parse(observedAt)
  if (Number.isNaN(parsed)) return undefined
  const iso = new Date(parsed).toISOString()
  return /^\d{4}-/.test(iso) ? iso : undefined
}

const COUNT_FORMAT = new Intl.NumberFormat('en-US')

/** A count with thousands separators (`12,345`); `unknown` for a value that is not a finite number. */
export function formatCount(value: number): string {
  return Number.isFinite(value) ? COUNT_FORMAT.format(value) : 'unknown'
}
