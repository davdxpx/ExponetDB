import { codePointCount, formatCount, takeCodePoints } from '@exponetdb/ui-patterns'

import { type ColumnMeta, isNumericKind } from './column-kind.ts'
import { compactJson } from './json-text.ts'
import type { CellValue, TruncatedCell } from './types.ts'

/** A cell shows at most this many code points of a value; the rest is one press away. */
export const CELL_PREVIEW_CODE_POINTS = 160

/** A `bytea` cell shows this many bytes (two hex digits each) before the size. */
export const BYTEA_PREVIEW_BYTES = 24

/** What the server cut from a value, with the size of the whole. */
export interface ServerCut {
  readonly size: number
  readonly unit: NonNullable<TruncatedCell['unit']>
}

export interface TextCellView {
  readonly kind: 'text'
  /** The part of the value the cell shows, one line, cut by code points. */
  readonly shown: string
  /** `shown` is less than the value. */
  readonly cut: boolean
  /** Code points in `shown`. */
  readonly length: number
  /** The whole value as text, as far as the grid holds it. */
  readonly full: string
  readonly align: 'start' | 'end'
  /** A quiet note after the value: "11 bytes", "cut, 12,000 characters". */
  readonly suffix: string | undefined
  /** The value has line breaks; the cell shows them as code points on one line. */
  readonly multiline: boolean
  /** The server kept only a part of the value. */
  readonly serverCut: ServerCut | undefined
}

/**
 * What a cell shows. NULL, an empty string, a masked column and a value the row
 * did not carry are four different things and never share a look.
 */
export type CellView =
  | { readonly kind: 'null' }
  | { readonly kind: 'masked' }
  | { readonly kind: 'missing' }
  | { readonly kind: 'empty' }
  | TextCellView

const HEX_TEXT = /^(?:\\x)?([0-9a-fA-F]*)$/

/** The hex digits of a `bytea` text (`\x…` or bare), or `null` when the text is not whole bytes of hex. */
export function byteaHex(text: string): string | null {
  const match = HEX_TEXT.exec(text)
  const hex = match?.[1]
  return hex !== undefined && hex.length % 2 === 0 ? hex : null
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many
}

function sizeText(size: number, unit: ServerCut['unit']): string {
  const noun =
    unit === 'bytes'
      ? plural(size, 'byte', 'bytes')
      : unit === 'characters'
        ? plural(size, 'character', 'characters')
        : plural(size, 'dimension', 'dimensions')
  return `${formatCount(size)} ${noun}`
}

/** A number as text, keeping the sign of zero. */
function numberText(value: number): string {
  return Object.is(value, -0) ? '-0' : String(value)
}

/**
 * The whole value of a cell as text, or `null` for NULL, a masked column and a
 * missing value. A value the server cut gives the part the grid holds. A
 * `bytea` value always reads `\x` followed by its hex digits.
 */
export function fullText(value: CellValue | undefined, meta: ColumnMeta): string | null {
  if (meta.masked || value === undefined || value === null) return null
  if (typeof value === 'object') return withBytea(value.preview, meta)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return numberText(value)
  return withBytea(value, meta)
}

function withBytea(text: string, meta: ColumnMeta): string {
  if (meta.kind !== 'bytea') return text
  const hex = byteaHex(text)
  return hex === null ? text : `\\x${hex}`
}

function textView(
  full: string,
  meta: ColumnMeta,
  align: TextCellView['align'],
  serverCut: ServerCut | undefined,
): TextCellView {
  let source = full
  let cut = false
  let suffix: string | undefined
  if (meta.kind === 'json') {
    const compact = compactJson(full, CELL_PREVIEW_CODE_POINTS * 2 + 2)
    source = compact.head
    cut = compact.cut
  } else if (meta.kind === 'bytea') {
    const hex = byteaHex(full)
    if (hex !== null) {
      const digits = BYTEA_PREVIEW_BYTES * 2
      source = `\\x${hex.slice(0, digits)}`
      cut = hex.length > digits
      suffix = serverCut === undefined ? sizeText(hex.length / 2, 'bytes') : undefined
    }
  }
  const head = takeCodePoints(source, CELL_PREVIEW_CODE_POINTS)
  if (serverCut !== undefined) {
    suffix = `cut, ${sizeText(serverCut.size, serverCut.unit)}`
  }
  return {
    kind: 'text',
    shown: head.head,
    cut: cut || head.truncated,
    length: codePointCount(head.head),
    full,
    align,
    suffix,
    multiline: full.includes('\n') || full.includes('\r'),
    serverCut,
  }
}

/** The view of one cell of a column. */
export function viewCell(value: CellValue | undefined, meta: ColumnMeta): CellView {
  if (meta.masked) return { kind: 'masked' }
  if (value === undefined) return { kind: 'missing' }
  if (value === null) return { kind: 'null' }
  const align = isNumericKind(meta.kind) || typeof value === 'number' ? 'end' : 'start'
  if (typeof value === 'object') {
    const full = fullText(value, meta) ?? ''
    return textView(full, meta, align, { size: value.bytes, unit: value.unit ?? 'bytes' })
  }
  const full = fullText(value, meta) ?? ''
  if (full === '') return { kind: 'empty' }
  return textView(full, meta, align, undefined)
}
