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

/**
 * VC-015: `(.*?)\s*$` retried the trailing white-space match from every position of the lazy
 * group, so a directive value with a long run of white space before a last character took time
 * quadratic in the run. The directive is matched linearly and trimmed afterwards.
 */
describe('a directive value with a long run of white space (VC-015)', () => {
  const timed = (spaces: number) => {
    const text = `-- check: a${' '.repeat(spaces)}b\nSELECT true AS ok;\n`
    const started = performance.now()
    const checks = verifyDirectives(SUPPORTED_MAJORS[0] ?? 17, text)
    return { ms: performance.now() - started, name: checks?.[0]?.name }
  }

  it('is read in linear time and keeps the name', () => {
    timed(1000) // warm-up
    // The parse bound is 256 KiB; 200,000 spaces is as much padding as one line can carry.
    const small = timed(50_000)
    const large = timed(200_000)
    expect(small.name?.startsWith('a')).toBe(true)
    expect(large.name?.startsWith('a')).toBe(true)
    expect(large.ms).toBeLessThan(200)
    // Four times the input: linear is about 4, quadratic about 16.
    expect(large.ms / Math.max(small.ms, 1)).toBeLessThan(8)
  })
})
