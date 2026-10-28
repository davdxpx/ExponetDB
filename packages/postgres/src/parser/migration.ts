import { encodeUtf8 } from '@exponetdb/kernel'
import type { SupportedMajor } from './majors.ts'
import {
  type JsonNode,
  MAX_MIGRATION_PARSE_BYTES,
  names,
  nodeType,
  type ParsedStatement,
  type ParseFailure,
  parseWith,
  walk,
} from './parse.ts'

/**
 * PostgreSQL knowledge about migration statements
 * ([analysis.md](../../../../exponetdb-docs/04-migrations/analysis.md),
 * [migration-bundles.md §4, §5](../../../../exponetdb-docs/04-migrations/migration-bundles.md#4-upsql-verifysql-downsql),
 * C-34): each statement of `up.sql` or `down.sql`, split by the parser of
 * the target's major (never by `;` or comments), is classified: whether the
 * engine refuses it, whether it needs autocommit, which objects it touches,
 * which locks it takes on which relations, whether it rewrites or scans a
 * table, its compatibility flags and the structural expectations the engine
 * can derive from it. Pure and synchronous once the parser is loaded.
 *
 * The first rule is honesty (C-30): a statement without a rule is
 * `unknown` (compatibility, lock and coverage), never safe. Catalog facts
 * (sizes, relation kinds, extension ownership) are not read here; callers
 * add them, marked as live facts.
 */

export const COMPATIBILITY_ORDER = [
  'additive',
  'potentially_breaking',
  'data_rewrite',
  'destructive',
] as const
export type CompatibilityClass = (typeof COMPATIBILITY_ORDER)[number] | 'unknown'

export type LockMode =
  | 'ACCESS SHARE'
  | 'ROW SHARE'
  | 'ROW EXCLUSIVE'
  | 'SHARE UPDATE EXCLUSIVE'
  | 'SHARE'
  | 'SHARE ROW EXCLUSIVE'
  | 'EXCLUSIVE'
  | 'ACCESS EXCLUSIVE'

export type LockSeverity = 'none' | 'low' | 'medium' | 'high' | 'critical' | 'unknown'
export const SEVERITY_ORDER: readonly LockSeverity[] = [
  'none',
  'low',
  'medium',
  'high',
  'critical',
  'unknown',
]

export type ObjectKind =
  | 'table'
  | 'column'
  | 'index'
  | 'constraint'
  | 'function'
  | 'procedure'
  | 'policy'
  | 'trigger'
  | 'view'
  | 'materialized_view'
  | 'sequence'
  | 'schema'
  | 'type'
  | 'extension'
  | 'relation'
  | 'other'

export interface ObjectRef {
  readonly kind: ObjectKind
  /** Schema as written; null when unqualified (resolved by the manifest's `search_path`). */
  readonly schema: string | null
  readonly name: string
  /** The table of a column, index, constraint, policy or trigger. */
  readonly table?: { readonly schema: string | null; readonly name: string }
  readonly action: 'create' | 'alter' | 'drop' | 'rename' | 'grant' | 'revoke' | 'comment' | 'write'
}

export interface LockFact {
  readonly mode: LockMode
  /** `schema.name` or `name` as written. */
  readonly on: string
  /** What the lock's duration depends on: catalog only, a scan, a rewrite. */
  readonly duration: 'brief' | 'scan' | 'rewrite' | 'query'
  /** Severity before the size threshold (analysis.md §3). */
  readonly severity: LockSeverity
}

/** Why the engine refuses a statement in `up.sql` or `down.sql` (migration-bundles.md §4). */
export type ForbiddenReason =
  | 'transaction_control'
  | 'session_setting'
  | 'engine_setting'
  | 'role_switch'
  | 'discard'
  | 'role_management'
  | 'alter_system'
  | 'database'
  | 'tablespace'
  | 'load'
  | 'copy_server_file'
  | 'extension_not_trusted'
  | 'ledger_schema'
  | 'cursor_or_prepared'
  | 'privileged'

/** Parameters the executor pins; reviewed SQL never changes them, not even with SET LOCAL (G6 order §23). */
export const ENGINE_SETTINGS: ReadonlySet<string> = new Set([
  'role',
  'session_authorization',
  'search_path',
  'lock_timeout',
  'statement_timeout',
  'idle_in_transaction_session_timeout',
  'transaction_timeout',
  'standard_conforming_strings',
  'client_encoding',
  'timezone',
  'datestyle',
  'intervalstyle',
  'extra_float_digits',
  'check_function_bodies',
  'application_name',
  'default_transaction_read_only',
  'transaction_read_only',
  'transaction_isolation',
  'session_replication_role',
  'row_security',
  'default_tablespace',
  'temp_tablespaces',
])

/** A structural expectation the engine can check from the catalog (verification.md §3). */
export type Expectation =
  | {
      readonly kind: 'relation'
      readonly schema: string | null
      readonly name: string
      /** pg_class.relkind values that satisfy it. */
      readonly relkinds: readonly string[]
      readonly present: boolean
    }
  | {
      readonly kind: 'column'
      readonly schema: string | null
      readonly table: string
      readonly column: string
      readonly present: boolean
      /** Type name as written (for `to_regtype`), with array dimensions; null: not checked. */
      readonly type?: string | null
      /** Type modifiers as written, e.g. `20` or `10,2`; null when none. */
      readonly typmods?: string | null
      readonly notNull?: boolean | null
      readonly hasDefault?: boolean | null
    }
  | {
      readonly kind: 'columns_exactly'
      readonly schema: string | null
      readonly table: string
      readonly columns: readonly string[]
    }
  | {
      readonly kind: 'index'
      readonly schema: string | null
      readonly name: string
      readonly present: boolean
      readonly table?: { readonly schema: string | null; readonly name: string }
      readonly unique?: boolean
      readonly method?: string
      readonly partial?: boolean
      readonly keyCount?: number
    }
  | {
      readonly kind: 'constraint'
      readonly schema: string | null
      readonly table: string
      readonly name: string
      readonly present: boolean
      readonly contype?: string
      readonly validated?: boolean
    }
  | {
      readonly kind: 'not_null'
      readonly schema: string | null
      readonly table: string
      readonly column: string
      readonly notNull: boolean
    }
  | {
      readonly kind: 'row_security'
      readonly schema: string | null
      readonly table: string
      readonly enabled?: boolean
      readonly forced?: boolean
    }
  | {
      readonly kind: 'policy'
      readonly schema: string | null
      readonly table: string
      readonly name: string
      readonly present: boolean
      readonly command?: string
      readonly permissive?: boolean
      readonly roles?: readonly string[]
    }
  | {
      readonly kind: 'table_privilege'
      readonly schema: string | null
      readonly table: string
      readonly grantee: string
      readonly privileges: readonly string[]
      readonly granted: boolean
    }
  | {
      readonly kind: 'function'
      readonly schema: string | null
      readonly name: string
      /** Identity argument types as written, for `to_regprocedure`. */
      readonly args: readonly string[]
      readonly present: boolean
      readonly securityDefiner?: boolean
      readonly searchPathSet?: boolean
      readonly language?: string
      /** The body exactly as `pg_proc.prosrc` must hold it (SQL-standard bodies are not compared). */
      readonly body?: string | null
    }
  | {
      readonly kind: 'trigger'
      readonly schema: string | null
      readonly table: string
      readonly name: string
      readonly present: boolean
    }
  | {
      readonly kind: 'enum_labels'
      readonly schema: string | null
      readonly name: string
      /** All labels in order, or (for ADD VALUE) the one label that must exist. */
      readonly labels: readonly string[]
      readonly exact: boolean
    }
  | { readonly kind: 'schema'; readonly name: string; readonly present: boolean }
  | {
      readonly kind: 'extension'
      readonly name: string
      readonly present: boolean
      readonly version?: string | null
    }
  | {
      readonly kind: 'type'
      readonly schema: string | null
      readonly name: string
      readonly present: boolean
    }
  | {
      readonly kind: 'comment'
      readonly target: 'table' | 'column'
      readonly schema: string | null
      readonly table: string
      readonly column?: string
      readonly text: string | null
    }

export type Coverage = 'derived' | 'partly_derived' | 'underived'

export interface StatementFacts {
  readonly index: number
  /** Parse node type, e.g. `IndexStmt`. */
  readonly type: string
  /** Readable kind, e.g. `CREATE INDEX CONCURRENTLY`. */
  readonly kind: string
  /** JavaScript string range of the statement text. */
  readonly start: number
  readonly end: number
  /** UTF-8 byte offset of the statement and its 1-based line and column (code points). */
  readonly byteOffset: number
  readonly line: number
  readonly column: number
  readonly objects: readonly ObjectRef[]
  readonly locks: readonly LockFact[]
  readonly rewrite: 'none' | 'table' | 'possible' | 'unknown'
  /** Runs only outside a transaction block (CONCURRENTLY, VACUUM, …). */
  readonly autocommitOnly: boolean
  readonly forbidden: { readonly reason: ForbiddenReason; readonly detail: string } | null
  /** Every compatibility flag; `unknown` when no rule classifies the statement. */
  readonly compatibility: readonly CompatibilityClass[]
  /** A `DO` block or a procedure call: its effects are not derivable. */
  readonly procedural: boolean
  /** A `DO` block that branches on catalog state (conditional DDL). */
  readonly conditional: boolean
  readonly cascade: boolean
  /** `IF NOT EXISTS` / `IF EXISTS` / `OR REPLACE`: expectations must still hold (verification.md L0). */
  readonly conditionalForm: boolean
  readonly expectations: readonly Expectation[]
  readonly coverage: Coverage
  /** Facts some lint rules need. */
  readonly details: StatementDetails
}

