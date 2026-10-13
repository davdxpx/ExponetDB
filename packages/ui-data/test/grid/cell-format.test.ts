import { describe, expect, it } from 'vitest'

import {
  BYTEA_PREVIEW_BYTES,
  byteaHex,
  CELL_PREVIEW_CODE_POINTS,
  fullText,
  type TextCellView,
  viewCell,
} from '../../src/grid/cell-format.ts'
import { type ColumnMeta, describeColumns } from '../../src/grid/column-kind.ts'

function meta(type: string, masked = false): ColumnMeta {
  const [column] = describeColumns([{ name: 'c', type, masked }])
  if (column === undefined) throw new Error('no column')
  return column
}

function text(view: ReturnType<typeof viewCell>): TextCellView {
  if (view.kind !== 'text') throw new Error(`expected text, got ${view.kind}`)
  return view
}

describe('viewCell: what a cell is', () => {
  it('tells NULL, an empty string, a masked value and a missing value apart', () => {
    expect(viewCell(null, meta('text')).kind).toBe('null')
    expect(viewCell('', meta('text')).kind).toBe('empty')
    expect(viewCell(null, meta('text', true)).kind).toBe('masked')
    expect(viewCell('x', meta('text', true)).kind).toBe('masked')
    expect(viewCell(undefined, meta('text')).kind).toBe('missing')
    expect(text(viewCell('NULL', meta('text'))).shown).toBe('NULL')
  })

  it('shows booleans as true and false text', () => {
    expect(text(viewCell(true, meta('bool'))).shown).toBe('true')
    expect(text(viewCell(false, meta('bool'))).shown).toBe('false')
    expect(text(viewCell(false, meta('bool'))).align).toBe('start')
  })

  it('right-aligns numbers by column type and by value', () => {
    expect(text(viewCell(42, meta('int4'))).align).toBe('end')
    expect(text(viewCell('9007199254740993', meta('int8'))).align).toBe('end')
    expect(text(viewCell('12.50', meta('numeric'))).align).toBe('end')
    expect(text(viewCell(7, meta('text'))).align).toBe('end')
    expect(text(viewCell('abc', meta('text'))).align).toBe('start')
  })

  it('keeps every digit of a number and the sign of zero', () => {
    expect(text(viewCell(-0, meta('float8'))).shown).toBe('-0')
    expect(text(viewCell(0.1 + 0.2, meta('float8'))).shown).toBe('0.30000000000000004')
    expect(text(viewCell('123456789012345678901234567890.123456789', meta('numeric'))).shown).toBe(
      '123456789012345678901234567890.123456789',
    )
  })

  it('shows timestamps and arrays exactly as returned', () => {
    expect(text(viewCell('2026-10-13T08:00:00.123456Z', meta('timestamptz'))).shown).toBe(
      '2026-10-13T08:00:00.123456Z',
    )
    expect(text(viewCell('{"a b",NULL,3}', meta('_text'))).shown).toBe('{"a b",NULL,3}')
  })
})

describe('viewCell: json', () => {
  it('shows pretty-printed JSON on one line and keeps the whole value for the sheet', () => {
    const value = '{\n  "a": [1, 2],\n  "b": "x"\n}'
    const view = text(viewCell(value, meta('jsonb')))
    expect(view.shown).toBe('{"a":[1,2],"b":"x"}')
    expect(view.full).toBe(value)
    expect(view.multiline).toBe(true)
  })

  it('cuts a long JSON value and says so', () => {
    const value = JSON.stringify({ items: Array.from({ length: 500 }, (_, i) => i) })
    const view = text(viewCell(value, meta('json')))
    expect(view.cut).toBe(true)
    expect(view.length).toBeLessThanOrEqual(CELL_PREVIEW_CODE_POINTS)
    expect(view.full).toBe(value)
  })
})

