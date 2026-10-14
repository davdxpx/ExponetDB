import type { SchemaObject, SchemaObjectRef } from '@exponetdb/sdk/operations'
import type { ErdRelation, ErdTable, SchemaErdData } from '@exponetdb/ui-data'
import type { MessageKey } from '../../lib/i18n/i18n.ts'
import type { SchemaKind } from '../target/params.ts'

/**
 * The pure part of the schema browser: which object kinds of the contract a
 * page of `/schema/<kind>` lists, how an object is named for the detail read,
 * the foreign keys of a table as the diagram's relations, and the hints the
 * page raises from what a read gave (never from what a definition claims in
 * its body). No component, no clock: every rule is a table test.
 */

/** What a `/schema/<kind>` page shows. */
export type KindPlan =
  | {
      readonly type: 'objects'
      /** The kinds of the contract the search is limited to. */
      readonly kinds: readonly string[]
      readonly titleKey: MessageKey
    }
  | { readonly type: 'visualizer' }
  | { readonly type: 'unsupported'; readonly titleKey: MessageKey; readonly reasonKey: MessageKey }

export function kindPlan(kind: SchemaKind): KindPlan {
  switch (kind) {
    case 'schemas':
      return { type: 'objects', kinds: ['schema'], titleKey: 'schema.kind.schemas' }
    case 'tables':
      return { type: 'objects', kinds: ['table'], titleKey: 'schema.kind.tables' }
    case 'views':
      return { type: 'objects', kinds: ['view'], titleKey: 'schema.kind.views' }
    case 'materialized-views':
      return {
        type: 'objects',
        kinds: ['materialized_view'],
        titleKey: 'schema.kind.materialized-views',
      }
    case 'functions':
      return {
        type: 'objects',
        kinds: ['function', 'procedure'],
        titleKey: 'schema.kind.functions',
      }
    case 'triggers':
      return { type: 'objects', kinds: ['trigger'], titleKey: 'schema.kind.triggers' }
    case 'types':
      return { type: 'objects', kinds: ['type'], titleKey: 'schema.kind.types' }
    case 'sequences':
      return { type: 'objects', kinds: ['sequence'], titleKey: 'schema.kind.sequences' }
    case 'extensions':
      return { type: 'objects', kinds: ['extension'], titleKey: 'schema.kind.extensions' }
    case 'indexes':
      return { type: 'objects', kinds: ['index'], titleKey: 'schema.kind.indexes' }
    case 'policies':
      return { type: 'objects', kinds: ['policy'], titleKey: 'schema.kind.policies' }
    case 'privileges':
      // Grants are part of an object's detail; the list is the objects that carry them.
      return {
        type: 'objects',
        kinds: ['schema', 'table', 'view', 'materialized_view', 'sequence', 'function'],
        titleKey: 'schema.kind.privileges',
      }
    case 'publications':
      return { type: 'objects', kinds: ['publication'], titleKey: 'schema.kind.publications' }
    case 'roles':
      return {
        type: 'unsupported',
        titleKey: 'schema.kind.roles',
        reasonKey: 'schema.roles.requires',
      }
    case 'visualizer':
      return { type: 'visualizer' }
  }
}

/** The page of a kind in the order the information architecture lists them (tree, links). */
export const KIND_ORDER: readonly SchemaKind[] = [
  'schemas',
  'tables',
  'views',
  'materialized-views',
  'functions',
  'triggers',
  'types',
  'sequences',
  'extensions',
  'indexes',
  'policies',
  'privileges',
  'publications',
  'roles',
  'visualizer',
]

// ----- names -----

function quote(part: string): string {
  return `"${part.replaceAll('"', '""')}"`
}

/**
 * The name `getSchemaObject` takes for a reference: every part of the
 * canonical key double-quoted (a quote doubled), parts joined with dots; a
 * function or procedure is `"schema"."name"(identity arguments)`. Quoting
 * every part means a name with dots, quotes, `$$` or spaces stays one part.
 * Returns `undefined` for a reference without a key (nothing to ask for).
 */
export function qualifiedName(ref: SchemaObjectRef): string | undefined {
  const key = ref.key
  if (key.length === 0) return undefined
  if ((ref.kind === 'function' || ref.kind === 'procedure') && key.length >= 3) {
    return `${quote(key[0] ?? '')}.${quote(key[1] ?? '')}(${key[2] ?? ''})`
  }
  return key.map(quote).join('.')
}

/** A stable identity of a reference in one list. */
export function refKey(ref: SchemaObjectRef): string {
  return JSON.stringify([ref.kind, ref.key])
}

// ----- hints from the object read -----

/**
 * A security-definer function whose header sets no `search_path`: a caller
 * can plant objects the function then resolves first. Only the header of the
 * definition is read (the text before the line `AS $…$` that starts the
 * body), so text inside the body cannot switch the flag. The result is a hint
 * for a person to check the definition, not a policy decision.
 */
export function securityDefinerWithoutSearchPath(definition: string | null): boolean {
  if (definition === null) return false
  const body = /^AS\s/m.exec(definition)
  const header = body === null ? definition : definition.slice(0, body.index)
  const definer = /^\s*SECURITY DEFINER\s*$/m.test(header)
  if (!definer) return false
  const setsPath = /^\s*SET search_path\b/im.test(header)
  return !setsPath
}

/** Row level security is on, no policy is listed, and the table is not forced for its owner only: reads return no rows. */
export function rlsWithoutPolicy(object: SchemaObject): boolean {
  const rls = object.rowLevelSecurity
  if (rls === null || !rls.enabled) return false
  return object.policies !== null && object.policies.length === 0
}

export function invalidIndexes(object: SchemaObject): readonly string[] {
  return (object.indexes ?? []).filter((index) => !index.valid).map((index) => index.name)
}

