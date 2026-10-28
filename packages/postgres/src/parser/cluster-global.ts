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

/**
 * How far a guard must name `pg_catalog` itself to be read as the system
 * catalog's:
 *
 * - `none`: `pg_roles`, `::regrole` and `=` as written (PostgreSQL searches
 *   `pg_catalog` first unless a `search_path` names it later);
 * - `relations`: the history creates or renames a relation under a guard
 *   catalog's name (a temporary `pg_roles` is found before `pg_catalog`'s),
 *   so only `pg_catalog.pg_roles` and `pg_catalog.pg_auth_members` count;
 * - `all`: the history creates an operator named `=`, or sets a
 *   `search_path` that names `pg_catalog` after another schema, so the
 *   relation, every cast (`::pg_catalog.regrole`) and the operator
 *   (`OPERATOR(pg_catalog.=)`) must be qualified.
 *
 * Read from the text of the whole history, string literals included (the
 * verification review of follow-up 2, P2-2 and P3-3); a name built at run
 * time (`format('%I', …)`) is not seen (legacy-import.md §2.4).
 */
export type GuardStrictness = 'none' | 'relations' | 'all'

const SHADOWING =
  /\b(?:table|view|into|to|exists)\s+(?:only\s+)?(?:"?[\w$]+"?\s*\.\s*)?"?(?:pg_roles|pg_auth_members)\b/i
