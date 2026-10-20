import { describe, expect, it } from 'vitest'
import {
  type BrowseRequest,
  buildBrowse,
  editorSql,
  isKeysetType,
  isTextType,
  MAX_LOADED_ROWS,
  nextCursor,
  queryTableSql,
  sqlLiteral,
} from '../../src/features/schema/browse-sql.ts'
import {
  isQuotableIdentifier,
  quotedRelation,
  quoteIdent,
} from '../../src/features/schema/identifiers.ts'
import type { FilterOp } from '../../src/features/schema/search.ts'

const BIDI = String.fromCodePoint(0x202e)
const ZWSP = String.fromCodePoint(0x200b)

function request(over: Partial<BrowseRequest> = {}): BrowseRequest {
  return {
    schema: 'public',
    name: 'orders',
    columns: [
      { name: 'id', type: 'uuid' },
      { name: 'status', type: 'text' },
      { name: 'total', type: 'numeric(12,2)' },
      { name: 'created_at', type: 'timestamp with time zone' },
    ],
    primaryKey: ['id'],
    filters: [],
    ...over,
  }
}

function sql(over: Partial<BrowseRequest> = {}) {
  const built = buildBrowse(request(over))
  if (!built.ok) throw new Error(`not built: ${built.reason}`)
  return built.plan
}

describe('quoteIdent: always quoted, the quote doubled', () => {
  it.each([
    ['plain', 'orders', '"orders"'],
    ['a quote', 'a"b', '"a""b"'],
    ['two quotes in a row', '""', '""""""'],
    ['a statement', 'a"; DROP TABLE x; --', '"a""; DROP TABLE x; --"'],
    ['dollar quotes', '$$', '"$$"'],
    ['a space', 'a b', '"a b"'],
    ['a bidi override', `a${BIDI}b`, `"a${BIDI}b"`],
    ['a zero width space', `a${ZWSP}b`, `"a${ZWSP}b"`],
    ['an upper case letter', 'Orders', '"Orders"'],
    ['a backslash', 'a\\b', '"a\\b"'],
    ['a single quote', "a'b", `"a'b"`],
  ])('%s', (_label, name, expected) => {
    expect(quoteIdent(name)).toBe(expected)
  })

  it('quotes a relation as two identifiers, however many dots the names hold', () => {
    expect(quotedRelation('my.schema', 'a.b')).toBe('"my.schema"."a.b"')
  })

  it('knows what PostgreSQL cannot hold', () => {
    expect(isQuotableIdentifier('orders')).toBe(true)
    expect(isQuotableIdentifier('')).toBe(false)
    expect(isQuotableIdentifier('a\u0000b')).toBe(false)
  })
})

describe('the first page: order, limit and no cursor', () => {
  it('orders by the primary key and asks for one row more than a page', () => {
    const plan = sql()
    expect(plan.sql).toBe('SELECT *\nFROM "public"."orders"\nORDER BY "id" ASC\nLIMIT 101')
    expect(plan.params).toEqual([])
    expect(plan.order).toBe('primary_key')
    expect(plan.keyset).toBe(true)
    expect(plan.keysetColumns).toEqual(['id'])
  })

  it('has no ORDER BY, and says so, when there is no primary key and no sort', () => {
    const plan = sql({ primaryKey: [] })
    expect(plan.sql).toBe('SELECT *\nFROM "public"."orders"\nLIMIT 101')
    expect(plan.order).toBe('none')
    expect(plan.keyset).toBe(false)
  })

  it('refuses to build for an object with no column', () => {
    expect(buildBrowse(request({ columns: [] }))).toEqual({ ok: false, reason: 'no_columns' })
  })

  it('refuses to build from a name PostgreSQL cannot hold', () => {
    expect(buildBrowse(request({ name: 'a\u0000b' }))).toEqual({
      ok: false,
      reason: 'unquotable_name',
    })
    expect(buildBrowse(request({ schema: '' }))).toEqual({ ok: false, reason: 'unquotable_name' })
    expect(buildBrowse(request({ columns: [{ name: '', type: 'text' }], primaryKey: [] }))).toEqual(
      { ok: false, reason: 'unquotable_name' },
    )
  })
})

