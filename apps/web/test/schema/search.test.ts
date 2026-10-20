import { defaultParseSearch } from '@tanstack/react-router'
import { describe, expect, it } from 'vitest'
import { draftHref, sqlHref } from '../../src/features/schema/links.ts'
import {
  cleanSearch,
  FILTER_OPS,
  objectHref,
  objectKeyOf,
  pageOfKind,
  panelStateOf,
  schemaPageHref,
  schemaSearch,
  withPanelState,
} from '../../src/features/schema/search.ts'
import { parseSqlLink } from '../../src/features/sql/sql-model.ts'

const BIDI = String.fromCodePoint(0x202e)
const TARGET = { product: 'shop', project: 'platform', environment: 'staging' }

/** What the router hands `validateSearch` for a query string. */
function parse(query: string): Record<string, unknown> {
  return defaultParseSearch(query)
}

describe('schemaSearch: a link is input', () => {
  it('reads every key a link can carry', () => {
    const search = schemaSearch({
      q: 'ord',
      schema: 'public',
      object: ['table', 'public', 'orders'],
      tab: 'rows',
      sort: 'status',
      dir: 'desc',
      filter: [
        ['status', '=', 'paid'],
        ['deleted_at', 'IS NULL', ''],
      ],
    })
    expect(search).toEqual({
      q: 'ord',
      schema: 'public',
      object: ['table', 'public', 'orders'],
      tab: 'rows',
      sort: 'status',
      dir: 'desc',
      filter: [
        ['status', '=', 'paid'],
        ['deleted_at', 'IS NULL', ''],
      ],
    })
    expect(objectKeyOf(search)).toEqual({ kind: 'table', key: ['public', 'orders'] })
  })

  it('returns every key, undefined when absent, so a raw value never slips through', () => {
    expect(schemaSearch({ other: 'x' })).toEqual({
      q: undefined,
      schema: undefined,
      object: undefined,
      tab: undefined,
      sort: undefined,
      dir: undefined,
      filter: undefined,
    })
    expect(Object.keys(schemaSearch({})).sort()).toEqual(
      ['dir', 'filter', 'object', 'q', 'schema', 'sort', 'tab'].sort(),
    )
  })

  it('reads a number or a boolean the router parsed back as text', () => {
    expect(schemaSearch({ q: 2024 }).q).toBe('2024')
    expect(schemaSearch({ q: true }).q).toBe('true')
    expect(schemaSearch(parse('?q=2024')).q).toBe('2024')
  })

  it.each([
    ['a name filter with a control character', { q: 'a\u0000b' }, 'q'],
    ['a name filter with a bidi override', { q: `a${BIDI}b` }, 'q'],
    ['a name filter longer than 128', { q: 'x'.repeat(129) }, 'q'],
    ['an empty name filter', { q: '' }, 'q'],
    ['a name filter that is an object', { q: { a: 1 } }, 'q'],
    ['a schema with a NUL', { schema: 'a\u0000b' }, 'schema'],
    ['an empty schema', { schema: '' }, 'schema'],
  ] as const)('drops %s', (_label, raw, key) => {
    expect(schemaSearch(raw)[key]).toBeUndefined()
  })

  it.each([
    ['not an array', 'table.public.orders'],
    ['an object', { kind: 'table' }],
    ['one part', ['table']],
    ['an upper case kind', ['Table', 'public', 'orders']],
    ['a kind with a slash', ['table/x', 'public', 'orders']],
    ['a kind that starts with a digit', ['1table', 'public', 'orders']],
    ['a number in the key', ['table', 'public', 5]],
    ['an empty schema', ['table', '', 'orders']],
    ['an empty name', ['table', 'public', '']],
    ['a NUL in a part', ['table', 'public', 'or\u0000ders']],
    ['nine parts after the kind', ['table', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']],
    ['a part longer than 2048', ['table', 'public', 'x'.repeat(2_049)]],
    ['a null part', ['table', 'public', null]],
  ])('drops an object that is %s', (_label, object) => {
    expect(schemaSearch({ object }).object).toBeUndefined()
  })

  it('keeps an object whose name has hidden or quote characters: it is shown marked, not dropped', () => {
    const key = ['table', 'public', `a"b${BIDI}c`]
    expect(schemaSearch({ object: key }).object).toEqual(key)
  })

  it('keeps a function key whose argument list is empty', () => {
    expect(schemaSearch({ object: ['function', 'public', 'f', ''] }).object).toEqual([
      'function',
      'public',
      'f',
      '',
    ])
  })

  it.each([
    ['a tab that is not one', { tab: 'edit' }],
    ['a tab as a number', { tab: 1 }],
  ])('drops %s', (_label, extra) => {
    expect(schemaSearch({ object: ['table', 'public', 'orders'], ...extra }).tab).toBeUndefined()
  })

  it('drops what belongs to an object when there is no object', () => {
    const search = schemaSearch({
      tab: 'rows',
      sort: 'status',
      dir: 'desc',
      filter: [['status', '=', 'x']],
    })
    expect(search.tab).toBeUndefined()
    expect(search.sort).toBeUndefined()
    expect(search.dir).toBeUndefined()
    expect(search.filter).toBeUndefined()
  })

  it('drops a direction that is not one, and one without a sort', () => {
    const object = ['table', 'public', 'orders']
    expect(schemaSearch({ object, sort: 'a', dir: 'sideways' }).dir).toBeUndefined()
    expect(schemaSearch({ object, dir: 'desc' }).dir).toBeUndefined()
  })

  it('drops the whole filter list when any filter is not one of the allowed shapes', () => {
    const object = ['table', 'public', 'orders']
    const bad: unknown[] = [
      'status=paid',
      [],
      [['status', '=', 'x'], 'junk'],
      [['status', '= 1 OR 1=1; --', 'x']],
      [['status', 'LIKE', 'x']],
      [['status', '=']],
      [['status', '=', 5]],
      [['status', '=', 'x'.repeat(1_001)]],
      [['status', '=', 'a\u0000b']],
      [['', '=', 'x']],
      [[5, '=', 'x']],
      [['a', '=', 'x', 'extra']],
      Array.from({ length: 6 }, () => ['status', '=', 'x']),
    ]
    for (const filter of bad) {
      expect(schemaSearch({ object, filter }).filter, JSON.stringify(filter)).toBeUndefined()
    }
  })

  it('takes exactly the nine operators of the allowlist', () => {
    const object = ['table', 'public', 'orders']
    for (const op of FILTER_OPS) {
      expect(schemaSearch({ object, filter: [['c', op, 'v']] }).filter).toHaveLength(1)
    }
    expect(FILTER_OPS).toHaveLength(9)
  })

  it('normalizes the value of a null operator to the empty string', () => {
    expect(
      schemaSearch({
        object: ['table', 'public', 'orders'],
        filter: [['c', 'IS NOT NULL', 'typed text']],
      }).filter,
    ).toEqual([['c', 'IS NOT NULL', '']])
  })
})

describe('links', () => {
  it('round-trips an object, a tab, a sort and filters through the router', () => {
    const href = objectHref(
      TARGET,
      { kind: 'table', key: ['public', 'or"ders'] },
      {
        tab: 'rows',
        sort: 'status',
        dir: 'desc',
        filter: [
          ['status', '=', 'paid & "done"'],
          ['deleted_at', 'IS NULL', ''],
        ],
      },
    )
    if (href === undefined) throw new Error('no link')
    expect(href.startsWith('/t/shop/platform/staging/schema/tables?')).toBe(true)
    // Names travel in the search, never in the path.
    expect(href.split('?')[0]).not.toContain('orders')
    const back = schemaSearch(parse(href.slice(href.indexOf('?'))))
    expect(back.object).toEqual(['table', 'public', 'or"ders'])
    expect(back.tab).toBe('rows')
    expect(back.sort).toBe('status')
    expect(back.dir).toBe('desc')
    expect(back.filter).toEqual([
      ['status', '=', 'paid & "done"'],
      ['deleted_at', 'IS NULL', ''],
    ])
  })

  it('round-trips a name that looks like JSON', () => {
    const href = schemaPageHref(TARGET, 'tables', { q: '123', schema: 'true' })
    const back = schemaSearch(parse(href.slice(href.indexOf('?'))))
    expect(back.q).toBe('123')
    expect(back.schema).toBe('true')
  })

  it('is a path of the app: no space, no control character, no backslash', () => {
    const href = objectHref(TARGET, { kind: 'table', key: ['p ublic', `a${BIDI}\n\\b`] })
    expect(href).toBeDefined()
    expect(href).toMatch(/^\/[^\s\\]*$/)
    expect(href).not.toContain(BIDI)
  })

  it('has no link for a kind without a page', () => {
    expect(pageOfKind('table')).toBe('tables')
    expect(pageOfKind('procedure')).toBe('functions')
    expect(pageOfKind('mystery')).toBeUndefined()
    expect(objectHref(TARGET, { kind: 'mystery', key: ['a', 'b'] })).toBeUndefined()
  })

  it('leaves out what an object does not need and the defaults', () => {
    expect(cleanSearch({ tab: 'rows', sort: 'a', filter: [['a', '=', 'x']] })).toEqual({})
    expect(
      cleanSearch({
        object: ['table', 'public', 'orders'],
        tab: 'details',
        sort: 'a',
        dir: 'asc',
        filter: [],
      }),
    ).toEqual({ object: ['table', 'public', 'orders'], sort: 'a' })
  })

  it('keeps the panel state and the search apart', () => {
    const search = withPanelState(
      { q: 'ord', object: ['table', 'public', 'orders'] },
      { tab: 'rows', sort: 'a', dir: 'desc', filter: [['a', '=', 'x']] },
    )
    expect(panelStateOf(search)).toEqual({
      tab: 'rows',
      sort: 'a',
      dir: 'desc',
      filter: [['a', '=', 'x']],
    })
    expect(panelStateOf({})).toEqual({
      tab: 'details',
      sort: undefined,
      dir: undefined,
      filter: [],
    })
  })
})

describe('links to the SQL page', () => {
  it('carries the text in the sql parameter, as the SQL page reads it, and never more than it opens', () => {
    const text = 'SELECT *\nFROM "public"."orders"\nWHERE "a" = \'x&y\''
    const href = sqlHref(TARGET, text)
    if (href === undefined) throw new Error('no link')
    expect(href).toMatch(/^\/t\/shop\/platform\/staging\/sql\?sql=/)
    expect(href).toMatch(/^\/[^\s]*$/)
    const link = parseSqlLink(href.slice(href.indexOf('?')))
    expect(link.sql).toEqual({ kind: 'text', sql: text })
    expect(link.mode).toBeUndefined()
  })

  it('opens a draft in draft mode', () => {
    const href = sqlHref(TARGET, 'CREATE FUNCTION f() RETURNS int AS $$ SELECT 1 $$', 'draft')
    if (href === undefined) throw new Error('no link')
    expect(parseSqlLink(href.slice(href.indexOf('?'))).mode).toBe('draft')
    expect(draftHref(TARGET)).toBe('/t/shop/platform/staging/sql?mode=draft')
  })

  it('offers no link for a text the SQL page would not open', () => {
    expect(sqlHref(TARGET, '')).toBeUndefined()
    expect(sqlHref(TARGET, 'x'.repeat(16_385))).toBeUndefined()
    expect(sqlHref(TARGET, 'x'.repeat(16_384))).toBeDefined()
  })
})