const EQUALS_OPERATOR = /\b(?:create|alter)\s+operator\s+(?:[\w$"]+\s*\.\s*)?=\s*\(/i
/** `, pg_catalog` (optionally quoted): one `\s*` on each side of the quote would make a long run of white space quadratic. */
const CATALOG_AFTER_COMMA = /,\s*(?:["']\s*)?pg_catalog\b/i

/**
 * Whether a `search_path` names `pg_catalog` after another schema: from a
 * `search_path` to the next `;`, once. The first one in a statement covers the
 * rest of it, so the scan continues after the `;` and reads the text once
 * (TC-004: a lazy `[^;]*?` rescanned the statement for every occurrence, 17 s
 * for a 100 KB file, hours for 4 MiB).
 */
export function catalogNamedLater(text: string): boolean {
  const word = /\bsearch_path\b/gi
  for (let m = word.exec(text); m !== null; m = word.exec(text)) {
    const end = text.indexOf(';', m.index)
    if (CATALOG_AFTER_COMMA.test(text.slice(m.index + m[0].length, end < 0 ? undefined : end)))
      return true
    if (end < 0) return false
    word.lastIndex = end
  }
  return false
}

/** The strictness a history's guards are read with (see {@link GuardStrictness}). */
export function guardStrictness(texts: readonly string[]): GuardStrictness {
  let strictness: GuardStrictness = 'none'
  for (const text of texts) {
    if (EQUALS_OPERATOR.test(text) || catalogNamedLater(text)) return 'all'
    if (SHADOWING.test(text)) strictness = 'relations'
  }
  return strictness
}

const STRICTER: Record<GuardStrictness, number> = { none: 0, relations: 1, all: 2 }

/** Loads the file's major and the PL/pgSQL parser (18). */
export async function loadClusterGlobalParsers(major: SupportedMajor): Promise<void> {
  await Promise.all([loadParser(major), loadParser(18)])
}

/**
 * How deep a parse tree is followed (JSON levels). Ordinary statements stay
 * far below; deeper is not read, and is said so, before the stack ends.
 */
const MAX_TREE_DEPTH = 1000

/** RAISE levels below EXCEPTION (ERROR is 21 in PostgreSQL's elog.h). */
const MAX_RAISE_LEVEL = 19

function objects(value: unknown): JsonNode[] {
  return Array.isArray(value)
    ? value.filter((v): v is JsonNode => typeof v === 'object' && v !== null)
    : []
}

/**
 * Every embedded SQL statement anywhere in a PL/pgSQL tree (for the mixed
 * check), or `undefined` when the tree is deeper than it is followed (the
 * verification review of follow-up 2, P3-6).
 */
function embeddedQueries(value: unknown, out: string[] = [], depth = 0): string[] | undefined {
  if (depth > MAX_TREE_DEPTH) return undefined
  if (Array.isArray(value)) {
    for (const v of value) if (embeddedQueries(v, out, depth + 1) === undefined) return undefined
  } else if (typeof value === 'object' && value !== null) {
    const execsql = (value as JsonNode)['PLpgSQL_stmt_execsql']
    if (typeof execsql === 'object' && execsql !== null) {
      const q = ((execsql as JsonNode)['sqlstmt'] as JsonNode | undefined)?.['PLpgSQL_expr']
      const query = str((q as JsonNode | undefined)?.['query'])
      if (query !== null) out.push(query)
    }
    for (const v of Object.values(value))
      if (embeddedQueries(v, out, depth + 1) === undefined) return undefined
  }
  return out
}

/** How many exception blocks a PL/pgSQL tree holds (each brings SQLSTATE and SQLERRM). */
function exceptionBlocks(value: unknown, depth = 0): number {
  if (depth > MAX_TREE_DEPTH || typeof value !== 'object' || value === null) return 0
  let n = !Array.isArray(value) && 'PLpgSQL_exception_block' in value ? 1 : 0
  for (const v of Object.values(value)) n += exceptionBlocks(v, depth + 1)
  return n
}

/**
 * The function's datums are the parser's own and nothing else: `found`,
 * then SQLSTATE and SQLERRM (`text` constants) of each exception block. A
 * declared variable, even a constant named like them, runs code at block
 * entry through a default or a domain's check (the verification review of
 * follow-up 2, P2-1).
 */
function implicitDatumsOnly(fn: JsonNode): boolean {
  const datums = objects(fn['datums']).map((d) => nodeType(d))
  if (datums.length !== 1 + 2 * exceptionBlocks(fn['action'])) return false
  return datums.every((v, i) => {
    if (v?.type !== 'PLpgSQL_var') return false
    const type = str(
      ((v.body['datatype'] as JsonNode | undefined)?.['PLpgSQL_type'] as JsonNode | undefined)?.[
        'typname'
      ],
    )
    const name = i === 0 ? 'found' : i % 2 === 1 ? 'sqlstate' : 'sqlerrm'
    if (v.body['refname'] !== name) return false
    if (i === 0) return type === 'boolean' && onlyKeys(v.body, ['refname', 'datatype'])
    return (
      type === 'text' &&
      v.body['isconst'] === true &&
      onlyKeys(v.body, ['refname', 'lineno', 'datatype', 'isconst'])
    )
  })
}

interface Collected {
  readonly query: string
  /** Inside an exception handler or a `NOT EXISTS` guard: only what holds whether it ran or not. */
  readonly presenceOnly: boolean
  /** The `IF EXISTS` guards around it. */
  readonly when: readonly ClusterGlobalCondition[]
  /** The `IF NOT EXISTS` guards around it: it ran only while these were missing. */
  readonly absent: readonly ClusterGlobalCondition[]
  /**
   * The IF statements around it, one id each: a guard is evaluated where its
   * IF stands, after what ran before it, so two IFs with the same guard are
   * two decisions (the verification review of follow-up 2, P3-1).
   */
  readonly guards: readonly number[]
}

interface Scope {
  readonly presenceOnly: boolean
  readonly when: readonly ClusterGlobalCondition[]
  readonly absent: readonly ClusterGlobalCondition[]
  readonly guards: readonly number[]
  /** How far a guard must name `pg_catalog` (see {@link GuardStrictness}). */
  readonly strictness: GuardStrictness
  /** The IF statements and blocks it is nested in: deeper than {@link MAX_BLOCK_DEPTH} is mixed. */
  readonly depth: number
  /** The next IF statement's id. */
  readonly ids: { next: number }
}

/** How deep a role-only block may nest blocks and IF statements. */
const MAX_BLOCK_DEPTH = 64

/**
 * A RAISE below EXCEPTION that changes nothing: without parameters, or, in
 * an exception handler only, with SQLERRM or SQLSTATE (outside a handler
 * they are no variables: the RAISE fails at run time, and a handler around
 * it would swallow what follows; the verification review of follow-up 2,
 * P3-2).
 */
function harmlessRaise(
  n: { readonly type: string; readonly body: JsonNode } | undefined,
  inHandler: boolean,
): boolean {
  if (n?.type !== 'PLpgSQL_stmt_raise') return false
  const level = n.body['elog_level']
  if (typeof level !== 'number' || level > MAX_RAISE_LEVEL) return false
  if (n.body['options'] !== undefined || n.body['condname'] !== undefined) return false
  const params = objects(n.body['params'])
  if (!inHandler) return params.length === 0
  return params.every((p) => {
    const q = str(((p as JsonNode)['PLpgSQL_expr'] as JsonNode | undefined)?.['query'])
    return q !== null && /^\s*(sqlerrm|sqlstate)\s*$/i.test(q)
  })
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
  const inner = {
    ...scope,
    presenceOnly: scope.presenceOnly || exceptions !== undefined,
    depth: scope.depth + 1,
  }
  if (!roleOnlyBody(major, block['body'], inner, out, top)) return false
  if (exceptions !== undefined) {
    for (const exc of objects((exceptions as JsonNode)['exc_list'])) {
      const e = nodeType(exc)
      if (e?.type !== 'PLpgSQL_exception') return false
      for (const action of objects(e.body['action'])) {
        if (!harmlessRaise(nodeType(action), true)) return false
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
  if (scope.depth > MAX_BLOCK_DEPTH) return false
  const body = objects(items)
  for (const [at, item] of body.entries()) {
    const n = nodeType(item)
    if (n?.type === 'PLpgSQL_stmt_block') {
      if (!roleOnlyBlock(major, n.body, scope, out, false)) return false
    } else if (harmlessRaise(n, false)) {
      // A notice changes nothing.
    } else if (n?.type === 'PLpgSQL_stmt_if') {
      // A guard and its THEN branch: an ELSIF branch, or an ELSE branch that does more than
      // raise a notice, runs when the guard is false.
      if (n.body['elsif_list'] !== undefined) return false
      if (!objects(n.body['else_body']).every((e) => harmlessRaise(nodeType(e), false)))
        return false
      const cond = str(
        ((n.body['cond'] as JsonNode | undefined)?.['PLpgSQL_expr'] as JsonNode | undefined)?.[
          'query'
        ],
      )
      const guard = cond === null ? undefined : roleGuard(major, cond, scope.strictness)
      if (guard === undefined) return false
      // NOT EXISTS: the branch ran only if the role or membership was missing, so only what
      // holds either way is kept. EXISTS: what the branch states holds only while the guard does.
      const next = {
        ...scope,
        presenceOnly: scope.presenceOnly || guard.absent.length > 0,
        when: [...scope.when, ...guard.holds],
        absent: [...scope.absent, ...guard.absent],
        guards: [...scope.guards, scope.ids.next++],
        depth: scope.depth + 1,
      }
      if (!roleOnlyBody(major, n.body['then_body'], next, out, false)) return false
    } else if (n?.type === 'PLpgSQL_stmt_execsql') {
      const expr = (n.body['sqlstmt'] as JsonNode | undefined)?.['PLpgSQL_expr'] as
        | JsonNode
        | undefined
      const query = str(expr?.['query'])
      if (query === null || n.body['into'] !== undefined || n.body['target'] !== undefined) {
        return false
      }
      out.push({
        query,
        presenceOnly: scope.presenceOnly,
        when: scope.when,
        absent: scope.absent,
        guards: scope.guards,
      })
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

/** `=` (unless every name must be qualified) or `OPERATOR(pg_catalog.=)`. */
function isEquals(name: unknown, qualified: boolean): boolean {
  const parts = list(name).map((p) => {
    const n = nodeType(p)
    return n?.type === 'String' ? str(n.body['sval']) : null
  })
  return (
    (!qualified && parts.length === 1 && parts[0] === '=') ||
    (parts.length === 2 && parts[0] === 'pg_catalog' && parts[1] === '=')
  )
}

/** A string constant, optionally cast to one of `types`: its value and the cast's type. */
function stringConstant(
  value: unknown,
  types: readonly string[],
  qualified: boolean,
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
      names.length === 1 && !qualified
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

/**
 * A value as a `name` holds it: at most 63 bytes, cut at a character
 * boundary, as PostgreSQL cuts a longer literal or identifier (the
 * statements' own role names arrive cut by the scanner already).
 */
function asName(value: string): string {
  const bytes = new TextEncoder().encode(value)
  if (bytes.length <= 63) return value
  let end = 63
  // A UTF-8 continuation byte (10xxxxxx) never starts a character.
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--
  return new TextDecoder().decode(bytes.subarray(0, end))
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
  strictness: GuardStrictness,
):
  | {
      readonly holds: readonly ClusterGlobalCondition[]
      readonly absent: readonly ClusterGlobalCondition[]
    }
  | undefined {
  const parsed = parseWith(major, `SELECT ${query}`, MAX_MIGRATION_PARSE_BYTES)
  if (!parsed.ok || parsed.statements.length !== 1) return undefined
  const [st] = parsed.statements
  if (st?.type !== 'SelectStmt' || !plainSelect(st.node, ['targetList'])) return undefined
  const targets = list(st.node['targetList'])
  const target = targets.length === 1 ? nodeType(targets[0]) : undefined
  if (target?.type !== 'ResTarget' || !onlyKeys(target.body, ['val', 'location'])) return undefined
  const top = nodeType(target.body['val'])
  // Several conditions joined by AND; each one an [NOT] EXISTS.
  const parts =
    top?.type === 'BoolExpr' && top.body['boolop'] === 'AND_EXPR'
      ? list(top.body['args'])
      : [target.body['val']]
  const holds: ClusterGlobalCondition[] = []
  const absent: ClusterGlobalCondition[] = []
  for (const part of parts) {
    const c = existsCondition(part, strictness)
    if (c === undefined) return undefined
    ;(c.negated ? absent : holds).push(c.condition)
  }
  return { holds, absent }
}

/** One `[NOT] EXISTS (SELECT … FROM pg_roles | pg_auth_members WHERE …)`, or `undefined`. */
function existsCondition(
  node: unknown,
  strictness: GuardStrictness,
): { readonly negated: boolean; readonly condition: ClusterGlobalCondition } | undefined {
  let value = nodeType(node)
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
    !plainSelect(sub.body, ['targetList', 'fromClause', 'whereClause', 'limitCount'])
  )
    return undefined
  // EXISTS reads one row at most: a LIMIT of a positive constant changes nothing.
  if (sub.body['limitCount'] !== undefined) {
    const limit = nodeType(sub.body['limitCount'])
    const n = limit?.type === 'A_Const' ? (limit.body['ival'] as JsonNode | undefined)?.['ival'] : 0
    if (sub.body['limitOption'] !== 'LIMIT_OPTION_COUNT' || typeof n !== 'number' || n < 1)
      return undefined
  }
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
  if (schema !== undefined ? schema !== 'pg_catalog' : strictness !== 'none') return undefined
  const qualified = strictness === 'all'
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
      !isEquals(e.body['name'], qualified) ||
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
    const v = stringConstant(
      constant,
      relation === 'pg_roles' ? ['name', 'text'] : ['regrole'],
      qualified,
    )
    if (v === undefined) return undefined
    // `name = text` compares as text: a longer constant is never equal to a role name, and
    // is not cut to one (the verification review of follow-up 2, P3-4). Not a guard.
    if (v.type === 'text' && new TextEncoder().encode(v.value).length > 63) return undefined
    equal.set(col, v)
  }
  if (relation === 'pg_roles') {
    const role = equal.get('rolname')
    if (equal.size !== 1 || role === undefined) return undefined
    return { negated, condition: { kind: 'role', role: asName(role.value), exists: true } }
  }
  const role = equal.get('roleid')
  const member = equal.get('member')
  if (equal.size !== 2 || role?.type !== 'regrole' || member?.type !== 'regrole') return undefined
  const grantedRole = regroleName(role.value)
  const memberName = regroleName(member.value)
  if (grantedRole === undefined || memberName === undefined) return undefined
  return {
    negated,
    condition: {
      kind: 'membership',
      role: asName(grantedRole),
      member: asName(memberName),
      exists: true,
    },
  }
}

/** A SELECT without DISTINCT, GROUP BY, HAVING, WINDOW, ORDER BY, LIMIT, locking, WITH or set operations. */
function plainSelect(node: JsonNode, allowed: readonly string[]): boolean {
  return (
    onlyKeys(node, [...allowed, 'limitOption', 'op']) &&
    (node['limitOption'] === undefined ||
      node['limitOption'] === 'LIMIT_OPTION_DEFAULT' ||
      (allowed.includes('limitCount') && node['limitOption'] === 'LIMIT_OPTION_COUNT')) &&
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
  /** The whole history's ({@link guardStrictness}); the file's own is always read too. */
  history: GuardStrictness = 'none',
): ClusterGlobalStatement[] | undefined {
  const parsed = parseWith(major, text, MAX_MIGRATION_PARSE_BYTES)
  if (!parsed.ok) return undefined
  const own = guardStrictness([text])
  const strictness = STRICTER[own] > STRICTER[history] ? own : history
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
    // Too deep to follow: whatever it holds, it is not elided.
    const roleQueries =
      queries === undefined
        ? ['']
        : queries.filter((q) => singleRoleStatement(major, q) !== undefined)
    // A DO block without role statements (or one no parser can read) is ordinary procedural SQL.
    if (fn === undefined || roleQueries.length === 0) continue
    const statements: Collected[] = []
    const action = nodeType(fn['action'])
    const roleOnly =
      queries !== undefined &&
      implicitDatumsOnly(fn) &&
      action?.type === 'PLpgSQL_stmt_block' &&
      roleOnlyBlock(
        major,
        action.body,
        {
          presenceOnly: false,
          when: [],
          absent: [],
          guards: [],
          strictness,
          depth: 0,
          ids: { next: 0 },
        },
        statements,
        true,
      ) &&
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
    const raw: { readonly e: ClusterGlobalExpectation; readonly from: Collected }[] = []
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
      for (const e of effects.expectations) raw.push({ e, from: s })
      unknown ||= effects.unknown
    }
    out.push({
      index,
      type: st.type,
      form: 'role_do_block',
      effects: { expectations: blockExpectations(raw), unknown },
    })
  }
  return out
}

/**
 * What a role-only block states, in its order. The block runs top to
 * bottom, so a later statement about the same thing (or a later removal of
 * a role) supersedes an earlier one whenever it ran at least as often: it
 * stands in no IF statement the earlier one is outside of. Then each surviving expectation gets
 * its guards: a statement that undoes what its own `EXISTS` guard asked
 * (`IF EXISTS … THEN DROP ROLE`, `REVOKE`) leaves the same state either way,
 * so that guard does not apply; under a `NOT EXISTS` guard only the guard's
 * own subject made present holds either way, anything else is checked but
 * never supersedes (`when`, possibly empty).
 */
function blockExpectations(
  raw: readonly { readonly e: ClusterGlobalExpectation; readonly from: Collected }[],
): ClusterGlobalExpectation[] {
  // The later statement ran whenever the earlier did: it stands in no IF the earlier one is
  // outside of (the same IF statements, not merely the same guards).
  const within = (inner: Collected, outer: Collected) =>
    inner.guards.every((g) => outer.guards.includes(g)) &&
    (!inner.presenceOnly || outer.presenceOnly)
  const kept = raw.filter((x, i) =>
    raw.slice(i + 1).every((later) => {
      if (!within(later.from, x.from)) return true
      if (expectationKey(later.e) === expectationKey(x.e)) return false
      const removed = later.e.kind === 'role' && !later.e.exists ? later.e.role : null
      return removed === null || !rolesOf(x.e).includes(removed)
    }),
  )
  return kept.map(({ e, from }) => {
    const key = expectationKey(e)
    const undoes = 'exists' in e && !e.exists
    const when = from.when.filter((c) => !(undoes && expectationKey(c) === key))
    // Only when the subject is the one missing thing the branch waited for: with another
    // (`NOT EXISTS (a) AND NOT EXISTS (b)`), it may not have run while the subject was missing
    // (the verification review of follow-up 2, P2-5).
    const eitherWay =
      'exists' in e &&
      e.exists &&
      from.absent.length === 1 &&
      from.absent.some((c) => expectationKey(c) === key)
    if (from.absent.length > 0 && !eitherWay) return { ...e, when }
    return when.length === 0 ? e : { ...e, when }
  })
}
