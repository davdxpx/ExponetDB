import { codePointLabel, isInvisible } from '@exponetdb/ui-patterns'

import { truncateText } from '../truncate.ts'
import type { SqlDiagnostic } from './types.ts'

/**
 * Text helpers of the editors (no CodeMirror import). Everything that comes
 * from outside the editor and is shown outside the text itself (a completion
 * label, a diagnostic message) goes through here first: C-26, content is data,
 * and invisible or direction-changing characters are made visible.
 */

/** Every control, direction, format and invisible character as `⟨U+XXXX⟩`; the rest unchanged. */
export function markInvisible(text: string): string {
  let out = ''
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0
    out += isInvisible(cp) ? codePointLabel(cp) : ch
  }
  return out
}

/** One line for a list item or a tooltip: line breaks and tabs become a space, then `markInvisible`. */
export function singleLine(text: string): string {
  return markInvisible(text.replace(/\r\n|[\r\n\t]/g, ' '))
}

/** A message from outside, bounded and safe to put in a text node. */
export function untrustedMessage(text: string, max = 500): string {
  const cut = truncateText(text, max)
  return `${singleLine(cut.shown)}${cut.truncated ? '…' : ''}`
}

const isHighSurrogate = (unit: number): boolean => unit >= 0xd800 && unit <= 0xdbff
const isLowSurrogate = (unit: number): boolean => unit >= 0xdc00 && unit <= 0xdfff

export interface TextChange {
  readonly from: number
  readonly to: number
  readonly insert: string
}

/**
 * The smallest single replacement that turns `oldText` into `newText`
 * (common prefix and suffix kept, never cutting a surrogate pair). Used to
 * apply a new `value` without throwing the cursor and the undo history away,
 * or `null` when the texts are equal.
 */
export function minimalChange(oldText: string, newText: string): TextChange | null {
  if (oldText === newText) return null
  const limit = Math.min(oldText.length, newText.length)
  let start = 0
  while (start < limit && oldText.charCodeAt(start) === newText.charCodeAt(start)) start += 1
  if (start > 0 && isHighSurrogate(oldText.charCodeAt(start - 1))) start -= 1
  let endOld = oldText.length
  let endNew = newText.length
  while (
    endOld > start &&
    endNew > start &&
    oldText.charCodeAt(endOld - 1) === newText.charCodeAt(endNew - 1)
  ) {
    endOld -= 1
    endNew -= 1
  }
  if (endOld < oldText.length && isLowSurrogate(oldText.charCodeAt(endOld))) {
    endOld += 1
    endNew += 1
  }
  return { from: start, to: endOld, insert: newText.slice(start, endNew) }
}

/** The diagnostics lists have the same findings in the same order. */
export function sameDiagnostics(
  a: readonly SqlDiagnostic[] | undefined,
  b: readonly SqlDiagnostic[] | undefined,
): boolean {
  if (a === b) return true
  if (a === undefined || b === undefined || a.length !== b.length) return false
  return a.every((x, i) => {
    const y = b[i]
    return (
      y !== undefined &&
      x.line === y.line &&
      x.column === y.column &&
      x.endLine === y.endLine &&
      x.endColumn === y.endColumn &&
      x.severity === y.severity &&
      x.message === y.message
    )
  })
}
