import {
  isAllowedFunction,
  isAllowedOperator,
  isAllowedType,
  isWholeRowCallable,
  READ_NODES,
} from './allowlist.ts'
import type { SupportedMajor } from './majors.ts'
import {
  type JsonNode,
  loadParser,
  names,
  nodeType,
  type ParsedStatement,
  type ParseFailure,
  parseWith,
  walk,
} from './parse.ts'

/**
 * Parser-based admission of untrusted read SQL
 * ([sql-execution-security.md §2.1](../../../../exponetdb-docs/03-database-model/sql-execution-security.md#21-admission),
 * [verification.md §4.2](../../../../exponetdb-docs/04-migrations/verification.md#42-admission-plan-time)).
 *
 * Two profiles share one checker:
 *
 * - `data.read`: exactly one statement of class `SELECT` (with `WITH`
 *   without data-modifying CTEs), `VALUES`, `TABLE`, `SHOW` or `EXPLAIN`
 *   of such a statement; everything else is refused with
 *   `QUERY_NOT_READ_ONLY`;
 * - `verify`: every statement a `SELECT` whose output columns are `ok` and
 *   optionally `detail`; at most 200 checks.
 *
 * Inside an admitted statement only the node types of the closed read list
 * may occur; functions must be allowlisted `pg_catalog` built-ins
 * (unqualified names resolve in `pg_catalog` only because the session's
 * `search_path` is empty), operators and cast types must be built-ins,
 * relations must be schema-qualified, and a caller can check relation kinds
 * against the target (views and foreign tables run code on read). Locking
 * clauses, `SELECT … INTO` and data-modifying statements anywhere in the
 * tree are refused. This is defense in depth, never a sandbox: the read
 * path rests on permission, scope, tier, the target's setting and the
 * reader role's privileges.
 */
export type AdmissionCode =
  | 'QUERY_NOT_READ_ONLY'
  | 'QUERY_CONSTRUCT_UNSUPPORTED'
  | 'QUERY_PARSE_ERROR'

export type AdmissionReason =
  | 'nul'
  | 'empty'
  | 'too_large'
  | 'syntax'
  | 'parser_limit'
  | 'multiple_statements'
  | 'too_many_checks'
  | 'statement_class'
  | 'data_modifying'
  | 'locking_clause'
  | 'select_into'
  | 'node'
  | 'function'
  | 'field_selection'
  | 'operator'
  | 'cast'
  | 'user_code'
  | 'relation_unqualified'
  | 'relation_kind'
  | 'output_columns'
  | 'explain_option'

export interface RelationRef {
  readonly schema: string | null
  readonly name: string
}

export type Admission =
  | {
      readonly ok: true
      readonly major: SupportedMajor
      readonly statementClass: 'select' | 'values' | 'table' | 'show' | 'explain'
      readonly statements: number
      /** EXPLAIN ANALYZE executes the statement (admitted only as read). */
      readonly analyze: boolean
      readonly relations: readonly RelationRef[]
      readonly functions: readonly string[]
    }
  | {
      readonly ok: false
      readonly code: AdmissionCode
      readonly reason: AdmissionReason
      /** The offending construct as named in the request (capped; untrusted text). */
      readonly construct?: string
      readonly statement?: number
      readonly position?: number
    }

export interface AdmissionOptions {
  /** Schema-qualified own functions a trusted source may call (`schema.name`), e.g. Control Store helpers. */
  readonly extraFunctions?: ReadonlySet<string>
  /** Relations may be unqualified (a trusted source with a fixed `search_path`). */
  readonly unqualifiedRelations?: boolean
}

type Refusal = Extract<Admission, { ok: false }>

const WRITE_STATEMENTS = new Set(['InsertStmt', 'UpdateStmt', 'DeleteStmt', 'MergeStmt'])
const EXPLAIN_OPTIONS = new Set([
  'analyze',
  'verbose',
  'costs',
  'settings',
  'generic_plan',
  'buffers',
  'wal',
  'timing',
  'summary',
  'memory',
  'serialize',
  'format',
])
const CATALOG_SCHEMAS = new Set(['pg_catalog', 'information_schema'])
const BETWEEN_NAMES = new Set([
  'BETWEEN',
  'NOT BETWEEN',
  'BETWEEN SYMMETRIC',
  'NOT BETWEEN SYMMETRIC',
])

