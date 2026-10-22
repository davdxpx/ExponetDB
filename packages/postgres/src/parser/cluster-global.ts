import type { SupportedMajor } from './majors.ts'
import {
  type JsonNode,
  loadParser,
  MAX_MIGRATION_PARSE_BYTES,
  nodeType,
  parsePlpgsql,
  parseWith,
} from './parse.ts'

/**
 * Cluster-global effects of role statements, for the legacy replay only
 * ([`legacy-import.md` §2.4](../../../../exponetdb-docs/04-migrations/legacy-import.md#24-files-with-cluster-global-effects),
 * Wave 9 order A6). A bundle never runs these statements (the admission
 * refuses them, `role_management`); a legacy file that does is replayed
 * without them, and what they state about roles is checked against the
 * imported target's catalog instead.
 *
 * Pure: a raw parse tree in, expectations out. A statement whose subject
 * depends on who runs it (`CURRENT_USER`, `SESSION_USER`, `CURRENT_ROLE`,
 * `PUBLIC`) or whose value comes from the session yields `unknown`, never
 * a guessed expectation. A password is never part of an expectation.
 */
export type RoleAttribute =
  | 'login'
  | 'superuser'
  | 'createdb'
  | 'createrole'
  | 'replication'
  | 'bypassrls'
  | 'inherit'

export type MembershipOption = 'admin' | 'inherit' | 'set'

/**
 * What a guard (`IF EXISTS (SELECT … FROM pg_roles | pg_auth_members WHERE …)`)
 * around an elided statement asked: a role, or a membership, exists.
 */
export type ClusterGlobalCondition =
  | { readonly kind: 'role'; readonly role: string; readonly exists: true }
  | {
      readonly kind: 'membership'
      readonly role: string
      readonly member: string
      readonly exists: true
    }

export type ClusterGlobalExpectation = ClusterGlobalFact & {
  /**
   * Set for a statement inside `IF EXISTS` guards: the expectation is
   * checked only while every condition holds on the imported target, and
   * it never supersedes another one (the guard may have been false when
   * the file ran).
   */
  readonly when?: readonly ClusterGlobalCondition[]
}

type ClusterGlobalFact =
  | { readonly kind: 'role'; readonly role: string; readonly exists: boolean }
  | {
      readonly kind: 'role_attribute'
      readonly role: string
      readonly attribute: RoleAttribute
      readonly value: boolean
    }
  | { readonly kind: 'role_connection_limit'; readonly role: string; readonly value: number }
  | {
      readonly kind: 'membership'
      readonly role: string
      readonly member: string
      readonly exists: boolean
    }
  | {
      readonly kind: 'membership_option'
      readonly role: string
      readonly member: string
      readonly option: MembershipOption
      readonly value: boolean
    }
  | {
      readonly kind: 'role_setting'
      /** `null`: `ALTER ROLE ALL`. */
      readonly role: string | null
      /** `null`: every database. */
      readonly database: string | null
      readonly name: string
      /** As PostgreSQL stores it after `name=`; `null`: reset. */
      readonly value: string | null
    }
  | { readonly kind: 'role_comment'; readonly role: string; readonly value: string | null }

export interface RoleStatementEffects {
  readonly expectations: readonly ClusterGlobalExpectation[]
  /** Something the statement does cannot be stated as an expectation. */
  readonly unknown: boolean
}

const ROLE_STATEMENTS = new Set([
  'CreateRoleStmt',
  'AlterRoleStmt',
  'AlterRoleSetStmt',
  'DropRoleStmt',
  'GrantRoleStmt',
])

/** Whether a parsed statement only changes roles (what the legacy replay elides). */
export function isRoleStatement(type: string, node: JsonNode): boolean {
  if (ROLE_STATEMENTS.has(type)) return true
  if (type === 'RenameStmt') return node['renameType'] === 'OBJECT_ROLE'
  if (type === 'CommentStmt') return node['objtype'] === 'OBJECT_ROLE'
  return false
}

const ATTRIBUTES: Readonly<Record<string, RoleAttribute>> = {
  canlogin: 'login',
  superuser: 'superuser',
  createdb: 'createdb',
  createrole: 'createrole',
  isreplication: 'replication',
  bypassrls: 'bypassrls',
  inherit: 'inherit',
}

