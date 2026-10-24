import { describe, expect, it } from 'vitest'
import {
  type RelationRef,
  relationReferences,
  resolveQualifier,
} from '../../src/features/sql/relation-scan.ts'

function ref(name: string, alias?: string, schema?: string): RelationRef {
  return { schema, name, alias }
}

describe('relationReferences', () => {
  it('reads a relation with an alias, with and without AS', () => {
    expect(relationReferences('SELECT u. FROM users u')).toEqual([ref('users', 'u')])
    expect(relationReferences('SELECT * FROM public.users AS u')).toEqual([
      ref('users', 'u', 'public'),
    ])
  })

  it('reads a relation without an alias, also before a keyword', () => {
    expect(relationReferences('SELECT * FROM users')).toEqual([ref('users')])
    expect(relationReferences('SELECT * FROM users WHERE id = 1')).toEqual([ref('users')])
    expect(relationReferences('SELECT * FROM users ORDER BY id LIMIT 1')).toEqual([ref('users')])
  })

  it('reads joins of every kind and their aliases', () => {
    const sql = `SELECT *
      FROM public.orders o
      LEFT JOIN customers AS c ON c.id = o.customer_id
      INNER JOIN items ON items.order_id = o.id
      CROSS JOIN LATERAL other x
      NATURAL JOIN tags`
    expect(relationReferences(sql)).toEqual([
      ref('orders', 'o', 'public'),
      ref('customers', 'c'),
      ref('items'),
      ref('other', 'x'),
      ref('tags'),
    ])
  })

  it('reads a comma list in FROM', () => {
    expect(relationReferences('SELECT * FROM a x, b y, c')).toEqual([
      ref('a', 'x'),
      ref('b', 'y'),
      ref('c'),
    ])
  })

  it('folds unquoted names to lower case and keeps quoted names as they are', () => {
    expect(relationReferences('SELECT * FROM Public.Users U')).toEqual([
      ref('users', 'u', 'public'),
    ])
    expect(relationReferences('SELECT * FROM "My Schema"."Users" "U"')).toEqual([
      ref('Users', 'U', 'My Schema'),
    ])
    expect(relationReferences('SELECT * FROM "a""b" x')).toEqual([ref('a"b', 'x')])
  })

  it('reads the relations of UPDATE, INSERT INTO and DELETE ... USING', () => {
    expect(relationReferences('UPDATE public.users u SET x = 1 WHERE u.id = 1')).toEqual([
      ref('users', 'u', 'public'),
    ])
    expect(relationReferences('INSERT INTO t AS a (x) VALUES (1)')).toEqual([ref('t', 'a')])
    expect(relationReferences('INSERT INTO t (x) VALUES (1)')).toEqual([ref('t')])
    expect(relationReferences('DELETE FROM t USING u v WHERE t.id = v.id')).toEqual([
      ref('t'),
      ref('u', 'v'),
    ])
  })

  it('does not take a keyword for a relation', () => {
    expect(
      relationReferences('INSERT INTO t VALUES (1) ON CONFLICT (id) DO UPDATE SET x = 2'),
    ).toEqual([ref('t')])
    expect(relationReferences('INSERT INTO t SELECT * FROM s')).toEqual([ref('t'), ref('s')])
  })

  it('skips comments, string literals, dollar-quoted text and quoted identifiers that hold keywords', () => {
    const sql = `-- FROM hidden h
      SELECT 'from fake f', $$ join ghost g $$, "from" FROM /* join also_ghost a */ real r`
    expect(relationReferences(sql)).toEqual([ref('real', 'r')])
    expect(relationReferences("SELECT 'it''s from x' FROM y")).toEqual([ref('y')])
    expect(relationReferences('SELECT $tag$ from x $tag$ FROM y')).toEqual([ref('y')])
  })

  it('does not take a subquery or a function call for a relation, and goes on after them', () => {
    expect(relationReferences('SELECT * FROM (SELECT 1) s, orders o')).toEqual([ref('orders', 'o')])
    expect(relationReferences('SELECT * FROM generate_series(1, 3) g, t')).toEqual([ref('t')])
    expect(
      relationReferences('SELECT * FROM (SELECT * FROM inner_t i) s JOIN outer_t o ON true'),
    ).toEqual([ref('inner_t', 'i'), ref('outer_t', 'o')])
  })

  it('does not take a common table expression for a relation', () => {
    const sql =
      'WITH x AS (SELECT 1), y (a) AS MATERIALIZED (SELECT 2) SELECT * FROM x, y, orders o'
    expect(relationReferences(sql)).toEqual([ref('orders', 'o')])
    // A schema-qualified name is never a CTE.
    expect(relationReferences('WITH x AS (SELECT 1) SELECT * FROM public.x')).toEqual([
      ref('x', undefined, 'public'),
    ])
  })

  it('survives text that is cut off anywhere', () => {
    for (const sql of [
      'SELECT * FROM',
      'SELECT * FROM ',
      'SELECT * FROM public.',
      'SELECT * FROM users AS',
      "SELECT 'unterminated",
      'SELECT "unterminated',
      'SELECT /* unterminated',
      'SELECT $tag$ unterminated',
      'SELECT * FROM (',
      'SELECT * FROM (((',
      'WITH x AS (',
      'WITH',
      '',
    ]) {
      expect(() => relationReferences(sql)).not.toThrow()
    }
    expect(relationReferences('SELECT * FROM users AS')).toEqual([ref('users')])
  })

  it('handles extract(... FROM ...) without losing the real relation', () => {
    const refs = relationReferences('SELECT extract(year FROM created_at) FROM t')
    expect(refs).toContainEqual(ref('t'))
  })

  it('is fast on a long text', () => {
    const sql = `SELECT ${'a, '.repeat(2_000)} z FROM ${'t u, '.repeat(500)} last_t l`
    const started = performance.now()
    expect(relationReferences(sql).at(-1)).toEqual(ref('last_t', 'l'))
    expect(performance.now() - started).toBeLessThan(500)
  })
})