function cap(text: string): string {
  return text.length > 128 ? `${text.slice(0, 128)}…` : text
}

function refuse(
  code: AdmissionCode,
  reason: AdmissionReason,
  extra: { construct?: string; statement?: number; position?: number } = {},
): Refusal {
  return {
    ok: false,
    code,
    reason,
    ...(extra.construct === undefined ? {} : { construct: cap(extra.construct) }),
    ...(extra.statement === undefined ? {} : { statement: extra.statement }),
    ...(extra.position === undefined ? {} : { position: extra.position }),
  }
}

function parseRefusal(failure: ParseFailure): Refusal {
  switch (failure.kind) {
    case 'nul':
      return refuse('QUERY_CONSTRUCT_UNSUPPORTED', 'nul')
    case 'empty':
      return refuse('QUERY_PARSE_ERROR', 'empty')
    case 'too_large':
      return refuse('QUERY_CONSTRUCT_UNSUPPORTED', 'too_large')
    case 'syntax':
      return refuse(
        'QUERY_PARSE_ERROR',
        failure.resource ? 'parser_limit' : 'syntax',
        failure.position === null ? {} : { position: failure.position },
      )
  }
}

interface Collected {
  readonly relations: RelationRef[]
  readonly functions: Set<string>
}

function location(body: JsonNode, indexOf: (b: number) => number): number | undefined {
  const loc = body['location']
  return typeof loc === 'number' && loc >= 0 ? indexOf(loc) : undefined
}

/**
 * An operator name a read may use: a built-in symbol, unqualified or in
 * `pg_catalog`. Returns the refused name, or `undefined` when it is allowed.
 */
function operatorRefusal(name: unknown, between: boolean): string | undefined {
  const parts = names(name)
  const symbol = parts?.[parts.length - 1]
  const ok =
    parts !== undefined &&
    symbol !== undefined &&
    (parts.length === 1 || (parts.length === 2 && parts[0] === 'pg_catalog')) &&
    (between ? BETWEEN_NAMES.has(symbol) : isAllowedOperator(symbol))
  return ok ? undefined : (parts?.join('.') ?? '?')
}

/**
 * The name a function in FROM is referred to by and the column names a
 * qualified reference into it may use: the alias's column names when it
 * declares them; otherwise only the default column of a scalar result, which
 * carries the reference's own name (and `ordinality`). A function returning
 * a row type has columns this check cannot see: they must be declared to be
 * referenced with a qualifier, or referenced without one. Column definition
 * lists (`AS r(a integer)`) are refused as a node.
 *
 * Without an alias, PostgreSQL names the item after its expression
 * (`FigureColname`): `CAST(1 AS float8)` is `float8`, `COALESCE(…)` is
 * `coalesce`. Only a single plain function call is admitted without an
 * alias, so the name is always known; `undefined` means refuse.
 */
function functionColumns(body: JsonNode): [string, Set<string>] | undefined {
  const alias =
    typeof body['alias'] === 'object' && body['alias'] !== null
      ? (body['alias'] as JsonNode)
      : undefined
  const items = Array.isArray(body['functions']) ? body['functions'] : []
  const declared = names(alias?.['colnames']) ?? []
  let ref: string | undefined
  if (typeof alias?.['aliasname'] === 'string') {
    ref = alias['aliasname']
  } else {
    // [expression, column definition list] per function; only one, a plain call.
    const item = items.length === 1 ? nodeType(items[0]) : undefined
    const list = item?.type === 'List' ? item.body['items'] : undefined
    const call = Array.isArray(list) ? nodeType(list[0]) : undefined
    const parts = call?.type === 'FuncCall' ? names(call.body['funcname']) : undefined
    ref = parts?.[parts.length - 1]
  }
  if (ref === undefined) return undefined
  const columns = new Set(declared.length > 0 ? declared : [ref])
  if (declared.length === 0 && body['ordinality'] === true) columns.add('ordinality')
  return [ref, columns]
}