/** Settings PostgreSQL stores with each list element quoted like `quote_ident` (GUC_LIST_QUOTE). */
const LIST_QUOTED = new Set([
  'search_path',
  'temp_tablespaces',
  'session_preload_libraries',
  'shared_preload_libraries',
  'local_preload_libraries',
])

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function list(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  const n = nodeType(value)
  if (n?.type === 'List' && Array.isArray(n.body['items'])) return n.body['items'] as unknown[]
  return []
}

function bool(arg: unknown): boolean | null {
  const n = nodeType(arg)
  if (n?.type === 'Boolean') return n.body['boolval'] === true
  if (n?.type === 'Integer') return n.body['ival'] !== undefined && n.body['ival'] !== 0
  return null
}

/** A role name the statement names literally, or `null` (CURRENT_USER, PUBLIC, …). */
function roleName(spec: unknown): string | null {
  const n = nodeType(spec)
  const body = n?.type === 'RoleSpec' ? n.body : (spec as JsonNode | undefined)
  if (body === undefined || body === null || typeof body !== 'object') return null
  return body['roletype'] === 'ROLESPEC_CSTRING' ? str(body['rolename']) : null
}

interface DefElem {
  readonly name: string
  readonly arg: unknown
}

function defElems(value: unknown): DefElem[] {
  const out: DefElem[] = []
  for (const item of list(value)) {
    const n = nodeType(item)
    if (n?.type !== 'DefElem') continue
    const name = str(n.body['defname'])
    if (name !== null) out.push({ name, arg: n.body['arg'] })
  }
  return out
}

/** `quote_ident` for the characters PostgreSQL leaves bare; anything else is quoted. */
export function quoteIdentLike(value: string): string {
  return /^[a-z_][a-z0-9_]*$/.test(value) ? value : `"${value.replaceAll('"', '""')}"`
}

/** A `SET` value as PostgreSQL flattens it into `pg_db_role_setting`, or `null` when it would evaluate it. */
export function renderSettingValue(name: string, args: readonly unknown[]): string | null {
  const parts: string[] = []
  for (const a of args) {
    const n = nodeType(a)
    if (n?.type !== 'A_Const') return null
    if (n.body['sval'] !== undefined) {
      const v = str((n.body['sval'] as JsonNode)['sval']) ?? ''
      parts.push(LIST_QUOTED.has(name) ? quoteIdentLike(v) : v)
    } else if (n.body['ival'] !== undefined) {
      const v = (n.body['ival'] as JsonNode)['ival']
      parts.push(String(typeof v === 'number' ? v : 0))
    } else if (n.body['fval'] !== undefined) {
      const v = str((n.body['fval'] as JsonNode)['fval'])
      if (v === null) return null
      parts.push(v)
    } else if (n.body['boolval'] !== undefined) {
      parts.push((n.body['boolval'] as JsonNode)['boolval'] === true ? 'true' : 'false')
    } else {
      return null
    }
  }
  return parts.length === 0 ? null : parts.join(', ')
}

/**
 * The cluster-global effects of one role statement, or `null` when it is
 * not a role statement. `presenceOnly` (a statement inside a `DO` block
 * whose handler swallows its failure) keeps only what holds whether the
 * statement created something or found it: that a role or a membership
 * exists.
 */
