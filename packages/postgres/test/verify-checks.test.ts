import { beforeAll, describe, expect, it } from 'vitest'
import {
  analyzeVerifyFile,
  declaredFunction,
  loadParser,
  SUPPORTED_MAJORS,
  verifyDirectives,
} from '../src/parser/index.ts'

beforeAll(async () => {
  for (const major of SUPPORTED_MAJORS) await loadParser(major)
})

describe.each(SUPPORTED_MAJORS)('verify.sql checks with the PostgreSQL %i grammar', (major) => {
  it('names checks by the line comments before them, never by text inside a statement', () => {
    const text = `-- leading file comment
-- check: index exists
SELECT pg_catalog.to_regclass('public.leads_idx') IS NOT NULL AS ok;

-- covers: 0, 2
SELECT '-- check: not a directive' <> '' AS ok;

/* -- check: inside a block comment */
SELECT $q$
-- calls: public.evil(int)
$q$ <> '' AS ok;
`
    const checks = verifyDirectives(major, text)
    expect(checks?.map((c) => [c.name, c.covers, c.calls])).toEqual([
      ['index exists', [], null],
      ['check_1', ['0', '2'], null],
      ['check_2', [], null],
    ])
    const file = analyzeVerifyFile(major, text)
    expect(file.ok).toBe(true)
    if (file.ok) {
      expect(file.checks[0]?.text.startsWith('SELECT')).toBe(true)
      expect(file.checks[2]?.text).toContain('$q$')
    }
  })

  it('allows a declared consumer function only in the check that declares it', () => {
    const declared = `-- check: tenant isolation
-- calls: app.visible_leads(uuid)
SELECT count(*) = 0 AS ok FROM app.visible_leads('00000000-0000-0000-0000-000000000000');
`
    const file = analyzeVerifyFile(major, declared)
    expect(file.ok).toBe(true)
    if (file.ok) {
      expect(file.checks[0]?.calls).toBe('app.visible_leads(uuid)')
      expect(file.checks[0]?.functions).toContain('app.visible_leads')
    }
    const leaked = `${declared}
-- check: second
SELECT count(*) = 0 AS ok FROM app.visible_leads('00000000-0000-0000-0000-000000000000');
`
    const refused = analyzeVerifyFile(major, leaked)
    expect(refused).toMatchObject({
      ok: false,
      refusal: { reason: 'function', construct: 'app.visible_leads' },
      check: { index: 1, name: 'second' },
    })
  })

  it('refuses malformed declarations, other statement classes and other output columns', () => {
    expect(declaredFunction('app.f(int, text)')).toBe('app.f')
    expect(declaredFunction('f(int)')).toBeNull()
    expect(analyzeVerifyFile(major, '-- calls: nope\nSELECT true AS ok;')).toMatchObject({
      ok: false,
      refusal: { reason: 'user_code' },
    })
    expect(analyzeVerifyFile(major, 'SELECT true AS ok, 1 AS n;')).toMatchObject({
      ok: false,
      refusal: { reason: 'output_columns' },
    })
    expect(analyzeVerifyFile(major, 'DELETE FROM public.t;')).toMatchObject({
      ok: false,
      refusal: { code: 'MIGRATION_STATEMENT_FORBIDDEN' },
    })
    expect(analyzeVerifyFile(major, 'SELECT true AS ok FROM public.t FOR UPDATE;')).toMatchObject({
      ok: false,
      refusal: { reason: 'locking_clause', code: 'MIGRATION_STATEMENT_FORBIDDEN' },
    })
    expect(analyzeVerifyFile(major, 'SELECT true AS ok, 1 AS n;')).toMatchObject({
      ok: false,
      refusal: { code: 'VERIFY_CONSTRUCT_UNSUPPORTED' },
    })
    expect(analyzeVerifyFile(major, 'SELECT (')).toMatchObject({ ok: false, check: null })
  })
})