export interface StatementDetails {
  readonly createdTable?: { readonly schema: string | null; readonly name: string }
  readonly rlsEnabledOn?: { readonly schema: string | null; readonly name: string }
  readonly grantOnTables?: readonly { readonly schema: string | null; readonly name: string }[]
  readonly securityDefiner?: boolean
  readonly searchPathSet?: boolean
  readonly functionCreated?: boolean
  readonly enumValueAdded?: { readonly type: string; readonly value: string }
  /** String constants used anywhere in the statement (bounded; for enum use in the same transaction). */
  readonly stringConstants: readonly string[]
  readonly createIndex?: {
    readonly concurrent: boolean
    readonly table: { readonly schema: string | null; readonly name: string }
  }
  readonly notNullWithoutProof?: readonly string[]
  readonly constraintValidated?: boolean
  readonly volatileDefault?: boolean
  readonly typeChange?: boolean
  readonly dropColumn?: boolean
  readonly rename?: boolean
  readonly policyAlwaysTrue?: boolean
  readonly extensionCreated?: string
  /** Schema-qualified function or type names this statement references (for extension ownership). */
  readonly referencedNames: readonly string[]
  readonly dataChange?: 'insert' | 'update' | 'delete' | 'merge' | 'truncate'
  readonly unboundedDataChange?: boolean
  /**
   * A `DO` block or a created routine whose body runs dynamic SQL
   * (`EXECUTE` in its text; OD-55 (c)). Detected in the text only: a body
   * without the keyword can still call code that does.
   */
  readonly dynamicSql?: boolean
}

export type MigrationAnalysis =
  | {
      readonly ok: true
      readonly major: SupportedMajor
      readonly statements: readonly StatementFacts[]
    }
  | {
      readonly ok: false
      readonly failure: ParseFailure
      /** UTF-8 byte offset, 1-based line and column of a syntax error, when known. */
      readonly byteOffset: number | null
      readonly line: number | null
      readonly column: number | null
    }

// ----- helpers -----

function obj(value: unknown): JsonNode {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonNode)
    : {}
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function list(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : []
}

function bool(value: unknown): boolean {
  return value === true
}

/** `RangeVar` → schema and name. */
function rangeVar(value: unknown): { schema: string | null; name: string } | null {
  const n = nodeType(value)
  const body = n?.type === 'RangeVar' ? n.body : obj(value)
  const name = str(body['relname'])
  if (name === null) return null
  return { schema: str(body['schemaname']), name }
}

function qualified(ref: { schema: string | null; name: string }): string {
  return ref.schema === null ? ref.name : `${ref.schema}.${ref.name}`
}

/** A list of `String` nodes → schema and name (the last two parts). */
function qualifiedName(value: unknown): { schema: string | null; name: string } | null {
  const parts = names(value)
  if (parts === undefined || parts.length === 0) return null
  const name = parts[parts.length - 1] as string
  return { schema: parts.length > 1 ? (parts[parts.length - 2] as string) : null, name }
}

/** A `TypeName` → its name as written (schema.name, array suffix) and typmods. */
function typeName(value: unknown): { name: string; typmods: string | null } | null {
  const n = nodeType(value)
  const body = n?.type === 'TypeName' ? n.body : obj(value)
  const parts = names(body['names'])
  if (parts === undefined || parts.length === 0) return null
  let name = parts.map((p) => `"${p.replaceAll('"', '""')}"`).join('.')
  if (parts.length === 2 && parts[0] === 'pg_catalog') {
    name = `pg_catalog.${parts[1]}`
  }
  if (bool(body['setof'])) return null
  const bounds = list(body['arrayBounds']).length
  name += '[]'.repeat(bounds)
  const mods: string[] = []
  if (list(body['typmods']).length > 0 && /(^|\.)"?interval"?$/.test(name.replace(/\[\]/g, ''))) {
    // Interval field modifiers are a bit mask, not printed as written.
    return { name, typmods: '?' }
  }
  for (const m of list(body['typmods'])) {
    const c = nodeType(m)
    const v = obj(c?.body['ival'])['ival']
    if (c?.type === 'A_Const' && typeof v === 'number') {
      mods.push(String(v))
    } else if (
      c?.type === 'A_Const' &&
      obj(c.body['ival']) !== undefined &&
      c.body['ival'] !== undefined
    ) {
      // A_Const ival of 0 is printed as {} by libpg_query.
      mods.push('0')
    } else {
      return { name, typmods: '?' }
    }
  }
  return { name, typmods: mods.length === 0 ? null : mods.join(',') }
}

function defElems(options: unknown): Map<string, unknown> {
  const out = new Map<string, unknown>()
  for (const o of list(options)) {
    const d = nodeType(o)
    if (d?.type === 'DefElem') {
      const name = str(d.body['defname'])
      if (name !== null) out.set(name, d.body['arg'])
    }
  }
  return out
}

function stringConstants(node: unknown, cap = 256): string[] {
  const out: string[] = []
  walk(node, (type, body) => {
    if (out.length >= cap) return false
    if (type === 'A_Const') {
      const s = obj(body['sval'])['sval']
      if (typeof s === 'string') out.push(s)
    }
    return undefined
  })
  return out
}

/**
 * Functions, types and operator classes a statement names (bounded), for
 * extension ownership and project denylists. Type names appear wrapped
 * (`TypeName`) and unwrapped (a column's `typeName`), so the tree is scanned
 * by shape, not only by node type.
 */
function referencedNames(node: unknown, cap = 512): string[] {
  const out = new Set<string>()
  const visit = (value: unknown, depth: number): void => {
    if (out.size >= cap || depth > 10_000) return
    if (Array.isArray(value)) {
      for (const v of value) visit(v, depth + 1)
      return
    }
    if (typeof value !== 'object' || value === null) return
    const o = value as Record<string, unknown>
    const n = nodeType(value)
    if (n?.type === 'FuncCall') {
      const q = qualifiedName(n.body['funcname'])
      if (q !== null) out.add(qualified(q))
    }
    if (Array.isArray(o['names']) && ('typemod' in o || 'typmods' in o || 'arrayBounds' in o)) {
      const parts = names(o['names'])
      if (parts !== undefined && parts.length > 0 && parts[0] !== 'pg_catalog')
        out.add(parts.join('.'))
    }
    if (n?.type === 'IndexElem') {
      const parts = names(n.body['opclass'])
      if (parts !== undefined && parts.length > 0) out.add(parts.join('.'))
    }
    for (const v of Object.values(o)) visit(v, depth + 1)
  }
  visit(node, 0)
  return [...out]
}

const VOLATILE_DEFAULTS = new Set([
  'now',
  'clock_timestamp',
  'statement_timestamp',
  'transaction_timestamp',
  'random',
  'gen_random_uuid',
  'uuid_generate_v4',
  'nextval',
  'timeofday',
])

/** Whether a default expression may be volatile (anything but constants, casts and known stable forms). */
function volatileExpression(expr: unknown): boolean {
  let volatile = false
  walk(expr, (type, body) => {
    if (type === 'FuncCall') {
      const n = qualifiedName(body['funcname'])
      // Unknown functions may be volatile: a rewrite cannot be ruled out.
      if (n === null || VOLATILE_DEFAULTS.has(n.name) || n.schema !== 'pg_catalog') {
        volatile = true
      }
    }
    if (type === 'SubLink' || type === 'SQLValueFunction') {
      volatile = volatile || type === 'SubLink'
    }
    return undefined
  })
  return volatile
}

/**
 * Line, column (code points, 1-based) and UTF-8 byte offset of ascending
 * string indices, in one pass over the text.
 */
function positionsOf(
  text: string,
  indices: readonly number[],
): { line: number; column: number; byteOffset: number }[] {
  const out: { line: number; column: number; byteOffset: number }[] = []
  let line = 1
  let column = 1
  let bytes = 0
  let i = 0
  for (const target of indices) {
    for (; i < target && i < text.length; i++) {
      const c = text.charCodeAt(i)
      if (c === 10) {
        line++
        column = 1
      } else if (c < 0xdc00 || c > 0xdfff) {
        column++
      }
      bytes +=
        c < 0x80
          ? 1
          : c < 0x800
            ? 2
            : c >= 0xd800 && c <= 0xdbff
              ? 4
              : c >= 0xdc00 && c <= 0xdfff
                ? 0
                : 3
    }
    out.push({ line, column, byteOffset: bytes })
  }
  return out
}

/** The index of the statement's first token: whitespace and comments before it are skipped. */
function firstToken(text: string, start: number, end: number): number {
  let i = start
  while (i < end) {
    const c = text[i]
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\v' || c === '\f') {
      i++
    } else if (c === '-' && text[i + 1] === '-') {
      while (i < end && text[i] !== '\n') i++
    } else if (c === '/' && text[i + 1] === '*') {
      let depth = 0
      while (i < end) {
        if (text[i] === '/' && text[i + 1] === '*') {
          depth++
          i += 2
        } else if (text[i] === '*' && text[i + 1] === '/') {
          depth--
          i += 2
          if (depth === 0) break
        } else {
          i++
        }
      }
    } else {
      break
    }
  }
  return Math.min(i, end)
}

function lineColumn(text: string, index: number): { line: number; column: number } {
  let line = 1
  let column = 1
  for (let i = 0; i < index && i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c === 10) {
      line++
      column = 1
    } else if (c < 0xdc00 || c > 0xdfff) {
      column++
    }
  }
  return { line, column }
}

function byteOffsetOf(text: string, index: number): number {
  return encodeUtf8(text.slice(0, index)).length
}

// ----- the classifier -----

interface Draft {
  kind: string
  objects: ObjectRef[]
  locks: LockFact[]
  rewrite: StatementFacts['rewrite']
  autocommitOnly: boolean
  forbidden: StatementFacts['forbidden']
  compatibility: CompatibilityClass[]
  procedural: boolean
  conditional: boolean
  cascade: boolean
  conditionalForm: boolean
  expectations: Expectation[]
  /** null: derived when expectations exist; false: partly derived. */
  underivedParts: boolean
  details: {
    -readonly [K in keyof Omit<
      StatementDetails,
      'stringConstants' | 'referencedNames'
    >]?: StatementDetails[K]
  }
}

function draft(kind: string): Draft {
  return {
    kind,
    objects: [],
    locks: [],
    rewrite: 'none',
    autocommitOnly: false,
    forbidden: null,
    compatibility: [],
    procedural: false,
    conditional: false,
    cascade: false,
    conditionalForm: false,
    expectations: [],
    underivedParts: false,
    details: {},
  }
}

function forbid(d: Draft, reason: ForbiddenReason, detail: string): Draft {
  d.forbidden = { reason, detail }
  d.compatibility.push('unknown')
  return d
}

