import { beforeAll, describe, expect, it } from 'vitest'
import { loadParser, sensitiveReference } from '../src/parser/index.ts'
import { SUPPORTED_MAJORS } from '../src/versions.ts'

/**
 * Masking guards the output; `sensitiveReference` guards the rest of the
 * statement (Wave 7 review): a masked column may only be a bare output
 * column of a plain top-level SELECT.
 */
beforeAll(async () => {
  for (const major of SUPPORTED_MAJORS) await loadParser(major)
})

const MASKED = new Set(['password', 'email'])

const ALLOWED: readonly string[] = [
  'SELECT id, password, email FROM public.accounts WHERE id = 1',
  'SELECT * FROM public.accounts ORDER BY id',
  'SELECT a.* FROM public.accounts a',
  'SELECT a.password FROM public.accounts a WHERE a.id > 3',
  'SELECT count(*) FROM public.accounts WHERE id > 1',
  'SELECT upper(note) FROM public.accounts',
  'SHOW search_path',
]

const REFUSED: readonly (readonly [string, string])[] = [
  ["SELECT id FROM public.accounts WHERE password LIKE 'h%'", 'password'],
  ['SELECT id FROM public.accounts ORDER BY password', 'password'],
  ['SELECT id, password AS p FROM public.accounts ORDER BY p', 'p'],
  ['SELECT id, password AS p FROM public.accounts GROUP BY id, p', 'p'],
  ['SELECT id, password FROM public.accounts ORDER BY 2', 'position'],
  ['SELECT id, password FROM public.accounts GROUP BY 1, 2', 'position'],
  ['SELECT upper(email) FROM public.accounts', 'email'],
  ["SELECT 1 / (CASE WHEN password LIKE 'h%' THEN 0 ELSE 1 END) FROM public.accounts", 'password'],
  ["SELECT id FROM public.accounts a WHERE a::text LIKE '%x%'", 'a'],
  ["SELECT id FROM public.accounts WHERE accounts::text LIKE '%x%'", 'accounts'],
  ['SELECT row_to_json(a) FROM public.accounts a', 'a'],
  ['SELECT id FROM public.accounts a JOIN public.accounts b USING (email)', 'email'],
  ['SELECT id FROM public.accounts NATURAL JOIN public.other', 'NATURAL JOIN'],
  ['SELECT DISTINCT password FROM public.accounts', 'DISTINCT'],
  ['SELECT DISTINCT ON (id) id, password FROM public.accounts', 'DISTINCT'],
  [
    'SELECT id FROM public.accounts WHERE id IN (SELECT id FROM public.accounts WHERE email = $1)',
    'email',
  ],
  ['WITH c AS (SELECT email FROM public.accounts) SELECT * FROM c', 'email'],
  ['SELECT email FROM public.accounts UNION SELECT email FROM public.accounts', 'email'],
  ['SELECT id, count(*) OVER (ORDER BY password) FROM public.accounts', 'password'],
  ['SELECT id FROM public.accounts HAVING max(password) > $1', 'password'],
  [
    'SELECT (SELECT max(id) FROM public.accounts b WHERE b.password = a.password) FROM public.accounts a',
    'password',
  ],
  ['SELECT * FROM (SELECT * FROM public.accounts) s', '*'],
  ["EXPLAIN ANALYZE SELECT id FROM public.accounts WHERE password = 'x'", 'password'],
]

describe.each(SUPPORTED_MAJORS.map((m) => [m]))('sensitive references on %i', (major) => {
  it.each(ALLOWED)('allows %s', (text) => {
    expect(sensitiveReference(major, text, MASKED)).toBeUndefined()
  })

  it.each(REFUSED)('refuses %s', (text, construct) => {
    expect(sensitiveReference(major, text, MASKED)).toBe(construct)
  })

  it('checks nothing when no column is masked', () => {
    expect(
      sensitiveReference(major, "SELECT id FROM public.accounts WHERE password = 'x'", new Set()),
    ).toBeUndefined()
  })
})