/** The name a FROM item other than a function is referred to by, if it has one. */
function rangeName(type: string, body: JsonNode): string | undefined {
  const alias =
    typeof body['alias'] === 'object' && body['alias'] !== null
      ? (body['alias'] as JsonNode)
      : undefined
  const aliasName = typeof alias?.['aliasname'] === 'string' ? alias['aliasname'] : undefined
  if (type === 'RangeVar') {
    return aliasName ?? (typeof body['relname'] === 'string' ? body['relname'] : undefined)
  }
  return type === 'RangeSubselect' || type === 'JoinExpr' ? aliasName : undefined
}

/** Checks one statement body (a read) node by node. */
function checkTree(
  major: SupportedMajor,
  root: unknown,
  options: AdmissionOptions,
  collected: Collected,
  indexOf: (b: number) => number,
  statement: number,
): Refusal | undefined {
  const ctes = new Set<string>()
  // Every name a qualified column reference may start with, and the columns a
  // reference into a function in FROM may name.
  const rangeRefs = new Set<string>()
  const functionRefs = new Map<string, Set<string>>()
  let refusal: Refusal | undefined
  const at = (body: JsonNode) => {
    const position = location(body, indexOf)
    return position === undefined ? { statement } : { statement, position }
  }
  walk(root, (type, body) => {
    if (refusal !== undefined) return false
    if (type === 'CommonTableExpr' && typeof body['ctename'] === 'string') {
      ctes.add(body['ctename'])
    }
    const name = rangeName(type, body)
    if (name !== undefined) rangeRefs.add(name)
    if (type === 'RangeFunction') {
      const named = functionColumns(body)
      if (named === undefined) {
        refusal = refuse('QUERY_CONSTRUCT_UNSUPPORTED', 'function', {
          construct: 'FROM item without an alias',
          ...at(body),
        })
        return false
      }
      const [ref, columns] = named
      rangeRefs.add(ref)
      const known = functionRefs.get(ref)
      // The same name in two scopes: only the columns both allow.
      functionRefs.set(
        ref,
        known === undefined ? columns : new Set([...known].filter((c) => columns.has(c))),
      )
    }
    return true
  })
  if (refusal !== undefined) return refusal
  walk(root, (type, body) => {
    if (refusal !== undefined) return false
    if (WRITE_STATEMENTS.has(type)) {
      refusal = refuse('QUERY_NOT_READ_ONLY', 'data_modifying', { construct: type, ...at(body) })
      return false
    }
    if (!READ_NODES.has(type)) {
      refusal = refuse('QUERY_CONSTRUCT_UNSUPPORTED', 'node', { construct: type, ...at(body) })
      return false
    }
    if (type === 'SelectStmt') {
      if (Array.isArray(body['lockingClause']) && body['lockingClause'].length > 0) {
        refusal = refuse('QUERY_NOT_READ_ONLY', 'locking_clause', { statement })
        return false
      }
      if (body['intoClause'] !== undefined) {
        refusal = refuse('QUERY_NOT_READ_ONLY', 'select_into', { statement })
        return false
      }
    }
    if (type === 'FuncCall') {
      const parts = names(body['funcname'])
      const qualified = parts?.join('.') ?? '?'
      const name = parts === undefined ? undefined : parts[parts.length - 1]
      const builtin =
        parts !== undefined &&
        name !== undefined &&
        (parts.length === 1 || (parts.length === 2 && parts[0] === 'pg_catalog')) &&
        isAllowedFunction(major, name)
      const own = parts?.length === 2 && options.extraFunctions?.has(qualified) === true
      if (!builtin && !own) {
        refusal = refuse('QUERY_CONSTRUCT_UNSUPPORTED', 'function', {
          construct: qualified,
          ...at(body),
        })
        return false
      }
      collected.functions.add(parts?.length === 1 ? `pg_catalog.${qualified}` : qualified)
    }
    if (type === 'A_Expr') {
      const between = typeof body['kind'] === 'string' && body['kind'].includes('BETWEEN')
      const bad = operatorRefusal(body['name'], between)
      if (bad !== undefined) {
        refusal = refuse('QUERY_CONSTRUCT_UNSUPPORTED', 'operator', { construct: bad, ...at(body) })
        return false
      }
    }
    // An operator also hides in `x OPERATOR(s.op) ANY (subquery)` and `ORDER BY x USING op`.
    const hiddenOperator =
      type === 'SubLink' ? body['operName'] : type === 'SortBy' ? body['useOp'] : undefined
    if (hiddenOperator !== undefined) {
      const bad = operatorRefusal(hiddenOperator, false)
      if (bad !== undefined) {
        refusal = refuse('QUERY_CONSTRUCT_UNSUPPORTED', 'operator', { construct: bad, ...at(body) })
        return false
      }
    }
    // `(expr).name` is a function call `name(expr)` when `name` is no field of
    // `expr` (any one-argument function, `(0.5).pg_sleep` among them): field
    // selection is refused as a whole.
    if (type === 'A_Indirection') {
      const field = Array.isArray(body['indirection'])
        ? body['indirection'].map(nodeType).find((n) => n?.type === 'String')
        : undefined
      if (field !== undefined) {
        refusal = refuse('QUERY_CONSTRUCT_UNSUPPORTED', 'field_selection', {
          construct: String(field.body['sval'] ?? '?'),
          ...at(body),
        })
        return false
      }
    }
    // `t.name` is the call `name(t)` on the whole row when `t` has no column `name`.
    if (type === 'ColumnRef' && Array.isArray(body['fields']) && body['fields'].length >= 2) {
      const last = nodeType(body['fields'][body['fields'].length - 1])
      const name = last?.type === 'String' ? last.body['sval'] : undefined
      // A function in FROM whose result is a scalar has that scalar as its whole row, so
      // `q.name` would call any one-argument function `name(q)` (`q.ts_stat` runs SQL
      // text): a qualified reference into a function may name only its declared columns.
      // A qualifier that names no FROM item seen here (one PostgreSQL names by a rule
      // this check does not model) is refused rather than guessed.
      const first = nodeType(body['fields'][0])
      const ref = first?.type === 'String' ? first.body['sval'] : undefined
      const columns = typeof ref === 'string' ? functionRefs.get(ref) : undefined
      if (
        body['fields'].length === 2 &&
        typeof name === 'string' &&
        (typeof ref !== 'string' ||
          !rangeRefs.has(ref) ||
          (columns !== undefined && !columns.has(name)))
      ) {
        refusal = refuse('QUERY_CONSTRUCT_UNSUPPORTED', 'function', {
          construct: `${String(ref)}.${name}`,
          ...at(body),
        })
        return false
      }
      if (
        typeof name === 'string' &&
        isWholeRowCallable(major, name) &&
        !isAllowedFunction(major, name)
      ) {
        refusal = refuse('QUERY_CONSTRUCT_UNSUPPORTED', 'function', {
          construct: (names(body['fields']) ?? [name]).join('.'),
          ...at(body),
        })
        return false
      }
    }
    // A cast's type is embedded without a node wrapper (`TypeCast.typeName`).
    const typeName =
      type === 'TypeName'
        ? body
        : type === 'TypeCast' && typeof body['typeName'] === 'object' && body['typeName'] !== null
          ? (body['typeName'] as JsonNode)
          : undefined
    if (typeName !== undefined) {
      const parts = names(typeName['names'])
      const name = parts?.[parts.length - 1]
      const ok =
        parts !== undefined &&
        name !== undefined &&
        (parts.length === 1 || (parts.length === 2 && parts[0] === 'pg_catalog')) &&
        isAllowedType(name) &&
        typeName['setof'] !== true &&
        typeName['pct_type'] !== true
      if (!ok) {
        refusal = refuse('QUERY_CONSTRUCT_UNSUPPORTED', 'cast', {
          construct: parts?.join('.') ?? '?',
          ...at(typeName),
        })
        return false
      }
    }
    if (type === 'RangeVar') {
      const schema = typeof body['schemaname'] === 'string' ? body['schemaname'] : null
      const name = typeof body['relname'] === 'string' ? body['relname'] : ''
      if (schema === null && ctes.has(name)) {
        return true
      }
      if (schema === null && options.unqualifiedRelations !== true) {
        refusal = refuse('QUERY_CONSTRUCT_UNSUPPORTED', 'relation_unqualified', {
          construct: name,
          ...at(body),
        })
        return false
      }
      if (typeof body['catalogname'] === 'string') {
        refusal = refuse('QUERY_CONSTRUCT_UNSUPPORTED', 'relation_unqualified', {
          construct: name,
          ...at(body),
        })
        return false
      }
      collected.relations.push({ schema, name })
    }
    return true
  })
  return refusal
}

