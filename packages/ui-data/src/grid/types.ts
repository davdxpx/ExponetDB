import type { NowInput, Readable } from '@exponetdb/ui-patterns'

/**
 * Types and props of the data grid. This module imports no heavy library, so
 * the app can type its calls without loading the grid.
 *
 * Everything here is presentational: nothing is imported from the contracts or
 * the SDK. The mapping from a query result (`QueryResult` of the REST contract)
 * is documented on `cellFromWire` in `wire.ts`.
 */

/** One column of a result. `type` is a PostgreSQL type name: `int8` and `bigint` both work. */
export interface GridColumn {
  /** The column name as the database reports it. Untrusted: shown as text. */
  readonly name: string
  /** The PostgreSQL type name (`pg_type.typname` such as `_text`, or `format_type` such as `text[]`). */
  readonly type: string
  /**
   * The server masked this column (`masked` of the contract's column). Its
   * values are `null` on the wire, and the grid says "masked" instead of
   * "NULL": a masked value is not a NULL one.
   */
  readonly masked?: boolean
}

/** A value the server cut off: what it kept and the size of the whole. */
export interface TruncatedCell {
  readonly truncated: true
  /** The part of the value the server kept. */
  readonly preview: string
  /** The size of the whole value, in `unit`. */
  readonly bytes: number
  /**
   * What `bytes` counts. Default `bytes`; a text cut by characters says `characters`, a vector
   * cut to its first values says `dimensions`.
   */
  readonly unit?: 'bytes' | 'characters' | 'dimensions'
}

/**
 * One cell of a row. The server has already bounded every value. A `jsonb`
 * value is its JSON text, a `bytea` value its hex text (`\x…` or bare), an
 * array its PostgreSQL literal; `null` is SQL NULL.
 */
export type CellValue = string | number | boolean | null | TruncatedCell

export type SortDirection = 'asc' | 'desc'

/**
 * Sorting is the server's job: the grid never reorders rows. Passing `sort`
 * makes the column headers sortable; pressing one asks the caller to read the
 * result again in the new order (ascending, descending, unsorted).
 */
export interface GridSort {
  /** Index of the sorted column in `columns`, or `null` when the result is unsorted. */
  readonly column: number | null
  readonly direction: SortDirection
  readonly onSortChange: (next: { column: number; direction: SortDirection } | null) => void
}

/**
 * Keyset-friendly paging: the grid only asks for more; the caller knows the
 * last key and appends the next rows. Rows are never loaded by scrolling: a
 * read of a target is an audited action, so the person presses the button.
 */
export interface GridPage {
  readonly hasMore: boolean
  readonly onLoadMore: () => void
  /** The next page is being read. */
  readonly loading: boolean
}

/** The server cut the result at its row or byte cap. */
export interface GridTruncation {
  /** What was exceeded, in words: "the 5,000 row limit". Untrusted text. */
  readonly reason: string
}

/** The most an export may hold; whichever is reached first ends it. */
export interface ExportLimit {
  readonly rows: number
  readonly bytes: number
}

export type ExportFormat = 'csv' | 'json'

/** What an export produced and what it left out. */
export interface ExportResult {
  readonly format: ExportFormat
  /** The file content. */
  readonly text: string
  /** UTF-8 size of `text`. */
  readonly bytes: number
  readonly rowsExported: number
  /** Rows the grid holds (loaded). */
  readonly rowsLoaded: number
  /** Which cap ended the export, or `null` when every loaded row was exported. */
  readonly cappedBy: 'rows' | 'bytes' | null
  /** The result has rows this export does not hold (cap, server cut or more pages). */
  readonly incomplete: boolean
  /** Cells the server had cut; they are exported as previews. */
  readonly truncatedValues: number
  /** Masked columns, exported empty. */
  readonly maskedColumns: number
  /** What to tell the person: "Exported the first 10,000 rows; the result has more." */
  readonly message: string
}

export interface DataGridProps {
  /** The accessible name of the grid: "Result of the last query". */
  label: string
  columns: readonly GridColumn[]
  /** The rows as a truthful read: a failed read never renders as "No rows". */
  rows: Readable<readonly (readonly CellValue[])[]>
  /** The server cut the result at its cap. */
  truncated?: GridTruncation
  page?: GridPage
  /** Makes the column headers sortable (the server orders). */
  sort?: GridSort
  /** Export caps. Default `DEFAULT_EXPORT_LIMIT` (10,000 rows, 10 MiB). */
  exportLimit?: ExportLimit
  /** Base name of exported files, without extension. Default `result`. */
  fileName?: string
  /** What is read, as a noun phrase for the state messages. Default `result rows`. */
  what?: string
  /** Called with every export, after the download started. */
  onExport?: (result: ExportResult) => void
  /** Reads again after a failed read. */
  onRetry?: () => void
  /** Reads again when the rows are stale. */
  onRefresh?: () => void
  /** A read is running. */
  busy?: boolean
  now?: NowInput
  /** Tallest the scrolling region gets, in pixels. Default 560. */
  maxHeight?: number
  /** Height of a row, in pixels. Default 32. */
  rowHeight?: number
  className?: string
}
