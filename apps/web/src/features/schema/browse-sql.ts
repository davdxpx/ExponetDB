import { isQuotableIdentifier, quotedRelation, quoteIdent } from './identifiers.ts'
import { FILTER_VALUE_MAX, type FilterOp, isFilterOp, isNullOp, MAX_FILTERS } from './search.ts'

/**
 * The one statement the row browser sends: a read-only `SELECT` per page that
 * the server admits as a `data.read` (audited, masked, capped, refused for
 * constructs it does not support). The browser never decides what is safe;
 * this module only builds text that cannot mean anything but what it was
 * meant to:
 *
 * - every identifier comes from the schema read of the object and is quoted
 *   with `quoteIdent` (always quoted, `"` doubled);
 * - a filter or a keyset value is a bind parameter (`$1` and on), never part
 *   of the text; the operator is one of a fixed allowlist;
 * - `ORDER BY` names only columns of the object;
 * - `LIMIT` and `OFFSET` are integers validated here and written as digits.
 *
 * A filter or a sort from a link that does not match the object is ignored
 * and reported, never repaired and never sent. The text for the SQL editor
 * ("Open in SQL editor") is the same statement with the filter values written
 * as escaped literals, because the editor sends no parameters; that text is
 * opened and never run.
 */

/** The rows a page shows. The statement asks for one more, to know whether there are more. */
export const PAGE_SIZE = 100
/** The most rows the browser loads in one session; after that it says so and stops. */
export const MAX_LOADED_ROWS = 5_000
/** The most columns of a primary key the browser pages by. */
export const MAX_KEY_COLUMNS = 4

/** A bind parameter as the request takes it. */
export type Param = string | number | boolean | null
/** A value that can stand for a row in a keyset cursor. */
export type KeyValue = string | number | boolean

export interface BrowseColumn {
  readonly name: string
  /** The canonical type of the column (`uuid`, `character varying(255)`). */
  readonly type: string
}

export interface BrowseFilter {
  readonly column: string
  readonly op: FilterOp
  readonly value: string
}

export interface BrowseSort {
  readonly column: string
  readonly direction: 'asc' | 'desc'
}

export type BrowseCursor =
  | { readonly kind: 'keyset'; readonly values: readonly KeyValue[] }
  | { readonly kind: 'offset'; readonly offset: number }

export interface BrowseRequest {
  readonly schema: string
  readonly name: string
  readonly columns: readonly BrowseColumn[]
  /** The primary key columns in key order; empty when the object has none. */
  readonly primaryKey: readonly string[]
  readonly sort?: BrowseSort | undefined
  readonly filters: readonly BrowseFilter[]
  /** Where the next page starts; absent for the first page. */
  readonly cursor?: BrowseCursor | undefined
}

export type IgnoredReason = 'unknown_column' | 'bad_operator' | 'bad_value' | 'too_many'

export interface IgnoredFilter {
  readonly filter: BrowseFilter
  readonly reason: IgnoredReason
}

export type BrowseRefusal = 'no_columns' | 'unquotable_name' | 'bad_cursor'

export interface BrowsePlan {
  /** The statement text, with `$1` and on where a value goes. */
  readonly sql: string
  readonly params: readonly Param[]
  /** What the rows are ordered by: the primary key, the chosen sort, or nothing. */
  readonly order: 'primary_key' | 'sort' | 'none'
  /** Keyset paging is possible with this ordering (else the next page is an OFFSET). */
  readonly keyset: boolean
  /** The columns whose values in the last row start the next page when `keyset` is true. */
  readonly keysetColumns: readonly string[]
  readonly ignoredFilters: readonly IgnoredFilter[]
  /** A sort was asked for that is not a column of the object. */
  readonly sortIgnored: boolean
}

export type BrowseBuild =
  | { readonly ok: true; readonly plan: BrowsePlan }
  | { readonly ok: false; readonly reason: BrowseRefusal }

/**
 * Types whose values come back on the wire exactly and compare the same way in
 * the database, so a value of the last row can start the next page. Anything
 * else (timestamps, floats, bytes, enums, arrays, composites) pages by OFFSET.
 */
const KEYSET_TYPE =
  /^(smallint|integer|bigint|int2|int4|int8|uuid|text|character varying|varchar|character|char|bpchar|citext|numeric|decimal)(\(.*\))?$/i

export function isKeysetType(type: string): boolean {
  return KEYSET_TYPE.test(type.trim())
}

/** The types `ILIKE` works on without a cast. */
const TEXT_TYPE = /^(text|character varying|varchar|character|char|bpchar|citext|name)(\(.*\))?$/i

export function isTextType(type: string): boolean {
  return TEXT_TYPE.test(type.trim())
}