export function roleStatementEffects(
  type: string,
  node: JsonNode,
  options: { readonly presenceOnly?: boolean } = {},
): RoleStatementEffects | null {
  if (!isRoleStatement(type, node)) return null
  const out: ClusterGlobalExpectation[] = []
  let unknown = false
  const presenceOnly = options.presenceOnly === true
  const attributes = (role: string, elems: readonly DefElem[]) => {
    for (const e of elems) {
      const attribute = ATTRIBUTES[e.name]
      if (attribute !== undefined) {
        const v = bool(e.arg)
        if (v === null) unknown = true
        else if (!presenceOnly) out.push({ kind: 'role_attribute', role, attribute, value: v })
      } else if (e.name === 'connectionlimit') {
        const n = nodeType(e.arg)
        // The JSON tree leaves out an ival of 0.
        const v = n?.type === 'Integer' ? (n.body['ival'] ?? 0) : undefined
        if (typeof v !== 'number') unknown = true
        else if (!presenceOnly) out.push({ kind: 'role_connection_limit', role, value: v })
      }
    }
  }
  const memberships = (
    pairs: readonly (readonly [role: string | null, member: string | null])[],
    exists: boolean,
    admin: boolean,
  ) => {
    for (const [role, member] of pairs) {
      if (role === null || member === null) {
        unknown = true
        continue
      }
      out.push({ kind: 'membership', role, member, exists })
      if (exists && admin && !presenceOnly) {
        out.push({ kind: 'membership_option', role, member, option: 'admin', value: true })
      }
    }
  }
  switch (type) {
    case 'CreateRoleStmt': {
      const role = str(node['role'])
      if (role === null) return { expectations: [], unknown: true }
      out.push({ kind: 'role', role, exists: true })
      const elems = defElems(node['options'])
      attributes(role, elems)
      for (const e of elems) {
        const named = list(e.arg).map(roleName)
        if (e.name === 'addroleto') {
          memberships(
            named.map((r) => [r, role] as const),
            true,
            false,
          )
        } else if (e.name === 'rolemembers') {
          memberships(
            named.map((m) => [role, m] as const),
            true,
            false,
          )
        } else if (e.name === 'adminmembers') {
          memberships(
            named.map((m) => [role, m] as const),
            true,
            true,
          )
        }
      }
      break
    }
    case 'AlterRoleStmt': {
      const role = roleName(node['role'])
      if (role === null) return { expectations: [], unknown: true }
      const elems = defElems(node['options'])
      attributes(role, elems)
      const action = node['action']
      for (const e of elems) {
        if (e.name !== 'rolemembers') continue
        memberships(
          list(e.arg).map((m) => [role, roleName(m)] as const),
          action !== -1,
          false,
        )
      }
      break
    }
    case 'AlterRoleSetStmt': {
      const role = node['role'] === undefined ? null : roleName(node['role'])
      if (node['role'] !== undefined && role === null) return { expectations: [], unknown: true }
      const set = (node['setstmt'] ?? {}) as JsonNode
      const kind = str(set['kind'])
      const name = str(set['name'])
      const database = str(node['database'])
      if (
        name === null ||
        (kind !== 'VAR_SET_VALUE' && kind !== 'VAR_SET_DEFAULT' && kind !== 'VAR_RESET')
      ) {
        // RESET ALL, SET … FROM CURRENT: the value is not in the statement.
        return { expectations: [], unknown: true }
      }
      const value = kind === 'VAR_SET_VALUE' ? renderSettingValue(name, list(set['args'])) : null
      if (kind === 'VAR_SET_VALUE' && value === null) return { expectations: [], unknown: true }
      if (!presenceOnly) out.push({ kind: 'role_setting', role, database, name, value })
      break
    }
    case 'DropRoleStmt': {
      for (const spec of list(node['roles'])) {
        const role = roleName(spec)
        if (role === null) unknown = true
        else out.push({ kind: 'role', role, exists: false })
      }
      break
    }
    case 'GrantRoleStmt': {
      const granted = list(node['granted_roles']).map((p) => {
        const n = nodeType(p)
        return n?.type === 'AccessPriv' ? str(n.body['priv_name']) : null
      })
      const grantees = list(node['grantee_roles']).map(roleName)
      const isGrant = node['is_grant'] === true
      const opts = defElems(node['opt'])
      for (const role of granted) {
        for (const member of grantees) {
          if (role === null || member === null) {
            unknown = true
            continue
          }
          if (isGrant) {
            out.push({ kind: 'membership', role, member, exists: true })
            if (!presenceOnly) {
              for (const o of opts) {
                const v = bool(o.arg)
                if (o.name === 'admin' || o.name === 'inherit' || o.name === 'set') {
                  if (v === null) unknown = true
                  else
                    out.push({ kind: 'membership_option', role, member, option: o.name, value: v })
                }
              }
            }
          } else if (opts.length === 0) {
            if (!presenceOnly) out.push({ kind: 'membership', role, member, exists: false })
          } else if (!presenceOnly) {
            for (const o of opts) {
              if (o.name === 'admin' || o.name === 'inherit' || o.name === 'set') {
                out.push({ kind: 'membership_option', role, member, option: o.name, value: false })
              }
            }
          }
        }
      }
      break
    }
    case 'RenameStmt': {
      const from = str(node['subname'])
      const to = str(node['newname'])
      if (from === null || to === null) return { expectations: [], unknown: true }
      out.push(
        { kind: 'role', role: from, exists: false },
        { kind: 'role', role: to, exists: true },
      )
      break
    }
    case 'CommentStmt': {
      const target = nodeType(node['object'])
      const role = target?.type === 'String' ? str(target.body['sval']) : null
      if (role === null) return { expectations: [], unknown: true }
      if (!presenceOnly) out.push({ kind: 'role_comment', role, value: str(node['comment']) })
      break
    }
  }
  return { expectations: out, unknown }
}

