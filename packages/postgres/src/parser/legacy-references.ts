import type { SupportedMajor } from './majors.ts'
import {
  type JsonNode,
  MAX_MIGRATION_PARSE_BYTES,
  names,
  nodeType,
  parsePlpgsql,
  parseWith,
} from './parse.ts'

/**
 * What a legacy history references in schemas **outside** the project's
 * managed scope ([`legacy-import.md` §2.5](../../../../exponetdb-docs/04-migrations/legacy-import.md#25-scratch-targets),
 * follow-up 2 F3): the objects a replay needs on the scratch target before
 * the file that names them runs (an `auth.uid()` in a policy, a foreign key
 * to `auth.users`, a column of an `auth` type), which the imported target's
 * current schema may no longer depend on.
 *
 * Pure: read from each file's parse tree (the major's own grammar), from
 * the body of every `LANGUAGE sql` function (PostgreSQL validates it at
 * `CREATE FUNCTION`) and from every SQL statement and expression of a
 * PL/pgSQL `DO` block (it runs during the replay). PL/pgSQL function bodies
 * run only when called and are not read. Only schema-qualified names count:
 * an unqualified one resolves through the replay's search path. An object
 * the history itself creates is not a reference. The parsers of `major` and
 * of 18 (for `DO` bodies) must be loaded.
 */
export interface LegacyReference {
  readonly kind: 'relation' | 'function' | 'type' | 'schema'
  readonly schema: string
  readonly name: string
  /** The first file (stem) that names it. */
  readonly file: string
}

export interface LegacyReferences {
  readonly references: readonly LegacyReference[]
  /** Files the major's grammar cannot read (the replay refuses them). */
  readonly unparsed: readonly string[]
  /** Bodies nest deeper than the scan follows: what they name is not known. */
  readonly tooComplex: boolean
}

/** How deep bodies inside bodies are followed (a file's statements are level 0). */
export const MAX_BODY_NESTING = 2

/**
 * How deep a parse tree is followed (JSON levels). Ordinary statements stay
 * far below; deeper is not read, and is said so, before the stack ends.
 */
const MAX_TREE_DEPTH = 1000

export interface ScopeTest {
  readonly includeSchemas?: readonly string[] | null
  readonly excludeSchemas?: readonly string[] | null
}

const SYSTEM = new Set(['pg_catalog', 'information_schema', 'pg_toast', 'exponetdb'])

/** Whether a schema lies outside the managed scope and outside the system's. */
export function outsideScope(scope: ScopeTest, schema: string): boolean {
  if (SYSTEM.has(schema) || schema.startsWith('pg_temp') || schema.startsWith('pg_toast_temp'))
    return false
  const included =
    scope.includeSchemas === undefined || scope.includeSchemas === null
      ? true
      : scope.includeSchemas.includes(schema)
  return !included || (scope.excludeSchemas ?? []).includes(schema)
}

type Kind = LegacyReference['kind']

interface Collector {
  /** What the statement being read names. */
  readonly refs: Map<string, { kind: Kind; schema: string; name: string }>
  /** What the history created so far (`schema\u0000name`; a schema as `\u0000schema`). */
  readonly created: Set<string>
  tooComplex: boolean
}

const key = (schema: string, name: string) => `${schema}\u0000${name}`

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function qualified(list: unknown): readonly [string, string] | undefined {
  const parts = names(list)
  return parts?.length === 2 ? [parts[0] as string, parts[1] as string] : undefined
}

function rangeVar(value: unknown): readonly [string, string] | undefined {
  const n = nodeType(value)
  const body = n?.type === 'RangeVar' ? n.body : (value as JsonNode | undefined)
  const schema = str(body?.['schemaname'])
  const name = str(body?.['relname'])
  return schema !== null && name !== null ? [schema, name] : undefined
}

function add(c: Collector, kind: Kind, at: readonly [string, string] | undefined): void {
  if (at === undefined) return
  const k = `${kind}\u0000${key(at[0], at[1])}`
  if (!c.refs.has(k)) c.refs.set(k, { kind, schema: at[0], name: at[1] })
}

/** An object created in a schema needs the schema. */
function create(c: Collector, at: readonly [string, string] | undefined): void {
  if (at === undefined) return
  c.created.add(key(at[0], at[1]))
  add(c, 'schema', [at[0], at[0]])
}

function schemaRef(c: Collector, name: unknown): void {
  const n = nodeType(name)
  const schema = n?.type === 'String' ? str(n.body['sval']) : str(name)
  if (schema !== null) add(c, 'schema', [schema, schema])
}