describe('viewCell: bytea', () => {
  it('previews hex with the size', () => {
    const view = text(viewCell('\\x48656c6c6f', meta('bytea')))
    expect(view.shown).toBe('\\x48656c6c6f')
    expect(view.suffix).toBe('5 bytes')
    expect(view.cut).toBe(false)
  })

  it('accepts bare hex and writes the \\x prefix', () => {
    const view = text(viewCell('deadbeef', meta('bytea')))
    expect(view.shown).toBe('\\xdeadbeef')
    expect(view.full).toBe('\\xdeadbeef')
    expect(view.suffix).toBe('4 bytes')
  })

  it('cuts the preview after a fixed number of bytes', () => {
    const hex = 'ab'.repeat(100)
    const view = text(viewCell(`\\x${hex}`, meta('bytea')))
    expect(view.shown).toBe(`\\x${'ab'.repeat(BYTEA_PREVIEW_BYTES)}`)
    expect(view.cut).toBe(true)
    expect(view.suffix).toBe('100 bytes')
    expect(view.full).toBe(`\\x${hex}`)
  })

  it('does not call text hex', () => {
    expect(byteaHex('\\xzz')).toBeNull()
    expect(byteaHex('abc')).toBeNull()
    expect(byteaHex('\\xabc')).toBeNull()
    expect(byteaHex('')).toBe('')
    expect(text(viewCell('not hex', meta('bytea'))).shown).toBe('not hex')
    expect(text(viewCell('not hex', meta('bytea'))).suffix).toBeUndefined()
  })
})

describe('viewCell: long and cut values', () => {
  it('cuts long text at a code point and keeps the whole text', () => {
    const value = '😀'.repeat(CELL_PREVIEW_CODE_POINTS + 40)
    const view = text(viewCell(value, meta('text')))
    expect(view.cut).toBe(true)
    expect(view.length).toBe(CELL_PREVIEW_CODE_POINTS)
    expect(Array.from(view.shown)).toHaveLength(CELL_PREVIEW_CODE_POINTS)
    expect(view.full).toBe(value)
  })

  it('marks multi-line text', () => {
    expect(text(viewCell('a\nb', meta('text'))).multiline).toBe(true)
    expect(text(viewCell('a\rb', meta('text'))).multiline).toBe(true)
    expect(text(viewCell('ab', meta('text'))).multiline).toBe(false)
  })

  it('shows the preview of a value the server cut, with the size of the whole', () => {
    const view = text(viewCell({ truncated: true, preview: 'abc', bytes: 123_456 }, meta('text')))
    expect(view.shown).toBe('abc')
    expect(view.serverCut).toEqual({ size: 123_456, unit: 'bytes' })
    expect(view.suffix).toBe('cut, 123,456 bytes')
    expect(view.full).toBe('abc')
  })

  it('names the unit the server counted in', () => {
    const view = text(
      viewCell(
        { truncated: true, preview: 'abc', bytes: 10_001, unit: 'characters' },
        meta('text'),
      ),
    )
    expect(view.suffix).toBe('cut, 10,001 characters')
    const one = text(
      viewCell({ truncated: true, preview: 'a', bytes: 1, unit: 'characters' }, meta('text')),
    )
    expect(one.suffix).toBe('cut, 1 character')
  })

  it('previews the hex of a cut bytea without claiming its own size', () => {
    const view = text(
      viewCell({ truncated: true, preview: '\\xabcd', bytes: 9_000 }, meta('bytea')),
    )
    expect(view.shown).toBe('\\xabcd')
    expect(view.suffix).toBe('cut, 9,000 bytes')
  })
})

describe('fullText', () => {
  it('is null for NULL, masked and missing values', () => {
    expect(fullText(null, meta('text'))).toBeNull()
    expect(fullText('x', meta('text', true))).toBeNull()
    expect(fullText(undefined, meta('text'))).toBeNull()
  })

  it('is the whole value as text otherwise', () => {
    expect(fullText('', meta('text'))).toBe('')
    expect(fullText(true, meta('bool'))).toBe('true')
    expect(fullText(12, meta('int4'))).toBe('12')
    expect(fullText('a\tb\nc', meta('text'))).toBe('a\tb\nc')
    expect(fullText({ truncated: true, preview: 'p', bytes: 9 }, meta('text'))).toBe('p')
    expect(fullText('beef', meta('bytea'))).toBe('\\xbeef')
  })
})