/**
 * Whether a statement names the `exponetdb` schema: a relation in it
 * (`schemaname`, wrapped or not), a qualified name whose schema part it is,
 * or the schema itself (create, drop, grant, comment, alter).
 */
function touchesLedger(node: unknown, depth = 0): boolean {
  if (depth > 10_000) throw new RangeError('parse tree too deep')
  if (Array.isArray(node)) {
    const parts = names(node)
    if (parts !== undefined && parts.length >= 1 && parts.slice(0, -1).includes('exponetdb')) {
      return true
    }
    return node.some((n) => touchesLedger(n, depth + 1))
  }
  if (typeof node !== 'object' || node === null) return false
  const o = node as Record<string, unknown>
  if (o['schemaname'] === 'exponetdb' || o['newschema'] === 'exponetdb') return true
  if (o['renameType'] === 'OBJECT_SCHEMA' && o['subname'] === 'exponetdb') return true
  const n = nodeType(node)
  if (n?.type === 'DropStmt' && n.body['removeType'] === 'OBJECT_SCHEMA') {
    if (JSON.stringify(n.body['objects']).includes('"sval":"exponetdb"')) return true
  }
  if (n?.type === 'GrantStmt' && n.body['objtype'] === 'OBJECT_SCHEMA') {
    if (JSON.stringify(n.body['objects']).includes('"sval":"exponetdb"')) return true
  }
  if (
    (n?.type === 'CommentStmt' || n?.type === 'AlterOwnerStmt' || n?.type === 'RenameStmt') &&
    JSON.stringify(n.body['object'] ?? null) === '{"String":{"sval":"exponetdb"}}'
  ) {
    return true
  }
  return Object.values(o).some((v) => touchesLedger(v, depth + 1))
}

const RELKIND_TABLE = ['r', 'p']

/**
 * A top-level call that changes a setting the executor pins: `set_config`
 * of an engine setting, of a name that is not a constant, or not local
 * (G6 order §23: no unclassified settings call). Function bodies are text
 * and are not walked; the executor checks its guards after every statement.
 */
function settingsCall(node: unknown): string | null {
  let found: string | null = null
  walk(node, (type, body) => {
    if (found !== null) return false
    if (type !== 'FuncCall') return undefined
    const n = qualifiedName(body['funcname'])
    if (n === null || n.name !== 'set_config' || (n.schema !== null && n.schema !== 'pg_catalog')) {
      return undefined
    }
    const args = list(body['args'])
    const name = obj(obj(nodeType(args[0])?.body)['sval'])['sval']
    const local = obj(obj(nodeType(args[2])?.body)['boolval'])['boolval']
    if (typeof name !== 'string' || ENGINE_SETTINGS.has(name.toLowerCase()) || local !== true) {
      found = `set_config(${typeof name === 'string' ? name : '…'})`
    }
    return undefined
  })
  return found
}

function alterTable(d: Draft, body: JsonNode): void {
  const rel = rangeVar(body['relation'])
  const objtype = str(body['objtype'])
  if (rel === null) {
    d.compatibility.push('unknown')
    d.underivedParts = true
    return
  }
  const on = qualified(rel)
  if (bool(body['missing_ok'])) d.conditionalForm = true
  d.objects.push({ kind: objtype === 'OBJECT_INDEX' ? 'index' : 'table', ...rel, action: 'alter' })
  let lock: LockMode = 'ACCESS EXCLUSIVE'
  let severity: LockSeverity = 'high'
  let duration: LockFact['duration'] = 'brief'
  for (const c of list(body['cmds'])) {
    const cmd = nodeType(c)
    if (cmd?.type !== 'AlterTableCmd') {
      d.compatibility.push('unknown')
      d.underivedParts = true
      continue
    }
    const sub = str(cmd.body['subtype'])
    const colname = str(cmd.body['name'])
    if (bool(cmd.body['missing_ok'])) d.conditionalForm = true
    if (cmd.body['behavior'] === 'DROP_CASCADE') d.cascade = true
    const def = nodeType(cmd.body['def'])
    switch (sub) {
      case 'AT_AddColumn': {
        const col = obj(def?.body)
        const name = str(col['colname'])
        const t = typeName(col['typeName'])
        let notNull = false
        let hasDefault = false
        let volatileDefault = false
        for (const k of list(col['constraints'])) {
          const ck = nodeType(k)
          const contype = str(ck?.body['contype'])
          if (contype === 'CONSTR_NOTNULL' || contype === 'CONSTR_PRIMARY') notNull = true
          if (contype === 'CONSTR_DEFAULT') {
            hasDefault = true
            if (volatileExpression(ck?.body['raw_expr'])) volatileDefault = true
          }
          if (contype === 'CONSTR_IDENTITY' || contype === 'CONSTR_GENERATED') {
            hasDefault = true
            if (contype === 'CONSTR_GENERATED') volatileDefault = true
          }
        }
        if (bool(cmd.body['missing_ok'])) d.conditionalForm = true
        if (name !== null) {
          d.objects.push({ kind: 'column', schema: rel.schema, name, table: rel, action: 'create' })
          d.expectations.push({
            kind: 'column',
            schema: rel.schema,
            table: rel.name,
            column: name,
            present: true,
            type: t?.name ?? null,
            typmods: t?.typmods === '?' ? null : (t?.typmods ?? null),
            notNull,
            hasDefault,
          })
        }
        if (volatileDefault) {
          d.rewrite = 'table'
          duration = 'rewrite'
          severity = 'critical'
          d.compatibility.push('data_rewrite')
          d.details.volatileDefault = true
        } else {
          d.compatibility.push(notNull && !hasDefault ? 'potentially_breaking' : 'additive')
        }
        break
      }
      case 'AT_DropColumn':
        if (colname !== null) {
          d.objects.push({
            kind: 'column',
            schema: rel.schema,
            name: colname,
            table: rel,
            action: 'drop',
          })
          d.expectations.push({
            kind: 'column',
            schema: rel.schema,
            table: rel.name,
            column: colname,
            present: false,
          })
        }
        d.compatibility.push('destructive')
        d.details.dropColumn = true
        break
      case 'AT_AlterColumnType': {
        const col = obj(def?.body)
        const t = typeName(col['typeName'])
        if (colname !== null) {
          d.objects.push({
            kind: 'column',
            schema: rel.schema,
            name: colname,
            table: rel,
            action: 'alter',
          })
          d.expectations.push({
            kind: 'column',
            schema: rel.schema,
            table: rel.name,
            column: colname,
            present: true,
            type: t?.name ?? null,
            typmods: t?.typmods === '?' ? null : (t?.typmods ?? null),
          })
        }
        // Whether the change is binary coercible needs the old type: assume a rewrite (C-30).
        d.rewrite = 'possible'
        duration = 'rewrite'
        severity = 'critical'
        d.compatibility.push('data_rewrite', 'potentially_breaking')
        d.details.typeChange = true
        break
      }
      case 'AT_SetNotNull':
        if (colname !== null) {
          d.objects.push({
            kind: 'column',
            schema: rel.schema,
            name: colname,
            table: rel,
            action: 'alter',
          })
          d.expectations.push({
            kind: 'not_null',
            schema: rel.schema,
            table: rel.name,
            column: colname,
            notNull: true,
          })
          d.details.notNullWithoutProof = [...(d.details.notNullWithoutProof ?? []), colname]
        }
        duration = 'scan'
        severity = 'critical'
        d.compatibility.push('potentially_breaking')
        break
      case 'AT_DropNotNull':
        if (colname !== null) {
          d.expectations.push({
            kind: 'not_null',
            schema: rel.schema,
            table: rel.name,
            column: colname,
            notNull: false,
          })
        }
        d.compatibility.push('additive')
        break
      case 'AT_ColumnDefault':
        // SET DEFAULT is metadata only; DROP DEFAULT can break inserts.
        d.compatibility.push(cmd.body['def'] === undefined ? 'potentially_breaking' : 'additive')
        d.underivedParts = true
        break
      case 'AT_AddConstraint': {
        const k = obj(def?.body)
        const contype = str(k['contype'])
        const conname = str(k['conname'])
        const notValid = bool(k['skip_validation'])
        if (conname !== null) {
          d.objects.push({
            kind: 'constraint',
            schema: rel.schema,
            name: conname,
            table: rel,
            action: 'create',
          })
          d.expectations.push({
            kind: 'constraint',
            schema: rel.schema,
            table: rel.name,
            name: conname,
            present: true,
            contype: contype ?? undefined,
            validated: !notValid,
          } as Expectation)
        } else {
          d.underivedParts = true
        }
        if (contype === 'CONSTR_FOREIGN') {
          lock = 'SHARE ROW EXCLUSIVE'
          const pk = rangeVar(k['pktable'])
          if (pk !== null) {
            d.locks.push({
              mode: 'SHARE ROW EXCLUSIVE',
              on: qualified(pk),
              duration: notValid ? 'brief' : 'scan',
              severity: notValid ? 'medium' : 'high',
            })
          }
          severity = notValid ? 'medium' : 'high'
          duration = notValid ? 'brief' : 'scan'
        } else if (contype === 'CONSTR_PRIMARY' || contype === 'CONSTR_UNIQUE') {
          duration = 'scan'
          severity = 'critical'
        } else if (!notValid) {
          duration = 'scan'
          severity = 'critical'
        }
        d.details.constraintValidated = !notValid
        d.compatibility.push('potentially_breaking')
        break
      }
      case 'AT_ValidateConstraint':
        lock = 'SHARE UPDATE EXCLUSIVE'
        severity = 'low'
        duration = 'scan'
        if (colname !== null) {
          d.expectations.push({
            kind: 'constraint',
            schema: rel.schema,
            table: rel.name,
            name: colname,
            present: true,
            validated: true,
          })
        }
        d.compatibility.push('potentially_breaking')
        break
      case 'AT_DropConstraint':
        if (colname !== null) {
          d.objects.push({
            kind: 'constraint',
            schema: rel.schema,
            name: colname,
            table: rel,
            action: 'drop',
          })
          d.expectations.push({
            kind: 'constraint',
            schema: rel.schema,
            table: rel.name,
            name: colname,
            present: false,
          })
        }
        d.compatibility.push('potentially_breaking')
        break
      case 'AT_EnableRowSecurity':
      case 'AT_ForceRowSecurity':
        d.expectations.push({
          kind: 'row_security',
          schema: rel.schema,
          table: rel.name,
          ...(sub === 'AT_EnableRowSecurity' ? { enabled: true } : { forced: true }),
        })
        d.details.rlsEnabledOn = rel
        d.compatibility.push('potentially_breaking')
        break
      case 'AT_DisableRowSecurity':
      case 'AT_NoForceRowSecurity':
        d.expectations.push({
          kind: 'row_security',
          schema: rel.schema,
          table: rel.name,
          ...(sub === 'AT_DisableRowSecurity' ? { enabled: false } : { forced: false }),
        })
        d.compatibility.push('potentially_breaking')
        break
      case 'AT_EnableTrig':
      case 'AT_DisableTrig':
      case 'AT_EnableAlwaysTrig':
      case 'AT_EnableReplicaTrig':
      case 'AT_EnableTrigAll':
      case 'AT_DisableTrigAll':
      case 'AT_EnableTrigUser':
      case 'AT_DisableTrigUser':
        lock = 'SHARE ROW EXCLUSIVE'
        severity = 'medium'
        d.compatibility.push('potentially_breaking')
        d.underivedParts = true
        break
      case 'AT_AttachPartition':
        lock = 'SHARE UPDATE EXCLUSIVE'
        severity = 'high'
        duration = 'scan'
        d.compatibility.push('potentially_breaking')
        d.underivedParts = true
        break
      case 'AT_DetachPartition':
        d.compatibility.push('destructive')
        d.underivedParts = true
        break
      case 'AT_DetachPartitionFinalize':
        d.compatibility.push('destructive')
        d.underivedParts = true
        break
      case 'AT_ChangeOwner':
        d.compatibility.push('potentially_breaking')
        d.underivedParts = true
        break
      case 'AT_SetTableSpace':
        d.rewrite = 'table'
        duration = 'rewrite'
        severity = 'critical'
        d.compatibility.push('data_rewrite')
        d.underivedParts = true
        break
      case 'AT_AddIndex':
      case 'AT_AddIndexConstraint':
        duration = 'scan'
        severity = 'critical'
        d.compatibility.push('potentially_breaking')
        d.underivedParts = true
        break
      case 'AT_SetStatistics':
      case 'AT_SetOptions':
      case 'AT_ResetOptions':
      case 'AT_SetStorage':
      case 'AT_SetRelOptions':
      case 'AT_ResetRelOptions':
      case 'AT_ReplicaIdentity':
      case 'AT_ClusterOn':
      case 'AT_DropCluster':
        lock = sub === 'AT_SetStatistics' ? 'SHARE UPDATE EXCLUSIVE' : 'ACCESS EXCLUSIVE'
        d.compatibility.push('additive')
        d.underivedParts = true
        break
      default:
        d.compatibility.push('unknown')
        d.underivedParts = true
        severity = 'unknown'
    }
  }
  d.locks.unshift({ mode: lock, on, duration, severity })
  if (d.rewrite === 'table' || d.rewrite === 'possible') {
    d.locks[0] = { mode: 'ACCESS EXCLUSIVE', on, duration: 'rewrite', severity: 'critical' }
  }
  void RELKIND_TABLE
}