/** A string literal with the quote doubled, and `E'…'` with the backslash doubled when there is one. */
export function sqlLiteral(value: string): string {
  const quoted = value.replaceAll("'", "''")
  return value.includes('\\') ? `E'${quoted.replaceAll('\\', '\\\\')}'` : `'${quoted}'`
}

type Bind = (value: string) => string

interface Ordering {
  readonly by: readonly { readonly column: string; readonly direction: 'ASC' | 'DESC' }[]
  readonly order: BrowsePlan['order']
  readonly keyset: boolean
}

function orderingOf(
  sort: BrowseSort | undefined,
  key: readonly string[],
  keySafe: boolean,
): Ordering {
  if (sort === undefined) {
    if (key.length === 0) return { by: [], order: 'none', keyset: false }
    return {
      by: key.map((column) => ({ column, direction: 'ASC' as const })),
      order: 'primary_key',
      keyset: keySafe,
    }
  }
  const direction = sort.direction === 'desc' ? ('DESC' as const) : ('ASC' as const)
  if (key.length === 1 && key[0] === sort.column && keySafe) {
    return { by: [{ column: sort.column, direction }], order: 'sort', keyset: true }
  }
  // A tie-break by the key makes the order the same on every read of the same rows.
  return {
    by: [
      { column: sort.column, direction },
      ...key
        .filter((column) => column !== sort.column)
        .map((column) => ({ column, direction: 'ASC' as const })),
    ],
    order: 'sort',
    keyset: false,
  }
}

/** `(a > $1 OR (a = $1 AND b > $2))`: rows after the cursor in key order, without a row comparison. */
function keysetPredicate(
  columns: readonly string[],
  direction: 'ASC' | 'DESC',
  values: readonly KeyValue[],
  bindValue: (value: KeyValue) => string,
): string {
  const placeholders = values.map(bindValue)
  const op = direction === 'ASC' ? '>' : '<'
  if (columns.length === 1)
    return `(${quoteIdent(columns[0] ?? '')} ${op} ${placeholders[0] ?? ''})`
  const alternatives = columns.map((column, index) => {
    const equal = columns
      .slice(0, index)
      .map((earlier, i) => `${quoteIdent(earlier)} = ${placeholders[i] ?? ''}`)
    return `(${[...equal, `${quoteIdent(column)} ${op} ${placeholders[index] ?? ''}`].join(' AND ')})`
  })
  return `(${alternatives.join(' OR ')})`
}

function build(request: BrowseRequest, literal: boolean, limit: number): BrowseBuild {
  const { columns } = request
  if (columns.length === 0) return { ok: false, reason: 'no_columns' }
  if (
    !isQuotableIdentifier(request.schema) ||
    !isQuotableIdentifier(request.name) ||
    columns.some((column) => !isQuotableIdentifier(column.name))
  ) {
    return { ok: false, reason: 'unquotable_name' }
  }
  const types = new Map(columns.map((column) => [column.name, column.type]))

  const params: Param[] = []
  const bindText: Bind = (value) => {
    if (literal) return sqlLiteral(value)
    params.push(value)
    return `$${params.length}`
  }
  const bindKey = (value: KeyValue): string => {
    params.push(value)
    return `$${params.length}`
  }

  // Filters: the ones that match the object, each as `"column" OP $n`.
  const where: string[] = []
  const ignoredFilters: IgnoredFilter[] = []
  let used = 0
  for (const filter of request.filters) {
    if (!isFilterOp(filter.op)) {
      ignoredFilters.push({ filter, reason: 'bad_operator' })
    } else if (!types.has(filter.column)) {
      ignoredFilters.push({ filter, reason: 'unknown_column' })
    } else if (
      !isNullOp(filter.op) &&
      (filter.value.length > FILTER_VALUE_MAX || filter.value.includes('\u0000'))
    ) {
      ignoredFilters.push({ filter, reason: 'bad_value' })
    } else if (used >= MAX_FILTERS) {
      ignoredFilters.push({ filter, reason: 'too_many' })
    } else {
      used += 1
      where.push(
        isNullOp(filter.op)
          ? `${quoteIdent(filter.column)} ${filter.op}`
          : `${quoteIdent(filter.column)} ${filter.op} ${bindText(filter.value)}`,
      )
    }
  }

  const sort =
    request.sort !== undefined && types.has(request.sort.column) ? request.sort : undefined
  const key =
    request.primaryKey.length > 0 && request.primaryKey.every((column) => types.has(column))
      ? request.primaryKey
      : []
  const keySafe =
    key.length > 0 &&
    key.length <= MAX_KEY_COLUMNS &&
    key.every((column) => isKeysetType(types.get(column) ?? ''))
  const ordering = orderingOf(sort, key, keySafe)
  const keysetColumns = ordering.keyset ? ordering.by.map((entry) => entry.column) : []

  let offset = 0
  const cursor = literal ? undefined : request.cursor
  if (cursor?.kind === 'keyset') {
    const direction = ordering.by[0]?.direction ?? 'ASC'
    if (
      !ordering.keyset ||
      cursor.values.length !== keysetColumns.length ||
      !cursor.values.every(
        (value) =>
          typeof value === 'boolean' ||
          typeof value === 'string' ||
          (typeof value === 'number' && Number.isFinite(value)),
      )
    ) {
      return { ok: false, reason: 'bad_cursor' }
    }
    where.push(keysetPredicate(keysetColumns, direction, cursor.values, bindKey))
  } else if (cursor?.kind === 'offset') {
    if (
      !Number.isSafeInteger(cursor.offset) ||
      cursor.offset < 0 ||
      cursor.offset > MAX_LOADED_ROWS
    ) {
      return { ok: false, reason: 'bad_cursor' }
    }
    offset = cursor.offset
  }

  const clauses = ['SELECT *', `FROM ${quotedRelation(request.schema, request.name)}`]
  if (where.length > 0) clauses.push(`WHERE ${where.join(' AND ')}`)
  if (ordering.by.length > 0) {
    clauses.push(
      `ORDER BY ${ordering.by.map((entry) => `${quoteIdent(entry.column)} ${entry.direction}`).join(', ')}`,
    )
  }
  // Integers checked here, written as digits: no text of a link reaches these two clauses.
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LOADED_ROWS + 1) {
    return { ok: false, reason: 'bad_cursor' }
  }
  clauses.push(`LIMIT ${String(limit)}`)
  if (offset > 0) clauses.push(`OFFSET ${String(offset)}`)

  return {
    ok: true,
    plan: {
      sql: clauses.join('\n'),
      params,
      order: ordering.order,
      keyset: ordering.keyset,
      keysetColumns,
      ignoredFilters,
      sortIgnored: request.sort !== undefined && sort === undefined,
    },
  }
}