/** What one statement's tree names and creates (and its SQL function bodies). */
function visit(
  major: SupportedMajor,
  value: unknown,
  c: Collector,
  level: number,
  depth = 0,
): void {
  // Deeper than the scan follows: what is below is not read, so the scan is not complete.
  if (depth > MAX_TREE_DEPTH) {
    c.tooComplex = true
    return
  }
  if (Array.isArray(value)) {
    for (const v of value) visit(major, v, c, level, depth + 1)
    return
  }
  if (typeof value !== 'object' || value === null) return
  const n = nodeType(value)
  if (n === undefined) {
    const body = value as JsonNode
    // A type name, and a relation inside many statements, are bare objects in the JSON tree.
    if (Array.isArray(body['names']) && 'typemod' in body) add(c, 'type', qualified(body['names']))
    if (typeof body['relname'] === 'string' && 'relpersistence' in body)
      add(c, 'relation', rangeVar(body))
    // So is the call of CALL.
    if (Array.isArray(body['funcname']) && 'funcformat' in body)
      add(c, 'function', qualified(body['funcname']))
    for (const v of Object.values(body)) visit(major, v, c, level, depth + 1)
    return
  }
  const body = n.body
  switch (n.type) {
    // Dropping what is not there needs nothing (and IF EXISTS is the norm).
    case 'DropStmt':
      return
    case 'GrantStmt':
      if (
        ['OBJECT_FUNCTION', 'OBJECT_PROCEDURE', 'OBJECT_ROUTINE'].includes(String(body['objtype']))
      ) {
        for (const o of Array.isArray(body['objects']) ? body['objects'] : []) {
          const f = nodeType(o)
          if (f?.type === 'ObjectWithArgs') add(c, 'function', qualified(f.body['objname']))
        }
      } else if (body['objtype'] === 'OBJECT_SCHEMA') {
        for (const o of Array.isArray(body['objects']) ? body['objects'] : []) schemaRef(c, o)
      }
      break
    case 'AlterDefaultPrivilegesStmt':
      for (const o of Array.isArray(body['options']) ? body['options'] : []) {
        const d = nodeType(o)
        if (d?.type !== 'DefElem' || d.body['defname'] !== 'schemas') continue
        const items = nodeType(d.body['arg'])?.body['items'] ?? d.body['arg']
        for (const item of Array.isArray(items) ? items : []) schemaRef(c, item)
      }
      break
    case 'CreateSchemaStmt': {
      const name = str(body['schemaname'])
      if (name !== null) c.created.add(key('', name))
      break
    }
    case 'CommentStmt': {
      const objtype = String(body['objtype'])
      const object = nodeType(body['object'])
      if (
        [
          'OBJECT_TABLE',
          'OBJECT_VIEW',
          'OBJECT_MATVIEW',
          'OBJECT_FOREIGN_TABLE',
          'OBJECT_SEQUENCE',
        ].includes(objtype)
      ) {
        add(c, 'relation', qualified(object?.type === 'List' ? object.body['items'] : undefined))
      } else if (['OBJECT_FUNCTION', 'OBJECT_PROCEDURE'].includes(objtype)) {
        if (object?.type === 'ObjectWithArgs') add(c, 'function', qualified(object.body['objname']))
      }
      break
    }
    case 'FuncCall':
      add(c, 'function', qualified(body['funcname']))
      break
    case 'RangeVar':
      add(c, 'relation', rangeVar(body))
      break
    case 'CreateTrigStmt':
      add(c, 'function', qualified(body['funcname']))
      break
    case 'CreateStmt':
      create(c, rangeVar(body['relation']))
      break
    case 'ViewStmt':
      create(c, rangeVar(body['view']))
      break
    case 'CreateSeqStmt':
      create(c, rangeVar(body['sequence']))
      break
    case 'CreateTableAsStmt':
      create(
        c,
        rangeVar(
          nodeType(body['into'])?.body['rel'] ?? (body['into'] as JsonNode | undefined)?.['rel'],
        ),
      )
      break
    case 'CompositeTypeStmt':
      create(c, rangeVar(body['typevar']))
      break
    case 'CreateEnumStmt':
    case 'CreateRangeStmt':
      create(c, qualified(body['typeName']))
      break
    case 'CreateDomainStmt':
      create(c, qualified(body['domainname']))
      break
    case 'DefineStmt':
      create(c, qualified(body['defnames']))
      break
    case 'CreateFunctionStmt': {
      create(c, qualified(body['funcname']))
      const options = (Array.isArray(body['options']) ? body['options'] : []).map((o) =>
        nodeType(o),
      )
      const option = (name: string) => options.find((o) => o?.body['defname'] === name)?.body['arg']
      const language = nodeType(option('language'))
      const lang = language?.type === 'String' ? str(language.body['sval'])?.toLowerCase() : null
      const asArg = option('as')
      const as = names(nodeType(asArg)?.type === 'List' ? nodeType(asArg)?.body['items'] : asArg)
      // A LANGUAGE sql body is parsed and checked at CREATE FUNCTION (BEGIN ATOMIC is in the tree).
      if (lang === 'sql' && as?.length === 1 && as[0] !== undefined)
        statements(major, as[0], c, level + 1)
      break
    }
  }
  for (const v of Object.values(body)) visit(major, v, c, level, depth + 1)
}

