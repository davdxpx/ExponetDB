/**
 * React keys for a list of names that may repeat (untrusted data can repeat a column name):
 * the name and how many times it came before, so a key is unique and does not depend on a
 * position in the array.
 */
export function keysFor(names: readonly string[]): string[] {
  const seen = new Map<string, number>()
  return names.map((name) => {
    const before = seen.get(name) ?? 0
    seen.set(name, before + 1)
    return `${name}#${before}`
  })
}
