import { describe, expect, it } from 'vitest'

import { describeColumns } from '../../src/grid/column-kind.ts'
import {
  buildExport,
  csvField,
  DEFAULT_EXPORT_LIMIT,
  guardFormula,
  rowToTsv,
  safeFileName,
  tsvField,
  uniqueKeys,
  utf8Length,
} from '../../src/grid/export.ts'
import type { CellValue, GridColumn } from '../../src/grid/types.ts'

const BIG = { rows: 1_000, bytes: 1_000_000 }

function csv(
  columns: readonly GridColumn[],
  rows: readonly (readonly CellValue[])[],
  extra: { limit?: { rows: number; bytes: number }; moreRows?: boolean } = {},
) {
  return buildExport({
    columns: describeColumns(columns),
    rows,
    format: 'csv',
    limit: extra.limit ?? BIG,
    moreRows: extra.moreRows ?? false,
  })
}

function json(
  columns: readonly GridColumn[],
  rows: readonly (readonly CellValue[])[],
  extra: { limit?: { rows: number; bytes: number }; moreRows?: boolean } = {},
) {
  return buildExport({
    columns: describeColumns(columns),
    rows,
    format: 'json',
    limit: extra.limit ?? BIG,
    moreRows: extra.moreRows ?? false,
  })
}

const TEXT: GridColumn[] = [{ name: 'v', type: 'text' }]

describe('csvField (RFC 4180)', () => {
  it('leaves plain text bare', () => {
    expect(csvField('hello world')).toBe('hello world')
  })

  it('quotes a comma, a double quote, a line feed and a carriage return', () => {
    expect(csvField('a,b')).toBe('"a,b"')
    expect(csvField('say "hi"')).toBe('"say ""hi"""')
    expect(csvField('line\nbreak')).toBe('"line\nbreak"')
    expect(csvField('line\r\nbreak')).toBe('"line\r\nbreak"')
    expect(csvField('a\rb')).toBe('"a\rb"')
  })

  it('writes NULL as an empty field and an empty string as ""', () => {
    expect(csvField(null)).toBe('')
    expect(csvField('')).toBe('""')
  })
})

describe('formula-injection guard', () => {
  it.each(['=1+1', '+1', '-1+1', '@SUM(A1)', '\tcmd', '\rcmd', '=cmd|" /C calc"!A0'])(
    'prefixes a single quote to %j',
    (text) => {
      expect(guardFormula(text)).toBe(`'${text}`)
    },
  )

  it.each(['plain', 'a=b', ' =1', "'=1", '1-2', 'x+y', 'mail@example.test', ''])(
    'leaves %j alone',
    (text) => {
      expect(guardFormula(text)).toBe(text)
    },
  )

  it('guards a CSV cell and still quotes it when needed', () => {
    const result = csv(TEXT, [['=HYPERLINK("http://x.test","click")'], ['+1,2'], ['-5'], ['@a']])
    expect(result.text).toBe(
      ['v', `"'=HYPERLINK(""http://x.test"",""click"")"`, `"'+1,2"`, `'-5`, `'@a`, ''].join('\r\n'),
    )
  })

  it('guards a header that starts like a formula', () => {
    const result = csv([{ name: '=evil()', type: 'text' }], [['x']])
    expect(result.text.split('\r\n')[0]).toBe("'=evil()")
  })

  it('keeps the sign of a plain number in a numeric column', () => {
    const result = csv(
      [
        { name: 'i', type: 'int8' },
        { name: 'n', type: 'numeric' },
        { name: 'f', type: 'float8' },
        { name: 't', type: 'text' },
      ],
      [[-5, '-12.50', '-Infinity', '-5']],
    )
    expect(result.text.split('\r\n')[1]).toBe("-5,-12.50,-Infinity,'-5")
  })

  it('guards a numeric column that holds something else than a plain number', () => {
    const result = csv([{ name: 'n', type: 'numeric' }], [['-1+1'], ['=2+2'], ['-$1.00']])
    expect(result.text).toBe(['n', "'-1+1", "'=2+2", "'-$1.00", ''].join('\r\n'))
  })

  it('applies to a copied row as well', () => {
    const metas = describeColumns([
      { name: 'a', type: 'text' },
      { name: 'b', type: 'int4' },
    ])
    expect(rowToTsv(['=1+1', -3], metas)).toBe("'=1+1\t-3")
  })
})