describe('hostile identifiers stay one identifier', () => {
  const HOSTILE = [
    'a"; DROP TABLE x; --',
    '"; SELECT pg_sleep(1); --',
    `bidi${BIDI}name`,
    `zero${ZWSP}wide`,
    '$$ $$',
    'x\ny',
    "x' OR '1'='1",
  ]

  it.each(HOSTILE)('quotes the table %j, its key column and its sort column', (name) => {
    const plan = sql({
      name,
      columns: [
        { name, type: 'integer' },
        { name: `${name}2`, type: 'text' },
      ],
      primaryKey: [name],
      sort: { column: `${name}2`, direction: 'desc' },
      filters: [{ column: `${name}2`, op: '=', value: 'x' }],
    })
    const quoted = quoteIdent(name)
    const quotedOther = quoteIdent(`${name}2`)
    expect(plan.sql).toBe(
      `SELECT *\nFROM "public".${quoted}\nWHERE ${quotedOther} = $1\nORDER BY ${quotedOther} DESC, ${quoted} ASC\nLIMIT 101`,
    )
    // The only parameter is the filter value; nothing of a name is a parameter or text outside quotes.
    expect(plan.params).toEqual(['x'])
  })

  it('keeps a quote-closing name from ending the identifier', () => {
    const plan = sql({
      name: 'a"; DROP TABLE x; --',
      columns: [{ name: 'id', type: 'integer' }],
    })
    expect(plan.sql).toContain('FROM "public"."a""; DROP TABLE x; --"')
    // Every double quote in the statement is paired: the count is even.
    expect((plan.sql.match(/"/g) ?? []).length % 2).toBe(0)
  })
})

describe('sorting', () => {
  it('sorts by a column with the key as a tie-break and pages by offset', () => {
    const plan = sql({ sort: { column: 'status', direction: 'asc' } })
    expect(plan.sql).toBe(
      'SELECT *\nFROM "public"."orders"\nORDER BY "status" ASC, "id" ASC\nLIMIT 101',
    )
    expect(plan.order).toBe('sort')
    expect(plan.keyset).toBe(false)
  })

  it('keeps keyset paging when the sort is the one key column, in either direction', () => {
    const asc = sql({ sort: { column: 'id', direction: 'asc' } })
    const desc = sql({ sort: { column: 'id', direction: 'desc' } })
    expect(asc.keyset).toBe(true)
    expect(desc.sql).toContain('ORDER BY "id" DESC')
    expect(desc.keyset).toBe(true)
  })

  it('sorts without a key when there is none', () => {
    const plan = sql({ primaryKey: [], sort: { column: 'total', direction: 'desc' } })
    expect(plan.sql).toBe('SELECT *\nFROM "public"."orders"\nORDER BY "total" DESC\nLIMIT 101')
  })

  it('ignores a sort that is not a column of the object, and says so', () => {
    const plan = sql({ sort: { column: 'nope"; DROP TABLE x', direction: 'asc' } })
    expect(plan.sortIgnored).toBe(true)
    expect(plan.sql).not.toContain('nope')
    expect(plan.order).toBe('primary_key')
  })
})

describe('filters: bind parameters and a fixed set of operators', () => {
  it.each([
    ['=', '"status" = $1'],
    ['<>', '"status" <> $1'],
    ['<', '"status" < $1'],
    ['<=', '"status" <= $1'],
    ['>', '"status" > $1'],
    ['>=', '"status" >= $1'],
    ['ILIKE', '"status" ILIKE $1'],
  ] as const)('%s takes its value as $1', (op, clause) => {
    const plan = sql({ filters: [{ column: 'status', op, value: "it's; DROP TABLE x" }] })
    expect(plan.sql).toContain(`WHERE ${clause}`)
    expect(plan.params).toEqual(["it's; DROP TABLE x"])
    expect(plan.sql).not.toContain('DROP')
    expect(plan.sql).not.toContain("it's")
  })

  it.each(['IS NULL', 'IS NOT NULL'] as const)('%s takes no parameter', (op) => {
    const plan = sql({ filters: [{ column: 'status', op, value: 'ignored text' }] })
    expect(plan.sql).toContain(`WHERE "status" ${op}`)
    expect(plan.params).toEqual([])
    expect(plan.sql).not.toContain('ignored text')
  })

  it('joins several filters with AND and numbers the parameters in order', () => {
    const plan = sql({
      filters: [
        { column: 'status', op: '=', value: 'paid' },
        { column: 'total', op: '>=', value: '10' },
        { column: 'created_at', op: 'IS NOT NULL', value: '' },
      ],
    })
    expect(plan.sql).toContain('WHERE "status" = $1 AND "total" >= $2 AND "created_at" IS NOT NULL')
    expect(plan.params).toEqual(['paid', '10'])
  })

  it('ignores a filter on a column that is not in the object, an operator that is not allowed and too many filters', () => {
    const plan = sql({
      filters: [
        { column: 'ghost', op: '=', value: '1' },
        // A hostile operator from a link is not a FilterOp, whatever its type says.
        { column: 'status', op: '= 1 OR 1=1; --' as unknown as FilterOp, value: 'x' },
        { column: 'status', op: '=', value: 'x'.repeat(2_000) },
        { column: 'status', op: '=', value: 'a\u0000b' },
        ...[1, 2, 3, 4, 5, 6].map((n) => ({ column: 'total', op: '>' as const, value: String(n) })),
      ],
    })
    expect(plan.ignoredFilters.map((entry) => entry.reason)).toEqual([
      'unknown_column',
      'bad_operator',
      'bad_value',
      'bad_value',
      'too_many',
    ])
    expect(plan.params).toEqual(['1', '2', '3', '4', '5'])
    expect(plan.sql).not.toContain('ghost')
    expect(plan.sql).not.toContain('1=1')
  })
})

describe('the next page', () => {
  it('continues after the last key value with one bind parameter', () => {
    const plan = sql({ cursor: { kind: 'keyset', values: ['u-100'] } })
    expect(plan.sql).toBe(
      'SELECT *\nFROM "public"."orders"\nWHERE ("id" > $1)\nORDER BY "id" ASC\nLIMIT 101',
    )
    expect(plan.params).toEqual(['u-100'])
  })

  it('numbers the key after the filters', () => {
    const plan = sql({
      filters: [{ column: 'status', op: '=', value: 'paid' }],
      cursor: { kind: 'keyset', values: ['u-100'] },
    })
    expect(plan.sql).toContain('WHERE "status" = $1 AND ("id" > $2)')
    expect(plan.params).toEqual(['paid', 'u-100'])
  })

  it('walks a composite key without a row comparison', () => {
    const plan = sql({
      columns: [
        { name: 'a', type: 'integer' },
        { name: 'b', type: 'text' },
        { name: 'c', type: 'bigint' },
      ],
      primaryKey: ['a', 'b', 'c'],
      cursor: { kind: 'keyset', values: [1, 'x', '9007199254740993'] },
    })
    expect(plan.sql).toContain(
      'WHERE (("a" > $1) OR ("a" = $1 AND "b" > $2) OR ("a" = $1 AND "b" = $2 AND "c" > $3))',
    )
    expect(plan.sql).toContain('ORDER BY "a" ASC, "b" ASC, "c" ASC')
    expect(plan.params).toEqual([1, 'x', '9007199254740993'])
    expect(plan.sql).not.toMatch(/\(\s*"a"\s*,/)
  })

  it('goes down with < when the order is descending', () => {
    const plan = sql({
      sort: { column: 'id', direction: 'desc' },
      cursor: { kind: 'keyset', values: ['u-100'] },
    })
    expect(plan.sql).toContain('WHERE ("id" < $1)')
  })

  it('continues with an offset written as digits', () => {
    const plan = sql({
      sort: { column: 'status', direction: 'asc' },
      cursor: { kind: 'offset', offset: 200 },
    })
    expect(plan.sql).toBe(
      'SELECT *\nFROM "public"."orders"\nORDER BY "status" ASC, "id" ASC\nLIMIT 101\nOFFSET 200',
    )
  })

  it('does not take a keyset cursor where the order cannot page by key, or one with the wrong values', () => {
    expect(
      buildBrowse(
        request({
          sort: { column: 'status', direction: 'asc' },
          cursor: { kind: 'keyset', values: ['x'] },
        }),
      ),
    ).toEqual({ ok: false, reason: 'bad_cursor' })
    expect(buildBrowse(request({ cursor: { kind: 'keyset', values: ['a', 'b'] } }))).toEqual({
      ok: false,
      reason: 'bad_cursor',
    })
    expect(
      buildBrowse(request({ cursor: { kind: 'keyset', values: [Number.POSITIVE_INFINITY] } })),
    ).toEqual({ ok: false, reason: 'bad_cursor' })
  })

  it('does not take an offset that is not a bounded integer', () => {
    for (const offset of [-1, 1.5, Number.NaN, MAX_LOADED_ROWS + 1, Number.POSITIVE_INFINITY]) {
      expect(buildBrowse(request({ cursor: { kind: 'offset', offset } }))).toEqual({
        ok: false,
        reason: 'bad_cursor',
      })
    }
  })

  it('pages by offset when a key column is of a type that does not compare the same on the wire', () => {
    const plan = sql({
      columns: [
        { name: 'at', type: 'timestamp with time zone' },
        { name: 'x', type: 'text' },
      ],
      primaryKey: ['at'],
    })
    expect(plan.order).toBe('primary_key')
    expect(plan.keyset).toBe(false)
  })

  it('pages by offset for a key of more than four columns', () => {
    const names = ['a', 'b', 'c', 'd', 'e']
    const plan = sql({
      columns: names.map((name) => ({ name, type: 'integer' })),
      primaryKey: names,
    })
    expect(plan.keyset).toBe(false)
  })
})

describe('the cursor after a page', () => {
  const columns = [
    { name: 'id', masked: false },
    { name: 'secret', masked: true },
  ]

  it('takes the key values of the last row, as they came', () => {
    const plan = sql()
    expect(
      nextCursor(
        plan,
        columns,
        [
          ['u-1', null],
          ['u-2', null],
        ],
        2,
      ),
    ).toEqual({ cursor: { kind: 'keyset', values: ['u-2'] }, fellBack: false })
  })

  it('falls back to an offset, and says so, when a key value cannot be sent back', () => {
    const plan = sql()
    // Cut by the server (an object on the wire), null, missing column, masked column.
    expect(
      nextCursor(plan, columns, [[{ value: 'x', truncatedAt: 1, length: 9 }, null]], 1),
    ).toEqual({ cursor: { kind: 'offset', offset: 1 }, fellBack: true })
    expect(nextCursor(plan, columns, [[null, null]], 1).fellBack).toBe(true)
    expect(nextCursor(plan, [{ name: 'other', masked: false }], [['x']], 1).fellBack).toBe(true)
    expect(nextCursor(plan, [{ name: 'id', masked: true }], [[null]], 1).fellBack).toBe(true)
    expect(nextCursor(plan, columns, [], 0).fellBack).toBe(true)
  })

  it('counts rows for an offset without calling it a fall back', () => {
    const plan = sql({ sort: { column: 'status', direction: 'asc' } })
    expect(nextCursor(plan, columns, [['u-1', null]], 100)).toEqual({
      cursor: { kind: 'offset', offset: 100 },
      fellBack: false,
    })
  })
})

describe('the text for the SQL editor', () => {
  it('writes the filter values as escaped literals, for the first page', () => {
    const text = editorSql(
      request({
        filters: [
          { column: 'status', op: '=', value: "it's" },
          { column: 'total', op: 'IS NULL', value: '' },
        ],
        cursor: { kind: 'offset', offset: 100 },
      }),
    )
    expect(text).toBe(
      `SELECT *\nFROM "public"."orders"\nWHERE "status" = 'it''s' AND "total" IS NULL\nORDER BY "id" ASC\nLIMIT 100`,
    )
  })

  it('keeps a hostile value one literal', () => {
    const text = editorSql(
      request({ filters: [{ column: 'status', op: '=', value: "x'; DROP TABLE orders; --" }] }),
    )
    expect(text).toContain(`"status" = 'x''; DROP TABLE orders; --'`)
    expect(sqlLiteral("'")).toBe("''''")
  })

  it('writes a backslash as an escape string, so the setting of the server does not matter', () => {
    expect(sqlLiteral('a\\b')).toBe("E'a\\\\b'")
    expect(sqlLiteral("a\\'b")).toBe("E'a\\\\''b'")
    expect(sqlLiteral('plain')).toBe("'plain'")
  })

  it('has no text for an object that cannot be queried', () => {
    expect(editorSql(request({ columns: [] }))).toBeUndefined()
  })
})

describe('"Query this table"', () => {
  it('is a quoted SELECT with a limit of 100', () => {
    expect(queryTableSql('public', 'orders')).toBe('SELECT * FROM "public"."orders" LIMIT 100')
    expect(queryTableSql('a"b', 'c"; DROP TABLE x; --')).toBe(
      'SELECT * FROM "a""b"."c""; DROP TABLE x; --" LIMIT 100',
    )
    expect(queryTableSql('', 'x')).toBeUndefined()
  })
})

describe('types', () => {
  it.each(['integer', 'bigint', 'uuid', 'text', 'character varying(255)', 'numeric(12,2)'])(
    '%s pages by key',
    (type) => expect(isKeysetType(type)).toBe(true),
  )
  it.each(['timestamp with time zone', 'double precision', 'bytea', 'jsonb', 'text[]', 'mood'])(
    '%s pages by offset',
    (type) => expect(isKeysetType(type)).toBe(false),
  )
  it('offers ILIKE for text types only', () => {
    expect(isTextType('text')).toBe(true)
    expect(isTextType('character varying(40)')).toBe(true)
    expect(isTextType('integer')).toBe(false)
    expect(isTextType('uuid')).toBe(false)
  })
})
