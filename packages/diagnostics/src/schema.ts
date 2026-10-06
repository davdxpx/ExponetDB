import type {
  SchemaDiff,
  SchemaFingerprintResult,
  SchemaObject,
  SchemaObjectRef,
  SchemaOverview,
  VisibilityReport,
} from '@exponetdb/contracts'
import type { Queryable } from '@exponetdb/control-store'
import { isJsonObject, type JsonValue } from '@exponetdb/kernel'
import {
  type CanonicalDocument,
  type CanonicalEntry,
  diffDocuments,
  fingerprintOf,
  securityRelevant,
  sql,
  type TargetRow,
  type TrustedSql,
} from '@exponetdb/postgres'
import { brand, type TargetRecord } from '@exponetdb/registry'
import { documentHead, loadDocument } from './documents.ts'
import { DiagnosticsError } from './errors.ts'
import { clip } from './findings.ts'
import { requireIdentity } from './identity.ts'
import { classesOfKind, objectKind, objectRef } from './objects.ts'
import {
  latestSnapshot,
  observeSchema,
  persistSnapshot,
  projectScope,
  type SnapshotDeps,
  type SnapshotRecord,
  sameScope,
  scopeOfHeader,
} from './snapshots.ts'

/**
 * Schema reads ([resources.md "Schema"](../../../exponetdb-docs/06-rest-api/resources.md),
 * order §91, §92): every answer comes from a canonical document of the
 * target's current generation, with its source and time. A document taken
 * within the last {@link SCHEMA_REUSE_MS} with the project's current scope
 * is reused (`cached`); otherwise a live snapshot is taken and stored
 * (`live`). The fingerprint read is always live. A schema that could not be
 * read completely says so (`complete: false` and the visibility report);
 * a failed read is an error, never an empty schema.
 *
 * Object names are untrusted catalog text: they are returned as data,
 * bounded, and never interpreted.
 */
export const SCHEMA_REUSE_MS = 30_000

export interface CurrentSchema {
  readonly document: CanonicalDocument
  readonly snapshot: SnapshotRecord
  readonly source: 'live' | 'cached'
}

function readable(target: TargetRecord): void {
  if (target.state !== 'active' && target.state !== 'suspended') {
    throw new DiagnosticsError(
      target.state === 'decommissioned' ? 'TARGET_NOT_FOUND' : 'TARGET_UNAVAILABLE',
    )
  }
}

/** The target's schema now, or as observed within `maxAgeMs` (0: always live). */
export async function currentSchema(
  deps: SnapshotDeps,
  target: TargetRecord,
  maxAgeMs: number = SCHEMA_REUSE_MS,
): Promise<CurrentSchema> {
  readable(target)
  const scope = await projectScope(deps.store, target)
  if (maxAgeMs > 0) {
    const recent = await latestSnapshot(deps.store, target, { maxAgeMs })
    if (recent !== undefined) {
      const document = await loadDocument(deps.store, recent.fingerprint)
      if (sameScope(scopeOfHeader(document.header), scope)) {
        return { document, snapshot: recent, source: 'cached' }
      }
    }
  }
  const snapshot = await observeSchema(deps, target, 'read', scope)
  const stored = await deps.store.transaction('observation.schema.read', (tx) =>
    persistSnapshot(tx, target, snapshot, 'read', null),
  )
  return { document: snapshot.document, snapshot: stored, source: 'live' }
}

export function visibilityReport(snapshot: SnapshotRecord): VisibilityReport {
  return {
    complete: snapshot.complete,
    gaps: snapshot.visibility.slice(0, 200).map((g) => ({
      objectClass: g.class,
      key: g.key.slice(0, 8).map((k) => clip(k, 2048)),
      attribute: g.attribute,
      reason: g.reason,
    })),
    gapCount: snapshot.visibility.length,
    missingSchemas: snapshot.missingSchemas.map((s) => clip(s, 63)),
  }
}

