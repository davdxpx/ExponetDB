/**
 * The ranges the health history can be asked for, as pure functions of a
 * choice and a clock (so every rule is a table test). The server serves at
 * most 60 days back from now, which is the longest retention an installation
 * can configure (3 to 60 days, 14 by default; health.md §3); it refuses a
 * range that ends in the future, starts at or after its end, is longer than
 * 60 days or starts before them. A choice is clamped to what the server can
 * serve before it is sent, and the clamp is reported, never hidden.
 */
export const HISTORY_RANGES = ['1h', '6h', '24h', '7d', '14d'] as const
export type HistoryRange = (typeof HISTORY_RANGES)[number]

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS

export const RANGE_MS: Readonly<Record<HistoryRange, number>> = {
  '1h': HOUR_MS,
  '6h': 6 * HOUR_MS,
  '24h': 24 * HOUR_MS,
  '7d': 7 * DAY_MS,
  '14d': 14 * DAY_MS,
}

/** The longest range the server serves: the longest retention. */
export const HISTORY_MAX_DAYS = 60
export const HISTORY_MAX_MS = HISTORY_MAX_DAYS * DAY_MS
/** The default retention, and the bounds an installation can set it within. */
export const RETENTION_DEFAULT_DAYS = 14
export const RETENTION_MIN_DAYS = 3
/**
 * A margin at the far end of the range, for a clock that differs from the
 * server's by a little: a range that starts exactly 60 days back would be
 * refused if this device's clock is behind.
 */
const CLOCK_SLACK_MS = 5 * 60_000

/** What the person chose: a preset ending now, or whole days in their own time zone. */
export type HistorySelection =
  | { readonly kind: 'preset'; readonly range: HistoryRange }
  | {
      readonly kind: 'custom'
      /** `YYYY-MM-DD`, the first day, in the time zone of this device. */
      readonly fromDay: string
      /** `YYYY-MM-DD`, the last day, in the time zone of this device. */
      readonly toDay: string
    }

export const DEFAULT_SELECTION: HistorySelection = { kind: 'preset', range: '24h' }

/** The key of a choice in the query cache. */
export function selectionKey(selection: HistorySelection): string {
  return selection.kind === 'preset'
    ? `preset:${selection.range}`
    : `custom:${selection.fromDay}:${selection.toDay}`
}

/** `2026-10-05` from the local calendar day of a date. */
export function dayString(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${String(date.getFullYear()).padStart(4, '0')}-${month}-${day}`
}

/** The local midnight a `YYYY-MM-DD` names, or `undefined` for text that is not a real calendar day. */
export function parseDay(day: string): Date | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
  if (match === null) return undefined
  const year = Number(match[1])
  const month = Number(match[2])
  const date = Number(match[3])
  const parsed = new Date(year, month - 1, date)
  return parsed.getFullYear() === year &&
    parsed.getMonth() === month - 1 &&
    parsed.getDate() === date
    ? parsed
    : undefined
}

export interface HistoryWindow {
  readonly from: Date
  readonly to: Date
  /** The start was moved forward because the server serves no further back. */
  readonly clamped: boolean
}

/**
 * The range to ask for. `to` is never later than `nowMs` (whole seconds: the
 * server refuses a time in the future); a custom range ends at the end of its
 * last day, or now when that day is today. `undefined` for a range that is
 * empty or names a day that does not exist, which is not sent.
 */
export function historyWindow(
  selection: HistorySelection,
  nowMs: number,
): HistoryWindow | undefined {
  const now = Math.floor(nowMs / 1_000) * 1_000
  if (selection.kind === 'preset') {
    return { from: new Date(now - RANGE_MS[selection.range]), to: new Date(now), clamped: false }
  }
  const first = parseDay(selection.fromDay)
  const last = parseDay(selection.toDay)
  if (first === undefined || last === undefined || last < first) return undefined
  const endOfLast = new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1).getTime()
  const to = Math.min(endOfLast, now)
  const earliest = now - HISTORY_MAX_MS + CLOCK_SLACK_MS
  const clamped = first.getTime() < earliest
  const from = clamped ? earliest : first.getTime()
  if (to <= from) return undefined
  return { from: new Date(from), to: new Date(to), clamped }
}

/** The first and last day the picker offers: today and the earliest day the server can serve. */
export function pickableDays(nowMs: number): { readonly min: Date; readonly max: Date } {
  const now = new Date(nowMs)
  const max = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  // One day short of the limit, so that the whole first day is within what the server serves.
  const min = new Date(max.getFullYear(), max.getMonth(), max.getDate() - (HISTORY_MAX_DAYS - 1))
  return { min, max }
}
