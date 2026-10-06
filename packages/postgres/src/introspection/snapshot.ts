import {
  compareUtf8,
  isJsonArray,
  isJsonObject,
  type JsonObject,
  type JsonValue,
} from '@exponetdb/kernel'
import { sha256Hex } from '@exponetdb/kernel/hash'
import type { TargetRow } from '../rows.ts'
import type { ReadOnlyTransaction, TargetSession } from '../session.ts'
import type { SupportedMajor } from '../versions.ts'
import {
  type AttributeValue,
  type CanonicalDocument,
  type CanonicalEntry,
  type DocumentHeader,
  entryId,
  fingerprintOf,
  type ManagedScope,
  makeDocument,
  makeEntry,
  type ObjectClass,
} from './canonical.ts'
import * as Q from './queries.ts'

/**
 * The schema snapshotter ([postgres-adapter.md §4](../../../../exponetdb-docs/03-database-model/postgres-adapter.md#4-introspection)):
 * one read-only, repeatable-read transaction on an observer session, the
 * determinism settings pinned inside it, one query per class, keyset pages
 * for the large classes. It returns the canonical document, the `fp1`
 * fingerprint, the visibility report and the inspection extras (comments)
 * that are never hashed.
 *
 * A non-empty visibility report makes the snapshot `incomplete`; an
 * incomplete fingerprint is never used for plan binding, evidence or as a
 * drift baseline (fail closed, §8).
 */
export const ALWAYS_EXCLUDED_SCHEMAS: readonly string[] = [
  'pg_catalog',
  'information_schema',
  'exponetdb',
]

export function alwaysExcluded(name: string): boolean {
  return (
    ALWAYS_EXCLUDED_SCHEMAS.includes(name) ||
    name.startsWith('pg_toast') ||
    name.startsWith('pg_temp_') ||
    name.startsWith('pg_toast_temp_')
  )
}

export interface VisibilityItem {
  readonly class: ObjectClass
  readonly key: readonly string[]
  readonly attribute: string
  readonly reason: 'unreadable' | 'missing_schema'
}

export interface Snapshot {
  readonly document: CanonicalDocument
  readonly fingerprint: string
  readonly complete: boolean
  readonly visibility: readonly VisibilityItem[]
  /** Configured schemas that do not exist (informational, not a visibility gap). */
  readonly missingSchemas: readonly string[]
  /**
   * Schemas that exist but lie outside the managed scope (never hashed):
   * drift reports them as unmanaged, never as matched.
   */
  readonly excludedSchemas: readonly string[]
  /** Untrusted comment text per entry id (inspection model only). */
  readonly comments: ReadonlyMap<string, string>
  readonly serverVersionNum: number
  readonly stats: {
    readonly durationMs: number
    readonly queries: number
    readonly entries: number
  }
}

export interface SnapshotOptions {
  /** Relations, functions and types per page (default 500). */
  readonly pageSize?: number
  readonly statementTimeoutMs?: number
}

function oidArray(oids: readonly string[]): string {
  if (!oids.every((o) => /^\d+$/.test(o))) {
    throw new TypeError('OIDs are decimal integers')
  }
  return `{${oids.join(',')}}`
}

function strings(row: TargetRow, column: string): string[] {
  return row.jsonArray(column).filter((v): v is string => typeof v === 'string')
}

function jsonOrUndefined(row: TargetRow, column: string): JsonValue | undefined {
  return row.isNull(column) ? undefined : row.json(column)
}

function pair(value: JsonValue | undefined): string[] | undefined {
  return isJsonArray(value) && value.every((v) => typeof v === 'string')
    ? (value as string[])
    : undefined
}

const POLICY_COMMANDS: Readonly<Record<string, string>> = {
  r: 'select',
  a: 'insert',
  w: 'update',
  d: 'delete',
  '*': 'all',
}

function bodyDigest(row: TargetRow): string {
  const sqlBody = row.textOrNull('sql_body')
  if (sqlBody !== null) return `sha256:${sha256Hex(`sql_body\n${sqlBody}`)}`
  const bin = row.textOrNull('bin')
  const src = row.textOrNull('src') ?? ''
  return `sha256:${sha256Hex(bin === null ? src : `${bin}\n${src}`)}`
}