/** What an expectation is about: a later one with the same key supersedes it. */
export function expectationKey(e: ClusterGlobalExpectation | ClusterGlobalCondition): string {
  switch (e.kind) {
    case 'role':
      return `role:${e.role}`
    case 'role_attribute':
      return `attribute:${e.role}:${e.attribute}`
    case 'role_connection_limit':
      return `connection_limit:${e.role}`
    case 'membership':
      return `membership:${e.role}:${e.member}`
    case 'membership_option':
      return `membership_option:${e.role}:${e.member}:${e.option}`
    case 'role_setting':
      return `setting:${e.role ?? '*'}:${e.database ?? '*'}:${e.name}`
    case 'role_comment':
      return `comment:${e.role}`
  }
}

/** The roles an expectation names (a dropped role supersedes everything about it). */
export function rolesOf(e: ClusterGlobalExpectation): readonly string[] {
  switch (e.kind) {
    case 'membership':
    case 'membership_option':
      return [e.role, e.member]
    case 'role_setting':
      return e.role === null ? [] : [e.role]
    default:
      return [e.role]
  }
}

// ----- a legacy file's statements with cluster-global effects -----

export type ClusterGlobalForm =
  /** A role statement at the top level: elided from the replay. */
  | 'role_statement'
  /**
   * A `DO` block of role statements, exception handlers and `IF [NOT] EXISTS`
   * guards on `pg_roles` or `pg_auth_members` only: elided.
   */
  | 'role_do_block'
  /** A `DO` block with role statements and anything else: replayed, the file is ambiguous. */
  | 'mixed_do_block'

export interface ClusterGlobalStatement {
  /** The statement's index in the file, as the migration analysis counts them. */
  readonly index: number
  readonly type: string
  readonly form: ClusterGlobalForm
  readonly effects: RoleStatementEffects
}

/** Loads the file's major and the PL/pgSQL parser (18). */
export async function loadClusterGlobalParsers(major: SupportedMajor): Promise<void> {
  await Promise.all([loadParser(major), loadParser(18)])
}

/** Implicit variables of every PL/pgSQL block (and of each exception block). */
const IMPLICIT = new Set(['found', 'sqlstate', 'sqlerrm'])
/** RAISE levels below EXCEPTION (ERROR is 21 in PostgreSQL's elog.h). */
const MAX_RAISE_LEVEL = 19

function objects(value: unknown): JsonNode[] {
  return Array.isArray(value)
    ? value.filter((v): v is JsonNode => typeof v === 'object' && v !== null)
    : []
}

/** Every embedded SQL statement anywhere in a PL/pgSQL tree (for the mixed check). */
function embeddedQueries(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const v of value) embeddedQueries(v, out)
  } else if (typeof value === 'object' && value !== null) {
    const execsql = (value as JsonNode)['PLpgSQL_stmt_execsql']
    if (typeof execsql === 'object' && execsql !== null) {
      const q = ((execsql as JsonNode)['sqlstmt'] as JsonNode | undefined)?.['PLpgSQL_expr']
      const query = str((q as JsonNode | undefined)?.['query'])
      if (query !== null) out.push(query)
    }
    for (const v of Object.values(value)) embeddedQueries(v, out)
  }
  return out
}