/**
 * An EXPLAIN option's value: absent means on; `false`, `off`, `no` and `0`
 * mean off. The JSON tree omits zero values (`ival: 0`, `boolval: false`), so
 * an empty `Integer` or `Boolean` is off. Anything unrecognized counts as on
 * (the conservative reading: ANALYZE executes).
 */
function optionEnabled(arg: unknown): boolean {
  if (arg === undefined) return true
  const n = nodeType(arg)
  if (n === undefined) return true
  if (n.type === 'Boolean') return n.body['boolval'] === true
  if (n.type === 'Integer') return typeof n.body['ival'] === 'number' && n.body['ival'] !== 0
  if (n.type === 'String') return !/^(false|off|no|0)$/i.test(String(n.body['sval']))
  return true
}

function selectClass(body: JsonNode): 'select' | 'values' | 'table' {
  if (Array.isArray(body['valuesLists'])) return 'values'
  const list = body['targetList']
  const first = Array.isArray(list) ? nodeType(list[0]) : undefined
  const val = first?.type === 'ResTarget' ? nodeType(first.body['val']) : undefined
  return val?.type === 'ColumnRef' && val.body['location'] === -1 ? 'table' : 'select'
}

function dedupe(relations: readonly RelationRef[]): RelationRef[] {
  const seen = new Map<string, RelationRef>()
  for (const r of relations) seen.set(`${r.schema ?? ''}\u0000${r.name}`, r)
  return [...seen.values()]
}

