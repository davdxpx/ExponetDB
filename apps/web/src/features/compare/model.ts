import type { SchemaDiff, SchemaObjectRef } from '@exponetdb/sdk/operations'
import type { SchemaDiffEntry } from '@exponetdb/ui-data'
import { isSlug } from '../target/params.ts'

/**
 * The compare page as data: its search (`?to=<environment>`, a slug or
 * nothing), the schema diff of the server as the entries `SchemaDiffView`
 * draws, what a truncated diff leaves out, and the named states of the
 * refusals a comparison can meet. Nothing is decided here: an incomparable
 * diff is never "no differences". Pure functions, unit-tested with hostile
 * input.
 */
export interface CompareSearch {
  readonly to?: string | undefined
}

/**
 * `validateSearch` of `/t/<product>/<project>/<environment>/compare`: only a
 * slug passes; anything else is dropped (never shortened). The key is
 * always returned, so the router never keeps a raw value.
 */
export function compareSearch(search: Readonly<Record<string, unknown>>): CompareSearch {
  const to = search['to']
  return { to: isSlug(to) ? to : undefined }
}

/** The name of an object as one string: `name`, with the parent and signature when given. */
function objectName(ref: SchemaObjectRef): string {
  const name = ref.signature === null ? ref.name : `${ref.name}${ref.signature}`
  return ref.parent === null ? name : `${ref.parent}.${name}`
}

function sameObject(a: SchemaObjectRef, b: SchemaObjectRef): boolean {
  return (
    a.kind === b.kind &&
    a.key.length === b.key.length &&
    a.key.every((part, index) => part === b.key[index])
  )
}

/**
 * The server's diff (left = this target, right = the other) as the entries
 * of `SchemaDiffView`: one per listed object, `added` when it exists only on
 * the right, `removed` when only on the left, `changed` with the changed
 * attributes as details; an object the server flags as security-relevant
 * carries the `security` class.
 */
export function diffEntries(diff: SchemaDiff): readonly SchemaDiffEntry[] {
  const security = (ref: SchemaObjectRef): SchemaDiffEntry['classes'] =>
    diff.securityRelevant.some((flagged) => sameObject(flagged, ref)) ? ['security'] : []
  const entries: SchemaDiffEntry[] = []
  for (const group of diff.groups) {
    for (const ref of group.added) {
      entries.push({
        objectType: group.objectClass,
        schema: ref.schema,
        name: objectName(ref),
        change: 'added',
        classes: security(ref),
        details: '',
      })
    }
    for (const ref of group.removed) {
      entries.push({
        objectType: group.objectClass,
        schema: ref.schema,
        name: objectName(ref),
        change: 'removed',
        classes: security(ref),
        details: '',
      })
    }
    for (const change of group.changed) {
      entries.push({
        objectType: group.objectClass,
        schema: change.ref.schema,
        name: objectName(change.ref),
        change: 'changed',
        classes: security(change.ref),
        details: change.attributes.length === 0 ? '' : change.attributes.join(', '),
      })
    }
  }
  return entries
}

/** How many differences the diff lists and how many exist (the totals count before any cap). */
export function diffCounts(diff: SchemaDiff): { readonly listed: number; readonly total: number } {
  let listed = 0
  for (const group of diff.groups) {
    listed += group.added.length + group.removed.length + group.changed.length
  }
  return {
    listed,
    total: diff.totals.added + diff.totals.removed + diff.totals.changed,
  }
}

/**
 * The refusals of `POST /schema-diffs` that the page names in its own words
 * (each with the server's message and code), instead of the generic failed
 * read: the fingerprints cannot be compared, a schema sample is too old, the
 * target's identity or cluster changed.
 */
export const NAMED_REFUSALS = [
  'SCHEMA_FINGERPRINT_MISMATCH',
  'SAMPLE_STALE',
  'TARGET_IDENTITY_MISMATCH',
  'CLUSTER_IDENTITY_MISMATCH',
] as const

export type NamedRefusal = (typeof NAMED_REFUSALS)[number]

export function namedRefusal(code: string): NamedRefusal | undefined {
  return NAMED_REFUSALS.find((candidate) => candidate === code)
}
