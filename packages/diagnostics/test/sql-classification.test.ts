import { SQL_CLASSIFY_MAX_STATEMENTS, SqlClassificationSchema } from '@exponetdb/contracts'
import { describe, expect, it } from 'vitest'
import { classifySql, type SqlClassificationResult } from '../src/index.ts'

/**
 * The classification mapping (sql-execution-security.md §2.4): positions in
 * characters, the node kind, the classes from the analysis facts and the
 * read-only verdict, and no text in the answer.
 */
async function classify(sql: string, major: 16 | 17 | 18 = 17): Promise<SqlClassificationResult> {
  const outcome = await classifySql(major, sql, { maxStatements: SQL_CLASSIFY_MAX_STATEMENTS })
  if (outcome.kind !== 'classified') throw new Error('too many statements')
  // Every answer is a valid answer of the contract.
  expect(
    SqlClassificationSchema.safeParse({ ...outcome.result, computedAt: '2026-10-13T00:00:00Z' })
      .success,
  ).toBe(true)
  return outcome.result
}

const one = async (sql: string) => {
  const r = await classify(sql)
  expect(r.status, sql).toBe('parsed')
  expect(r.statements, sql).toHaveLength(1)
  return r.statements[0] as SqlClassificationResult['statements'][number]
}

describe('classes', () => {
  it.each([
    ['SELECT 1', 'SelectStmt', ['read_only']],
    ['SELECT id FROM public.users WHERE id = 1', 'SelectStmt', ['read_only']],
    ['SHOW server_version', 'VariableShowStmt', ['read_only']],
    ['INSERT INTO public.t (a) VALUES (1)', 'InsertStmt', ['write']],
    ['UPDATE public.t SET a = 1 WHERE b = 2', 'UpdateStmt', ['write']],
    ['DELETE FROM public.t WHERE a = 1', 'DeleteStmt', ['write', 'destructive']],
    ['DROP TABLE public.t', 'DropStmt', ['write', 'destructive']],
    ['TRUNCATE public.t', 'TruncateStmt', ['write', 'destructive']],
    ['ALTER TABLE public.t ALTER COLUMN a TYPE bigint', 'AlterTableStmt', ['write', 'rewrite']],
    ['ALTER TABLE public.t DROP COLUMN a', 'AlterTableStmt', ['write', 'destructive']],
    ['CREATE TABLE public.t (a int)', 'CreateStmt', ['write']],
    ['CREATE INDEX CONCURRENTLY i ON public.t (a)', 'IndexStmt', ['write', 'non_transactional']],
    ['CREATE INDEX i ON public.t (a)', 'IndexStmt', ['write']],
    ['VACUUM public.t', 'VacuumStmt', ['write', 'non_transactional']],
    ['VACUUM FULL public.t', 'VacuumStmt', ['write', 'rewrite', 'non_transactional']],
    ['GRANT SELECT ON public.t TO app', 'GrantStmt', ['write', 'security']],
    ['REVOKE ALL ON public.t FROM app', 'GrantStmt', ['write', 'security']],
    ['CREATE ROLE app LOGIN', 'CreateRoleStmt', ['write', 'security']],
    ['ALTER TABLE public.t ENABLE ROW LEVEL SECURITY', 'AlterTableStmt', ['write', 'security']],
    ['ALTER TABLE public.t DISABLE ROW LEVEL SECURITY', 'AlterTableStmt', ['write', 'security']],
    ['CREATE POLICY p ON public.t USING (true)', 'CreatePolicyStmt', ['write', 'security']],
    ['DROP POLICY p ON public.t', 'DropStmt', ['write', 'security']],
    [
      'CREATE FUNCTION public.f() RETURNS int LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1 $$',
      'CreateFunctionStmt',
      ['write', 'security'],
    ],
    [
      'CREATE FUNCTION public.f() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$',
      'CreateFunctionStmt',
      ['write'],
    ],
  ] as const)('%s is %s with %j', async (sql, kind, classes) => {
    const s = await one(sql)
    expect(s.kind).toBe(kind)
    expect(s.classes).toEqual(classes)
  })

  it('claims nothing it cannot derive: a SELECT outside the read allowlist is neither read-only nor a write', async () => {
    const s = await one('SELECT pg_sleep(1)')
    expect(s.classes).toEqual([])
    expect(s.readOnlyPath).toBe(false)
    expect(s.readOnlyRefusal).toEqual({ code: 'QUERY_CONSTRUCT_UNSUPPORTED', reason: 'function' })
    expect(s.procedural).toBe(true)
    const unqualified = await one('SELECT * FROM users')
    expect(unqualified.classes).toEqual([])
    expect(unqualified.readOnlyRefusal?.reason).toBe('relation_unqualified')
  })

  it('treats a data-modifying CTE, a locking clause and SELECT INTO as writes', async () => {
    const cte = await one('WITH d AS (DELETE FROM public.t RETURNING *) SELECT * FROM d')
    expect(cte.classes).toContain('write')
    expect(cte.readOnlyRefusal).toEqual({ code: 'QUERY_NOT_READ_ONLY', reason: 'data_modifying' })
    const lock = await one('SELECT * FROM public.t FOR UPDATE')
    expect(lock.classes).toEqual(['write'])
    expect(lock.readOnlyRefusal?.reason).toBe('locking_clause')
    const into = await one('SELECT * INTO public.copy FROM public.t')
    expect(into.classes).toEqual(['write'])
    expect(into.readOnlyRefusal?.reason).toBe('select_into')
  })

  it('names why the migration engine would refuse a statement, as a reason code', async () => {
    expect((await one('CREATE ROLE app')).migrationRefusal).toBe('role_management')
    expect((await one('BEGIN')).migrationRefusal).toBe('transaction_control')
    expect((await one('CREATE TABLE public.t (a int)')).migrationRefusal).toBeNull()
  })

  it('answers with the grammar of the major asked for', async () => {
    const r = await classify('SELECT 1', 16)
    expect(r.postgresMajor).toBe(16)
    expect(r.grammar).toContain('16')
    expect(r.source).toBe('parser')
  })
})