/** Classes whose key starts with a schema name. */
function schemaOf(entry: CanonicalEntry): string | null {
  switch (entry.class) {
    case 'schema':
    case 'extension':
    case 'event_trigger':
    case 'publication':
    case 'default_privileges':
    case 'cast':
      return null
    default:
      return entry.key[0] ?? null
  }
}

export function schemaOverviewView(target: TargetRecord, current: CurrentSchema): SchemaOverview {
  const counts = new Map<string, Record<string, number>>()
  for (const e of current.document.entries) {
    if (e.class === 'schema') {
      counts.set(e.key[0] ?? '', counts.get(e.key[0] ?? '') ?? {})
      continue
    }
    const schema = schemaOf(e)
    if (schema === null) continue
    const record = counts.get(schema) ?? {}
    const kind = objectKind(e)
    record[kind] = (record[kind] ?? 0) + 1
    counts.set(schema, record)
  }
  const managed = [...counts.entries()].map(([name, objectCounts]) => ({
    name: clip(name, 63),
    managed: true,
    objectCounts,
  }))
  const unmanaged = current.snapshot.excludedSchemas.map((name) => ({
    name: clip(name, 63),
    managed: false,
    objectCounts: {},
  }))
  return {
    targetId: brand('tgt', target.targetId),
    fingerprint: current.snapshot.fingerprint as SchemaOverview['fingerprint'],
    schemas: [...managed, ...unmanaged],
    complete: current.snapshot.complete,
    visibility: visibilityReport(current.snapshot),
    pgMajor: current.document.header.pgMajor,
    source: current.source,
    observedAt: current.snapshot.takenAt,
  }
}

export async function schemaFingerprintView(
  q: Queryable,
  target: TargetRecord,
  current: CurrentSchema,
): Promise<SchemaFingerprintResult> {
  const head = await documentHead(q, current.snapshot.fingerprint)
  if (head === undefined) {
    throw new DiagnosticsError('INTERNAL')
  }
  return {
    targetId: brand('tgt', target.targetId),
    fingerprint: current.snapshot.fingerprint as SchemaFingerprintResult['fingerprint'],
    pgMajor: head.pgMajor,
    canonicalizer: head.canonicalizer,
    complete: current.snapshot.complete,
    entries: head.entries,
    documentDigest: head.documentDigest as SchemaFingerprintResult['documentDigest'],
    snapshotId: brand('smp', current.snapshot.snapshotId),
    visibility: visibilityReport(current.snapshot),
    source: current.source,
    observedAt: current.snapshot.takenAt,
  }
}

// ----- search -----

const SEARCH_CURSOR = 'd1.'

function decodeOffset(cursor: string | undefined): number {
  if (cursor === undefined) return 0
  if (!cursor.startsWith(SEARCH_CURSOR)) {
    throw new DiagnosticsError('VALIDATION_FAILED', {
      errors: [{ path: '/cursor', code: 'invalid', message: 'Unknown cursor.' }],
    })
  }
  const n = Number(Buffer.from(cursor.slice(SEARCH_CURSOR.length), 'base64url').toString('utf8'))
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new DiagnosticsError('VALIDATION_FAILED', {
      errors: [{ path: '/cursor', code: 'invalid', message: 'Unknown cursor.' }],
    })
  }
  return n
}

/** Objects whose name contains `q` (case-insensitive), in document order. */
export function searchSchemaView(
  current: CurrentSchema,
  query: { readonly q: string; readonly kinds?: readonly string[] },
  page: { readonly limit: number; readonly cursor?: string | undefined },
): { readonly items: SchemaObjectRef[]; readonly nextCursor: string | null } {
  const needle = query.q.toLowerCase()
  const kinds = query.kinds === undefined || query.kinds.length === 0 ? null : new Set(query.kinds)
  const limit = Math.min(Math.max(1, Math.trunc(page.limit)), 200)
  const offset = decodeOffset(page.cursor)
  const matches: SchemaObjectRef[] = []
  let seen = 0
  let more = false
  for (const e of current.document.entries) {
    if (kinds !== null && !kinds.has(objectKind(e))) continue
    const ref = objectRef(e)
    const name =
      e.class === 'schema'
        ? (e.key[0] ?? '')
        : (e.key[e.class === 'function' ? 1 : e.key.length - 1] ?? '')
    if (!name.toLowerCase().includes(needle) && !ref.name.toLowerCase().includes(needle)) continue
    if (seen++ < offset) continue
    if (matches.length === limit) {
      more = true
      break
    }
    matches.push(ref)
  }
  return {
    items: matches,
    nextCursor: more
      ? SEARCH_CURSOR + Buffer.from(String(offset + limit), 'utf8').toString('base64url')
      : null,
  }
}