function dropObjectKind(removeType: string | null): ObjectKind {
  switch (removeType) {
    case 'OBJECT_TABLE':
      return 'table'
    case 'OBJECT_INDEX':
      return 'index'
    case 'OBJECT_VIEW':
      return 'view'
    case 'OBJECT_MATVIEW':
      return 'materialized_view'
    case 'OBJECT_SEQUENCE':
      return 'sequence'
    case 'OBJECT_SCHEMA':
      return 'schema'
    case 'OBJECT_FUNCTION':
      return 'function'
    case 'OBJECT_PROCEDURE':
      return 'procedure'
    case 'OBJECT_TYPE':
    case 'OBJECT_DOMAIN':
      return 'type'
    case 'OBJECT_POLICY':
      return 'policy'
    case 'OBJECT_TRIGGER':
      return 'trigger'
    case 'OBJECT_EXTENSION':
      return 'extension'
    default:
      return 'other'
  }
}

function dropStmt(d: Draft, body: JsonNode): void {
  const kind = dropObjectKind(str(body['removeType']))
  const concurrent = bool(body['concurrent'])
  if (bool(body['missing_ok'])) d.conditionalForm = true
  if (body['behavior'] === 'DROP_CASCADE') d.cascade = true
  d.kind = `DROP ${kind.toUpperCase().replace('_', ' ')}${concurrent ? ' CONCURRENTLY' : ''}`
  if (concurrent) d.autocommitOnly = true
  for (const o of list(body['objects'])) {
    const n = nodeType(o)
    let ref: { schema: string | null; name: string } | null = null
    let table: { schema: string | null; name: string } | undefined
    if (n?.type === 'List') {
      const parts = names(n.body['items'])
      if (parts !== undefined && parts.length > 0) {
        if (kind === 'policy' || kind === 'trigger') {
          // [schema.]table.name
          const name = parts[parts.length - 1] as string
          const tableParts = parts.slice(0, -1)
          table = {
            schema: tableParts.length > 1 ? (tableParts[tableParts.length - 2] as string) : null,
            name: tableParts[tableParts.length - 1] as string,
          }
          ref = { schema: table.schema, name }
        } else {
          ref = {
            schema: parts.length > 1 ? (parts[parts.length - 2] as string) : null,
            name: parts[parts.length - 1] as string,
          }
        }
      }
    } else if (n?.type === 'String') {
      ref = { schema: null, name: str(n.body['sval']) ?? '' }
    } else if (n?.type === 'ObjectWithArgs') {
      ref = qualifiedName(n.body['objname'])
    } else if (n?.type === 'TypeName') {
      ref = qualifiedName(n.body['names'])
    }
    if (ref === null) {
      d.underivedParts = true
      continue
    }
    d.objects.push({ kind, ...ref, ...(table === undefined ? {} : { table }), action: 'drop' })
    switch (kind) {
      case 'table':
        d.expectations.push({ kind: 'relation', ...ref, relkinds: ['r', 'p'], present: false })
        d.locks.push({
          mode: 'ACCESS EXCLUSIVE',
          on: qualified(ref),
          duration: 'brief',
          severity: 'high',
        })
        break
      case 'view':
        d.expectations.push({ kind: 'relation', ...ref, relkinds: ['v'], present: false })
        d.locks.push({
          mode: 'ACCESS EXCLUSIVE',
          on: qualified(ref),
          duration: 'brief',
          severity: 'high',
        })
        break
      case 'materialized_view':
        d.expectations.push({ kind: 'relation', ...ref, relkinds: ['m'], present: false })
        d.locks.push({
          mode: 'ACCESS EXCLUSIVE',
          on: qualified(ref),
          duration: 'brief',
          severity: 'high',
        })
        break
      case 'sequence':
        d.expectations.push({ kind: 'relation', ...ref, relkinds: ['S'], present: false })
        break
      case 'index':
        d.expectations.push({ kind: 'index', ...ref, present: false })
        d.locks.push({
          mode: concurrent ? 'SHARE UPDATE EXCLUSIVE' : 'ACCESS EXCLUSIVE',
          on: `table of ${qualified(ref)}`,
          duration: 'brief',
          severity: concurrent ? 'low' : 'high',
        })
        break
      case 'schema':
        d.expectations.push({ kind: 'schema', name: ref.name, present: false })
        break
      case 'policy':
        if (table !== undefined) {
          d.expectations.push({
            kind: 'policy',
            schema: table.schema,
            table: table.name,
            name: ref.name,
            present: false,
          })
          d.locks.push({
            mode: 'ACCESS EXCLUSIVE',
            on: qualified(table),
            duration: 'brief',
            severity: 'high',
          })
        }
        break
      case 'trigger':
        if (table !== undefined) {
          d.expectations.push({
            kind: 'trigger',
            schema: table.schema,
            table: table.name,
            name: ref.name,
            present: false,
          })
          d.locks.push({
            mode: 'SHARE ROW EXCLUSIVE',
            on: qualified(table),
            duration: 'brief',
            severity: 'medium',
          })
        }
        break
      case 'type':
        d.expectations.push({ kind: 'type', ...ref, present: false })
        break
      case 'extension':
        d.expectations.push({ kind: 'extension', name: ref.name, present: false })
        break
      default:
        d.underivedParts = true
    }
  }
  d.compatibility.push(
    kind === 'index' || kind === 'policy' || kind === 'trigger'
      ? 'potentially_breaking'
      : 'destructive',
  )
}

function functionArgs(parameters: unknown): string[] | null {
  const out: string[] = []
  for (const p of list(parameters)) {
    const fp = nodeType(p)
    if (fp?.type !== 'FunctionParameter') return null
    const mode = str(fp.body['mode'])
    if (mode === 'FUNC_PARAM_OUT' || mode === 'FUNC_PARAM_TABLE') continue
    const t = typeName(fp.body['argType'])
    if (t === null || t.typmods === '?') return null
    out.push(t.name)
  }
  return out
}

/** Dynamic SQL in a procedural body (PL/pgSQL `EXECUTE`), by its text (OD-55 (c)). */
const DYNAMIC_SQL = /\bEXECUTE\b/i