export function unvalidatedConstraints(object: SchemaObject): readonly string[] {
  return (object.constraints ?? [])
    .filter((constraint) => !constraint.validated)
    .map((constraint) => constraint.name)
}

/** `1536` as `1.5 KiB`; the size of an object as the Control Plane read it. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return ''
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'] as const
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`
}

// ----- the diagram -----

/** One identifier of a definition: `"quoted ""name"""` or a bare word. Returns it and the rest of the text. */
function identifier(text: string): { readonly name: string; readonly rest: string } | undefined {
  const start = text.trimStart()
  if (start.startsWith('"')) {
    let name = ''
    let i = 1
    while (i < start.length) {
      const char = start[i]
      if (char === '"') {
        if (start[i + 1] === '"') {
          name += '"'
          i += 2
          continue
        }
        return { name, rest: start.slice(i + 1) }
      }
      name += char
      i += 1
    }
    return undefined
  }
  const bare = /^[A-Za-z_\u0080-￿][A-Za-z0-9_$\u0080-￿]*/u.exec(start)
  if (bare === null) return undefined
  return { name: bare[0], rest: start.slice(bare[0].length) }
}

/** A parenthesized, comma separated identifier list: `(a, "b c")`. */
function identifierList(
  text: string,
): { readonly names: readonly string[]; readonly rest: string } | undefined {
  let rest = text.trimStart()
  if (!rest.startsWith('(')) return undefined
  rest = rest.slice(1)
  const names: string[] = []
  for (let guard = 0; guard < 64; guard += 1) {
    const next = identifier(rest)
    if (next === undefined) return undefined
    names.push(next.name)
    rest = next.rest.trimStart()
    if (rest.startsWith(',')) {
      rest = rest.slice(1)
      continue
    }
    if (rest.startsWith(')')) return { names, rest: rest.slice(1) }
    return undefined
  }
  return undefined
}

export interface ForeignKey {
  readonly fromColumns: readonly string[]
  readonly toSchema: string | null
  readonly toTable: string
  readonly toColumns: readonly string[]
}

/**
 * The columns and referenced table of a `foreign_key` constraint's
 * definition (`FOREIGN KEY (a, b) REFERENCES schema.table(c, d) …`), or
 * `undefined` when the text does not have that shape. The text is untrusted:
 * only identifiers in the grammar's places are read, quoted identifiers may
 * hold anything, and nothing is evaluated.
 */
export function parseForeignKey(definition: string): ForeignKey | undefined {
  const head = /^\s*FOREIGN KEY\s*/i.exec(definition)
  if (head === null) return undefined
  const from = identifierList(definition.slice(head[0].length))
  if (from === undefined) return undefined
  const references = /^\s*REFERENCES\s+/i.exec(from.rest)
  if (references === null) return undefined
  let rest = from.rest.slice(references[0].length)
  const first = identifier(rest)
  if (first === undefined) return undefined
  rest = first.rest
  let toSchema: string | null = null
  let toTable = first.name
  if (rest.startsWith('.')) {
    const second = identifier(rest.slice(1))
    if (second === undefined) return undefined
    toSchema = first.name
    toTable = second.name
    rest = second.rest
  }
  const to = identifierList(rest)
  if (to === undefined) return undefined
  return { fromColumns: from.names, toSchema, toTable, toColumns: to.names }
}

/** The id of a table in the diagram: its canonical key as one unambiguous string. */
export function erdTableId(schema: string, name: string): string {
  return JSON.stringify([schema, name])
}

export interface ErdBuild {
  readonly data: SchemaErdData
  /** Foreign keys the diagram could not draw: unreadable text, or a referenced table outside the tables read. */
  readonly undrawn: number
}

/**
 * The diagram's tables and relations from the details of some tables. A
 * relation is drawn only when both ends are among the tables read; the others
 * are counted in `undrawn`, never dropped silently.
 */
export function buildErdData(tables: readonly SchemaObject[]): ErdBuild {
  const erdTables: ErdTable[] = tables.map((table) => {
    const primary = new Set(
      (table.constraints ?? [])
        .filter((constraint) => constraint.type === 'primary_key')
        .flatMap((constraint) => parsePrimaryKey(constraint.definition)),
    )
    return {
      id: erdTableId(table.ref.schema, table.ref.name),
      schema: table.ref.schema,
      name: table.ref.name,
      columns: (table.columns ?? []).map((column) => ({
        name: column.name,
        type: column.type,
        pk: primary.has(column.name),
      })),
    }
  })
  const ids = new Set(erdTables.map((table) => table.id))
  const relations: ErdRelation[] = []
  let undrawn = 0
  for (const table of tables) {
    for (const constraint of table.constraints ?? []) {
      if (constraint.type !== 'foreign_key') continue
      const parsed = parseForeignKey(constraint.definition)
      if (parsed === undefined) {
        undrawn += 1
        continue
      }
      const toId = erdTableId(parsed.toSchema ?? table.ref.schema, parsed.toTable)
      if (!ids.has(toId)) {
        undrawn += 1
        continue
      }
      relations.push({
        name: constraint.name,
        fromTable: erdTableId(table.ref.schema, table.ref.name),
        fromColumns: parsed.fromColumns,
        toTable: toId,
        toColumns: parsed.toColumns,
      })
    }
  }
  return { data: { tables: erdTables, relations }, undrawn }
}

/** The columns of a `PRIMARY KEY (a, b)` definition; empty when the text does not have that shape. */
export function parsePrimaryKey(definition: string): readonly string[] {
  const head = /^\s*PRIMARY KEY\s*/i.exec(definition)
  if (head === null) return []
  return identifierList(definition.slice(head[0].length))?.names ?? []
}
