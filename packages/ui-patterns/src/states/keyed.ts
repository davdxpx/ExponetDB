/**
 * Stable React keys for a list of strings that may repeat: the text plus the
 * number of earlier occurrences of the same text. The key never depends on the
 * position, so reordering a list moves its items instead of rebuilding them.
 */
export function keyedStrings(
  items: readonly string[],
): readonly { readonly key: string; readonly text: string }[] {
  const seen = new Map<string, number>()
  const keyed: { key: string; text: string }[] = []
  for (const text of items) {
    const count = seen.get(text) ?? 0
    seen.set(text, count + 1)
    keyed.push({ key: `${count}:${text}`, text })
  }
  return keyed
}