// ----- one object -----

/**
 * `schema.name`, `schema.table.name` (policies, triggers) or
 * `schema.name(identity arguments)` (functions): parts are separated by dots
 * outside double quotes; a quoted part keeps its quotes' content with `""`
 * as one quote; an unquoted part is taken verbatim (no case folding).
 */
export function parseQualifiedName(
  text: string,
): { readonly parts: string[]; readonly signature: string | null } | undefined {
  const parts: string[] = []
  let i = 0
  let current = ''
  let signature: string | null = null
  while (i < text.length) {
    const ch = text[i] as string
    if (ch === '"') {
      i++
      let closed = false
      while (i < text.length) {
        const c = text[i] as string
        if (c === '"') {
          if (text[i + 1] === '"') {
            current += '"'
            i += 2
            continue
          }
          closed = true
          i++
          break
        }
        current += c
        i++
      }
      if (!closed) return undefined
      continue
    }
    if (ch === '.') {
      if (current.length === 0) return undefined
      parts.push(current)
      current = ''
      i++
      continue
    }
    if (ch === '(') {
      if (!text.endsWith(')')) return undefined
      signature = text.slice(i + 1, -1)
      break
    }
    current += ch
    i++
  }
  if (current.length === 0) return undefined
  parts.push(current)
  return { parts, signature }
}

function findEntry(
  document: CanonicalDocument,
  kind: string,
  qualifiedName: string,
): CanonicalEntry | undefined {
  const parsed = parseQualifiedName(qualifiedName)
  if (parsed === undefined) return undefined
  const classes = classesOfKind(kind)
  const key = parsed.signature === null ? parsed.parts : [...parsed.parts, parsed.signature.trim()]
  return document.entries.find(
    (e) =>
      classes.includes(e.class) &&
      objectKind(e) === kind &&
      e.key.length === key.length &&
      e.key.every((k, i) => k === key[i]),
  )
}

type ConstraintType = 'primary_key' | 'foreign_key' | 'unique' | 'check' | 'exclusion' | 'not_null'

/** `pg_constraint.contype` → the contract's constraint type (constraint triggers are not listed). */
const CONSTRAINT_TYPES: Readonly<Record<string, ConstraintType>> = {
  p: 'primary_key',
  f: 'foreign_key',
  u: 'unique',
  c: 'check',
  x: 'exclusion',
  n: 'not_null',
}

const text = (v: JsonValue | undefined): string | null => (typeof v === 'string' ? v : null)

function grantsOf(acl: JsonValue | undefined): NonNullable<SchemaObject['grants']> {
  if (!Array.isArray(acl)) return []
  const byGrantee = new Map<string, Set<string>>()
  for (const item of acl) {
    if (!isJsonObject(item)) continue
    const to = item['to']
    const privilege = item['privilege']
    if (typeof privilege !== 'string' || !/^[A-Z ]{3,32}$/.test(privilege)) continue
    const grantee = typeof to === 'string' ? to : 'PUBLIC'
    const set = byGrantee.get(grantee) ?? new Set<string>()
    set.add(privilege)
    byGrantee.set(grantee, set)
  }
  return [...byGrantee.entries()].map(([grantee, set]) => ({
    grantee: clip(grantee, 63),
    privileges: [...set].sort(),
  }))
}

const children = (document: CanonicalDocument, cls: string, schema: string, parent: string) =>
  document.entries.filter((e) => e.class === cls && e.key[0] === schema && e.key[1] === parent)

interface LiveExtras {
  readonly comment: string | null
  readonly definition: string | null
  readonly sizeBytes: number | null
}

