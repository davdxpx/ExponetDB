import { uniqueKeys } from './unique-keys.ts'

/**
 * The entries of a schema diff by object and how they are grouped. Light
 * module: no React. Plain strings, so ui-data does not import the contracts.
 *
 * Mapping to the contract: an entry is one object of the schema diff of a plan
 * (`objectType`, `schema`, `name`, the kind of change, the statement classes
 * that apply to it and the text of the change); `classes` are the
 * classification badges (`StatementClassification` of ui-patterns, limited to
 * the four that describe a change to a schema).
 */
export type SchemaDiffChange = 'added' | 'removed' | 'changed'
export type SchemaDiffClass = 'destructive' | 'rewrite' | 'non_transactional' | 'security'

export interface SchemaDiffEntry {
  /** `table`, `view`, `function`, `index`, ...; an unknown type is shown by its own name. */
  readonly objectType: string
  /** The schema of the object; empty for objects that live outside a schema (extensions, roles). */
  readonly schema: string
  readonly name: string
  readonly change: SchemaDiffChange
  readonly classes: readonly SchemaDiffClass[]
  /** What changed, as text: a definition, a list of altered columns. Untrusted. */
  readonly details: string
}

/** The order of the groups: what other objects depend on comes first. */
export const SCHEMA_DIFF_TYPE_ORDER: readonly string[] = [
  'schema',
  'extension',
  'role',
  'type',
  'sequence',
  'table',
  'column',
  'constraint',
  'index',
  'view',
  'materialized_view',
  'function',
  'procedure',
  'trigger',
  'policy',
  'grant',
]

/** The plural a group is headed with. A type that is not listed is headed by its own name. */
export const SCHEMA_DIFF_TYPE_LABELS: Readonly<Record<string, string>> = {
  schema: 'Schemas',
  extension: 'Extensions',
  role: 'Roles',
  type: 'Types',
  sequence: 'Sequences',
  table: 'Tables',
  column: 'Columns',
  constraint: 'Constraints',
  index: 'Indexes',
  view: 'Views',
  materialized_view: 'Materialized views',
  function: 'Functions',
  procedure: 'Procedures',
  trigger: 'Triggers',
  policy: 'Policies',
  grant: 'Grants',
}

export interface SchemaDiffItem {
  /** A key that is unique among the items of the diff. */
  readonly key: string
  readonly entry: SchemaDiffEntry
  /** The statement classes of the entry without repeats, in the order given. */
  readonly classes: readonly SchemaDiffClass[]
}

export interface SchemaDiffGroup {
  readonly objectType: string
  /** The heading, or `null` for a type that has no label (the view shows its name as untrusted text). */
  readonly label: string | null
  readonly items: readonly SchemaDiffItem[]
}

export type SchemaDiffChangeCounts = Readonly<{
  added: number
  removed: number
  changed: number
  /** Entries whose change is none of the three (a newer server). */
  other: number
}>

export function countSchemaChanges(entries: readonly SchemaDiffEntry[]): SchemaDiffChangeCounts {
  const counts = { added: 0, removed: 0, changed: 0, other: 0 }
  for (const entry of entries) {
    if (entry.change === 'added') counts.added += 1
    else if (entry.change === 'removed') counts.removed += 1
    else if (entry.change === 'changed') counts.changed += 1
    else counts.other += 1
  }
  return counts
}

/** How many entries carry each statement class. A class that no entry carries is absent. */
export function countSchemaClasses(
  entries: readonly SchemaDiffEntry[],
): readonly (readonly [SchemaDiffClass, number])[] {
  const counts = new Map<SchemaDiffClass, number>()
  for (const entry of entries) {
    for (const cls of new Set(entry.classes)) counts.set(cls, (counts.get(cls) ?? 0) + 1)
  }
  return [...counts.entries()]
}

function typeRank(objectType: string): number {
  const index = SCHEMA_DIFF_TYPE_ORDER.indexOf(objectType)
  return index === -1 ? SCHEMA_DIFF_TYPE_ORDER.length : index
}

/**
 * Groups the entries by object type. Known types come first in dependency
 * order, unknown types after them in the order they first appear; within a
 * group the entries keep the order the server gave.
 */
export function groupSchemaDiff(entries: readonly SchemaDiffEntry[]): readonly SchemaDiffGroup[] {
  const byType = new Map<string, SchemaDiffItem[]>()
  const keyed = uniqueKeys(
    entries,
    (entry) => `${entry.objectType}\u0000${entry.schema}\u0000${entry.name}`,
  )
  for (const { key, item } of keyed) {
    const group = byType.get(item.objectType) ?? []
    group.push({ key, entry: item, classes: [...new Set(item.classes)] })
    byType.set(item.objectType, group)
  }
  const appearance = [...byType.keys()]
  const ordered = [...appearance].sort((a, b) => {
    const rank = typeRank(a) - typeRank(b)
    return rank !== 0 ? rank : appearance.indexOf(a) - appearance.indexOf(b)
  })
  return ordered.map((objectType) => ({
    objectType,
    label: Object.hasOwn(SCHEMA_DIFF_TYPE_LABELS, objectType)
      ? (SCHEMA_DIFF_TYPE_LABELS[objectType] ?? null)
      : null,
    items: byType.get(objectType) ?? [],
  }))
}
