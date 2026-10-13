import { splitLines } from './segments.ts'

/**
 * Even after "Show all" a value is cut at this many code points and says so:
 * a hostile or runaway value must not be able to freeze the page.
 */
export const EXPANDED_CODE_POINT_LIMIT = 100_000

/**
 * Truncation of untrusted text by code points and lines (design-system.md §4:
 * long values are cut, with an explicit control to see all). Counting code
 * points and not UTF-16 units means a cut never splits a surrogate pair, and
 * an emoji counts once.
 */

/** The number of code points in a text. */
export function codePointCount(text: string): number {
  let count = 0
  for (const _character of text) count += 1
  return count
}

/** The first `max` code points of a text, and whether anything was cut off. */
export function takeCodePoints(
  text: string,
  max: number,
): { readonly head: string; readonly truncated: boolean } {
  const limit = Math.max(0, Math.floor(max))
  // Fewer UTF-16 units than the limit means fewer code points: nothing to cut.
  if (text.length <= limit) return { head: text, truncated: false }
  let count = 0
  let end = 0
  for (const character of text) {
    if (count === limit) return { head: text.slice(0, end), truncated: true }
    count += 1
    end += character.length
  }
  return { head: text, truncated: false }
}

export interface TruncateLimits {
  readonly maxCodePoints: number
  readonly maxLines: number
}

export interface TruncatedLines {
  readonly lines: readonly string[]
  readonly truncated: boolean
}

/**
 * The lines of a text up to the limits. Lines are split like `splitLines`
 * (CRLF, LF and a lone CR each end a line); a line break counts as one code
 * point against `maxCodePoints`. `truncated` is true when anything of the text
 * is left out.
 */
export function truncateText(text: string, limits: TruncateLimits): TruncatedLines {
  const kept: string[] = []
  let used = 0
  let truncated = false
  for (const line of splitLines(text)) {
    if (kept.length >= limits.maxLines) {
      truncated = true
      break
    }
    const { head, truncated: cut } = takeCodePoints(line, limits.maxCodePoints - used)
    kept.push(head)
    if (cut) {
      truncated = true
      break
    }
    used += codePointCount(line) + 1
  }
  return { lines: kept, truncated }
}