const RELATION_EXTRAS = sql`SELECT pg_catalog.obj_description(c.oid, 'pg_class') AS comment,
       CASE WHEN c.relkind IN ('r', 'p', 'm', 'i', 'I', 't') THEN pg_catalog.pg_total_relation_size(c.oid)::text END AS size
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = $1 AND c.relname = $2`
const FUNCTION_EXTRAS = sql`SELECT pg_catalog.obj_description(p.oid, 'pg_proc') AS comment,
       CASE WHEN p.prokind IN ('f', 'p', 'w') THEN pg_catalog.pg_get_functiondef(p.oid) END AS definition
  FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = $1 AND p.proname = $2 AND pg_catalog.pg_get_function_identity_arguments(p.oid) = $3`
const TYPE_EXTRAS = sql`SELECT pg_catalog.obj_description(t.oid, 'pg_type') AS comment
  FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
 WHERE n.nspname = $1 AND t.typname = $2`
const SCHEMA_EXTRAS = sql`SELECT pg_catalog.obj_description(n.oid, 'pg_namespace') AS comment
  FROM pg_catalog.pg_namespace n WHERE n.nspname = $1`
const EXTENSION_EXTRAS = sql`SELECT pg_catalog.obj_description(e.oid, 'pg_extension') AS comment
  FROM pg_catalog.pg_extension e WHERE e.extname = $1`
const POLICY_EXTRAS = sql`SELECT pg_catalog.obj_description(p.oid, 'pg_policy') AS comment
  FROM pg_catalog.pg_policy p JOIN pg_catalog.pg_class c ON c.oid = p.polrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = $1 AND c.relname = $2 AND p.polname = $3`
const TRIGGER_EXTRAS = sql`SELECT pg_catalog.obj_description(t.oid, 'pg_trigger') AS comment
  FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = $1 AND c.relname = $2 AND t.tgname = $3 AND NOT t.tgisinternal`

function extrasQuery(
  entry: CanonicalEntry,
): { readonly q: TrustedSql; readonly params: string[] } | null {
  const k = entry.key
  switch (entry.class) {
    case 'table':
    case 'foreign_table':
    case 'view':
    case 'materialized_view':
    case 'sequence':
    case 'index':
      return { q: RELATION_EXTRAS, params: [k[0] ?? '', k[1] ?? ''] }
    case 'function':
      return { q: FUNCTION_EXTRAS, params: [k[0] ?? '', k[1] ?? '', k[2] ?? ''] }
    case 'enum':
    case 'domain':
    case 'composite_type':
    case 'range_type':
      return { q: TYPE_EXTRAS, params: [k[0] ?? '', k[1] ?? ''] }
    case 'schema':
      return { q: SCHEMA_EXTRAS, params: [k[0] ?? ''] }
    case 'extension':
      return { q: EXTENSION_EXTRAS, params: [k[0] ?? ''] }
    case 'policy':
      return { q: POLICY_EXTRAS, params: [k[0] ?? '', k[1] ?? '', k[2] ?? ''] }
    case 'trigger':
      return { q: TRIGGER_EXTRAS, params: [k[0] ?? '', k[1] ?? '', k[2] ?? ''] }
    default:
      return null
  }
}

async function liveExtras(
  deps: SnapshotDeps,
  target: TargetRecord,
  entry: CanonicalEntry,
): Promise<LiveExtras> {
  const query = extrasQuery(entry)
  if (query === null) return { comment: null, definition: null, sizeBytes: null }
  const opened = await deps.connector.forTarget(
    target,
    'observer',
    `schema/object/${target.targetId}`,
  )
  try {
    await requireIdentity(opened.session, target, deps.installationId)
    const rows: TargetRow[] = await opened.session.readOnly(
      (tx) => tx.query(query.q, query.params),
      { statementTimeoutMs: 10_000 },
    )
    const row = rows[0]
    if (row === undefined) return { comment: null, definition: null, sizeBytes: null }
    const size = row.has('size') ? row.textOrNull('size') : null
    return {
      comment: row.textOrNull('comment'),
      definition: row.has('definition') ? row.textOrNull('definition') : null,
      sizeBytes: size === null ? null : Number(size),
    }
  } finally {
    await opened.session.close()
  }
}

