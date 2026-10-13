/**
 * The matching rules of a typed confirmation (design-system.md §3,
 * information-architecture.md §5): the person types the text the dialog
 * shows, a target path such as `shop/platform/production` or an object name.
 *
 * - Both sides are normalized to NFC, so a precomposed and a decomposed
 *   accent are the same text. Nothing else is folded: no NFKC (a fullwidth
 *   or ligature look-alike stays different), no case folding.
 * - The comparison is exact and case-sensitive. Nothing is trimmed, inside or
 *   at the ends: a space pasted before or after the text is a mismatch, which
 *   the dialog names so the person can remove it.
 * - Invisible, bidirectional and control characters count like any other
 *   character; the dialog shows them by code point in the expected text.
 * - An empty expected text never matches (a confirmation without anything to
 *   type fails closed).
 */
export function normalizeConfirmationText(text: string): string {
  return text.normalize('NFC')
}

/** Whether the typed text is exactly the expected text (NFC on both sides). */
export function matchesExpectedText(typed: string, expected: string): boolean {
  const want = normalizeConfirmationText(expected)
  return want.length > 0 && normalizeConfirmationText(typed) === want
}

/**
 * Why a typed text does not match, for the message the dialog shows after the
 * person tried to confirm; `null` when it matches.
 * - `empty`: nothing typed.
 * - `surrounding-space`: the text matches apart from whitespace before or after it.
 * - `case`: the text matches apart from upper and lower case.
 * - `different`: anything else.
 */
export type ConfirmationMismatch = 'empty' | 'surrounding-space' | 'case' | 'different'

export function confirmationMismatch(typed: string, expected: string): ConfirmationMismatch | null {
  if (matchesExpectedText(typed, expected)) return null
  const have = normalizeConfirmationText(typed)
  if (have.length === 0) return 'empty'
  const want = normalizeConfirmationText(expected)
  if (want.length > 0 && have.trim() === want) return 'surrounding-space'
  if (want.length > 0 && have.toLowerCase() === want.toLowerCase()) return 'case'
  return 'different'
}

/** The message for a mismatch, in words a person can act on. */
export function confirmationMismatchMessage(mismatch: ConfirmationMismatch): string {
  switch (mismatch) {
    case 'empty':
      return 'Type the text shown above to continue.'
    case 'surrounding-space':
      return 'Remove the space before or after the text.'
    case 'case':
      return 'The text must match exactly, including upper and lower case.'
    case 'different':
      return 'The text does not match. Type it exactly as shown.'
  }
}