/** `data.read` admission of one statement (the parser for `major` must be loaded). */
export function admitReadSync(major: SupportedMajor, text: string): Admission {
  const parsed = parseWith(major, text)
  if (!parsed.ok) return parseRefusal(parsed.failure)
  if (parsed.statements.length !== 1) {
    return refuse('QUERY_CONSTRUCT_UNSUPPORTED', 'multiple_statements')
  }
  const stmt = parsed.statements[0] as ParsedStatement
  const collected: Collected = { relations: [], functions: new Set() }
  let target: { type: string; node: JsonNode } = { type: stmt.type, node: stmt.node }
  let statementClass: 'select' | 'values' | 'table' | 'show' | 'explain'
  let analyze = false
  if (stmt.type === 'VariableShowStmt') {
    return {
      ok: true,
      major,
      statementClass: 'show',
      statements: 1,
      analyze: false,
      relations: [],
      functions: [],
    }
  }
  if (stmt.type === 'ExplainStmt') {
    const options = Array.isArray(stmt.node['options']) ? stmt.node['options'] : []
    for (const option of options) {
      const o = nodeType(option)
      const name = o?.type === 'DefElem' ? o.body['defname'] : undefined
      if (typeof name !== 'string' || !EXPLAIN_OPTIONS.has(name)) {
        return refuse('QUERY_CONSTRUCT_UNSUPPORTED', 'explain_option', {
          construct: typeof name === 'string' ? name : '?',
        })
      }
      if (name === 'analyze') {
        analyze = optionEnabled(o?.body['arg'])
      }
    }
    const inner = nodeType(stmt.node['query'])
    if (inner === undefined) {
      return refuse('QUERY_CONSTRUCT_UNSUPPORTED', 'statement_class')
    }
    target = { type: inner.type, node: inner.body }
    statementClass = 'explain'
  } else {
    statementClass = 'select'
  }
  if (target.type !== 'SelectStmt') {
    return refuse(
      WRITE_STATEMENTS.has(target.type) || !READ_NODES.has(target.type)
        ? 'QUERY_NOT_READ_ONLY'
        : 'QUERY_CONSTRUCT_UNSUPPORTED',
      'statement_class',
      { construct: target.type },
    )
  }
  if (statementClass === 'select') statementClass = selectClass(target.node)
  const refusal = checkTree(major, { SelectStmt: target.node }, {}, collected, parsed.indexOf, 0)
  if (refusal !== undefined) return refusal
  return {
    ok: true,
    major,
    statementClass,
    statements: 1,
    analyze,
    relations: dedupe(collected.relations),
    functions: [...collected.functions].sort(),
  }
}

export async function admitRead(major: SupportedMajor, text: string): Promise<Admission> {
  await loadParser(major)
  return admitReadSync(major, text)
}