function createFunction(d: Draft, body: JsonNode): void {
  const name = qualifiedName(body['funcname'])
  const procedure = bool(body['is_procedure'])
  d.kind = `CREATE${bool(body['replace']) ? ' OR REPLACE' : ''} ${procedure ? 'PROCEDURE' : 'FUNCTION'}`
  if (bool(body['replace'])) d.conditionalForm = true
  const opts = defElems(body['options'])
  const security = obj(nodeType(opts.get('security'))?.body)['boolval'] === true
  const setArg = nodeType(opts.get('set'))
  let searchPathSet = false
  for (const o of list(body['options'])) {
    const de = nodeType(o)
    if (de?.type === 'DefElem' && de.body['defname'] === 'set') {
      const v = nodeType(de.body['arg'])
      if (v?.type === 'VariableSetStmt' && str(v.body['name'])?.toLowerCase() === 'search_path') {
        searchPathSet = true
      }
    }
  }
  void setArg
  const language = str(nodeType(opts.get('language'))?.body['sval'])
  const as = nodeType(opts.get('as'))
  let bodyText: string | null = null
  if (as?.type === 'List') {
    const items = names(as.body['items'])
    if (items !== undefined && items.length === 1) bodyText = items[0] ?? null
  } else if (as?.type === 'String') {
    bodyText = str(as.body['sval'])
  }
  d.details.securityDefiner = security
  d.details.searchPathSet = searchPathSet
  d.details.functionCreated = true
  if (bodyText !== null && DYNAMIC_SQL.test(bodyText)) d.details.dynamicSql = true
  const args = functionArgs(body['parameters'])
  if (name === null) {
    d.underivedParts = true
  } else {
    d.objects.push({ kind: procedure ? 'procedure' : 'function', ...name, action: 'create' })
    if (args === null) {
      d.underivedParts = true
    } else {
      d.expectations.push({
        kind: 'function',
        ...name,
        args,
        present: true,
        securityDefiner: security,
        searchPathSet,
        ...(language === null ? {} : { language }),
        body: body['sql_body'] === undefined ? bodyText : null,
      })
    }
  }
  // A replaced function may change behavior for callers.
  d.compatibility.push(bool(body['replace']) ? 'potentially_breaking' : 'additive')
}

function createTable(d: Draft, body: JsonNode, rel: { schema: string | null; name: string }): void {
  const ifNotExists = bool(body['if_not_exists'])
  d.kind = `CREATE TABLE${ifNotExists ? ' IF NOT EXISTS' : ''}`
  if (ifNotExists) d.conditionalForm = true
  d.objects.push({ kind: 'table', ...rel, action: 'create' })
  d.details.createdTable = rel
  const partitioned = obj(body['partspec']) !== undefined && body['partspec'] !== undefined
  d.expectations.push({
    kind: 'relation',
    ...rel,
    relkinds: partitioned ? ['p'] : ['r'],
    present: true,
  })
  const columns: string[] = []
  let underived = list(body['inhRelations']).length > 0 || body['partbound'] !== undefined
  for (const e of list(body['tableElts'])) {
    const el = nodeType(e)
    if (el?.type === 'ColumnDef') {
      const name = str(el.body['colname'])
      const t = typeName(el.body['typeName'])
      let notNull = false
      let hasDefault = false
      for (const k of list(el.body['constraints'])) {
        const contype = str(nodeType(k)?.body['contype'])
        if (contype === 'CONSTR_NOTNULL' || contype === 'CONSTR_PRIMARY') notNull = true
        if (
          contype === 'CONSTR_DEFAULT' ||
          contype === 'CONSTR_IDENTITY' ||
          contype === 'CONSTR_GENERATED'
        )
          hasDefault = true
      }
      if (name === null) {
        underived = true
        continue
      }
      columns.push(name)
      d.expectations.push({
        kind: 'column',
        schema: rel.schema,
        table: rel.name,
        column: name,
        present: true,
        type: t === null ? null : t.name,
        typmods: t === null || t.typmods === '?' ? null : t.typmods,
        // A table-level key can make a column NOT NULL: only a stated value is checked.
        notNull: notNull ? true : null,
        hasDefault: hasDefault ? true : null,
      })
    } else if (el?.type === 'Constraint') {
      const conname = str(el.body['conname'])
      if (conname !== null) {
        d.expectations.push({
          kind: 'constraint',
          schema: rel.schema,
          table: rel.name,
          name: conname,
          present: true,
        })
      }
      // Table-level PRIMARY KEY makes its columns NOT NULL; not derived here.
    } else {
      underived = true
    }
  }
  if (!underived) {
    d.expectations.push({ kind: 'columns_exactly', schema: rel.schema, table: rel.name, columns })
  } else {
    d.underivedParts = true
  }
  d.compatibility.push('additive')
}

function grantStmt(d: Draft, body: JsonNode): void {
  const isGrant = bool(body['is_grant'])
  const objtype = str(body['objtype'])
  d.kind = isGrant ? 'GRANT' : 'REVOKE'
  const privileges: string[] = []
  let all = false
  for (const p of list(body['privileges'])) {
    const ap = nodeType(p)
    const n = str(ap?.body['priv_name'])
    if (n === null || list(ap?.body['cols']).length > 0) {
      d.underivedParts = true
      continue
    }
    privileges.push(n.toUpperCase())
  }
  if (list(body['privileges']).length === 0) all = true
  const grantees: string[] = []
  for (const g of list(body['grantees'])) {
    const r = nodeType(g)
    const type = str(r?.body['roletype'])
    if (type === 'ROLESPEC_PUBLIC') grantees.push('PUBLIC')
    else if (type === 'ROLESPEC_CSTRING') grantees.push(str(r?.body['rolename']) ?? '')
    else d.underivedParts = true
  }
  if (body['targtype'] !== 'ACL_TARGET_OBJECT' || objtype !== 'OBJECT_TABLE' || all) {
    d.underivedParts = true
  }
  const tables: { schema: string | null; name: string }[] = []
  for (const o of list(body['objects'])) {
    const rel = objtype === 'OBJECT_TABLE' ? rangeVar(o) : null
    if (rel === null) {
      d.underivedParts = true
      continue
    }
    tables.push(rel)
    d.objects.push({ kind: 'table', ...rel, action: isGrant ? 'grant' : 'revoke' })
    if (objtype === 'OBJECT_TABLE' && !all && body['targtype'] === 'ACL_TARGET_OBJECT') {
      for (const grantee of grantees) {
        d.expectations.push({
          kind: 'table_privilege',
          schema: rel.schema,
          table: rel.name,
          grantee,
          privileges,
          granted: isGrant,
        })
      }
    }
  }
  if (isGrant) d.details.grantOnTables = tables
  d.compatibility.push(isGrant ? 'additive' : 'potentially_breaking')
}

function variableSet(d: Draft, body: JsonNode): void {
  const kind = str(body['kind'])
  const name = str(body['name'])?.toLowerCase() ?? null
  const local = bool(body['is_local'])
  if (kind === 'VAR_RESET_ALL') {
    forbid(d, 'session_setting', 'RESET ALL')
    return
  }
  if (name === 'role' || name === 'session_authorization') {
    forbid(d, 'role_switch', name === 'role' ? 'SET ROLE' : 'SET SESSION AUTHORIZATION')
    return
  }
  if (
    name === 'transaction_isolation' ||
    name === 'transaction_read_only' ||
    kind === 'VAR_SET_MULTI'
  ) {
    forbid(d, 'transaction_control', 'SET TRANSACTION')
    return
  }
  if (name !== null && ENGINE_SETTINGS.has(name)) {
    forbid(d, 'engine_setting', `${local ? 'SET LOCAL' : 'SET'} ${name}`)
    return
  }
  if (!local) {
    forbid(d, 'session_setting', `SET ${name ?? ''} (without LOCAL)`)
    return
  }
  d.kind = 'SET LOCAL'
  d.compatibility.push('additive')
  d.underivedParts = true
}