describe('the read-only data path', () => {
  it('is admitted for exactly one admitted statement', async () => {
    const r = await classify('SELECT 1')
    expect(r.readOnlyPath).toEqual({ admitted: true, refusal: null })
  })

  it('refuses a text of several statements as a whole, while each statement keeps its own verdict', async () => {
    const r = await classify('SELECT 1; SELECT 2; DELETE FROM public.t')
    expect(r.readOnlyPath).toEqual({
      admitted: false,
      refusal: { code: 'QUERY_CONSTRUCT_UNSUPPORTED', reason: 'multiple_statements' },
    })
    expect(r.statements.map((s) => s.readOnlyPath)).toEqual([true, true, false])
    expect(r.statements.map((s) => s.index)).toEqual([0, 1, 2])
  })
})

describe('positions', () => {
  it('are 1-based lines and columns, the end exclusive after the last character', async () => {
    const r = await classify('SELECT 1;\nSELECT 22')
    const [a, b] = r.statements
    expect(a?.start).toEqual({ line: 1, column: 1, offset: 0 })
    expect(a?.end).toEqual({ line: 1, column: 9, offset: 8 })
    expect(b?.start).toEqual({ line: 2, column: 1, offset: 10 })
    expect(b?.end).toEqual({ line: 2, column: 10, offset: 19 })
  })

  it('start at the first token, after comments and white space, and end before the semicolon and trailing white space', async () => {
    const sql = '-- leading\n/* block\ncomment */\n   SELECT 1   ;  \n\n  DELETE FROM public.t  '
    const r = await classify(sql)
    const [a, b] = r.statements
    expect(a?.start).toEqual({ line: 4, column: 4, offset: sql.indexOf('SELECT') })
    expect(sql.slice(a?.start.offset, a?.end.offset)).toBe('SELECT 1')
    expect(sql.slice(b?.start.offset, b?.end.offset)).toBe('DELETE FROM public.t')
    expect(b?.start.line).toBe(6)
    expect(b?.start.column).toBe(3)
  })

  it('count columns in code points and offsets in UTF-16 code units, for non-ASCII text', async () => {
    // "é" is one code point and one code unit; "😀" is one code point and two code units.
    const first = "SELECT 'é😀😀é'"
    const second = "SELECT '😀' || 'x'"
    const sql = `${first};\n${second}`
    const r = await classify(sql)
    const [a, b] = r.statements
    expect(sql.slice(a?.start.offset, a?.end.offset)).toBe(first)
    // 13 code points and 15 code units.
    expect([...first]).toHaveLength(13)
    expect(first).toHaveLength(15)
    expect(a?.end).toEqual({ line: 1, column: 14, offset: 15 })
    expect(b?.start).toEqual({ line: 2, column: 1, offset: 17 })
    expect(sql.slice(b?.start.offset, b?.end.offset)).toBe(second)
    expect([...second]).toHaveLength(17)
    expect(b?.end).toEqual({ line: 2, column: 18, offset: 17 + second.length })
  })

  it('keeps a carriage return in its line: only U+000A ends a line', async () => {
    const r = await classify('SELECT 1;\r\nSELECT 2')
    expect(r.statements[1]?.start).toEqual({ line: 2, column: 1, offset: 11 })
    expect(r.statements[0]?.end).toEqual({ line: 1, column: 9, offset: 8 })
  })

  it('see a dollar-quoted body and comments with semicolons as part of one statement', async () => {
    const sql =
      'CREATE FUNCTION public.f() RETURNS void LANGUAGE plpgsql AS $$ BEGIN PERFORM 1; -- ;\nEND $$; /* ; */ SELECT 1 -- ; trailing'
    const r = await classify(sql)
    expect(r.statements.map((s) => s.kind)).toEqual(['CreateFunctionStmt', 'SelectStmt'])
    expect(sql.slice(r.statements[0]?.start.offset, r.statements[0]?.end.offset)).toMatch(
      /^CREATE FUNCTION .*\sEND \$\$$/s,
    )
  })
})

