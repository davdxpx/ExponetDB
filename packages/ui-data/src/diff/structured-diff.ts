/**
 * The rows of a before/after comparison of settings or grants and how they are
 * classified. Light module: no React. The rows are plain strings; `null` means
 * "absent" (the setting is not set, the grant is not held), which is not the
 * same as the empty string.
 *
 * Mapping to the contract: a row is one key of a settings or grants diff in the
 * plan analysis (`before` and `after` are the rendered values).
 */
export interface StructuredDiffRow {
  /** What changed: a setting name, `role on object` of a grant. Untrusted text. */
  readonly key: string
  /** The value before, or `null` when the key was absent. */
  readonly before: string | null
  /** The value after, or `null` when the key is absent. */
  readonly after: string | null
}

export type StructuredDiffKind = 'added' | 'removed' | 'changed' | 'unchanged'

/** How a row changed: absent before is added, absent after is removed, equal text is unchanged. */
export function classifyDiffRow(row: StructuredDiffRow): StructuredDiffKind {
  if (row.before === null && row.after === null) return 'unchanged'
  if (row.before === null) return 'added'
  if (row.after === null) return 'removed'
  return row.before === row.after ? 'unchanged' : 'changed'
}

export type StructuredDiffCounts = Readonly<Record<StructuredDiffKind, number>>

export function countDiffRows(rows: readonly StructuredDiffRow[]): StructuredDiffCounts {
  const counts = { added: 0, removed: 0, changed: 0, unchanged: 0 }
  for (const row of rows) counts[classifyDiffRow(row)] += 1
  return counts
}