describe('buildExport: CSV', () => {
  const columns: GridColumn[] = [
    { name: 'id', type: 'int8' },
    { name: 'note', type: 'text' },
    { name: 'ok', type: 'bool' },
    { name: 'meta', type: 'jsonb' },
  ]

  it('writes a header, CRLF line ends and one record per row', () => {
    const result = csv(columns, [
      [1, 'a, b', true, '{"k":1}'],
      [2, null, false, null],
      [3, '', true, '{}'],
    ])
    expect(result.text).toBe(
      ['id,note,ok,meta', '1,"a, b",true,"{""k"":1}"', '2,,false,', '3,"",true,{}', ''].join(
        '\r\n',
      ),
    )
    expect(result.rowsExported).toBe(3)
    expect(result.rowsLoaded).toBe(3)
    expect(result.cappedBy).toBeNull()
    expect(result.incomplete).toBe(false)
    expect(result.message).toBe('Exported 3 rows.')
    expect(result.bytes).toBe(utf8Length(result.text))
  })

  it('exports no rows as a header alone', () => {
    const result = csv(columns, [])
    expect(result.text).toBe('id,note,ok,meta\r\n')
    expect(result.message).toBe('Exported 0 rows.')
  })

  it('exports a bytea cell as a hex literal', () => {
    const result = csv([{ name: 'b', type: 'bytea' }], [['deadbeef']])
    expect(result.text).toBe('b\r\n\\xdeadbeef\r\n')
  })

  it('exports a masked column and a missing value empty', () => {
    const result = csv(
      [
        { name: 'a', type: 'text', masked: true },
        { name: 'b', type: 'text' },
      ],
      [['secret']],
    )
    expect(result.text).toBe('a,b\r\n,\r\n')
    expect(result.maskedColumns).toBe(1)
    expect(result.message).toBe('Exported 1 row. Masked columns are exported empty.')
  })

  it('exports a value the server cut as its preview and says so', () => {
    const result = csv(TEXT, [
      [{ truncated: true, preview: 'abc', bytes: 123_456 }],
      [{ truncated: true, preview: 'd', bytes: 9, unit: 'characters' }],
      ['whole'],
    ])
    expect(result.text).toBe(
      ['v', 'abc…[truncated: 123456 bytes]', 'd…[truncated: 9 characters]', 'whole', ''].join(
        '\r\n',
      ),
    )
    expect(result.truncatedValues).toBe(2)
    expect(result.message).toBe(
      'Exported 3 rows. 2 values cut by the server are exported as previews.',
    )
  })
})