interface Collected {
  readonly query: string
  /** Inside an exception handler or a `NOT EXISTS` guard: only what holds whether it ran or not. */
  readonly presenceOnly: boolean
  /** The `IF EXISTS` guards around it. */
  readonly when: readonly ClusterGlobalCondition[]
}

interface Scope {
  readonly presenceOnly: boolean
  readonly when: readonly ClusterGlobalCondition[]
}

/** Whether the block holds role statements, guards and exception handlers only (collected into `out`). */
function roleOnlyBlock(
  major: SupportedMajor,
  block: JsonNode,
  scope: Scope,
  out: Collected[],
  top: boolean,
): boolean {
  const exceptions = (block['exceptions'] as JsonNode | undefined)?.['PLpgSQL_exception_block']
  const inner = { presenceOnly: scope.presenceOnly || exceptions !== undefined, when: scope.when }
  if (!roleOnlyBody(major, block['body'], inner, out, top)) return false
  if (exceptions !== undefined) {
    for (const exc of objects((exceptions as JsonNode)['exc_list'])) {
      const e = nodeType(exc)
      if (e?.type !== 'PLpgSQL_exception') return false
      for (const action of objects(e.body['action'])) {
        const a = nodeType(action)
        if (a?.type !== 'PLpgSQL_stmt_raise') return false
        const level = a.body['elog_level']
        if (typeof level !== 'number' || level > MAX_RAISE_LEVEL) return false
        if (a.body['options'] !== undefined || a.body['condname'] !== undefined) return false
        for (const p of objects(a.body['params'])) {
          const q = str(((p as JsonNode)['PLpgSQL_expr'] as JsonNode | undefined)?.['query'])
          if (q === null || !/^\s*(sqlerrm|sqlstate)\s*$/i.test(q)) return false
        }
      }
    }
  }
  return true
}

function roleOnlyBody(
  major: SupportedMajor,
  items: unknown,
  scope: Scope,
  out: Collected[],
  top: boolean,
): boolean {
  const body = objects(items)
  for (const [at, item] of body.entries()) {
    const n = nodeType(item)
    if (n?.type === 'PLpgSQL_stmt_block') {
      if (!roleOnlyBlock(major, n.body, scope, out, false)) return false
    } else if (n?.type === 'PLpgSQL_stmt_if') {
      // A guard and its THEN branch only: an ELSE or ELSIF branch runs when the guard is false.
      if (n.body['elsif_list'] !== undefined || n.body['else_body'] !== undefined) return false
      const cond = str(
        ((n.body['cond'] as JsonNode | undefined)?.['PLpgSQL_expr'] as JsonNode | undefined)?.[
          'query'
        ],
      )
      const guard = cond === null ? undefined : roleGuard(major, cond)
      if (guard === undefined) return false
      // NOT EXISTS: the branch ran only if the role or membership was missing, so only what
      // holds either way is kept. EXISTS: what the branch states holds only while the guard does.
      const next = guard.negated
        ? { presenceOnly: true, when: scope.when }
        : { presenceOnly: scope.presenceOnly, when: [...scope.when, guard.condition] }
      if (!roleOnlyBody(major, n.body['then_body'], next, out, false)) return false
    } else if (n?.type === 'PLpgSQL_stmt_execsql') {
      const expr = (n.body['sqlstmt'] as JsonNode | undefined)?.['PLpgSQL_expr'] as
        | JsonNode
        | undefined
      const query = str(expr?.['query'])
      if (query === null || n.body['into'] !== undefined || n.body['target'] !== undefined) {
        return false
      }
      out.push({ query, presenceOnly: scope.presenceOnly, when: scope.when })
    } else if (n?.type === 'PLpgSQL_stmt_return') {
      // The parser adds a bare RETURN at the end of the outermost block; one anywhere else
      // would skip what follows it.
      if (!top || at !== body.length - 1) return false
      if (Object.keys(n.body).some((k) => k !== 'lineno')) return false
    } else {
      return false
    }
  }
  return true
}

/** The relations a guard may read, and the columns each condition names. */
const GUARD_RELATIONS = new Set(['pg_roles', 'pg_auth_members'])

function onlyKeys(node: JsonNode, allowed: readonly string[]): boolean {
  return Object.keys(node).every((k) => allowed.includes(k))
}

