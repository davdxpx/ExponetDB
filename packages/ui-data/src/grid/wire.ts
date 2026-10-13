import { columnKind } from './column-kind.ts'
import type { CellValue } from './types.ts'

/**
 * Maps one value of a query result on the wire to a grid cell. The REST
 * contract's `QueryResult.rows` holds typed JSON values (`JsonValueSchema`),
 * and a data read gives the bounded forms of
 * `sql-execution-security.md` §2.2 for the types JSON cannot hold:
 *
 * | wire value | grid cell |
 * |---|---|
 * | `null` | `null` (SQL NULL; a masked column is also `null`, see `GridColumn.masked`) |
 * | boolean, finite number, string | the same value (`numeric` and `int8` beyond 2^53 are already strings) |
 * | `{ hex, bytes, truncatedAt? }` of a `bytea` column | `\x` + hex, or a cut cell with `bytes` the size of the whole |
 * | `{ value, truncatedAt, length }` (text over the cap) | a cut cell: `preview` the kept text, `bytes` the length in characters |
 * | `{ dimension, head }` of a vector | `[a,b,c]` when whole, else a cut cell in dimensions |
 * | a parsed JSON value of a `json` or `jsonb` column | its compact JSON text |
 *
 * One case cannot be told apart on the wire: a `json` or `jsonb` string value
 * arrives as a plain string, like the raw JSON text the server keeps when a
 * number in it would not survive a double. A string of such a column that is
 * itself valid JSON is taken as JSON text; any other string is a JSON string
 * and is quoted. A parsed object that has exactly the shape of a cut text is
 * taken as one (a `jsonb` value can mimic it; the grid then shows a preview,
 * never more than the value holds).
 */
export function cellFromWire(type: string, value: unknown): CellValue {
  if (value === null || value === undefined) return null
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value)
  const kind = columnKind(type)
  if (typeof value === 'string') {
    return kind === 'json' && !isJsonText(value) ? JSON.stringify(value) : value
  }
  if (typeof value === 'bigint') return value.toString()
  if (typeof value !== 'object') return String(value)

  if (!Array.isArray(value)) {
    const shape = value as Record<string, unknown>
    const hex = shape['hex']
    const bytes = shape['bytes']
    if (kind === 'bytea' && typeof hex === 'string' && typeof bytes === 'number') {
      const text = `\\x${hex}`
      return shape['truncatedAt'] === undefined
        ? text
        : { truncated: true, preview: text, bytes, unit: 'bytes' }
    }
    const cut = shape['value']
    const length = shape['length']
    if (
      typeof cut === 'string' &&
      typeof shape['truncatedAt'] === 'number' &&
      typeof length === 'number'
    ) {
      return { truncated: true, preview: cut, bytes: length, unit: 'characters' }
    }
    const dimension = shape['dimension']
    const head = shape['head']
    if (typeof dimension === 'number' && Array.isArray(head) && kind !== 'json') {
      const items = head.map((item) => String(item))
      return head.length >= dimension
        ? `[${items.join(',')}]`
        : { truncated: true, preview: `[${items.join(',')},`, bytes: dimension, unit: 'dimensions' }
    }
  }
  try {
    return JSON.stringify(value)
  } catch {
    return '[a value that cannot be shown]'
  }
}

function isJsonText(text: string): boolean {
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}