/** Reads one text's statements at `level`; `false` when its grammar cannot read it. */
function statements(major: SupportedMajor, text: string, c: Collector, level: number): boolean {
  if (level > MAX_BODY_NESTING) {
    c.tooComplex = true
    return true
  }
  const parsed = parseWith(major, text, MAX_MIGRATION_PARSE_BYTES)
  if (!parsed.ok) {
    // A body too large to parse is not read: the scan is not complete.
    if (parsed.failure.kind !== 'too_large') return false
    c.tooComplex = true
    return true
  }
  for (const st of parsed.statements) {
    visit(major, { [st.type]: st.node }, c, level)
    if (st.type === 'DoStmt') doBlock(major, text.slice(st.start, st.end), st.node, c, level + 1)
  }
  return true
}

/** Every SQL statement and expression of a PL/pgSQL DO block. */
function doBlock(
  major: SupportedMajor,
  text: string,
  node: JsonNode,
  c: Collector,
  level: number,
): void {
  if (level > MAX_BODY_NESTING) {
    c.tooComplex = true
    return
  }
  for (const arg of Array.isArray(node['args']) ? node['args'] : []) {
    const d = nodeType(arg)
    if (d?.type === 'DefElem' && d.body['defname'] === 'language') {
      const v = nodeType(d.body['arg'])
      if ((v?.type === 'String' ? str(v.body['sval']) : null)?.toLowerCase() !== 'plpgsql') return
    }
  }
  const queries: { query: string; statement: boolean }[] = []
  const collect = (value: unknown, depth = 0): void => {
    if (depth > MAX_TREE_DEPTH) {
      c.tooComplex = true
      return
    }
    if (Array.isArray(value)) {
      for (const v of value) collect(v, depth + 1)
    } else if (typeof value === 'object' && value !== null) {
      const expr = (value as JsonNode)['PLpgSQL_expr'] as JsonNode | undefined
      const query = str(expr?.['query'])
      if (query !== null) queries.push({ query, statement: expr?.['parseMode'] === 0 })
      for (const v of Object.values(value)) collect(v, depth + 1)
    }
  }
  const tree = parsePlpgsql(text)
  // A body the PL/pgSQL parser cannot be given (too large) or cannot read is not scanned.
  if (tree === undefined) {
    c.tooComplex = true
    return
  }
  collect(tree)
  for (const q of queries) {
    // A statement's text is parsed as it is; an expression as a SELECT of it.
    if (!statements(major, q.query, c, level) && !q.statement)
      statements(major, `SELECT ${q.query}`, c, level)
  }
}

/** The references of a whole history into schemas outside the scope, in file order. */
export function legacyReferences(
  major: SupportedMajor,
  files: readonly { readonly name: string; readonly text: string }[],
  scope: ScopeTest,
): LegacyReferences {
  const c: Collector = { refs: new Map(), created: new Set(), tooComplex: false }
  const first = new Map<string, LegacyReference>()
  const unparsed: string[] = []
  for (const file of files) {
    const stem = file.name.replace(/\.sql$/, '')
    const parsed = parseWith(major, file.text, MAX_MIGRATION_PARSE_BYTES)
    if (!parsed.ok) {
      // A file without statements (comments only) is no failure; the parser calls it empty.
      if (parsed.failure.kind !== 'empty') unparsed.push(stem)
      continue
    }
    for (const st of parsed.statements) {
      c.refs.clear()
      visit(major, { [st.type]: st.node }, c, 0)
      if (st.type === 'DoStmt') doBlock(major, file.text.slice(st.start, st.end), st.node, c, 1)
      // What this statement or an earlier one created is the history's own.
      for (const [k, r] of c.refs) {
        const own =
          r.kind === 'schema'
            ? c.created.has(key('', r.name))
            : c.created.has(key(r.schema, r.name))
        if (!own && !first.has(k) && outsideScope(scope, r.schema))
          first.set(k, { ...r, file: stem })
      }
    }
  }
  return { references: [...first.values()], unparsed, tooComplex: c.tooComplex }
}