class Builder {
  readonly entries: CanonicalEntry[] = []
  readonly visibility: VisibilityItem[] = []
  readonly comments = new Map<string, string>()

  add(
    cls: ObjectClass,
    key: readonly string[],
    attributes: Readonly<Record<string, AttributeValue>>,
    comment?: string | null,
  ): void {
    const entry = makeEntry(cls, key, attributes, comment)
    this.entries.push(entry)
    if (comment !== undefined && comment !== null && comment.length > 0) {
      this.comments.set(entryId(entry), comment)
    }
  }

  /** A deparse result that must exist; a NULL is a visibility gap, never an empty definition. */
  required(cls: ObjectClass, key: readonly string[], attribute: string, value: string | null) {
    if (value === null) {
      this.visibility.push({ class: cls, key, attribute, reason: 'unreadable' })
      return undefined
    }
    return value
  }
}

interface Relation {
  readonly oid: string
  readonly schema: string
  readonly name: string
  readonly relkind: string
}

async function relations(
  tx: ReadOnlyTransaction,
  major: SupportedMajor,
  namespaces: string,
  page: number,
  b: Builder,
  counter: { queries: number },
): Promise<void> {
  let after = '0'
  for (;;) {
    const rows = await tx.query(Q.RELATIONS, [after, namespaces, page])
    counter.queries++
    if (rows.length === 0) return
    after = rows[rows.length - 1]?.text('oid') ?? after
    const byOid = new Map<string, Relation>()
    for (const r of rows) {
      byOid.set(r.text('oid'), {
        oid: r.text('oid'),
        schema: r.text('schema'),
        name: r.text('name'),
        relkind: r.text('relkind'),
      })
    }
    const oids = oidArray([...byOid.keys()])
    // One connection runs one statement at a time: no pipelining, no parallel queries.
    const columns = await tx.query(Q.COLUMNS, [oids])
    const constraints = await tx.query(Q.constraints(major), [oids])
    const indexes = await tx.query(Q.INDEXES, [oids])
    const triggers = await tx.query(Q.TRIGGERS, [oids])
    const policies = await tx.query(Q.POLICIES, [oids])
    const rules = await tx.query(Q.RULES, [oids])
    const parents = await tx.query(Q.PARENTS, [oids])
    counter.queries += 7
    const parentsOf = new Map<string, string[][]>()
    for (const p of parents) {
      const list = parentsOf.get(p.text('rel')) ?? []
      list.push([p.text('schema'), p.text('name')])
      parentsOf.set(p.text('rel'), list)
    }
    for (const r of rows) {
      const rel = byOid.get(r.text('oid')) as Relation
      const key = [rel.schema, rel.name]
      const owner = r.text('owner')
      const acl = jsonOrUndefined(r, 'acl')
      const reloptions = strings(r, 'reloptions')
      const comment = r.textOrNull('comment')
      switch (rel.relkind) {
        case 'r':
        case 'p': {
          const am = r.textOrNull('access_method')
          b.add(
            'table',
            key,
            {
              partitioned: rel.relkind === 'p',
              persistence: r.text('persistence') === 'p' ? undefined : r.text('persistence'),
              partitionKey: r.textOrNull('partition_key') ?? undefined,
              partitionBound: r.textOrNull('partition_bound') ?? undefined,
              parents: (parentsOf.get(rel.oid) ?? []).sort((x, y) =>
                compareUtf8(JSON.stringify(x), JSON.stringify(y)),
              ),
              rowSecurity: r.bool('rls'),
              rowSecurityForced: r.bool('rls_forced'),
              replicaIdentity:
                r.text('replica_identity') === 'd' ? undefined : r.text('replica_identity'),
              accessMethod: am === null || am === 'heap' ? undefined : am,
              reloptions,
              tablespace: r.textOrNull('tablespace') ?? undefined,
              owner,
              acl,
            },
            comment,
          )
          break
        }
        case 'v':
        case 'm': {
          const cls = rel.relkind === 'v' ? 'view' : 'materialized_view'
          const definition = b.required(cls, key, 'definition', r.textOrNull('view_definition'))
          const am = r.textOrNull('access_method')
          b.add(
            cls,
            key,
            {
              definition,
              reloptions,
              accessMethod: rel.relkind === 'm' && am !== null && am !== 'heap' ? am : undefined,
              tablespace: r.textOrNull('tablespace') ?? undefined,
              owner,
              acl,
            },
            comment,
          )
          break
        }
        case 'S': {
          // An identity column's sequence is part of the column (its options are there).
          if (r.textOrNull('identity_owned') === 'i') break
          const seq = jsonOrUndefined(r, 'sequence')
          b.add(
            'sequence',
            key,
            {
              ...(isJsonObject(seq) ? seq : {}),
              ownedBy: pair(jsonOrUndefined(r, 'owned_by')),
              owner,
              acl,
            },
            comment,
          )
          break
        }
        case 'f': {
          const ft = jsonOrUndefined(r, 'foreign_table')
          b.add('foreign_table', key, { ...(isJsonObject(ft) ? ft : {}), owner, acl }, comment)
          break
        }
      }
    }
    let position = 0
    let lastRel = ''
    for (const c of columns) {
      const relOid = c.text('rel')
      const rel = byOid.get(relOid)
      if (rel === undefined || rel.relkind === 'S') continue
      if (relOid !== lastRel) {
        position = 0
        lastRel = relOid
      }
      position++
      const generated = c.textOrNull('generated')
      const identity = c.textOrNull('identity')
      const defaultExpr = c.textOrNull('default_expr')
      b.add(
        'column',
        [rel.schema, rel.name, c.text('name')],
        {
          position,
          type: c.text('type'),
          notNull: c.bool('not_null'),
          default: generated === null ? (defaultExpr ?? undefined) : undefined,
          generated:
            generated === null
              ? undefined
              : {
                  kind: generated === 's' ? 'stored' : 'virtual',
                  expression: defaultExpr ?? undefined,
                },
          identity:
            identity === null
              ? undefined
              : {
                  kind: identity === 'a' ? 'always' : 'by_default',
                  sequence: jsonOrUndefined(c, 'identity_sequence'),
                },
          collation: pair(jsonOrUndefined(c, 'collation')),
          storage: c.textOrNull('storage') ?? undefined,
          compression: c.textOrNull('compression') ?? undefined,
          statisticsTarget: c.intOrNull('statistics_target') ?? undefined,
          acl: jsonOrUndefined(c, 'acl'),
        },
        c.textOrNull('comment'),
      )
    }
    for (const k of constraints) {
      const rel = byOid.get(k.text('rel'))
      if (rel === undefined) continue
      const key = [rel.schema, rel.name, k.text('name')]
      b.add(
        'constraint',
        key,
        {
          type: k.text('type'),
          definition: b.required('constraint', key, 'definition', k.textOrNull('definition')),
          deferrable: k.bool('deferrable'),
          deferred: k.bool('deferred'),
          notValidated: !k.bool('validated'),
          notEnforced: !k.bool('enforced'),
          references: pair(jsonOrUndefined(k, 'references')),
        },
        k.textOrNull('comment'),
      )
    }
    for (const i of indexes) {
      const rel = byOid.get(i.text('rel'))
      if (rel === undefined) continue
      const key = [i.text('schema'), i.text('name')]
      b.add(
        'index',
        key,
        {
          table: [rel.schema, rel.name],
          definition: b.required('index', key, 'definition', i.textOrNull('definition')),
          unique: i.bool('is_unique'),
          primary: i.bool('is_primary'),
          exclusion: i.bool('is_exclusion'),
          nullsNotDistinct: i.bool('nulls_not_distinct'),
          invalid: !i.bool('valid'),
          notReady: !i.bool('ready'),
          tablespace: i.textOrNull('tablespace') ?? undefined,
        },
        i.textOrNull('comment'),
      )
    }
    for (const t of triggers) {
      const rel = byOid.get(t.text('rel'))
      if (rel === undefined) continue
      const key = [rel.schema, rel.name, t.text('name')]
      const enabled = t.text('enabled')
      b.add(
        'trigger',
        key,
        {
          definition: b.required('trigger', key, 'definition', t.textOrNull('definition')),
          enabled: enabled === 'O' ? undefined : enabled,
          constraintTrigger: t.bool('is_constraint'),
        },
        t.textOrNull('comment'),
      )
    }
    for (const p of policies) {
      const rel = byOid.get(p.text('rel'))
      if (rel === undefined) continue
      b.add(
        'policy',
        [rel.schema, rel.name, p.text('name')],
        {
          command: POLICY_COMMANDS[p.text('command')] ?? p.text('command'),
          restrictive: !p.bool('permissive'),
          // PUBLIC is null (never a role name): a role called "Public" stays distinct.
          roles: p.jsonArray('roles') as JsonValue[],
          using: p.textOrNull('using_expr') ?? undefined,
          withCheck: p.textOrNull('check_expr') ?? undefined,
        },
        p.textOrNull('comment'),
      )
    }
    for (const r of rules) {
      const rel = byOid.get(r.text('rel'))
      if (rel === undefined) continue
      const key = [rel.schema, rel.name, r.text('name')]
      const enabled = r.text('enabled')
      b.add('rule', key, {
        definition: b.required('rule', key, 'definition', r.textOrNull('definition')),
        enabled: enabled === 'O' ? undefined : enabled,
      })
    }
    if (rows.length < page) return
  }
}

