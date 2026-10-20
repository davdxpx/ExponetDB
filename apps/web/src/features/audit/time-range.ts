/**
 * The time range of the audit search as a person enters it: a quick range
 * (the last hour up to the last 30 days) or a date and time in their own
 * time zone (`datetime-local`), converted to the UTC `…Z` text the API takes.
 * The address and the request always hold UTC, so a shared link means the
 * same range to everyone; `isAuditTime` in `search.ts` stays the final gate
 * for what is sent.
 */
export type QuickRangeId = 'hour' | 'sixHours' | 'day' | 'week' | 'month'

export const QUICK_RANGES: readonly { readonly id: QuickRangeId; readonly milliseconds: number }[] =
  [
    { id: 'hour', milliseconds: 60 * 60_000 },
    { id: 'sixHours', milliseconds: 6 * 60 * 60_000 },
    { id: 'day', milliseconds: 24 * 60 * 60_000 },
    { id: 'week', milliseconds: 7 * 24 * 60 * 60_000 },
    { id: 'month', milliseconds: 30 * 24 * 60 * 60_000 },
  ]

const pad = (value: number, width = 2): string => String(value).padStart(width, '0')

/** `2026-10-13T09:00`: the value a `datetime-local` field holds for a moment, in the viewer's time zone. */
export function toLocalInput(date: Date): string {
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

const LOCAL_INPUT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/

/**
 * The UTC text (`2026-10-13T07:00:00Z`) of a `datetime-local` value, or
 * undefined when the value is not a real date and time. A date the calendar
 * does not have (the 31st of February) is refused, never moved to another
 * day.
 */
export function localInputToUtc(value: string): string | undefined {
  const match = LOCAL_INPUT.exec(value.trim())
  if (match === null) return undefined
  const date = new Date(value.trim())
  if (!Number.isFinite(date.getTime())) return undefined
  if (toLocalInput(date) !== value.trim()) return undefined
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/** The `datetime-local` value (viewer's time zone) of a UTC time from the address, or '' when it is not a time. */
export function utcToLocalInput(utc: string | undefined): string {
  if (utc === undefined) return ''
  const date = new Date(utc)
  return Number.isFinite(date.getTime()) ? toLocalInput(date) : ''
}

/** The start of a quick range ending now, as a `datetime-local` value. The end is left open. */
export function quickRangeStart(id: QuickRangeId, now: Date): string {
  const range = QUICK_RANGES.find((entry) => entry.id === id)
  const milliseconds = range === undefined ? 0 : range.milliseconds
  return toLocalInput(new Date(now.getTime() - milliseconds))
}