describe('buildExport: caps', () => {
  const rows = Array.from({ length: 10 }, (_, i): CellValue[] => [`row ${i}`])

  it('ends at the row cap and says the result has more', () => {
    const result = csv(TEXT, rows, { limit: { rows: 4, bytes: 1_000_000 } })
    expect(result.rowsExported).toBe(4)
    expect(result.rowsLoaded).toBe(10)
    expect(result.cappedBy).toBe('rows')
    expect(result.incomplete).toBe(true)
    expect(result.text).toBe('v\r\nrow 0\r\nrow 1\r\nrow 2\r\nrow 3\r\n')
    expect(result.message).toBe('Exported the first 4 rows; the result has more.')
  })

  it('writes the owner example with a thousands separator', () => {
    const many = Array.from({ length: 10_001 }, (): CellValue[] => ['x'])
    const result = csv(TEXT, many, { limit: DEFAULT_EXPORT_LIMIT })
    expect(result.rowsExported).toBe(10_000)
    expect(result.message).toBe('Exported the first 10,000 rows; the result has more.')
  })

  it('is not capped when the rows are exactly the cap', () => {
    const result = csv(TEXT, rows, { limit: { rows: 10, bytes: 1_000_000 } })
    expect(result.cappedBy).toBeNull()
    expect(result.message).toBe('Exported 10 rows.')
  })

  it('ends at the byte cap without cutting a row', () => {
    // Header "v\r\n" is 3 bytes; each record "row N\r\n" is 7 bytes.
    const result = csv(TEXT, rows, { limit: { rows: 100, bytes: 3 + 7 * 3 + 2 } })
    expect(result.rowsExported).toBe(3)
    expect(result.cappedBy).toBe('bytes')
    expect(result.text).toBe('v\r\nrow 0\r\nrow 1\r\nrow 2\r\n')
    expect(result.bytes).toBeLessThanOrEqual(3 + 7 * 3 + 2)
    expect(result.message).toBe(
      'Exported the first 3 rows; the export reached its size limit of 26 bytes and the result has more.',
    )
  })

  it('counts UTF-8 bytes, not characters', () => {
    const result = csv(TEXT, [['ééééé'], ['ééééé']], { limit: { rows: 10, bytes: 3 + 12 } })
    expect(result.rowsExported).toBe(1)
    expect(result.cappedBy).toBe('bytes')
  })

  it('says so when the first row alone is over the byte cap', () => {
    const result = csv(TEXT, rows, { limit: { rows: 100, bytes: 5 } })
    expect(result.rowsExported).toBe(0)
    expect(result.cappedBy).toBe('bytes')
    expect(result.message).toBe(
      'Exported no rows; the first row is larger than the export size limit of 5 bytes.',
    )
  })

  it('says the result has more when the server cut it or more pages exist', () => {
    const result = csv(TEXT, rows.slice(0, 2), { moreRows: true })
    expect(result.cappedBy).toBeNull()
    expect(result.incomplete).toBe(true)
    expect(result.message).toBe('Exported the 2 loaded rows; the result has more.')
  })

  it('speaks of one row in the singular', () => {
    expect(csv(TEXT, rows.slice(0, 1)).message).toBe('Exported 1 row.')
    expect(csv(TEXT, rows, { limit: { rows: 1, bytes: 1_000_000 } }).message).toBe(
      'Exported the first row; the result has more.',
    )
  })

  it('falls back to the default caps for a cap that is not a number', () => {
    const result = csv(TEXT, rows, { limit: { rows: Number.NaN, bytes: -1 } })
    expect(result.rowsExported).toBe(10)
  })
})

describe('buildExport: JSON', () => {
  const columns: GridColumn[] = [
    { name: 'id', type: 'int8' },
    { name: 'note', type: 'text' },
    { name: 'ok', type: 'bool' },
    { name: 'meta', type: 'jsonb' },
  ]

  it('writes an array of objects, one row per line, that parses back', () => {
    const result = json(columns, [
      [1, 'a "quoted" \n line', true, '{\n "k": [1, 2]\n}'],
      [2, null, false, null],
    ])
    expect(result.text).toBe(
      [
        '[',
        '  {"id":1,"note":"a \\"quoted\\" \\n line","ok":true,"meta":{"k":[1,2]}},',
        '  {"id":2,"note":null,"ok":false,"meta":null}',
        ']',
        '',
      ].join('\n'),
    )
    expect(JSON.parse(result.text)).toEqual([
      { id: 1, note: 'a "quoted" \n line', ok: true, meta: { k: [1, 2] } },
      { id: 2, note: null, ok: false, meta: null },
    ])
    expect(result.message).toBe('Exported 2 rows.')
  })

  it('writes no rows as an empty array', () => {
    const result = json(columns, [])
    expect(result.text).toBe('[]\n')
    expect(JSON.parse(result.text)).toEqual([])
  })

  it('embeds JSON text with every digit and keeps invalid JSON as a string', () => {
    const result = json(
      [{ name: 'j', type: 'jsonb' }],
      [['{"id": 12345678901234567890}'], ['{"a":']],
    )
    expect(result.text).toContain('{"j":{"id":12345678901234567890}}')
    expect(result.text).toContain('{"j":"{\\"a\\":"}')
  })

  it('keeps an empty string distinct from NULL', () => {
    const result = json(TEXT, [[''], [null]])
    expect(JSON.parse(result.text)).toEqual([{ v: '' }, { v: null }])
  })

  it('keeps big numbers given as strings as strings', () => {
    const result = json([{ name: 'n', type: 'int8' }], [['9007199254740993']])
    expect(JSON.parse(result.text)).toEqual([{ n: '9007199254740993' }])
  })

  it('does not lose a value when two columns have the same name', () => {
    const result = json(
      [
        { name: 'a', type: 'int4' },
        { name: 'a', type: 'int4' },
        { name: 'a', type: 'int4' },
      ],
      [[1, 2, 3]],
    )
    expect(JSON.parse(result.text)).toEqual([{ a: 1, a_2: 2, a_3: 3 }])
  })

  it('writes a column named __proto__ as an ordinary key', () => {
    const result = json(
      [
        { name: '__proto__', type: 'text' },
        { name: 'constructor', type: 'text' },
      ],
      [['x', 'y']],
    )
    expect(result.text).toContain('"__proto__":"x"')
    const parsed: unknown = JSON.parse(result.text)
    expect(Array.isArray(parsed)).toBe(true)
    expect(Object.keys((parsed as Record<string, unknown>[])[0] ?? {})).toEqual([
      '__proto__',
      'constructor',
    ])
    expect(({} as Record<string, unknown>)['x']).toBeUndefined()
  })

  it('writes a value the server cut as an object with its preview and size', () => {
    const result = json(TEXT, [[{ truncated: true, preview: 'abc', bytes: 99 }]])
    expect(JSON.parse(result.text)).toEqual([
      { v: { truncated: true, preview: 'abc', bytes: 99, unit: 'bytes' } },
    ])
    expect(result.truncatedValues).toBe(1)
  })

  it('applies the same caps', () => {
    const rows = Array.from({ length: 5 }, (_, i): CellValue[] => [i])
    const byRows = json([{ name: 'n', type: 'int4' }], rows, { limit: { rows: 2, bytes: 1_000 } })
    expect(JSON.parse(byRows.text)).toEqual([{ n: 0 }, { n: 1 }])
    expect(byRows.message).toBe('Exported the first 2 rows; the result has more.')

    const byBytes = json([{ name: 'n', type: 'int4' }], rows, { limit: { rows: 100, bytes: 40 } })
    expect(byBytes.cappedBy).toBe('bytes')
    expect(byBytes.bytes).toBeLessThanOrEqual(40)
    expect(() => JSON.parse(byBytes.text)).not.toThrow()
  })

  it('needs no formula guard', () => {
    const result = json(TEXT, [['=1+1']])
    expect(JSON.parse(result.text)).toEqual([{ v: '=1+1' }])
  })
})

