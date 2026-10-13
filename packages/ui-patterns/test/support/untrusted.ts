import { isInvisible } from '../../src/untrusted/segments.ts'

/**
 * Whether a text holds a character `segmentLine` treats as invisible (control,
 * direction, joiner, tag and filler characters), a line break included. A view of
 * untrusted text must never hand such a character on to the document: it shows
 * the code point instead.
 */
export function containsInvisible(text: string): boolean {
  for (const character of text) {
    if (isInvisible(character.codePointAt(0) ?? 0)) return true
  }
  return false
}