describe('text that is not a statement', () => {
  it('reports comments only as empty, not as an error', async () => {
    const r = await classify('-- nothing\n/* here */')
    expect(r).toMatchObject({
      status: 'empty',
      statementCount: 0,
      statements: [],
      parseError: null,
    })
    expect(r.readOnlyPath.admitted).toBe(false)
  })

  it('reports a syntax error with its position, not as a failure of the call', async () => {
    const sql = "SELECT 'é😀😀' FROM ;"
    const r = await classify(sql)
    expect(r.status).toBe('parse_error')
    expect(r.statements).toEqual([])
    expect(r.parseError?.reason).toBe('syntax')
    // The position is the semicolon, in the same units as the statement positions.
    expect(r.parseError?.position).toEqual({
      line: 1,
      column: [...sql].indexOf(';') + 1,
      offset: sql.indexOf(';'),
    })
    expect(r.readOnlyPath.refusal).toEqual({ code: 'QUERY_PARSE_ERROR', reason: 'syntax' })
  })

  it('reports the line of an error in a later line', async () => {
    const r = await classify('SELECT 1;\nSELECT 2;\nSELEC 3')
    expect(r.parseError?.position?.line).toBe(3)
  })

  it('refuses a NUL as a parse error without a position', async () => {
    const r = await classify('SELECT 1\u0000')
    expect(r.status).toBe('parse_error')
    expect(r.parseError).toEqual({ reason: 'nul', position: null })
  })
})

describe('limits and text', () => {
  it('stops above the statement bound before it classifies anything', async () => {
    const sql = Array.from({ length: SQL_CLASSIFY_MAX_STATEMENTS + 1 }, () => 'SELECT 1').join(';')
    const outcome = await classifySql(17, sql, { maxStatements: SQL_CLASSIFY_MAX_STATEMENTS })
    expect(outcome).toEqual({ kind: 'too_many_statements', count: SQL_CLASSIFY_MAX_STATEMENTS + 1 })
    const atBound = Array.from({ length: SQL_CLASSIFY_MAX_STATEMENTS }, () => 'SELECT 1').join(';')
    const ok = await classifySql(17, atBound, { maxStatements: SQL_CLASSIFY_MAX_STATEMENTS })
    expect(ok.kind).toBe('classified')
  })

  it('never carries a piece of the text: only positions, kinds, labels and codes', async () => {
    const marker = 'zq9marker7x'
    const sql = `CREATE ROLE ${marker}; SELECT '${marker}' FROM ${marker}.${marker}; UPDATE ${marker}.t SET c = '${marker}'`
    const r = await classify(sql)
    expect(JSON.stringify(r)).not.toContain(marker)
    const failing = await classify(`SELECT '${marker}' FROM`)
    expect(JSON.stringify(failing)).not.toContain(marker)
  })
})
