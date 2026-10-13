import type { ReadSource } from '../readable.ts'

/**
 * Formatting of the chart family. Everything goes through `Intl` with a fixed
 * locale, so a rendered number or time is the same in every browser and in
 * every test (US English, design-system.md section 4).
 */
const LOCALE = 'en-US'

const fullNumber = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 2 })
const compactNumber = new Intl.NumberFormat(LOCALE, {
  notation: 'compact',
  maximumFractionDigits: 1,
})
const relative = new Intl.RelativeTimeFormat(LOCALE, { numeric: 'always' })

/** A number as text, with grouping and at most two decimals. */
export function formatNumber(value: number): string {
  return fullNumber.format(value)
}

/** A short number for axis ticks and narrow cells: 1.2K, 3.4M. */
export function formatCompact(value: number): string {
  return compactNumber.format(value)
}

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/

/**
 * Milliseconds since the epoch of an ISO 8601 time with an explicit offset, or
 * `NaN`. A time without an offset is refused instead of being read as local
 * time, so a chart never shifts data by the viewer's zone without saying so.
 */
export function parseTime(iso: string): number {
  return ISO_TIME.test(iso) ? Date.parse(iso) : Number.NaN
}

const zoneFormats = new Map<string, Intl.DateTimeFormat>()

function dateTimeFormat(timeZone: string, kind: 'full' | 'clock' | 'day'): Intl.DateTimeFormat {
  const key = `${kind}|${timeZone}`
  const cached = zoneFormats.get(key)
  if (cached !== undefined) return cached
  const options: Intl.DateTimeFormatOptions =
    kind === 'full'
      ? {
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          hourCycle: 'h23',
          timeZoneName: 'short',
        }
      : kind === 'clock'
        ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }
        : { month: 'short', day: 'numeric' }
  let format: Intl.DateTimeFormat
  try {
    format = new Intl.DateTimeFormat(LOCALE, { ...options, timeZone })
  } catch {
    format = new Intl.DateTimeFormat(LOCALE, { ...options, timeZone: 'UTC' })
  }
  zoneFormats.set(key, format)
  return format
}

/** `Oct 13, 09:41 UTC`: a time with its zone, for tooltips, tables and notes. */
export function formatDateTime(ms: number, timeZone: string): string {
  return dateTimeFormat(timeZone, 'full').format(ms)
}

/** An axis tick: the clock time for a short span, the day for a longer one. */
export function formatTick(ms: number, spanMs: number, timeZone: string): string {
  const DAY_AND_A_HALF = 36 * 60 * 60 * 1000
  return dateTimeFormat(timeZone, spanMs <= DAY_AND_A_HALF ? 'clock' : 'day').format(ms)
}

/** `4 minutes ago`, from the observation time and the current time (both in ms). */
export function formatAge(observedMs: number, nowMs: number): string {
  const seconds = Math.max(0, Math.round((nowMs - observedMs) / 1000))
  if (seconds < 10) return 'just now'
  if (seconds < 60) return relative.format(-seconds, 'second')
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return relative.format(-minutes, 'minute')
  const hours = Math.round(minutes / 60)
  if (hours < 48) return relative.format(-hours, 'hour')
  return relative.format(-Math.round(hours / 24), 'day')
}

const SOURCE_LABELS: Record<ReadSource, string> = {
  live: 'Read just now',
  sampled: 'Sampled',
  cached: 'Cached',
  agent_reported: 'Reported by the node agent',
  inferred: 'Inferred from other observations',
}

/** Where a value comes from, in words (C-28: every state carries its source). */
export function sourceLabel(source: ReadSource): string {
  return SOURCE_LABELS[source]
}

/** A catalog message without its closing period, so a sentence can add its own. */
export function withoutClosingPeriod(message: string): string {
  return message.replace(/[.\s]+$/u, '')
}

/** Whether a number can be drawn: finite, not `NaN`, not infinite. */
export function isDrawable(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}