/** `=` or `OPERATOR(pg_catalog.=)`. */
function isEquals(name: unknown): boolean {
  const parts = list(name).map((p) => {
    const n = nodeType(p)
    return n?.type === 'String' ? str(n.body['sval']) : null
  })
  return (
    (parts.length === 1 && parts[0] === '=') ||
    (parts.length === 2 && parts[0] === 'pg_catalog' && parts[1] === '=')
  )
}

/** A string constant, optionally cast to one of `types`: its value and the cast's type. */
function stringConstant(
  value: unknown,
  types: readonly string[],
): { readonly value: string; readonly type: string | null } | undefined {
  let n = nodeType(value)
  let type: string | null = null
  if (n?.type === 'TypeCast') {
    // The JSON tree gives a type name as a bare object, not a wrapped node.
    const typeName = n.body['typeName'] as JsonNode | undefined
    if (typeName === undefined || !onlyKeys(typeName, ['names', 'typemod', 'location'])) {
      return undefined
    }
    const names = list(typeName['names']).map((p) => {
      const s = nodeType(p)
      return s?.type === 'String' ? str(s.body['sval']) : null
    })
    const last =
      names.length === 1
        ? names[0]
        : names.length === 2 && names[0] === 'pg_catalog'
          ? names[1]
          : null
    if (last === null || last === undefined || !types.includes(last)) return undefined
    type = last
    n = nodeType(n.body['arg'])
  }
  if (n?.type !== 'A_Const' || !onlyKeys(n.body, ['sval', 'location'])) return undefined
  const v = str((n.body['sval'] as JsonNode | undefined)?.['sval'])
  return v === null ? undefined : { value: v, type }
}

/** A role name as `regrole` input reads it (an identifier), or `undefined` (an oid, anything else). */
function regroleName(input: string): string | undefined {
  const quoted = /^"((?:[^"]|"")+)"$/.exec(input)
  if (quoted !== null) return quoted[1]?.replaceAll('""', '"')
  return /^[A-Za-z_][A-Za-z0-9_$]*$/.test(input) ? input.toLowerCase() : undefined
}

/**
 * A guard around role statements: `[NOT] EXISTS (SELECT … FROM pg_roles
 * WHERE rolname = '<role>')` or `[NOT] EXISTS (SELECT … FROM pg_auth_members
 * WHERE roleid = '<role>'::regrole AND member = '<member>'::regrole)`, with
 * nothing else in it (no function, no subquery, no variable). Anything else
 * is `undefined`: the block is mixed.
 */