/**
 * The statement of one page: it asks for `PAGE_SIZE + 1` rows, so that a
 * further row says there are more without a second read.
 */
export function buildBrowse(request: BrowseRequest): BrowseBuild {
  return build(request, false, PAGE_SIZE + 1)
}

/**
 * The first page as text for the SQL editor: filter values written as escaped
 * literals (the editor sends no parameters), `LIMIT 100`, no cursor. The text
 * is opened in a new tab and never run on opening.
 */
export function editorSql(request: BrowseRequest): string | undefined {
  const built = build({ ...request, cursor: undefined }, true, PAGE_SIZE)
  return built.ok ? built.plan.sql : undefined
}

/** `SELECT * FROM "schema"."name" LIMIT 100` for "Query this table", or `undefined` for a name PostgreSQL cannot hold. */
export function queryTableSql(schema: string, name: string): string | undefined {
  if (!isQuotableIdentifier(schema) || !isQuotableIdentifier(name)) return undefined
  return `SELECT * FROM ${quotedRelation(schema, name)} LIMIT ${String(PAGE_SIZE)}`
}

export interface ResultColumn {
  readonly name: string
  readonly masked: boolean
}

export interface NextCursor {
  readonly cursor: BrowseCursor
  /** Keyset paging was planned, but the last row cannot start a page: the next page is an OFFSET. */
  readonly fellBack: boolean
}

/**
 * Where the page after `rows` starts. With keyset paging it is the key values
 * of the last row; a key column that is masked, missing or cut by the server
 * cannot be sent back as a value, so the next page falls back to OFFSET (the
 * caller says so). `loaded` is the number of rows shown so far.
 */
export function nextCursor(
  plan: BrowsePlan,
  columns: readonly ResultColumn[],
  rows: readonly (readonly unknown[])[],
  loaded: number,
): NextCursor {
  const offset: BrowseCursor = { kind: 'offset', offset: loaded }
  if (!plan.keyset) return { cursor: offset, fellBack: false }
  const last = rows[rows.length - 1]
  if (last === undefined) return { cursor: offset, fellBack: true }
  const values: KeyValue[] = []
  for (const column of plan.keysetColumns) {
    const index = columns.findIndex((candidate) => candidate.name === column)
    const value = index < 0 || columns[index]?.masked === true ? undefined : last[index]
    if (
      typeof value === 'string' ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value))
    ) {
      values.push(value)
    } else {
      return { cursor: offset, fellBack: true }
    }
  }
  return { cursor: { kind: 'keyset', values }, fellBack: false }
}
