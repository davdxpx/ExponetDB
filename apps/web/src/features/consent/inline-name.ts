import { codePointLabel, isInvisible } from '@exponetdb/ui-patterns'

/** The longest client name a heading or a button shows, in code points. */
export const INLINE_NAME_MAX = 48

/**
 * A client's untrusted name for a place that takes plain text only (the
 * page title, a button label): every control, direction, format or
 * invisible character is replaced by its visible code point (`⟨U+202E⟩`),
 * so the name can neither reorder nor hide the words around it, and a long
 * name is cut with an ellipsis. The full name is shown elsewhere through
 * `UntrustedName`. Returns undefined for an empty name.
 */
export function inlineName(name: string, max = INLINE_NAME_MAX): string | undefined {
  let out = ''
  let count = 0
  for (const character of name) {
    if (count >= max) return `${out}…`
    const cp = character.codePointAt(0) ?? 0
    out += isInvisible(cp) ? codePointLabel(cp) : character
    count += 1
  }
  return out === '' ? undefined : out
}
