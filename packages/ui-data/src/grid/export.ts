import { formatCount } from '@exponetdb/ui-patterns'

import { fullText } from './cell-format.ts'
import { type ColumnMeta, isNumericKind } from './column-kind.ts'
import { compactJson } from './json-text.ts'
import type { CellValue, ExportFormat, ExportLimit, ExportResult } from './types.ts'

/** The most an export holds unless the caller says otherwise. */
export const DEFAULT_EXPORT_LIMIT: ExportLimit = { rows: 10_000, bytes: 10 * 1024 * 1024 }

const CRLF = '\r\n'

/** The size of a text in UTF-8, without encoding it. */
export function utf8Length(text: string): number {
  let size = 0
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index)
    if (unit < 0x80) {
      size += 1
    } else if (unit < 0x800) {
      size += 2
    } else if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        size += 4
        index += 1
      } else {
        size += 3
      }
    } else {
      size += 3
    }
  }
  return size
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`
  const kib = bytes / 1024
  if (kib < 1024) return `${Number(kib.toFixed(1))} KiB`
  return `${Number((kib / 1024).toFixed(1))} MiB`
}

// ---------------------------------------------------------------------------
// Spreadsheet safety
// ---------------------------------------------------------------------------

/** A cell a spreadsheet would run as a formula starts with one of these. */
const FORMULA_START = /^[=+\-@\t\r]/

/** A plain number: its sign is data, not a formula. */
const PLAIN_NUMBER = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$|^-?Infinity$|^NaN$/

/**
 * Formula-injection guard of CSV exports and of the tab-separated row copy: a
 * text starting with `=`, `+`, `-`, `@`, a tab or a carriage return gets a
 * leading single quote, which spreadsheets show as text and do not evaluate.
 * The one exception is a plain number in a numeric column (`-5`, `1.5e3`),
 * whose sign is data. JSON exports need no guard.
 */
export function guardFormula(text: string): string {
  return FORMULA_START.test(text) ? `'${text}` : text
}

interface ExportCell {
  /** The text of the cell, or `null` for NULL, a masked column or a missing value. */
  readonly text: string | null
  /** The server had cut this value. */
  readonly cut: boolean
  /** The text is a plain number of a numeric column or a JavaScript number. */
  readonly number: boolean
}

function exportCell(value: CellValue | undefined, meta: ColumnMeta): ExportCell {
  const text = fullText(value, meta)
  if (text === null) return { text: null, cut: false, number: false }
  if (typeof value === 'object' && value !== null) {
    const unit = value.unit ?? 'bytes'
    return {
      text: `${text}…[truncated: ${value.bytes} ${unit}]`,
      cut: true,
      number: false,
    }
  }
  const number = typeof value === 'number' || (isNumericKind(meta.kind) && PLAIN_NUMBER.test(text))
  return { text, cut: false, number }
}

interface ExportRow {
  readonly text: string
  /** Cells of this row the server had cut. */
  readonly cut: number
}

// ---------------------------------------------------------------------------
// CSV (RFC 4180)
// ---------------------------------------------------------------------------

/**
 * One CSV field. NULL is an empty field and an empty string is `""`, the
 * convention of PostgreSQL's `COPY … CSV`. A field with a comma, a double quote
 * or a line break is quoted, and quotes inside it are doubled (RFC 4180).
 * `number` marks a plain number that keeps its sign (see `guardFormula`).
 */
