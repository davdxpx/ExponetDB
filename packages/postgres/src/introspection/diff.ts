import { canonicalize, type JsonValue } from '@exponetdb/kernel'
import {
  type CanonicalDocument,
  type CanonicalEntry,
  compareEntries,
  entryId,
  type ObjectClass,
} from './canonical.ts'

/**
 * Object-by-object diff of two canonical documents ([schema-fingerprints.md §6](../../../../exponetdb-docs/03-database-model/schema-fingerprints.md#6-hierarchy-for-diffs)):
 * entries are matched by class and key, compared by entry hash, and the
 * changed top-level attributes of a changed entry are named. Documents of
 * different canonicalizers or majors are "not comparable" for fingerprint
 * equality; their entries can still be compared structurally, and the
 * result says so (`comparable: false`).
 */
export interface EntryChange {
  readonly class: ObjectClass
  readonly key: readonly string[]
  readonly attributes: readonly string[]
  readonly before: CanonicalEntry
  readonly after: CanonicalEntry
}

export interface DocumentDiff {
  readonly comparable: boolean
  readonly added: readonly CanonicalEntry[]
  readonly removed: readonly CanonicalEntry[]
  readonly changed: readonly EntryChange[]
  /** Entries whose comment changed but nothing hashed (informational). */
  readonly documentationChanged: readonly CanonicalEntry[]
  readonly matched: number
}

function same(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
  if (a === undefined || b === undefined) return a === b
  const x = canonicalize(a)
  const y = canonicalize(b)
  return x.ok && y.ok && x.value === y.value
}

export function diffDocuments(left: CanonicalDocument, right: CanonicalDocument): DocumentDiff {
  const comparable =
    left.header.canonicalizer === right.header.canonicalizer &&
    left.header.pgMajor === right.header.pgMajor
  const byId = new Map(right.entries.map((e) => [entryId(e), e]))
  const added: CanonicalEntry[] = []
  const removed: CanonicalEntry[] = []
  const changed: EntryChange[] = []
  const documentationChanged: CanonicalEntry[] = []
  let matched = 0
  for (const before of left.entries) {
    const id = entryId(before)
    const after = byId.get(id)
    if (after === undefined) {
      removed.push(before)
      continue
    }
    byId.delete(id)
    if (after.hash === before.hash) {
      matched++
      if (after.documentation !== before.documentation) documentationChanged.push(after)
      continue
    }
    const names = new Set([...Object.keys(before.attributes), ...Object.keys(after.attributes)])
    const attributes = [...names]
      .filter((n) => !same(before.attributes[n], after.attributes[n]))
      .sort()
    changed.push({ class: before.class, key: before.key, attributes, before, after })
  }
  added.push(...byId.values())
  added.sort(compareEntries)
  return { comparable, added, removed, changed, documentationChanged, matched }
}

/**
 * Security-relevant drift classes ([drift-detection.md §6](../../../../exponetdb-docs/03-database-model/drift-detection.md#6-security-relevant-drift)):
 * ACLs and owners, default privileges, row security disabled or no longer
 * forced, policies added, removed or changed, `SECURITY DEFINER` and
 * `proconfig` of functions (and a new `SECURITY DEFINER` function), event
 * triggers.
 */
export function securityRelevant(
  change:
    | { readonly kind: 'added' | 'removed'; readonly entry: CanonicalEntry }
    | { readonly kind: 'changed'; readonly change: EntryChange },
): boolean {
  const cls = change.kind === 'changed' ? change.change.class : change.entry.class
  if (cls === 'policy' || cls === 'default_privileges' || cls === 'event_trigger') return true
  if (change.kind !== 'changed') {
    return cls === 'function' && change.entry.attributes['securityDefiner'] === true
  }
  const attributes = change.change.attributes
  if (attributes.includes('acl') || attributes.includes('owner')) return true
  if (
    cls === 'table' &&
    (attributes.includes('rowSecurity') || attributes.includes('rowSecurityForced'))
  ) {
    return true
  }
  if (cls === 'column' && attributes.includes('acl')) return true
  return (
    cls === 'function' && (attributes.includes('securityDefiner') || attributes.includes('config'))
  )
}
