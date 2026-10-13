/**
 * Bounded display of untrusted text (C-26, design-system.md §4): long values
 * are cut at a code point boundary with the full length kept, so the view can
 * say "shows N of M characters" and offer the full value on request.
 */
export interface Truncated {
  readonly shown: string
  readonly truncated: boolean
  /** Length of the full value in code points. */
  readonly total: number
}

export function truncateText(text: string, max: number): Truncated {
  const points = Array.from(text)
  if (points.length <= max) {
    return { shown: text, truncated: false, total: points.length }
  }
  return {
    shown: points.slice(0, Math.max(0, max)).join(''),
    truncated: true,
    total: points.length,
  }
}
