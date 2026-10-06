import {
  canonicalize,
  compareUtf8,
  InvariantError,
  isJsonObject,
  type JsonObject,
  type JsonValue,
} from '@exponetdb/kernel'
import { sha256Hex } from '@exponetdb/kernel/hash'

/**
 * The `fp1` canonical document ([schema-fingerprints.md](../../../../exponetdb-docs/03-database-model/schema-fingerprints.md)).
 *
 * - An entry is `{ class, key, attributes }`; its hash is SHA-256 over the
 *   RFC 8785 (JCS) serialization of exactly those three members. Keys are
 *   lists of names (never OIDs), so a dot or a quote in a name can never
 *   make two keys equal.
 * - Attributes omit absent and default values (no `null`, no `false`, no
 *   empty list or string), so an attribute added by a later canonicalizer
 *   never changes an old document; numbers that are not small integers are
 *   strings (no floats).
 * - Entries are sorted by class, then key, in UTF-8 byte order.
 * - The fingerprint is `fp1:<major>:` + SHA-256 over the JCS form of
 *   `{ header, entries: [[class, key, entryHash], …] }`; the header
 *   (`canonicalizer`, `pgMajor`, `scope`) is part of the hash.
 * - A documentation digest (SHA-256 of the comment) sits beside an entry and
 *   is never hashed (comments are not structure, §5).
 */
export const CANONICALIZER = 'fp1'

export const OBJECT_CLASSES = [
  'schema',
  'extension',
  'enum',
  'domain',
  'composite_type',
  'range_type',
  'sequence',
  'table',
  'foreign_table',
  'column',
  'constraint',
  'index',
  'view',
  'materialized_view',
  'function',
  'trigger',
  'event_trigger',
  'policy',
  'rule',
  'statistics',
  'publication',
  'default_privileges',
  'collation',
  'cast',
  'operator',
  'operator_class',
  'text_search_config',
] as const
export type ObjectClass = (typeof OBJECT_CLASSES)[number]

export interface ManagedScope {
  /** Schemas to include; absent means every non-system schema. */
  readonly includeSchemas?: readonly string[]
  /** Schemas to leave out in addition to the ones that are always excluded. */
  readonly excludeSchemas?: readonly string[]
}

export interface DocumentHeader {
  readonly canonicalizer: 'fp1'
  readonly pgMajor: number
  readonly scope: {
    readonly include: readonly string[] | 'all'
    readonly exclude: readonly string[]
  }
}

export interface CanonicalEntry {
  readonly class: ObjectClass
  readonly key: readonly string[]
  readonly attributes: JsonObject
  /** Lowercase hex SHA-256 of the entry's JCS form. */
  readonly hash: string
  /** SHA-256 of the object's comment; not part of any hash. */
  readonly documentation?: string
}

export interface CanonicalDocument {
  readonly header: DocumentHeader
  readonly entries: readonly CanonicalEntry[]
}

function jcs(value: JsonValue): string {
  const text = canonicalize(value)
  if (!text.ok) {
    throw new InvariantError('canonical document members are I-JSON')
  }
  return text.value
}

/** An attribute value before normalization: JSON with `undefined` allowed anywhere. */
export type AttributeValue =
  | JsonValue
  | undefined
  | { readonly [key: string]: AttributeValue }
  | readonly AttributeValue[]

/** Drops absent and default values, recursively for objects (lists keep their members). */
export function normalize(value: AttributeValue): JsonValue | undefined {
  if (value === null || value === undefined || value === false || value === '') return undefined
  if (Array.isArray(value)) {
    return value.length === 0
      ? undefined
      : value.map((v) => (v === undefined ? null : (normalize(v) ?? null)))
  }
  if (typeof value === 'object') {
    const out: Record<string, JsonValue> = {}
    for (const [k, v] of Object.entries(value)) {
      const n = normalize(v)
      if (n !== undefined) out[k] = n
    }
    return Object.keys(out).length === 0 ? undefined : out
  }
  if (typeof value === 'number' && !Number.isSafeInteger(value)) {
    return String(value)
  }
  return value
}

export function makeEntry(
  objectClass: ObjectClass,
  key: readonly string[],
  attributes: Readonly<Record<string, AttributeValue>> = {},
  comment?: string | null,
): CanonicalEntry {
  const normalized = (normalize(attributes) ?? {}) as JsonObject
  const hash = sha256Hex(jcs({ class: objectClass, key: [...key], attributes: normalized }))
  return comment === undefined || comment === null || comment.length === 0
    ? { class: objectClass, key, attributes: normalized, hash }
    : {
        class: objectClass,
        key,
        attributes: normalized,
        hash,
        documentation: sha256Hex(comment),
      }
}