async function functions(
  tx: ReadOnlyTransaction,
  namespaces: string,
  page: number,
  b: Builder,
  counter: { queries: number },
): Promise<void> {
  let after = '0'
  for (;;) {
    const rows = await tx.query(Q.FUNCTIONS, [after, namespaces, page])
    counter.queries++
    if (rows.length === 0) return
    after = rows[rows.length - 1]?.text('oid') ?? after
    for (const f of rows) {
      const kind = f.text('kind')
      const volatility = f.text('volatility')
      const parallel = f.text('parallel')
      const rowsEstimate = f.text('rows')
      b.add(
        'function',
        [f.text('schema'), f.text('name'), f.text('identity_args')],
        {
          kind: kind === 'f' ? undefined : kind,
          returns: f.textOrNull('result') ?? undefined,
          language: f.text('language'),
          bodyDigest: kind === 'a' ? undefined : bodyDigest(f),
          volatility: volatility === 'v' ? undefined : volatility,
          strict: f.bool('strict'),
          leakproof: f.bool('leakproof'),
          parallel: parallel === 'u' ? undefined : parallel,
          securityDefiner: f.bool('security_definer'),
          config: strings(f, 'config'),
          cost: f.text('cost'),
          rows: rowsEstimate === '0' ? undefined : rowsEstimate,
          aggregate: jsonOrUndefined(f, 'aggregate'),
          owner: f.text('owner'),
          acl: jsonOrUndefined(f, 'acl'),
        },
        f.textOrNull('comment'),
      )
    }
    if (rows.length < page) return
  }
}