export function csvField(text: string | null, number = false): string {
  if (text === null) return ''
  if (text === '') return '""'
  const guarded = number ? text : guardFormula(text)
  return /[",\r\n]/.test(guarded) ? `"${guarded.replaceAll('"', '""')}"` : guarded
}

function csvHeader(metas: readonly ColumnMeta[]): string {
  return `${metas.map((meta) => csvField(meta.name)).join(',')}${CRLF}`
}

function csvRow(row: readonly (CellValue | undefined)[], metas: readonly ColumnMeta[]): ExportRow {
  let cut = 0
  const fields = metas.map((meta, index) => {
    const cell = exportCell(row[index], meta)
    if (cell.cut) cut += 1
    return csvField(cell.text, cell.number)
  })
  return { text: `${fields.join(',')}${CRLF}`, cut }
}

// ---------------------------------------------------------------------------
// Markdown table (clipboard)
// ---------------------------------------------------------------------------

/**
 * One cell of a Markdown (GFM) table. A backslash and the pipe that would end
 * the cell are escaped, and a line break becomes `<br>`, the line break a table
 * cell can hold. NULL, a masked value and an empty string are all an empty cell
 * (a table has no way to tell them apart; CSV and JSON do). Nothing else is
 * changed: markup in the text stays markup in the text, for the document it is
 * pasted into to deal with.
 */
export function markdownCell(text: string | null): string {
  if (text === null) return ''
  return text
    .replaceAll('\\', '\\\\')
    .replaceAll('|', '\\|')
    .replace(/\r\n|\r|\n/g, '<br>')
}

function markdownHead(metas: readonly ColumnMeta[]): string {
  const names = metas.map((meta) => markdownCell(meta.name))
  const rules = metas.map((meta) => (isNumericKind(meta.kind) ? '---:' : '---'))
  return `| ${names.join(' | ')} |\n| ${rules.join(' | ')} |\n`
}

function markdownRow(
  row: readonly (CellValue | undefined)[],
  metas: readonly ColumnMeta[],
): ExportRow {
  let cut = 0
  const cells = metas.map((meta, index) => {
    const cell = exportCell(row[index], meta)
    if (cell.cut) cut += 1
    return markdownCell(cell.text)
  })
  return { text: `| ${cells.join(' | ')} |\n`, cut }
}

// ---------------------------------------------------------------------------
// Tab-separated row (clipboard)
// ---------------------------------------------------------------------------

/**
 * One field of a tab-separated row, as spreadsheets paste it: a field with a
 * tab, a line break or a double quote is quoted. NULL and an empty string are
 * both an empty field. The formula guard applies, as in CSV.
 */
export function tsvField(text: string | null, number = false): string {
  if (text === null || text === '') return ''
  const guarded = number ? text : guardFormula(text)
  return /[\t\r\n"]/.test(guarded) ? `"${guarded.replaceAll('"', '""')}"` : guarded
}

/** A row for the clipboard: tab-separated, no header, no line break at the end. */
export function rowToTsv(row: readonly (CellValue | undefined)[], metas: readonly ColumnMeta[]) {
  return metas
    .map((meta, index) => {
      const cell = exportCell(row[index], meta)
      return tsvField(cell.text, cell.number)
    })
    .join('\t')
}

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

/** Column names as object keys; a repeated name gets `_2`, `_3`, … so no value is lost. */
export function uniqueKeys(names: readonly string[]): string[] {
  const used = new Set<string>()
  return names.map((name) => {
    let key = name
    let suffix = 2
    while (used.has(key)) {
      key = `${name}_${suffix}`
      suffix += 1
    }
    used.add(key)
    return key
  })
}

function validJson(text: string): boolean {
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

function jsonValue(value: CellValue | undefined, meta: ColumnMeta): ExportCell & { json: string } {
  const text = fullText(value, meta)
  if (text === null || value === undefined || value === null) {
    return { text: null, cut: false, number: false, json: 'null' }
  }
  if (typeof value === 'object') {
    const json = `{"truncated":true,"preview":${JSON.stringify(value.preview)},"bytes":${JSON.stringify(value.bytes)},"unit":${JSON.stringify(value.unit ?? 'bytes')}}`
    return { text, cut: true, number: false, json }
  }
  if (typeof value === 'boolean') return { text, cut: false, number: false, json: text }
  if (typeof value === 'number') {
    const json = Number.isFinite(value) ? JSON.stringify(value) : JSON.stringify(text)
    return { text, cut: false, number: true, json }
  }
  // A json column holds JSON text: embed it as it is (digits untouched) when it is valid.
  if (meta.kind === 'json' && validJson(text)) {
    return {
      text,
      cut: false,
      number: false,
      json: compactJson(text, Number.POSITIVE_INFINITY).head,
    }
  }
  return { text, cut: false, number: false, json: JSON.stringify(text) }
}

function jsonRow(
  row: readonly (CellValue | undefined)[],
  metas: readonly ColumnMeta[],
  keys: readonly string[],
): ExportRow {
  let cut = 0
  const members = metas.map((meta, index) => {
    const cell = jsonValue(row[index], meta)
    if (cell.cut) cut += 1
    // The key goes through JSON.stringify and the object is never built: a column named
    // `__proto__` or `constructor` is an ordinary key in the text.
    return `${JSON.stringify(keys[index] ?? meta.name)}:${cell.json}`
  })
  return { text: `{${members.join(',')}}`, cut }
}

// ---------------------------------------------------------------------------
// The export
// ---------------------------------------------------------------------------

export interface BuildExportInput {
  readonly columns: readonly ColumnMeta[]
  readonly rows: readonly (readonly (CellValue | undefined)[])[]
  readonly format: ExportFormat
  readonly limit: ExportLimit
  /** The result has rows the grid does not hold: the server cut it, or more pages exist. */
  readonly moreRows: boolean
  /**
   * What the text is for. `export` (the default) is a file, `copy` the clipboard;
   * only the words of the message differ ("Copied 3 rows as Markdown.").
   */
  readonly purpose?: 'export' | 'copy'
}

const FORMAT_NAMES: Readonly<Record<ExportFormat, string>> = {
  csv: 'CSV',
  json: 'JSON',
  markdown: 'Markdown',
}

function wholeCount(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback
}

function describeExport(facts: {
  rowsExported: number
  cappedBy: ExportResult['cappedBy']
  moreRows: boolean
  limitBytes: number
  truncatedValues: number
  maskedColumns: number
  purpose: 'export' | 'copy'
  format: ExportFormat
}): string {
  const { rowsExported, cappedBy, moreRows, limitBytes, truncatedValues, maskedColumns } = facts
  const copy = facts.purpose === 'copy'
  const done = copy ? 'Copied' : 'Exported'
  const past = copy ? 'copied' : 'exported'
  const thing = copy ? 'copy' : 'export'
  const as = copy ? ` as ${FORMAT_NAMES[facts.format]}` : ''
  const count = formatCount(rowsExported)
  const noun = rowsExported === 1 ? 'row' : 'rows'
  const first = rowsExported === 1 ? 'row' : `${count} rows`
  const parts: string[] = []
  if (cappedBy === 'rows') {
    parts.push(`${done} the first ${first}${as}; the result has more.`)
  } else if (cappedBy === 'bytes') {
    parts.push(
      rowsExported === 0
        ? `${done} no rows; the first row is larger than the ${thing} size limit of ${formatSize(limitBytes)}.`
        : `${done} the first ${first}${as}; the ${thing} reached its size limit of ${formatSize(limitBytes)} and the result has more.`,
    )
  } else if (moreRows) {
    parts.push(`${done} the ${count} loaded ${noun}${as}; the result has more.`)
  } else {
    parts.push(`${done} ${count} ${noun}${as}.`)
  }
  if (truncatedValues > 0) {
    parts.push(
      `${formatCount(truncatedValues)} ${truncatedValues === 1 ? 'value' : 'values'} cut by the server ${truncatedValues === 1 ? 'is' : 'are'} ${past} as ${truncatedValues === 1 ? 'a preview' : 'previews'}.`,
    )
  }
  if (maskedColumns > 0) parts.push(`Masked columns are ${past} empty.`)
  return parts.join(' ')
}

/**
 * The text of an export of the loaded rows, with what it left out. The export
 * ends at the first cap reached (`limit.rows` rows or `limit.bytes` bytes of
 * UTF-8, header included) and never ends inside a row; `cappedBy` and the
 * message say which cap it was.
 *
 * - CSV: RFC 4180, CRLF line ends, a header row; NULL is an empty field and an
 *   empty string is `""`; the formula guard prefixes a single quote to cells
 *   that start with `=`, `+`, `-`, `@`, a tab or a carriage return (plain
 *   numbers of numeric columns excepted).
 * - JSON: an array with one object per row, one row per line. A repeated column
 *   name gets a numeric suffix; `json` and `jsonb` cells are embedded as JSON
 *   when valid; a value the server cut is an object with its preview and size.
 * - Markdown: a GFM table, LF line ends, numeric columns right-aligned; see
 *   `markdownCell` for what is escaped. There is no formula guard: a table is
 *   not a spreadsheet format.
 * - A value the server cut is exported as its preview, and `truncatedValues`
 *   counts them; masked columns are exported empty.
 */
export function buildExport(input: BuildExportInput): ExportResult {
  const { columns, rows, format, moreRows } = input
  const maxRows = wholeCount(input.limit.rows, DEFAULT_EXPORT_LIMIT.rows)
  const maxBytes = wholeCount(input.limit.bytes, DEFAULT_EXPORT_LIMIT.bytes)
  const keys = uniqueKeys(columns.map((meta) => meta.name))

  const parts: string[] = []
  let bytes = 0
  const head =
    format === 'csv' ? csvHeader(columns) : format === 'markdown' ? markdownHead(columns) : '[\n'
  // JSON closes with a fixed tail; reserve it so a full export still fits.
  const tail = format === 'json' ? '\n]\n' : ''
  const empty = format === 'json' ? '[]\n' : head
  bytes += utf8Length(head) + utf8Length(tail)

  let rowsExported = 0
  let cappedBy: ExportResult['cappedBy'] = null
  let truncatedValues = 0
  for (const row of rows) {
    if (rowsExported >= maxRows) {
      cappedBy = 'rows'
      break
    }
    const made =
      format === 'csv'
        ? csvRow(row, columns)
        : format === 'markdown'
          ? markdownRow(row, columns)
          : jsonRow(row, columns, keys)
    const text = format === 'json' ? `${rowsExported === 0 ? '' : ',\n'}  ${made.text}` : made.text
    const size = utf8Length(text)
    if (bytes + size > maxBytes) {
      cappedBy = 'bytes'
      break
    }
    parts.push(text)
    bytes += size
    rowsExported += 1
    truncatedValues += made.cut
  }

  const body = parts.join('')
  const text = rowsExported === 0 && format === 'json' ? empty : `${head}${body}${tail}`
  const maskedColumns = columns.filter((meta) => meta.masked).length
  const incomplete = cappedBy !== null || moreRows
  return {
    format,
    text,
    bytes: utf8Length(text),
    rowsExported,
    rowsLoaded: rows.length,
    cappedBy,
    incomplete,
    truncatedValues,
    maskedColumns,
    message: describeExport({
      rowsExported,
      cappedBy,
      moreRows,
      limitBytes: maxBytes,
      truncatedValues,
      maskedColumns,
      purpose: input.purpose ?? 'export',
      format,
    }),
  }
}

/**
 * A file name for a download: letters, digits, dot, dash and underscore only
 * (no path, no direction or control characters), at most 80 characters, plus
 * the extension.
 */
export function safeFileName(base: string | undefined, extension: string): string {
  const cleaned = (base ?? '')
    .normalize('NFKC')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+/, '')
    .replace(/[-.]+$/, '')
    .slice(0, 80)
  return `${cleaned === '' ? 'result' : cleaned}.${extension}`
}