describe('tab-separated row', () => {
  const metas = describeColumns([
    { name: 'a', type: 'text' },
    { name: 'b', type: 'text' },
    { name: 'c', type: 'text' },
    { name: 'd', type: 'int4' },
  ])

  it('joins fields with tabs and quotes the ones a spreadsheet would split', () => {
    expect(rowToTsv(['plain', 'has\ttab', 'has "quote"', 5], metas)).toBe(
      'plain\t"has\ttab"\t"has ""quote"""\t5',
    )
    expect(rowToTsv(['line\nbreak', 'x', 'y', 1], metas)).toBe('"line\nbreak"\tx\ty\t1')
  })

  it('writes NULL and an empty string as empty fields', () => {
    expect(rowToTsv([null, '', 'z', null], metas)).toBe('\t\tz\t')
  })

  it('has no line break at the end', () => {
    expect(rowToTsv(['a', 'b', 'c', 1], metas).endsWith('\n')).toBe(false)
    expect(tsvField('x')).toBe('x')
  })
})

describe('helpers', () => {
  it('measures UTF-8 the way an encoder does', () => {
    const encoder = new TextEncoder()
    for (const text of ['', 'abc', 'é', '€', '😀', 'a😀b', '\ud800', 'x\udc00y']) {
      expect(utf8Length(text)).toBe(encoder.encode(text).length)
    }
  })

  it('makes keys unique', () => {
    expect(uniqueKeys(['a', 'b', 'a', 'a', 'a_2'])).toEqual(['a', 'b', 'a_2', 'a_3', 'a_2_2'])
  })

  it('makes a safe file name', () => {
    expect(safeFileName('Orders 2026', 'csv')).toBe('Orders-2026.csv')
    expect(safeFileName('../../etc/passwd', 'csv')).toBe('etc-passwd.csv')
    expect(safeFileName('a‮b\u0000c', 'json')).toBe('a-b-c.json')
    expect(safeFileName('', 'csv')).toBe('result.csv')
    expect(safeFileName(undefined, 'json')).toBe('result.json')
    expect(safeFileName('...', 'csv')).toBe('result.csv')
    expect(safeFileName('x'.repeat(200), 'csv')).toBe(`${'x'.repeat(80)}.csv`)
  })
})