export function compareKeys(a: readonly string[], b: readonly string[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const c = compareUtf8(a[i] as string, b[i] as string)
    if (c !== 0) return c
  }
  return a.length - b.length
}

export function compareEntries(a: CanonicalEntry, b: CanonicalEntry): number {
  return compareUtf8(a.class, b.class) || compareKeys(a.key, b.key)
}

/** A stable identity of an entry inside one document. */
export function entryId(entry: Pick<CanonicalEntry, 'class' | 'key'>): string {
  return jcs([entry.class, [...entry.key]])
}

export function makeDocument(
  header: DocumentHeader,
  entries: readonly CanonicalEntry[],
): CanonicalDocument {
  const sorted = [...entries].sort(compareEntries)
  for (let i = 1; i < sorted.length; i++) {
    if (compareEntries(sorted[i - 1] as CanonicalEntry, sorted[i] as CanonicalEntry) === 0) {
      throw new InvariantError('two entries of a canonical document share a class and key')
    }
  }
  return { header, entries: sorted }
}

export function fingerprintOf(document: CanonicalDocument): string {
  const hash = sha256Hex(
    jcs({
      header: {
        canonicalizer: document.header.canonicalizer,
        pgMajor: document.header.pgMajor,
        scope: {
          include:
            document.header.scope.include === 'all' ? 'all' : [...document.header.scope.include],
          exclude: [...document.header.scope.exclude],
        },
      },
      entries: document.entries.map((e) => [e.class, [...e.key], e.hash]),
    }),
  )
  return `${CANONICALIZER}:${document.header.pgMajor}:${hash}`
}

/** The document as JSON (for storage and transport). */
export function documentJson(document: CanonicalDocument): JsonObject {
  return {
    header: {
      canonicalizer: document.header.canonicalizer,
      pgMajor: document.header.pgMajor,
      scope: {
        include:
          document.header.scope.include === 'all' ? 'all' : [...document.header.scope.include],
        exclude: [...document.header.scope.exclude],
      },
    },
    entries: document.entries.map((e) => ({
      class: e.class,
      key: [...e.key],
      attributes: e.attributes,
      hash: e.hash,
      ...(e.documentation === undefined ? {} : { documentation: e.documentation }),
    })),
  }
}

/** Parses a stored document and re-checks every entry hash (a changed document is refused). */
export function documentFromJson(value: JsonValue): CanonicalDocument | undefined {
  if (!isJsonObject(value)) return undefined
  const header = value['header']
  const entries = value['entries']
  if (!isJsonObject(header) || !Array.isArray(entries)) {
    return undefined
  }
  const major = header['pgMajor']
  const scope = header['scope']
  if (
    header['canonicalizer'] !== CANONICALIZER ||
    typeof major !== 'number' ||
    !isJsonObject(scope)
  ) {
    return undefined
  }
  const include = scope['include']
  const exclude = scope['exclude']
  if (
    !(
      include === 'all' ||
      (Array.isArray(include) && include.every((s) => typeof s === 'string'))
    ) ||
    !Array.isArray(exclude) ||
    !exclude.every((s) => typeof s === 'string')
  ) {
    return undefined
  }
  const out: CanonicalEntry[] = []
  for (const e of entries) {
    if (!isJsonObject(e)) return undefined
    const cls = e['class']
    const key = e['key']
    const attributes = e['attributes']
    if (
      typeof cls !== 'string' ||
      !(OBJECT_CLASSES as readonly string[]).includes(cls) ||
      !Array.isArray(key) ||
      !key.every((k) => typeof k === 'string') ||
      !isJsonObject(attributes)
    ) {
      return undefined
    }
    const hash = sha256Hex(jcs({ class: cls, key, attributes }))
    if (hash !== e['hash']) return undefined
    const documentation = e['documentation']
    out.push({
      class: cls as ObjectClass,
      key: key as string[],
      attributes,
      hash,
      ...(typeof documentation === 'string' ? { documentation } : {}),
    })
  }
  return makeDocument(
    {
      canonicalizer: 'fp1',
      pgMajor: major,
      scope: {
        include: include === 'all' ? 'all' : (include as string[]),
        exclude: exclude as string[],
      },
    },
    out,
  )
}