/** One object: structure from the canonical document, comment, function definition and size read live. */
export async function schemaObject(
  deps: SnapshotDeps,
  target: TargetRecord,
  kind: string,
  qualifiedName: string,
): Promise<SchemaObject> {
  const current = await currentSchema(deps, target)
  const entry = findEntry(current.document, kind, qualifiedName)
  if (entry === undefined) {
    throw new DiagnosticsError('NOT_FOUND')
  }
  const extras = await liveExtras(deps, target, entry)
  const a = entry.attributes
  const schema = entry.key[0] ?? ''
  const name = entry.key[1] ?? ''
  const isRelation = ['table', 'foreign_table', 'view', 'materialized_view'].includes(entry.class)
  const columns = isRelation
    ? children(current.document, 'column', schema, name)
        .sort(
          (x, y) => Number(x.attributes['position'] ?? 0) - Number(y.attributes['position'] ?? 0),
        )
        .map((c): NonNullable<SchemaObject['columns']>[number] => {
          const identity = c.attributes['identity']
          const generated = c.attributes['generated']
          const identityKind = isJsonObject(identity) ? identity['kind'] : undefined
          return {
            name: clip(c.key[2] ?? '', 63),
            type: clip(text(c.attributes['type']) ?? '', 256),
            nullable: c.attributes['notNull'] !== true,
            default: (() => {
              const d = text(c.attributes['default'])
              return d === null ? null : clip(d, 4096)
            })(),
            identity:
              identityKind === 'always' || identityKind === 'by_default' ? identityKind : null,
            generated: isJsonObject(generated)
              ? clip(text(generated['expression']) ?? '', 4096)
              : null,
          }
        })
    : null
  const isTable = entry.class === 'table'
  const constraints = isTable
    ? children(current.document, 'constraint', schema, name).flatMap((c) => {
        const type = CONSTRAINT_TYPES[text(c.attributes['type']) ?? '']
        return type === undefined
          ? []
          : [
              {
                name: clip(c.key[2] ?? '', 63),
                type,
                definition: clip(text(c.attributes['definition']) ?? '', 8192),
                validated: c.attributes['notValidated'] !== true,
              },
            ]
      })
    : null
  const indexes =
    isTable || entry.class === 'materialized_view'
      ? current.document.entries
          .filter((e) => {
            const t = e.attributes['table']
            return e.class === 'index' && Array.isArray(t) && t[0] === schema && t[1] === name
          })
          .map((i) => ({
            name: clip(i.key[1] ?? '', 63),
            definition: clip(text(i.attributes['definition']) ?? '', 8192),
            unique: i.attributes['unique'] === true,
            valid: i.attributes['invalid'] !== true,
          }))
      : null
  const policyEntries = isTable
    ? children(current.document, 'policy', schema, name)
    : entry.class === 'policy'
      ? [entry]
      : null
  const policies =
    policyEntries?.map((p): NonNullable<SchemaObject['policies']>[number] => {
      const command = text(p.attributes['command'])
      const roles = p.attributes['roles']
      return {
        name: clip(p.key[2] ?? '', 63),
        command:
          command === 'select' ||
          command === 'insert' ||
          command === 'update' ||
          command === 'delete'
            ? command
            : ('all' as const),
        permissive: p.attributes['restrictive'] !== true,
        roles: Array.isArray(roles)
          ? roles.map((r) => clip(typeof r === 'string' ? r : 'PUBLIC', 63))
          : ['PUBLIC'],
        using: (() => {
          const u = text(p.attributes['using'])
          return u === null ? null : clip(u, 8192)
        })(),
        withCheck: (() => {
          const w = text(p.attributes['withCheck'])
          return w === null ? null : clip(w, 8192)
        })(),
      }
    }) ?? null
  const definition =
    extras.definition ??
    (['view', 'materialized_view', 'index', 'trigger'].includes(entry.class)
      ? text(a['definition'])
      : null)
  return {
    ref: objectRef(entry),
    owner: clip(text(a['owner']) ?? '', 63),
    comment: extras.comment === null ? null : clip(extras.comment, 8192),
    definition: definition === null ? null : clip(definition, 262_144),
    columns,
    constraints,
    indexes,
    policies,
    rowLevelSecurity: isTable
      ? { enabled: a['rowSecurity'] === true, forced: a['rowSecurityForced'] === true }
      : null,
    grants: 'acl' in a ? grantsOf(a['acl']) : null,
    sizeBytes:
      extras.sizeBytes !== null && Number.isSafeInteger(extras.sizeBytes) ? extras.sizeBytes : null,
    source: current.source,
    observedAt: current.snapshot.takenAt,
  }
}