/** Classifies one parsed statement. */
function classify(statement: ParsedStatement, trusted: ReadonlySet<string>): Draft {
  const { type, node: body } = statement
  const d = draft(
    type
      .replace(/Stmt$/, '')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .toUpperCase(),
  )
  // The database itself belongs to the cluster's operator, not to a migration: its grants,
  // comment, label, owner and name, like ALTER DATABASE below. An execution role may own its
  // database (ADR-0034 §3.1), so these would otherwise run (a REVOKE CONNECT from ExponetDB).
  const objectType = str(body['objtype']) ?? str(body['objectType']) ?? str(body['renameType'])
  if (
    objectType === 'OBJECT_DATABASE' &&
    ['GrantStmt', 'CommentStmt', 'SecLabelStmt', 'AlterOwnerStmt', 'RenameStmt'].includes(type)
  ) {
    return forbid(d, 'database', type)
  }
  switch (type) {
    case 'TransactionStmt':
      return forbid(d, 'transaction_control', str(body['kind']) ?? 'transaction control')
    case 'VariableSetStmt':
      variableSet(d, body)
      return d
    case 'DiscardStmt':
      return forbid(d, 'discard', 'DISCARD')
    case 'CreateRoleStmt':
    case 'AlterRoleStmt':
    case 'AlterRoleSetStmt':
    case 'DropRoleStmt':
    case 'GrantRoleStmt':
    case 'ReassignOwnedStmt':
      return forbid(d, 'role_management', type)
    case 'AlterSystemStmt':
      return forbid(d, 'alter_system', 'ALTER SYSTEM')
    case 'CreatedbStmt':
    case 'DropdbStmt':
    case 'AlterDatabaseStmt':
    case 'AlterDatabaseSetStmt':
    case 'AlterDatabaseRefreshCollStmt':
      return forbid(d, 'database', type)
    case 'CreateTableSpaceStmt':
    case 'DropTableSpaceStmt':
    case 'AlterTableSpaceOptionsStmt':
    case 'AlterTableMoveAllStmt':
      return forbid(d, 'tablespace', type)
    case 'LoadStmt':
      return forbid(d, 'load', 'LOAD')
    case 'CheckPointStmt':
    case 'CreateSubscriptionStmt':
    case 'AlterSubscriptionStmt':
    case 'DropSubscriptionStmt':
    case 'CreatePublicationStmt':
    case 'AlterPublicationStmt':
    case 'CreateFdwStmt':
    case 'AlterFdwStmt':
    case 'CreateForeignServerStmt':
    case 'AlterForeignServerStmt':
    case 'CreateUserMappingStmt':
    case 'AlterUserMappingStmt':
    case 'DropUserMappingStmt':
    case 'CreateEventTrigStmt':
    case 'AlterEventTrigStmt':
    case 'CreatePLangStmt':
      return forbid(d, 'privileged', type)
    case 'PrepareStmt':
    case 'ExecuteStmt':
    case 'DeallocateStmt':
    case 'DeclareCursorStmt':
    case 'FetchStmt':
    case 'ClosePortalStmt':
    case 'ListenStmt':
    case 'UnlistenStmt':
      return forbid(d, 'cursor_or_prepared', type)
    case 'CopyStmt':
      if (str(body['filename']) !== null || bool(body['is_program'])) {
        return forbid(
          d,
          'copy_server_file',
          bool(body['is_program']) ? 'COPY … PROGRAM' : 'COPY … FILE',
        )
      }
      // COPY FROM STDIN has no data in a migration file; COPY TO STDOUT returns rows.
      return forbid(d, 'copy_server_file', 'COPY')
    default:
      break
  }
  if (touchesLedger({ [type]: body })) {
    return forbid(d, 'ledger_schema', 'the exponetdb schema')
  }
  const setting = settingsCall(body)
  if (setting !== null) {
    return forbid(d, 'engine_setting', setting)
  }
  switch (type) {
    case 'CreateStmt': {
      const rel = rangeVar(body['relation'])
      if (rel === null) {
        d.compatibility.push('unknown')
        d.underivedParts = true
        return d
      }
      createTable(d, body, rel)
      return d
    }
    case 'AlterTableStmt':
      d.kind = `ALTER ${str(body['objtype']) === 'OBJECT_INDEX' ? 'INDEX' : 'TABLE'}`
      alterTable(d, body)
      return d
    case 'IndexStmt': {
      const rel = rangeVar(body['relation'])
      const concurrent = bool(body['concurrent'])
      const name = str(body['idxname'])
      d.kind = `CREATE${bool(body['unique']) ? ' UNIQUE' : ''} INDEX${concurrent ? ' CONCURRENTLY' : ''}${bool(body['if_not_exists']) ? ' IF NOT EXISTS' : ''}`
      if (bool(body['if_not_exists'])) d.conditionalForm = true
      d.autocommitOnly = concurrent
      if (rel === null) {
        d.compatibility.push('unknown')
        d.underivedParts = true
        return d
      }
      d.details.createIndex = { concurrent, table: rel }
      if (name !== null) {
        d.objects.push({ kind: 'index', schema: rel.schema, name, table: rel, action: 'create' })
        d.expectations.push({
          kind: 'index',
          schema: rel.schema,
          name,
          table: rel,
          present: true,
          unique: bool(body['unique']),
          method: str(body['accessMethod']) ?? 'btree',
          partial: body['whereClause'] !== undefined,
          keyCount: list(body['indexParams']).length,
        })
      } else {
        // An unnamed index gets a generated name: not derivable.
        d.underivedParts = true
      }
      d.objects.push({ kind: 'table', ...rel, action: 'alter' })
      d.locks.push({
        mode: concurrent ? 'SHARE UPDATE EXCLUSIVE' : 'SHARE',
        on: qualified(rel),
        duration: 'scan',
        severity: concurrent ? 'low' : 'high',
      })
      d.compatibility.push(bool(body['unique']) ? 'potentially_breaking' : 'additive')
      return d
    }
    case 'DropStmt':
      dropStmt(d, body)
      return d
    case 'RenameStmt': {
      const rel = rangeVar(body['relation'])
      const newname = str(body['newname'])
      const sub = str(body['subname'])
      const renameType = str(body['renameType'])
      d.kind = 'RENAME'
      d.details.rename = true
      d.compatibility.push('potentially_breaking')
      if (rel !== null && newname !== null) {
        d.locks.push({
          mode: 'ACCESS EXCLUSIVE',
          on: qualified(rel),
          duration: 'brief',
          severity: 'high',
        })
        if (renameType === 'OBJECT_COLUMN' && sub !== null) {
          d.objects.push({
            kind: 'column',
            schema: rel.schema,
            name: sub,
            table: rel,
            action: 'rename',
          })
          d.expectations.push(
            { kind: 'column', schema: rel.schema, table: rel.name, column: sub, present: false },
            { kind: 'column', schema: rel.schema, table: rel.name, column: newname, present: true },
          )
        } else if (renameType === 'OBJECT_TABLE') {
          d.objects.push({ kind: 'table', ...rel, action: 'rename' })
          d.expectations.push(
            { kind: 'relation', ...rel, relkinds: ['r', 'p'], present: false },
            {
              kind: 'relation',
              schema: rel.schema,
              name: newname,
              relkinds: ['r', 'p'],
              present: true,
            },
          )
        } else {
          d.objects.push({ kind: 'relation', ...rel, action: 'rename' })
          d.underivedParts = true
        }
      } else {
        d.underivedParts = true
      }
      return d
    }
    case 'CreatePolicyStmt': {
      const rel = rangeVar(body['table'])
      const name = str(body['policy_name'])
      d.kind = 'CREATE POLICY'
      const cmd = str(body['cmd_name']) ?? 'all'
      const roles: string[] = []
      for (const r of list(body['roles'])) {
        const rs = nodeType(r)
        const t = str(rs?.body['roletype'])
        roles.push(t === 'ROLESPEC_PUBLIC' ? 'public' : (str(rs?.body['rolename']) ?? '?'))
      }
      const alwaysTrue = (expr: unknown) =>
        obj(nodeType(expr)?.body['boolval'])['boolval'] === true &&
        nodeType(expr)?.type === 'A_Const'
      if (cmd !== 'select' && (alwaysTrue(body['qual']) || alwaysTrue(body['with_check']))) {
        d.details.policyAlwaysTrue = true
      }
      if (rel !== null && name !== null) {
        d.objects.push({ kind: 'policy', schema: rel.schema, name, table: rel, action: 'create' })
        d.locks.push({
          mode: 'ACCESS EXCLUSIVE',
          on: qualified(rel),
          duration: 'brief',
          severity: 'high',
        })
        d.expectations.push({
          kind: 'policy',
          schema: rel.schema,
          table: rel.name,
          name,
          present: true,
          command: cmd,
          permissive: body['permissive'] !== false,
          roles: roles.length === 0 ? ['public'] : roles,
        })
      } else {
        d.underivedParts = true
      }
      d.compatibility.push(body['permissive'] === false ? 'potentially_breaking' : 'additive')
      return d
    }
    case 'AlterPolicyStmt': {
      const rel = rangeVar(body['table'])
      d.kind = 'ALTER POLICY'
      if (rel !== null) {
        d.locks.push({
          mode: 'ACCESS EXCLUSIVE',
          on: qualified(rel),
          duration: 'brief',
          severity: 'high',
        })
        d.objects.push({
          kind: 'policy',
          schema: rel.schema,
          name: str(body['policy_name']) ?? '?',
          table: rel,
          action: 'alter',
        })
      }
      d.compatibility.push('potentially_breaking')
      d.underivedParts = true
      return d
    }
    case 'GrantStmt':
      grantStmt(d, body)
      return d
    case 'AlterDefaultPrivilegesStmt':
      d.kind = 'ALTER DEFAULT PRIVILEGES'
      d.compatibility.push('additive')
      d.underivedParts = true
      return d
    case 'CreateFunctionStmt':
      createFunction(d, body)
      return d
    case 'CreateTrigStmt': {
      const rel = rangeVar(body['relation'])
      const name = str(body['trigname'])
      d.kind = `CREATE${bool(body['replace']) ? ' OR REPLACE' : ''} TRIGGER`
      if (rel !== null && name !== null) {
        d.objects.push({ kind: 'trigger', schema: rel.schema, name, table: rel, action: 'create' })
        d.locks.push({
          mode: 'SHARE ROW EXCLUSIVE',
          on: qualified(rel),
          duration: 'brief',
          severity: 'medium',
        })
        d.expectations.push({
          kind: 'trigger',
          schema: rel.schema,
          table: rel.name,
          name,
          present: true,
        })
      } else {
        d.underivedParts = true
      }
      d.compatibility.push('potentially_breaking')
      return d
    }
    case 'ViewStmt': {
      const rel = rangeVar(body['view'])
      d.kind = `CREATE${bool(body['replace']) ? ' OR REPLACE' : ''} VIEW`
      if (bool(body['replace'])) d.conditionalForm = true
      if (rel !== null) {
        d.objects.push({ kind: 'view', ...rel, action: 'create' })
        d.expectations.push({ kind: 'relation', ...rel, relkinds: ['v'], present: true })
      }
      d.compatibility.push(bool(body['replace']) ? 'potentially_breaking' : 'additive')
      return d
    }
    case 'CreateTableAsStmt': {
      const into = obj(nodeType(body['into'])?.body ?? body['into'])
      const rel = rangeVar(into['rel'])
      const matview = body['objtype'] === 'OBJECT_MATVIEW'
      d.kind = matview ? 'CREATE MATERIALIZED VIEW' : 'CREATE TABLE AS'
      if (bool(body['if_not_exists'])) d.conditionalForm = true
      if (rel !== null) {
        d.objects.push({ kind: matview ? 'materialized_view' : 'table', ...rel, action: 'create' })
        d.expectations.push({
          kind: 'relation',
          ...rel,
          relkinds: matview ? ['m'] : ['r'],
          present: true,
        })
      }
      // The query runs: its reads and function calls are not derivable.
      d.underivedParts = true
      d.compatibility.push('additive')
      return d
    }
    case 'RefreshMatViewStmt': {
      const rel = rangeVar(body['relation'])
      const concurrent = bool(body['concurrent'])
      d.kind = `REFRESH MATERIALIZED VIEW${concurrent ? ' CONCURRENTLY' : ''}`
      if (rel !== null) {
        d.locks.push({
          mode: concurrent ? 'EXCLUSIVE' : 'ACCESS EXCLUSIVE',
          on: qualified(rel),
          duration: 'query',
          severity: concurrent ? 'medium' : 'high',
        })
      }
      d.compatibility.push('data_rewrite')
      d.underivedParts = true
      return d
    }
    case 'CreateSeqStmt': {
      const rel = rangeVar(body['sequence'])
      d.kind = 'CREATE SEQUENCE'
      if (bool(body['if_not_exists'])) d.conditionalForm = true
      if (rel !== null) {
        d.objects.push({ kind: 'sequence', ...rel, action: 'create' })
        d.expectations.push({ kind: 'relation', ...rel, relkinds: ['S'], present: true })
      }
      d.compatibility.push('additive')
      return d
    }
    case 'AlterSeqStmt':
      d.kind = 'ALTER SEQUENCE'
      d.compatibility.push('potentially_breaking')
      d.underivedParts = true
      return d
    case 'CreateSchemaStmt': {
      const name = str(body['schemaname'])
      d.kind = 'CREATE SCHEMA'
      if (bool(body['if_not_exists'])) d.conditionalForm = true
      if (name !== null) {
        d.objects.push({ kind: 'schema', schema: null, name, action: 'create' })
        d.expectations.push({ kind: 'schema', name, present: true })
      }
      if (list(body['schemaElts']).length > 0) d.underivedParts = true
      d.compatibility.push('additive')
      return d
    }
    case 'CreateEnumStmt': {
      const n = qualifiedName(body['typeName'])
      d.kind = 'CREATE TYPE AS ENUM'
      const labels = list(body['vals']).map((v) => str(nodeType(v)?.body['sval']) ?? '')
      if (n !== null) {
        d.objects.push({ kind: 'type', ...n, action: 'create' })
        d.expectations.push({ kind: 'enum_labels', ...n, labels, exact: true })
      }
      d.compatibility.push('additive')
      return d
    }
    case 'AlterEnumStmt': {
      const n = qualifiedName(body['typeName'])
      const value = str(body['newVal'])
      d.kind = body['oldVal'] === undefined ? 'ALTER TYPE ADD VALUE' : 'ALTER TYPE RENAME VALUE'
      if (bool(body['skipIfNewValExists'])) d.conditionalForm = true
      if (n !== null && value !== null) {
        d.objects.push({ kind: 'type', ...n, action: 'alter' })
        d.expectations.push({ kind: 'enum_labels', ...n, labels: [value], exact: false })
        if (body['oldVal'] === undefined) {
          d.details.enumValueAdded = { type: qualified(n), value }
        }
      }
      d.compatibility.push(body['oldVal'] === undefined ? 'additive' : 'potentially_breaking')
      return d
    }
    case 'CompositeTypeStmt':
    case 'CreateDomainStmt':
    case 'CreateRangeStmt': {
      const n =
        type === 'CompositeTypeStmt'
          ? rangeVar(body['typevar'])
          : qualifiedName(type === 'CreateDomainStmt' ? body['domainname'] : body['typeName'])
      d.kind = type === 'CreateDomainStmt' ? 'CREATE DOMAIN' : 'CREATE TYPE'
      if (n !== null) {
        d.objects.push({ kind: 'type', ...n, action: 'create' })
        d.expectations.push({ kind: 'type', ...n, present: true })
      }
      d.compatibility.push('additive')
      return d
    }
    case 'CreateExtensionStmt': {
      const name = str(body['extname'])
      d.kind = `CREATE EXTENSION${bool(body['if_not_exists']) ? ' IF NOT EXISTS' : ''}`
      if (name === null || !trusted.has(name)) {
        return forbid(d, 'extension_not_trusted', name ?? '?')
      }
      if (bool(body['if_not_exists'])) d.conditionalForm = true
      d.details.extensionCreated = name
      d.objects.push({ kind: 'extension', schema: null, name, action: 'create' })
      const version = str(nodeType(defElems(body['options']).get('new_version'))?.body['sval'])
      d.expectations.push({ kind: 'extension', name, present: true, version })
      d.compatibility.push('additive')
      return d
    }
    case 'CommentStmt': {
      const objtype = str(body['objtype'])
      const text = str(body['comment'])
      d.kind = 'COMMENT ON'
      const target = nodeType(body['object'])
      const parts = target?.type === 'List' ? names(target.body['items']) : undefined
      if (objtype === 'OBJECT_TABLE' && parts !== undefined && parts.length > 0) {
        d.expectations.push({
          kind: 'comment',
          target: 'table',
          schema: parts.length > 1 ? (parts[parts.length - 2] as string) : null,
          table: parts[parts.length - 1] as string,
          text,
        })
      } else if (objtype === 'OBJECT_COLUMN' && parts !== undefined && parts.length >= 2) {
        d.expectations.push({
          kind: 'comment',
          target: 'column',
          schema: parts.length > 2 ? (parts[parts.length - 3] as string) : null,
          table: parts[parts.length - 2] as string,
          column: parts[parts.length - 1] as string,
          text,
        })
      } else {
        d.underivedParts = true
      }
      d.compatibility.push('additive')
      return d
    }
    case 'DoStmt': {
      d.kind = 'DO'
      d.procedural = true
      const as = nodeType(defElems(body['args']).get('as'))
      const code = str(as?.body['sval']) ?? ''
      if (DYNAMIC_SQL.test(code)) d.details.dynamicSql = true
      d.conditional =
        /\b(pg_roles|pg_catalog|to_regclass|to_regproc|to_regtype|information_schema|pg_namespace|pg_class|pg_proc|current_setting)\b/i.test(
          code,
        )
      d.compatibility.push('unknown')
      d.underivedParts = true
      return d
    }
    case 'CallStmt':
      d.kind = 'CALL'
      d.procedural = true
      d.compatibility.push('unknown')
      d.underivedParts = true
      return d
    case 'InsertStmt':
    case 'UpdateStmt':
    case 'DeleteStmt':
    case 'MergeStmt': {
      const rel = rangeVar(body['relation'])
      const verb = type.replace('Stmt', '').toLowerCase() as
        | 'insert'
        | 'update'
        | 'delete'
        | 'merge'
      d.kind = verb.toUpperCase()
      d.details.dataChange = verb
      if (rel !== null) {
        d.objects.push({ kind: 'table', ...rel, action: 'write' })
        d.locks.push({
          mode: 'ROW EXCLUSIVE',
          on: qualified(rel),
          duration: 'query',
          severity: 'low',
        })
      }
      const unbounded =
        (verb === 'update' || verb === 'delete') && body['whereClause'] === undefined
      d.details.unboundedDataChange = unbounded
      d.compatibility.push(
        verb === 'delete'
          ? 'destructive'
          : verb === 'insert'
            ? 'additive'
            : unbounded
              ? 'data_rewrite'
              : 'data_rewrite',
      )
      // Data changes are covered only by verify.sql (verification.md §3).
      d.underivedParts = true
      return d
    }
    case 'TruncateStmt':
      d.kind = 'TRUNCATE'
      d.details.dataChange = 'truncate'
      for (const r of list(body['relations'])) {
        const rel = rangeVar(r)
        if (rel !== null) {
          d.objects.push({ kind: 'table', ...rel, action: 'write' })
          d.locks.push({
            mode: 'ACCESS EXCLUSIVE',
            on: qualified(rel),
            duration: 'brief',
            severity: 'high',
          })
        }
      }
      d.compatibility.push('destructive')
      d.underivedParts = true
      return d
    case 'VacuumStmt': {
      const vacuum = bool(body['is_vacuumcmd'])
      const full = list(body['options']).some((o) => str(nodeType(o)?.body['defname']) === 'full')
      d.kind = vacuum ? (full ? 'VACUUM FULL' : 'VACUUM') : 'ANALYZE'
      d.autocommitOnly = vacuum
      for (const r of list(body['rels'])) {
        const rel = rangeVar(obj(nodeType(r)?.body)['relation'])
        if (rel !== null) {
          d.locks.push({
            mode: full ? 'ACCESS EXCLUSIVE' : 'SHARE UPDATE EXCLUSIVE',
            on: qualified(rel),
            duration: full ? 'rewrite' : 'scan',
            severity: full ? 'critical' : 'low',
          })
        }
      }
      if (full) d.rewrite = 'table'
      d.compatibility.push(full ? 'data_rewrite' : 'additive')
      d.underivedParts = true
      return d
    }
    case 'ReindexStmt': {
      const concurrent = list(body['params']).some(
        (o) => str(nodeType(o)?.body['defname']) === 'concurrently',
      )
      d.kind = `REINDEX${concurrent ? ' CONCURRENTLY' : ''}`
      d.autocommitOnly =
        concurrent ||
        body['kind'] === 'REINDEX_OBJECT_SCHEMA' ||
        body['kind'] === 'REINDEX_OBJECT_DATABASE' ||
        body['kind'] === 'REINDEX_OBJECT_SYSTEM'
      const rel = rangeVar(body['relation'])
      if (rel !== null) {
        d.locks.push({
          mode: concurrent ? 'SHARE UPDATE EXCLUSIVE' : 'ACCESS EXCLUSIVE',
          on: qualified(rel),
          duration: 'scan',
          severity: concurrent ? 'low' : 'critical',
        })
      }
      d.compatibility.push('additive')
      d.underivedParts = true
      return d
    }
    case 'ClusterStmt': {
      const rel = rangeVar(body['relation'])
      d.kind = 'CLUSTER'
      d.autocommitOnly = rel === null
      if (rel !== null) {
        d.locks.push({
          mode: 'ACCESS EXCLUSIVE',
          on: qualified(rel),
          duration: 'rewrite',
          severity: 'critical',
        })
      }
      d.rewrite = 'table'
      d.compatibility.push('data_rewrite')
      d.underivedParts = true
      return d
    }
    case 'LockStmt':
      d.kind = 'LOCK'
      for (const r of list(body['relations'])) {
        const rel = rangeVar(r)
        if (rel !== null) {
          d.locks.push({
            mode: 'ACCESS EXCLUSIVE',
            on: qualified(rel),
            duration: 'query',
            severity: 'high',
          })
        }
      }
      d.compatibility.push('additive')
      d.underivedParts = true
      return d
    case 'AlterOwnerStmt':
    case 'AlterObjectSchemaStmt':
    case 'AlterFunctionStmt':
    case 'AlterDomainStmt':
    case 'AlterTypeStmt':
    case 'DefineStmt':
    case 'CreateCastStmt':
    case 'CreateOpClassStmt':
    case 'CreateOpFamilyStmt':
    case 'AlterOpFamilyStmt':
    case 'CreateStatsStmt':
    case 'AlterStatsStmt':
    case 'CreateConversionStmt':
    case 'CreateTransformStmt':
    case 'SecLabelStmt':
    case 'CreateForeignTableStmt':
    case 'ImportForeignSchemaStmt':
    case 'AlterCollationStmt':
    case 'CreateAmStmt':
    case 'RuleStmt':
    case 'AlterExtensionStmt':
    case 'AlterExtensionContentsStmt':
      d.compatibility.push(type === 'RuleStmt' ? 'potentially_breaking' : 'unknown')
      d.underivedParts = true
      return d
    case 'SelectStmt':
      // A top-level SELECT can call functions with any effect.
      d.kind = 'SELECT'
      d.procedural = true
      d.compatibility.push('unknown')
      d.underivedParts = true
      return d
    case 'NotifyStmt':
      d.kind = 'NOTIFY'
      d.compatibility.push('additive')
      d.underivedParts = true
      return d
    case 'VariableShowStmt':
    case 'ExplainStmt':
      d.compatibility.push('additive')
      d.underivedParts = true
      return d
    default:
      d.compatibility.push('unknown')
      d.underivedParts = true
      return d
  }
}

