/**
 * The fixed moment every demo of the patterns and the data components
 * measures ages against. A demo passes `NOW` (or `NOW_MS`) wherever a
 * component takes a `now`, so the visual-regression host renders the same
 * text on every run.
 */
export const NOW = '2026-10-13T12:00:00.000Z'
export const NOW_MS = Date.parse(NOW)

const MINUTE_MS = 60_000

/** An ISO 8601 time this many minutes before `NOW`. */
export function minutesAgo(minutes: number): string {
  return new Date(NOW_MS - minutes * MINUTE_MS).toISOString()
}

/** An ISO 8601 time this many minutes after `NOW`. */
export function minutesAhead(minutes: number): string {
  return new Date(NOW_MS + minutes * MINUTE_MS).toISOString()
}
