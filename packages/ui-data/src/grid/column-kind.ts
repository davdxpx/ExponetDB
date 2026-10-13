import type { GridColumn } from './types.ts'

/**
 * How a column's values are shown. The grid decides by the PostgreSQL type
 * name and accepts both spellings the server may use: the catalog name
 * (`int8`, `timestamptz`, `_text`) and the `format_type` name (`bigint`,
 * `timestamp with time zone`, `text[]`, `numeric(10,2)`).
 */
export type ColumnKind =
  | 'integer'
  | 'float'
  | 'numeric'
  | 'boolean'
  | 'json'
  | 'bytea'
  | 'temporal'
  | 'uuid'
  | 'array'
  | 'text'

const INTEGERS = new Set([
  'int2',
  'int4',
  'int8',
  'smallint',
  'integer',
  'int',
  'bigint',
  'oid',
  'xid',
  'xid8',
  'cid',
  'serial',
  'bigserial',
  'smallserial',
])
const FLOATS = new Set(['float4', 'float8', 'real', 'double precision', 'float'])
const NUMERICS = new Set(['numeric', 'decimal', 'money'])
const BOOLEANS = new Set(['bool', 'boolean'])
const JSONS = new Set(['json', 'jsonb'])
const TEMPORALS = new Set([
  'date',
  'time',
  'timetz',
  'timestamp',
  'timestamptz',
  'interval',
  'time with time zone',
  'time without time zone',
  'timestamp with time zone',
  'timestamp without time zone',
])

/** The kind of a PostgreSQL type name. An unknown or user-defined type is `text`. */
export function columnKind(type: string): ColumnKind {
  let name = type.trim().toLowerCase()
  // `text[]`, `integer[][]`, and the catalog's `_text` are arrays.
  if (name.endsWith(']') || (name.startsWith('_') && name.length > 1)) return 'array'
  // `numeric(10,2)`, `character varying(20)`, `timestamp(3) with time zone`: the modifier is not the type.
  name = name
    .replace(/\([^)]*\)/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  // `pg_catalog.int4`: the schema is not the type.
  if (name.startsWith('pg_catalog.')) name = name.slice('pg_catalog.'.length)
  if (INTEGERS.has(name)) return 'integer'
  if (FLOATS.has(name)) return 'float'
  if (NUMERICS.has(name)) return 'numeric'
  if (BOOLEANS.has(name)) return 'boolean'
  if (JSONS.has(name)) return 'json'
  if (name === 'bytea') return 'bytea'
  if (TEMPORALS.has(name)) return 'temporal'
  if (name === 'uuid') return 'uuid'
  return 'text'
}

/** Whether values of the kind are numbers: right-aligned, in tabular figures. */
export function isNumericKind(kind: ColumnKind): boolean {
  return kind === 'integer' || kind === 'float' || kind === 'numeric'
}

/** A column with what the grid derives from it once, so no cell derives it again. */
export interface ColumnMeta {
  readonly name: string
  readonly type: string
  readonly masked: boolean
  readonly kind: ColumnKind
}

export function describeColumns(columns: readonly GridColumn[]): ColumnMeta[] {
  return columns.map((column) => ({
    name: column.name,
    type: column.type,
    masked: column.masked === true,
    kind: columnKind(column.type),
  }))
}

/** Whether two column lists describe the same columns (name, type, masked), whatever their identity. */
export function sameColumns(a: readonly GridColumn[], b: readonly GridColumn[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  return a.every((column, index) => {
    const other = b[index]
    return (
      other !== undefined &&
      column.name === other.name &&
      column.type === other.type &&
      (column.masked === true) === (other.masked === true)
    )
  })
}