function roleGuard(
  major: SupportedMajor,
  query: string,
): { readonly negated: boolean; readonly condition: ClusterGlobalCondition } | undefined {
  const parsed = parseWith(major, `SELECT ${query}`, MAX_MIGRATION_PARSE_BYTES)
  if (!parsed.ok || parsed.statements.length !== 1) return undefined
  const [st] = parsed.statements
  if (st?.type !== 'SelectStmt' || !plainSelect(st.node, ['targetList'])) return undefined
  const targets = list(st.node['targetList'])
  const target = targets.length === 1 ? nodeType(targets[0]) : undefined
  if (target?.type !== 'ResTarget' || !onlyKeys(target.body, ['val', 'location'])) return undefined
  let value = nodeType(target.body['val'])
  let negated = false
  if (value?.type === 'BoolExpr') {
    const args = list(value.body['args'])
    if (value.body['boolop'] !== 'NOT_EXPR' || args.length !== 1) return undefined
    value = nodeType(args[0])
    negated = true
  }
  if (
    value?.type !== 'SubLink' ||
    value.body['subLinkType'] !== 'EXISTS_SUBLINK' ||
    !onlyKeys(value.body, ['subLinkType', 'subselect', 'location'])
  ) {
    return undefined
  }
  const sub = nodeType(value.body['subselect'])
  if (
    sub?.type !== 'SelectStmt' ||
    !plainSelect(sub.body, ['targetList', 'fromClause', 'whereClause'])
  )
    return undefined
  const from = list(sub.body['fromClause'])
  const range = from.length === 1 ? nodeType(from[0]) : undefined
  if (
    range?.type !== 'RangeVar' ||
    !onlyKeys(range.body, [
      'relname',
      'schemaname',
      'inh',
      'relpersistence',
      'alias',
      'location',
    ]) ||
    range.body['inh'] !== true ||
    range.body['relpersistence'] !== 'p'
  ) {
    return undefined
  }
  const relation = str(range.body['relname'])
  const schema = range.body['schemaname']
  if (relation === null || !GUARD_RELATIONS.has(relation)) return undefined
  if (schema !== undefined && schema !== 'pg_catalog') return undefined
  let qualifier = relation
  const alias = range.body['alias'] as JsonNode | undefined
  if (alias !== undefined) {
    // The JSON tree gives an alias as a bare object, not a wrapped node.
    const name = str(alias?.['aliasname'])
    if (name === null || !onlyKeys(alias, ['aliasname'])) return undefined
    qualifier = name
  }
  const column = (ref: unknown): string | null => {
    const n = nodeType(ref)
    if (n?.type !== 'ColumnRef' || !onlyKeys(n.body, ['fields', 'location'])) return null
    const fields = list(n.body['fields']).map((f) => {
      const s = nodeType(f)
      return s?.type === 'String' ? str(s.body['sval']) : s?.type === 'A_Star' ? '*' : null
    })
    if (fields.length === 2 && fields[0] === qualifier) return fields[1] ?? null
    return fields.length === 1 ? (fields[0] ?? null) : null
  }
  // What the subquery selects is never evaluated by EXISTS; only constants and columns.
  for (const t of list(sub.body['targetList'])) {
    const r = nodeType(t)
    if (r?.type !== 'ResTarget' || !onlyKeys(r.body, ['val', 'name', 'location'])) return undefined
    const v = nodeType(r.body['val'])
    if (!(v?.type === 'A_Const' || column(r.body['val']) !== null)) return undefined
  }
  const where = nodeType(sub.body['whereClause'])
  if (where === undefined) return undefined
  let conjuncts: unknown[] = [sub.body['whereClause']]
  if (where.type === 'BoolExpr') {
    if (where.body['boolop'] !== 'AND_EXPR') return undefined
    conjuncts = list(where.body['args'])
  }
  const equal = new Map<string, { readonly value: string; readonly type: string | null }>()
  for (const c of conjuncts) {
    const e = nodeType(c)
    if (
      e?.type !== 'A_Expr' ||
      e.body['kind'] !== 'AEXPR_OP' ||
      !isEquals(e.body['name']) ||
      !onlyKeys(e.body, ['kind', 'name', 'lexpr', 'rexpr', 'location'])
    ) {
      return undefined
    }
    const left = column(e.body['lexpr'])
    const right = column(e.body['rexpr'])
    const [col, constant] =
      left !== null && right === null
        ? [left, e.body['rexpr']]
        : right !== null && left === null
          ? [right, e.body['lexpr']]
          : [null, undefined]
    if (col === null || equal.has(col)) return undefined
    const v = stringConstant(constant, relation === 'pg_roles' ? ['name', 'text'] : ['regrole'])
    if (v === undefined) return undefined
    equal.set(col, v)
  }
  if (relation === 'pg_roles') {
    const role = equal.get('rolname')
    if (equal.size !== 1 || role === undefined) return undefined
    return { negated, condition: { kind: 'role', role: role.value, exists: true } }
  }
  const role = equal.get('roleid')
  const member = equal.get('member')
  if (equal.size !== 2 || role?.type !== 'regrole' || member?.type !== 'regrole') return undefined
  const grantedRole = regroleName(role.value)
  const memberName = regroleName(member.value)
  if (grantedRole === undefined || memberName === undefined) return undefined
  return {
    negated,
    condition: { kind: 'membership', role: grantedRole, member: memberName, exists: true },
  }
}

/** A SELECT without DISTINCT, GROUP BY, HAVING, WINDOW, ORDER BY, LIMIT, locking, WITH or set operations. */
function plainSelect(node: JsonNode, allowed: readonly string[]): boolean {
  return (
    onlyKeys(node, [...allowed, 'limitOption', 'op']) &&
    (node['limitOption'] === undefined || node['limitOption'] === 'LIMIT_OPTION_DEFAULT') &&
    (node['op'] === undefined || node['op'] === 'SETOP_NONE')
  )
}