async function types(
  tx: ReadOnlyTransaction,
  namespaces: string,
  page: number,
  b: Builder,
  counter: { queries: number },
): Promise<void> {
  let after = '0'
  for (;;) {
    const rows = await tx.query(Q.TYPES, [after, namespaces, page])
    counter.queries++
    if (rows.length === 0) return
    after = rows[rows.length - 1]?.text('oid') ?? after
    for (const t of rows) {
      const key = [t.text('schema'), t.text('name')]
      const common = { owner: t.text('owner'), acl: jsonOrUndefined(t, 'acl') }
      const comment = t.textOrNull('comment')
      switch (t.text('type_kind')) {
        case 'e':
          b.add('enum', key, { labels: t.jsonArray('labels') as JsonValue[], ...common }, comment)
          break
        case 'd':
          b.add(
            'domain',
            key,
            {
              baseType: t.textOrNull('base_type') ?? undefined,
              notNull: t.bool('not_null'),
              default: t.textOrNull('default_expr') ?? undefined,
              checks: t
                .jsonArray('checks')
                .map((c) =>
                  isJsonObject(c)
                    ? { ...c, validated: undefined, notValidated: c['validated'] === false }
                    : c,
                ) as JsonValue[],
              collation: pair(jsonOrUndefined(t, 'collation')),
              ...common,
            },
            comment,
          )
          break
        case 'c':
          b.add(
            'composite_type',
            key,
            { attributes: t.jsonArray('attributes') as JsonValue[], ...common },
            comment,
          )
          break
        case 'r':
          b.add(
            'range_type',
            key,
            {
              ...(isJsonObject(t.json('range')) ? (t.json('range') as JsonObject) : {}),
              ...common,
            },
            comment,
          )
          break
      }
    }
    if (rows.length < page) return
  }
}