describe('resolveQualifier', () => {
  const refs = [ref('users', 'u', 'public'), ref('orders'), ref('items', 'i')]

  it('resolves an alias, in any case', () => {
    expect(resolveQualifier(refs, ['u'])).toEqual({ schema: 'public', name: 'users' })
    expect(resolveQualifier(refs, ['U'])).toEqual({ schema: 'public', name: 'users' })
  })

  it('resolves the name of a relation that has no alias', () => {
    expect(resolveQualifier(refs, ['orders'])).toEqual({ schema: undefined, name: 'orders' })
  })

  it('does not resolve the name of a relation that has an alias (PostgreSQL does not either)', () => {
    expect(resolveQualifier(refs, ['users'])).toBeUndefined()
    expect(resolveQualifier(refs, ['items'])).toBeUndefined()
  })

  it('resolves schema and relation as they are written', () => {
    expect(resolveQualifier([], ['Public', 'Users'])).toEqual({ schema: 'public', name: 'users' })
  })

  it('resolves nothing for an unknown name, an empty part or a longer qualifier', () => {
    expect(resolveQualifier(refs, ['nope'])).toBeUndefined()
    expect(resolveQualifier(refs, [''])).toBeUndefined()
    expect(resolveQualifier(refs, ['a', ''])).toBeUndefined()
    expect(resolveQualifier(refs, ['a', 'b', 'c'])).toBeUndefined()
    expect(resolveQualifier(refs, [])).toBeUndefined()
  })

  it('takes the first of two references with the same alias', () => {
    expect(resolveQualifier([ref('a', 'x'), ref('b', 'x')], ['x'])).toEqual({
      schema: undefined,
      name: 'a',
    })
  })
})