function doLanguage(node: JsonNode): string {
  for (const arg of objects(node['args'])) {
    const d = nodeType(arg)
    if (d?.type === 'DefElem' && d.body['defname'] === 'language') {
      const v = nodeType(d.body['arg'])
      return (v?.type === 'String' ? str(v.body['sval']) : null)?.toLowerCase() ?? ''
    }
  }
  return 'plpgsql'
}

/** One parsed statement of the file as a role statement, if it is exactly one. */
function singleRoleStatement(
  major: SupportedMajor,
  query: string,
): { readonly type: string; readonly node: JsonNode } | undefined {
  const parsed = parseWith(major, query, MAX_MIGRATION_PARSE_BYTES)
  if (!parsed.ok || parsed.statements.length !== 1) return undefined
  const [st] = parsed.statements
  return st !== undefined && isRoleStatement(st.type, st.node)
    ? { type: st.type, node: st.node }
    : undefined
}

/**
 * Which statements of a legacy file have cluster-global effects
 * (`legacy-import.md` §2.4), with their expectations. The parsers of
 * `major` and 18 must be loaded ({@link loadClusterGlobalParsers}). A file
 * the parser of `major` cannot read yields `undefined` (the replay refuses
 * it as before).
 */
export function clusterGlobalStatements(
  major: SupportedMajor,
  text: string,
): ClusterGlobalStatement[] | undefined {
  const parsed = parseWith(major, text, MAX_MIGRATION_PARSE_BYTES)
  if (!parsed.ok) return undefined
  const out: ClusterGlobalStatement[] = []
  for (const [index, st] of parsed.statements.entries()) {
    if (isRoleStatement(st.type, st.node)) {
      const effects = roleStatementEffects(st.type, st.node)
      if (effects !== null) out.push({ index, type: st.type, form: 'role_statement', effects })
      continue
    }
    if (st.type !== 'DoStmt') continue
    const tree =
      doLanguage(st.node) === 'plpgsql' ? parsePlpgsql(text.slice(st.start, st.end)) : undefined
    const fn = objects((tree as JsonNode | undefined)?.['plpgsql_funcs'])[0]?.[
      'PLpgSQL_function'
    ] as JsonNode | undefined
    const queries = fn === undefined ? [] : embeddedQueries(fn['action'])
    const roleQueries = queries.filter((q) => singleRoleStatement(major, q) !== undefined)
    // A DO block without role statements (or one no parser can read) is ordinary procedural SQL.
    if (fn === undefined || roleQueries.length === 0) continue
    const statements: Collected[] = []
    const datums = objects(fn['datums']).every((d) => {
      const v = nodeType(d)
      return v?.type === 'PLpgSQL_var' && IMPLICIT.has(String(v.body['refname'] ?? ''))
    })
    const action = nodeType(fn['action'])
    const roleOnly =
      datums &&
      action?.type === 'PLpgSQL_stmt_block' &&
      roleOnlyBlock(major, action.body, { presenceOnly: false, when: [] }, statements, true) &&
      statements.every((s) => singleRoleStatement(major, s.query) !== undefined)
    if (!roleOnly) {
      out.push({
        index,
        type: st.type,
        form: 'mixed_do_block',
        effects: { expectations: [], unknown: true },
      })
      continue
    }
    const expectations: ClusterGlobalExpectation[] = []
    let unknown = false
    for (const s of statements) {
      const role = singleRoleStatement(major, s.query)
      const effects =
        role === undefined
          ? null
          : roleStatementEffects(role.type, role.node, { presenceOnly: s.presenceOnly })
      if (effects === null) {
        unknown = true
        continue
      }
      for (const e of effects.expectations) {
        // A statement that undoes what its guard asked (IF EXISTS … THEN DROP ROLE, REVOKE)
        // leaves the same state whether the guard held or not: that guard does not apply.
        const when = s.when.filter(
          (c) => !(expectationKey(c) === expectationKey(e) && 'exists' in e && !e.exists),
        )
        expectations.push(when.length === 0 ? e : { ...e, when })
      }
      unknown ||= effects.unknown
    }
    out.push({ index, type: st.type, form: 'role_do_block', effects: { expectations, unknown } })
  }
  return out
}
