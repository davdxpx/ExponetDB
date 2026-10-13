/**
 * Stable React keys for a list whose natural keys may repeat: the natural key
 * plus the number of earlier items with the same one. Reordering the list moves
 * items instead of rebuilding them, and two items never share a key.
 */
export function uniqueKeys<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
): readonly { readonly key: string; readonly item: T }[] {
  const seen = new Map<string, number>()
  return items.map((item) => {
    const natural = keyOf(item)
    const count = seen.get(natural) ?? 0
    seen.set(natural, count + 1)
    return { key: `${count}:${natural}`, item }
  })
}