/** The managed scope's schemas (after the fixed and the configured exclusions). */
function inScope(name: string, scope: ManagedScope): boolean {
  if (alwaysExcluded(name)) return false
  if (scope.excludeSchemas?.includes(name) === true) return false
  return scope.includeSchemas === undefined || scope.includeSchemas.includes(name)
}

export function scopeHeader(major: number, scope: ManagedScope): DocumentHeader {
  const sortedUnique = (list: readonly string[]) => [...new Set(list)].sort(compareUtf8)
  return {
    canonicalizer: 'fp1',
    pgMajor: major,
    scope: {
      include: scope.includeSchemas === undefined ? 'all' : sortedUnique(scope.includeSchemas),
      exclude: sortedUnique(scope.excludeSchemas ?? []),
    },
  }
}

/** Takes a snapshot of the managed scope on an observer session. */
export async function takeSnapshot(
  session: TargetSession,
  scope: ManagedScope = {},
  options: SnapshotOptions = {},
): Promise<Snapshot> {
  const started = performance.now()
  const page = options.pageSize ?? 500
  const major = session.facts.major
  const counter = { queries: 0 }
  const b = new Builder()
  let missingSchemas: string[] = []
  let excludedSchemas: string[] = []
  await session.readOnly(
    async (tx) => {
      await tx.query(Q.PIN_SETTINGS)
      const schemaRows = await tx.query(Q.SCHEMAS)
      counter.queries += 2
      const scoped = schemaRows.filter((s) => inScope(s.text('name'), scope) && s.bool('own'))
      missingSchemas = (scope.includeSchemas ?? []).filter(
        (n) => !alwaysExcluded(n) && !schemaRows.some((s) => s.text('name') === n),
      )
      // Outside the managed scope, and also a schema that belongs to an extension: its
      // objects are not hashed (the extension entry stands for them), so it is reported
      // as unmanaged rather than silently dropped.
      excludedSchemas = schemaRows
        .filter(
          (s) =>
            !alwaysExcluded(s.text('name')) && (!inScope(s.text('name'), scope) || !s.bool('own')),
        )
        .map((s) => s.text('name'))
        .sort(compareUtf8)
      for (const s of scoped) {
        b.add(
          'schema',
          [s.text('name')],
          { owner: s.text('owner'), acl: jsonOrUndefined(s, 'acl') },
          s.textOrNull('comment'),
        )
      }
      const namespaces = oidArray(scoped.map((s) => s.text('oid')))
      await relations(tx, major, namespaces, page, b, counter)
      await functions(tx, namespaces, page, b, counter)
      await types(tx, namespaces, page, b, counter)
      const extensions = await tx.query(Q.EXTENSIONS)
      const eventTriggers = await tx.query(Q.EVENT_TRIGGERS)
      const publications = await tx.query(Q.PUBLICATIONS)
      const defaultAcls = await tx.query(Q.DEFAULT_ACLS, [namespaces])
      const statistics = await tx.query(Q.STATISTICS, [namespaces])
      const collations = await tx.query(Q.collations(major), [namespaces])
      const casts = await tx.query(Q.CASTS)
      const operators = await tx.query(Q.OPERATORS, [namespaces])
      const opclasses = await tx.query(Q.OPCLASSES, [namespaces])
      const tsConfigs = await tx.query(Q.TS_CONFIGS, [namespaces])
      counter.queries += 10
      for (const e of extensions) {
        b.add(
          'extension',
          [e.text('name')],
          { version: e.textOrNull('version') ?? undefined, schema: e.text('schema') },
          e.textOrNull('comment'),
        )
      }
      for (const e of eventTriggers) {
        const enabled = e.text('enabled')
        b.add(
          'event_trigger',
          [e.text('name')],
          {
            event: e.text('event'),
            tags: strings(e, 'tags'),
            function: e.text('function'),
            enabled: enabled === 'O' ? undefined : enabled,
            owner: e.text('owner'),
          },
          e.textOrNull('comment'),
        )
      }
      for (const p of publications) {
        const publish = [
          p.bool('ins') ? 'insert' : undefined,
          p.bool('upd') ? 'update' : undefined,
          p.bool('del') ? 'delete' : undefined,
          p.bool('trunc') ? 'truncate' : undefined,
        ].filter((x): x is string => x !== undefined)
        b.add('publication', [p.text('name')], {
          allTables: p.bool('all_tables'),
          publish,
          viaRoot: p.bool('via_root'),
          tables: p.jsonArray('tables') as JsonValue[],
          schemas: strings(p, 'schemas'),
          owner: p.text('owner'),
        })
      }
      for (const d of defaultAcls) {
        b.add(
          'default_privileges',
          [d.text('role'), d.textOrNull('schema') ?? '', d.text('object_type')],
          {
            acl: jsonOrUndefined(d, 'acl'),
          },
        )
      }
      for (const s of statistics) {
        const key = [s.text('schema'), s.text('name')]
        b.add('statistics', key, {
          definition: b.required('statistics', key, 'definition', s.textOrNull('definition')),
        })
      }
      for (const c of collations) {
        b.add('collation', [c.text('schema'), c.text('name')], {
          provider: c.text('provider'),
          collate: c.textOrNull('lc_collate') ?? undefined,
          ctype: c.textOrNull('lc_ctype') ?? undefined,
          locale: c.textOrNull('locale') ?? undefined,
          rules: c.textOrNull('rules') ?? undefined,
          nondeterministic: !c.bool('deterministic'),
          owner: c.text('owner'),
        })
      }
      for (const c of casts) {
        b.add('cast', [c.text('source'), c.text('target')], {
          function: c.textOrNull('function') ?? undefined,
          context: c.text('context'),
          method: c.text('method'),
        })
      }
      for (const o of operators) {
        b.add(
          'operator',
          [o.text('schema'), o.text('name'), o.text('left_type'), o.text('right_type')],
          {
            result: o.text('result'),
            function: o.text('function'),
            commutator: o.textOrNull('commutator') ?? undefined,
            negator: o.textOrNull('negator') ?? undefined,
            restrict: o.textOrNull('restrict') ?? undefined,
            join: o.textOrNull('join_fn') ?? undefined,
            hashes: o.bool('hashes'),
            merges: o.bool('merges'),
            owner: o.text('owner'),
          },
        )
      }
      for (const c of opclasses) {
        b.add('operator_class', [c.text('schema'), c.text('name'), c.text('method')], {
          inputType: c.text('input_type'),
          default: c.bool('is_default'),
          family: pair(jsonOrUndefined(c, 'family')),
          keyType: c.textOrNull('key_type') ?? undefined,
          owner: c.text('owner'),
        })
      }
      for (const t of tsConfigs) {
        b.add('text_search_config', [t.text('schema'), t.text('name')], {
          parser: t.textOrNull('parser') ?? undefined,
          mappings: t.jsonArray('mappings') as JsonValue[],
          owner: t.text('owner'),
        })
      }
    },
    { statementTimeoutMs: options.statementTimeoutMs ?? 60_000 },
  )
  const document = makeDocument(scopeHeader(major, scope), b.entries)
  return {
    document,
    fingerprint: fingerprintOf(document),
    complete: b.visibility.length === 0,
    visibility: b.visibility,
    missingSchemas,
    excludedSchemas,
    comments: b.comments,
    serverVersionNum: session.facts.serverVersionNum,
    stats: {
      durationMs: Math.round(performance.now() - started),
      queries: counter.queries,
      entries: document.entries.length,
    },
  }
}