function outputColumns(body: JsonNode): string[] | undefined {
  if (body['op'] !== undefined && body['op'] !== 'SETOP_NONE') {
    const left = nodeType(body['larg'])
    return left?.type === 'SelectStmt' ? outputColumns(left.body) : undefined
  }
  const list = body['targetList']
  if (!Array.isArray(list)) return undefined
  const out: string[] = []
  for (const item of list) {
    const t = nodeType(item)
    const name = t?.type === 'ResTarget' ? t.body['name'] : undefined
    if (typeof name !== 'string') return undefined
    out.push(name)
  }
  return out
}

export const MAX_VERIFY_CHECKS = 200
export const MAX_VERIFY_BYTES = 512 * 1024

/** `verify.sql` admission of a whole check file (the parser for `major` must be loaded). */
export function admitVerifySync(
  major: SupportedMajor,
  text: string,
  options: AdmissionOptions = {},
): Admission {
  if (new TextEncoder().encode(text).length > MAX_VERIFY_BYTES) {
    return refuse('QUERY_CONSTRUCT_UNSUPPORTED', 'too_large')
  }
  const parsed = parseWith(major, text)
  if (!parsed.ok) return parseRefusal(parsed.failure)
  if (parsed.statements.length > MAX_VERIFY_CHECKS) {
    return refuse('QUERY_CONSTRUCT_UNSUPPORTED', 'too_many_checks')
  }
  const collected: Collected = { relations: [], functions: new Set() }
  for (const [i, stmt] of parsed.statements.entries()) {
    if (stmt.type !== 'SelectStmt' || Array.isArray(stmt.node['valuesLists'])) {
      return refuse(
        WRITE_STATEMENTS.has(stmt.type) ? 'QUERY_NOT_READ_ONLY' : 'QUERY_CONSTRUCT_UNSUPPORTED',
        'statement_class',
        { construct: stmt.type, statement: i },
      )
    }
    const columns = outputColumns(stmt.node)
    if (
      columns === undefined ||
      !columns.includes('ok') ||
      columns.some((c) => c !== 'ok' && c !== 'detail') ||
      new Set(columns).size !== columns.length
    ) {
      return refuse('QUERY_CONSTRUCT_UNSUPPORTED', 'output_columns', { statement: i })
    }
    const refusal = checkTree(
      major,
      { SelectStmt: stmt.node },
      options,
      collected,
      parsed.indexOf,
      i,
    )
    if (refusal !== undefined) return refusal
  }
  return {
    ok: true,
    major,
    statementClass: 'select',
    statements: parsed.statements.length,
    analyze: false,
    relations: dedupe(collected.relations),
    functions: [...collected.functions].sort(),
  }
}

export async function admitVerify(
  major: SupportedMajor,
  text: string,
  options: AdmissionOptions = {},
): Promise<Admission> {
  await loadParser(major)
  return admitVerifySync(major, text, options)
}

/** Relation kinds a read may touch without a declaration (`r`, `p`, `m`, `S`); catalog schemas are always readable. */
export const READABLE_RELKINDS: ReadonlySet<string> = new Set(['r', 'p', 'm', 'S'])

/**
 * The relation-kind step of admission, with the kinds resolved on the
 * target: a view or foreign table (or a relation that does not exist) is
 * unsupported, except in `pg_catalog` and `information_schema`.
 */
export function checkRelationKinds(
  relations: readonly RelationRef[],
  kinds: ReadonlyMap<string, string | null>,
): Refusal | undefined {
  for (const r of relations) {
    if (r.schema !== null && CATALOG_SCHEMAS.has(r.schema)) continue
    const kind = kinds.get(`${r.schema ?? ''}.${r.name}`)
    if (kind === undefined || kind === null || !READABLE_RELKINDS.has(kind)) {
      return refuse('QUERY_CONSTRUCT_UNSUPPORTED', 'relation_kind', {
        construct: `${r.schema ?? ''}.${r.name}`,
      })
    }
  }
  return undefined
}

/**
 * The user-code step of `data.read` admission, with the objects resolved on
 * the target (`resolveUserCode`): any such object refuses the read, since
 * the statement runs its code without naming it.
 */
export function checkUserCode(objects: readonly string[]): Refusal | undefined {
  const first = objects[0]
  return first === undefined
    ? undefined
    : refuse('QUERY_CONSTRUCT_UNSUPPORTED', 'user_code', { construct: first })
}