export interface AnalyzeOptions {
  /** Extensions the project lists as trusted: `CREATE EXTENSION` of another is refused. */
  readonly trustedExtensions?: readonly string[]
}

/** The most severe compatibility class of a list (`unknown` wins for gating, C-30). */
export function mostSevere(classes: readonly CompatibilityClass[]): CompatibilityClass {
  if (classes.length === 0 || classes.includes('unknown')) return 'unknown'
  let worst = 0
  for (const c of classes) {
    const i = COMPATIBILITY_ORDER.indexOf(c as (typeof COMPATIBILITY_ORDER)[number])
    if (i > worst) worst = i
  }
  return COMPATIBILITY_ORDER[worst] as CompatibilityClass
}

/** The most severe lock severity of a list. */
export function worstSeverity(values: readonly LockSeverity[]): LockSeverity {
  let worst = 0
  for (const v of values) {
    const i = SEVERITY_ORDER.indexOf(v)
    if (i > worst) worst = i
  }
  return SEVERITY_ORDER[worst] as LockSeverity
}

function parseFailurePosition(text: string, failure: ParseFailure) {
  if (failure.kind !== 'syntax' || failure.position === null) {
    return { byteOffset: null, line: null, column: null }
  }
  const lc = lineColumn(text, failure.position)
  return { byteOffset: byteOffsetOf(text, failure.position), ...lc }
}