// ----- diff -----

export const MAX_DIFF_ITEMS = 1000

/** Targets on which a fingerprint was observed (the caller must be allowed to read one of them). */
export async function fingerprintTargets(q: Queryable, fingerprint: string): Promise<string[]> {
  const { rows } = await q.query(
    'observation.schema.fingerprint_targets',
    `SELECT DISTINCT s.target_id FROM observation.schema_snapshots s WHERE s.fingerprint = $1 ORDER BY 1 LIMIT 1000`,
    [fingerprint],
  )
  return rows.map((r) => r.text('target_id'))
}

export function schemaDiffView(left: CanonicalDocument, right: CanonicalDocument): SchemaDiff {
  const diff = diffDocuments(left, right)
  const groups = new Map<
    string,
    {
      added: SchemaObjectRef[]
      removed: SchemaObjectRef[]
      changed: { ref: SchemaObjectRef; attributes: string[] }[]
    }
  >()
  const group = (e: CanonicalEntry) => {
    const kind = objectKind(e)
    const g = groups.get(kind) ?? { added: [], removed: [], changed: [] }
    groups.set(kind, g)
    return g
  }
  let listed = 0
  let truncated = false
  const take = () => {
    if (listed >= MAX_DIFF_ITEMS) {
      truncated = true
      return false
    }
    listed++
    return true
  }
  const security: SchemaObjectRef[] = []
  let securityCount = 0
  const flag = (relevant: boolean, e: CanonicalEntry) => {
    if (!relevant) return
    securityCount++
    if (security.length < 500) security.push(objectRef(e))
  }
  for (const e of diff.added) {
    flag(securityRelevant({ kind: 'added', entry: e }), e)
    if (take()) group(e).added.push(objectRef(e))
  }
  for (const e of diff.removed) {
    flag(securityRelevant({ kind: 'removed', entry: e }), e)
    if (take()) group(e).removed.push(objectRef(e))
  }
  for (const c of diff.changed) {
    flag(securityRelevant({ kind: 'changed', change: c }), c.after)
    if (take()) {
      group(c.after).changed.push({
        ref: objectRef(c.after),
        attributes: c.attributes.filter((n) => /^[a-zA-Z][a-zA-Z0-9_.]{0,63}$/.test(n)),
      })
    }
  }
  return {
    comparable: diff.comparable,
    left: { fingerprint: fingerprintOfDocument(left) },
    right: { fingerprint: fingerprintOfDocument(right) },
    groups: [...groups.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([objectClass, g]) => ({ objectClass, ...g })),
    totals: {
      added: diff.added.length,
      removed: diff.removed.length,
      changed: diff.changed.length,
      matched: diff.matched,
      securityRelevant: securityCount,
    },
    securityRelevant: security,
    truncated: truncated || securityCount > security.length,
  }
}

function fingerprintOfDocument(d: CanonicalDocument): SchemaDiff['left']['fingerprint'] {
  return fingerprintOf(d) as SchemaDiff['left']['fingerprint']
}

/** A stored document by fingerprint, verified (a diff side named by fingerprint). */
export function documentByFingerprint(
  q: Queryable,
  fingerprint: string,
): Promise<CanonicalDocument> {
  return loadDocument(q, fingerprint)
}