/**
 * Splits and classifies a migration file with the grammar of `major` (the
 * parser must be loaded). Text is the normalized source (`\n` line ends);
 * offsets refer to it. Never splits by `;` or by comment markers.
 */
export function analyzeMigrationSql(
  major: SupportedMajor,
  text: string,
  options: AnalyzeOptions = {},
): MigrationAnalysis {
  const parsed = parseWith(major, text, MAX_MIGRATION_PARSE_BYTES)
  if (!parsed.ok) {
    return { ok: false, failure: parsed.failure, ...parseFailurePosition(text, parsed.failure) }
  }
  const trusted = new Set(options.trustedExtensions ?? [])
  const statements: StatementFacts[] = []
  const firsts = parsed.statements.map((st) => firstToken(text, st.start, st.end))
  const positions = positionsOf(text, firsts)
  for (const [index, statement] of parsed.statements.entries()) {
    let d: Draft
    try {
      d = classify(statement, trusted)
    } catch (error) {
      if (error instanceof RangeError) {
        return {
          ok: false,
          failure: { kind: 'syntax', position: statement.start, resource: true },
          ...parseFailurePosition(text, {
            kind: 'syntax',
            position: statement.start,
            resource: true,
          }),
        }
      }
      throw error
    }
    if (d.compatibility.length === 0) d.compatibility.push('unknown')
    const at = positions[index] ?? { line: 1, column: 1, byteOffset: 0 }
    const coverage: Coverage =
      d.expectations.length === 0
        ? 'underived'
        : d.underivedParts || d.procedural
          ? 'partly_derived'
          : 'derived'
    statements.push({
      index,
      type: statement.type,
      kind: d.kind,
      start: firsts[index] ?? statement.start,
      end: statement.end,
      byteOffset: at.byteOffset,
      line: at.line,
      column: at.column,
      objects: d.objects,
      locks: d.locks,
      rewrite: d.rewrite,
      autocommitOnly: d.autocommitOnly,
      forbidden: d.forbidden,
      compatibility: [...new Set(d.compatibility)],
      procedural: d.procedural,
      conditional: d.conditional,
      cascade: d.cascade,
      conditionalForm: d.conditionalForm,
      expectations: d.expectations,
      coverage,
      details: {
        ...d.details,
        stringConstants: stringConstants(statement.node),
        referencedNames: referencedNames(statement.node),
      },
    })
  }
  return { ok: true, major, statements }
}

// ----- surviving expectations -----

function rel(schema: string | null, name: string): string {
  return `${schema ?? ''}\u0000${name}`
}

/** The keys an expectation asserts; a later statement that touches one of them supersedes it. */
export function expectationKeys(e: Expectation): string[] {
  switch (e.kind) {
    case 'relation':
      return [`rel:${rel(e.schema, e.name)}`]
    case 'column':
      return [`col:${rel(e.schema, e.table)}\u0000${e.column}`, `rel:${rel(e.schema, e.table)}`]
    case 'columns_exactly':
      return [`cols:${rel(e.schema, e.table)}`, `rel:${rel(e.schema, e.table)}`]
    case 'not_null':
      return [`col:${rel(e.schema, e.table)}\u0000${e.column}`, `rel:${rel(e.schema, e.table)}`]
    case 'index':
      return [`idx:${rel(e.schema, e.name)}`]
    case 'constraint':
      return [`con:${rel(e.schema, e.table)}\u0000${e.name}`, `rel:${rel(e.schema, e.table)}`]
    case 'row_security':
      return [`rls:${rel(e.schema, e.table)}`, `rel:${rel(e.schema, e.table)}`]
    case 'policy':
      return [`pol:${rel(e.schema, e.table)}\u0000${e.name}`, `rel:${rel(e.schema, e.table)}`]
    case 'table_privilege':
      return [`acl:${rel(e.schema, e.table)}`, `rel:${rel(e.schema, e.table)}`]
    case 'function':
      return [`fn:${rel(e.schema, e.name)}`]
    case 'trigger':
      return [`trg:${rel(e.schema, e.table)}\u0000${e.name}`, `rel:${rel(e.schema, e.table)}`]
    case 'enum_labels':
      return [`type:${rel(e.schema, e.name)}`]
    case 'schema':
      return [`schema:${e.name}`]
    case 'extension':
      return [`ext:${e.name}`]
    case 'type':
      return [`type:${rel(e.schema, e.name)}`]
    case 'comment':
      return [
        e.column === undefined
          ? `cmt:${rel(e.schema, e.table)}`
          : `cmt:${rel(e.schema, e.table)}\u0000${e.column}`,
        `rel:${rel(e.schema, e.table)}`,
      ]
  }
}

/**
 * What a statement changes, as keys: its own expectations' first keys, and
 * for its objects the facts they can change (a column of a table changes
 * that table's column list; a dropped or renamed relation changes
 * everything about it). Statements whose effects are not derivable touch
 * nothing here: their effect is covered only by `verify.sql`.
 */
export function touchedKeys(s: StatementFacts): { exact: Set<string>; relations: Set<string> } {
  const exact = new Set<string>()
  const relations = new Set<string>()
  for (const e of s.expectations) {
    const [first] = expectationKeys(e)
    if (first !== undefined) exact.add(first)
  }
  for (const o of s.objects) {
    if (o.kind === 'column' && o.table !== undefined) {
      exact.add(`col:${rel(o.table.schema, o.table.name)}\u0000${o.name}`)
      exact.add(`cols:${rel(o.table.schema, o.table.name)}`)
    }
    if (
      (o.kind === 'table' ||
        o.kind === 'view' ||
        o.kind === 'materialized_view' ||
        o.kind === 'relation') &&
      (o.action === 'drop' || o.action === 'rename')
    ) {
      relations.add(`rel:${rel(o.schema, o.name)}`)
    }
    if (o.kind === 'table' && (o.action === 'grant' || o.action === 'revoke')) {
      exact.add(`acl:${rel(o.schema, o.name)}`)
    }
    if (o.kind === 'constraint' && o.table !== undefined) {
      exact.add(`con:${rel(o.table.schema, o.table.name)}\u0000${o.name}`)
    }
    if (o.kind === 'policy' && o.table !== undefined) {
      exact.add(`pol:${rel(o.table.schema, o.table.name)}\u0000${o.name}`)
    }
    if (o.kind === 'index') exact.add(`idx:${rel(o.schema, o.name)}`)
    if (o.kind === 'function' || o.kind === 'procedure') exact.add(`fn:${rel(o.schema, o.name)}`)
    if (o.kind === 'type') exact.add(`type:${rel(o.schema, o.name)}`)
    if (o.kind === 'schema' && o.action === 'drop') exact.add(`schema:${o.name}`)
  }
  return { exact, relations }
}

/**
 * The expectations that must hold after the whole file ran: an expectation
 * of statement `i` is dropped when a later statement of the same file
 * changes what it asserts (`ADD COLUMN c` then `SET NOT NULL c`, a table
 * created and renamed). The later statement asserts the final state itself.
 */
export function survivingExpectations(
  statements: readonly StatementFacts[],
): { readonly statement: number; readonly expectation: Expectation }[] {
  // The last statement that touches each key: an expectation of statement `i` is superseded
  // exactly when that is a later statement. One pass over the chain plus one lookup per
  // expectation, where the scan of every later statement per expectation took minutes for a
  // chain of thousands of files (test campaign TC-021).
  const lastExact = new Map<string, number>()
  const lastRelation = new Map<string, number>()
  for (const [j, s] of statements.entries()) {
    const touched = touchedKeys(s)
    for (const k of touched.exact) lastExact.set(k, j)
    for (const k of touched.relations) lastRelation.set(k, j)
  }
  const out: { statement: number; expectation: Expectation }[] = []
  for (const [i, s] of statements.entries()) {
    for (const e of s.expectations) {
      const keys = expectationKeys(e)
      const [first] = keys
      const superseded =
        (first !== undefined && (lastExact.get(first) ?? -1) > i) ||
        keys.some((k) => k.startsWith('rel:') && (lastRelation.get(k) ?? -1) > i)
      if (!superseded) out.push({ statement: i, expectation: e })
    }
  }
  return out
}
