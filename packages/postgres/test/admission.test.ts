import { beforeAll, describe, expect, it } from 'vitest'
import {
  admitReadSync,
  admitVerifySync,
  checkRelationKinds,
  loadParser,
} from '../src/parser/index.ts'
import { SUPPORTED_MAJORS } from '../src/versions.ts'

/**
 * G4 item 8 (security): `data.read` admission refuses every statement class
 * of the security spec that is not a read, on every supported grammar; the
 * escape attempts of sql-execution-security.md §5 are refused or contained.
 */
beforeAll(async () => {
  for (const major of SUPPORTED_MAJORS) await loadParser(major)
})

const ACCEPTED: readonly string[] = [
  'SELECT 1',
  "SELECT a.id, count(*) FROM public.t a WHERE a.x = 'v' AND a.y = $1 GROUP BY 1 ORDER BY 2 DESC LIMIT 10",
  'WITH c AS (SELECT 1 AS x) SELECT x FROM c',
  'WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r WHERE n < 5) SELECT n FROM r',
  'VALUES (1), (2)',
  'TABLE public.t',
  'SHOW work_mem',
  'SHOW ALL',
  'EXPLAIN SELECT * FROM public.t',
  'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT 1',
  "SELECT lower('X'), now(), coalesce(NULL, 1), CASE WHEN true THEN 1 ELSE 2 END, greatest(1, 2)",
  "SELECT '{\"a\":1}'::jsonb -> 'a', (ARRAY[1,2])[1], (SELECT max(id) FROM public.t)",
  'SELECT * FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace LIMIT 1',
  "SELECT x FROM public.t WHERE x IN (1, 2) AND y BETWEEN 1 AND 2 AND z LIKE 'a%' AND w IS NOT NULL",
  'SELECT row_number() OVER (PARTITION BY a ORDER BY b) FROM public.t',
  'SELECT current_user, current_date, session_user',
  'SELECT 1 /* ; DROP TABLE x */',
  'SELECT $$; DROP TABLE x$$',
  "SELECT pg_catalog.has_table_privilege('public.t', 'SELECT')",
  'SELECT g FROM pg_catalog.generate_series(1, 3) g',
]

/** [statement, expected code] : every non-read class, then escape attempts. */
const REFUSED: readonly (readonly [string, string])[] = [
  ['INSERT INTO public.t VALUES (1)', 'QUERY_NOT_READ_ONLY'],
  ['UPDATE public.t SET x = 1', 'QUERY_NOT_READ_ONLY'],
  ['DELETE FROM public.t', 'QUERY_NOT_READ_ONLY'],
  ['MERGE INTO public.t USING public.s ON true WHEN MATCHED THEN DELETE', 'QUERY_NOT_READ_ONLY'],
  ['WITH d AS (DELETE FROM public.t RETURNING *) SELECT * FROM d', 'QUERY_NOT_READ_ONLY'],
  ['WITH u AS (UPDATE public.t SET x = 1 RETURNING x) SELECT * FROM u', 'QUERY_NOT_READ_ONLY'],
  ['WITH i AS (INSERT INTO public.t VALUES (1) RETURNING *) SELECT 1', 'QUERY_NOT_READ_ONLY'],
  ['SELECT * FROM public.t FOR UPDATE', 'QUERY_NOT_READ_ONLY'],
  ['SELECT * FROM public.t FOR SHARE', 'QUERY_NOT_READ_ONLY'],
  ['SELECT * FROM public.t FOR KEY SHARE', 'QUERY_NOT_READ_ONLY'],
  ['SELECT * FROM public.t FOR NO KEY UPDATE SKIP LOCKED', 'QUERY_NOT_READ_ONLY'],
  ['SELECT 1 INTO x', 'QUERY_NOT_READ_ONLY'],
  ['SELECT 1 INTO TEMP x', 'QUERY_NOT_READ_ONLY'],
  ['CREATE TABLE public.x AS SELECT 1', 'QUERY_NOT_READ_ONLY'],
  ["COPY public.t TO PROGRAM 'id'", 'QUERY_NOT_READ_ONLY'],
  ['COPY public.t TO STDOUT', 'QUERY_NOT_READ_ONLY'],
  ['COPY (SELECT 1) TO STDOUT', 'QUERY_NOT_READ_ONLY'],
  ['CALL public.p()', 'QUERY_NOT_READ_ONLY'],
  ['DO $$ BEGIN PERFORM 1; END $$', 'QUERY_NOT_READ_ONLY'],
  ['SET work_mem = 1', 'QUERY_NOT_READ_ONLY'],
  ['SET TRANSACTION READ WRITE', 'QUERY_NOT_READ_ONLY'],
  ['SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE', 'QUERY_NOT_READ_ONLY'],
  ['RESET ALL', 'QUERY_NOT_READ_ONLY'],
  ['BEGIN', 'QUERY_NOT_READ_ONLY'],
  ['COMMIT', 'QUERY_NOT_READ_ONLY'],
  ['ROLLBACK', 'QUERY_NOT_READ_ONLY'],
  ['SAVEPOINT s', 'QUERY_NOT_READ_ONLY'],
  ['LISTEN c', 'QUERY_NOT_READ_ONLY'],
  ["NOTIFY c, 'x'", 'QUERY_NOT_READ_ONLY'],
  ['UNLISTEN *', 'QUERY_NOT_READ_ONLY'],
  ['PREPARE s AS SELECT 1', 'QUERY_NOT_READ_ONLY'],
  ['EXECUTE s', 'QUERY_NOT_READ_ONLY'],
  ['DEALLOCATE ALL', 'QUERY_NOT_READ_ONLY'],
  ['DECLARE c CURSOR FOR SELECT 1', 'QUERY_NOT_READ_ONLY'],
  ['FETCH 1 FROM c', 'QUERY_NOT_READ_ONLY'],
  ['CLOSE c', 'QUERY_NOT_READ_ONLY'],
  ['LOCK public.t', 'QUERY_NOT_READ_ONLY'],
  ['VACUUM public.t', 'QUERY_NOT_READ_ONLY'],
  ['ANALYZE public.t', 'QUERY_NOT_READ_ONLY'],
  ['CLUSTER public.t', 'QUERY_NOT_READ_ONLY'],
  ['REINDEX TABLE public.t', 'QUERY_NOT_READ_ONLY'],
  ['CHECKPOINT', 'QUERY_NOT_READ_ONLY'],
  ["LOAD 'x'", 'QUERY_NOT_READ_ONLY'],
  ['DISCARD ALL', 'QUERY_NOT_READ_ONLY'],
  ['REFRESH MATERIALIZED VIEW public.m', 'QUERY_NOT_READ_ONLY'],
  ['CREATE TABLE public.x (id int)', 'QUERY_NOT_READ_ONLY'],
  ['DROP TABLE public.t', 'QUERY_NOT_READ_ONLY'],
  ['ALTER TABLE public.t ADD COLUMN y int', 'QUERY_NOT_READ_ONLY'],
  ['TRUNCATE public.t', 'QUERY_NOT_READ_ONLY'],
  ['GRANT SELECT ON public.t TO PUBLIC', 'QUERY_NOT_READ_ONLY'],
  ['REVOKE SELECT ON public.t FROM PUBLIC', 'QUERY_NOT_READ_ONLY'],
  ["COMMENT ON TABLE public.t IS 'x'", 'QUERY_NOT_READ_ONLY'],
  ["SECURITY LABEL ON TABLE public.t IS 'x'", 'QUERY_NOT_READ_ONLY'],
  ['IMPORT FOREIGN SCHEMA s FROM SERVER x INTO public', 'QUERY_NOT_READ_ONLY'],
  ['CREATE EXTENSION dblink', 'QUERY_NOT_READ_ONLY'],
  ['ALTER SYSTEM SET work_mem = 1', 'QUERY_NOT_READ_ONLY'],
  ['CREATE ROLE x', 'QUERY_NOT_READ_ONLY'],
  ['EXPLAIN INSERT INTO public.t VALUES (1)', 'QUERY_NOT_READ_ONLY'],
  ['EXPLAIN ANALYZE DELETE FROM public.t', 'QUERY_NOT_READ_ONLY'],
  ['EXPLAIN ANALYZE WITH d AS (DELETE FROM public.t RETURNING 1) SELECT 1', 'QUERY_NOT_READ_ONLY'],
  ['SELECT pg_sleep(1000000)', 'QUERY_CONSTRUCT_UNSUPPORTED'],
  ["SELECT pg_catalog.pg_sleep_for('1 hour')", 'QUERY_CONSTRUCT_UNSUPPORTED'],
  ['SELECT pg_advisory_lock(1)', 'QUERY_CONSTRUCT_UNSUPPORTED'],
  [
    "SELECT set_config('default_transaction_read_only', 'off', false)",
    'QUERY_CONSTRUCT_UNSUPPORTED',
  ],
  ["SELECT nextval('public.s')", 'QUERY_CONSTRUCT_UNSUPPORTED'],
  ["SELECT public.dblink_exec('host=x', 'DROP TABLE t')", 'QUERY_CONSTRUCT_UNSUPPORTED'],
  ["SELECT dblink_exec('host=x', 'DROP TABLE t')", 'QUERY_CONSTRUCT_UNSUPPORTED'],
  ['SELECT public.f()', 'QUERY_CONSTRUCT_UNSUPPORTED'],
  ['SELECT lo_create(0)', 'QUERY_CONSTRUCT_UNSUPPORTED'],
  ["SELECT query_to_xml('delete from t', true, true, '')", 'QUERY_CONSTRUCT_UNSUPPORTED'],
  ["SELECT * FROM ts_stat('delete from t')", 'QUERY_CONSTRUCT_UNSUPPORTED'],
  ['SELECT txid_current()', 'QUERY_CONSTRUCT_UNSUPPORTED'],
  ["SELECT pg_notify('c', 'x')", 'QUERY_CONSTRUCT_UNSUPPORTED'],
  ['SELECT pg_terminate_backend(1)', 'QUERY_CONSTRUCT_UNSUPPORTED'],
  ["SELECT pg_read_file('/etc/passwd')", 'QUERY_CONSTRUCT_UNSUPPORTED'],
  ['SELECT 1 OPERATOR(public.+) 2', 'QUERY_CONSTRUCT_UNSUPPORTED'],
  ['SELECT a <=> b FROM public.t', 'QUERY_CONSTRUCT_UNSUPPORTED'],
  ["SELECT 'x'::public.mytype", 'QUERY_CONSTRUCT_UNSUPPORTED'],
  ['SELECT 1::myenum', 'QUERY_CONSTRUCT_UNSUPPORTED'],
  ['SELECT * FROM t', 'QUERY_CONSTRUCT_UNSUPPORTED'],
  ['SELECT * FROM otherdb.public.t', 'QUERY_CONSTRUCT_UNSUPPORTED'],
  ['SELECT * FROM public.t TABLESAMPLE SYSTEM (10)', 'QUERY_CONSTRUCT_UNSUPPORTED'],
  ["SELECT * FROM XMLTABLE('/a' PASSING '<a/>' COLUMNS x int)", 'QUERY_CONSTRUCT_UNSUPPORTED'],
  ['SELECT xmlelement(name a)', 'QUERY_CONSTRUCT_UNSUPPORTED'],
  ['SELECT 1; DROP TABLE public.t', 'QUERY_CONSTRUCT_UNSUPPORTED'],
  ['SELECT 1; SELECT 2', 'QUERY_CONSTRUCT_UNSUPPORTED'],
  ['SELECT 1\u0000; DROP TABLE public.t', 'QUERY_CONSTRUCT_UNSUPPORTED'],
  ['SELEC 1', 'QUERY_PARSE_ERROR'],
  ['', 'QUERY_PARSE_ERROR'],
  ['-- only a comment', 'QUERY_PARSE_ERROR'],
]

describe.each(SUPPORTED_MAJORS.map((m) => [m]))(
  'data.read admission on the PostgreSQL %i grammar',
  (major) => {
    it.each(ACCEPTED)('admits %s', (text) => {
      const a = admitReadSync(major, text)
      expect(a).toMatchObject({ ok: true, statements: 1 })
    })

    it.each(REFUSED)('refuses %s', (text, code) => {
      const a = admitReadSync(major, text)
      expect(a.ok).toBe(false)
      if (!a.ok) expect(a.code).toBe(code)
    })

    it('reports relations and functions of an admitted read', () => {
      const a = admitReadSync(
        major,
        "SELECT lower(x) FROM public.t JOIN app.u ON true WHERE y = 'z'",
      )
      expect(a).toMatchObject({
        ok: true,
        statementClass: 'select',
        relations: [
          { schema: 'public', name: 't' },
          { schema: 'app', name: 'u' },
        ],
        functions: ['pg_catalog.lower'],
      })
    })

    it('marks EXPLAIN ANALYZE as executing and EXPLAIN (ANALYZE false) as not', () => {
      expect(admitReadSync(major, 'EXPLAIN ANALYZE SELECT 1')).toMatchObject({
        ok: true,
        analyze: true,
      })
      expect(admitReadSync(major, 'EXPLAIN (ANALYZE false) SELECT 1')).toMatchObject({
        ok: true,
        analyze: false,
      })
      expect(admitReadSync(major, 'EXPLAIN SELECT 1')).toMatchObject({ ok: true, analyze: false })
    })

    it('refuses hostile nesting as a typed parse error and keeps working', () => {
      const deep = `SELECT ${'('.repeat(30_000)}1${')'.repeat(30_000)}`
      const a = admitReadSync(major, deep)
      expect(a).toMatchObject({ ok: false, code: 'QUERY_PARSE_ERROR' })
      expect(admitReadSync(major, 'SELECT 1').ok).toBe(true)
    })

    it('admits a large IN list quickly', () => {
      const list = Array.from({ length: 20_000 }, (_, i) => String(i)).join(',')
      const started = performance.now()
      expect(admitReadSync(major, `SELECT 1 FROM public.t WHERE id IN (${list})`).ok).toBe(true)
      expect(performance.now() - started).toBeLessThan(2000)
    })

    // G4 review (2026-10-07): calls and operators hidden in other syntax.
    it.each([
      ['SELECT (0.5::float8).pg_sleep', 'field_selection'],
      ['SELECT (72707369::bigint).pg_advisory_lock', 'field_selection'],
      ['SELECT (1::bigint).pg_try_advisory_lock', 'field_selection'],
      ['SELECT ($1::int).pg_terminate_backend', 'field_selection'],
      ['SELECT (pid).pg_cancel_backend FROM pg_catalog.pg_stat_activity', 'field_selection'],
      ["SELECT ('public.s'::regclass).nextval", 'field_selection'],
      ["SELECT (12345::oid).lo_unlink, ('/x'::text).lo_import", 'field_selection'],
      ["SELECT ('/etc/passwd'::text).pg_read_file", 'field_selection'],
      ["SELECT ('SELECT 1'::text).ts_stat", 'field_selection'],
      ['SELECT (t.c).f FROM public.t t', 'field_selection'],
      ['SELECT t.record_out FROM public.t t', 'function'],
      ['SELECT public.t.hash_record FROM public.t', 'function'],
      ['SELECT t.pg_column_compression FROM public.t t', 'function'],
      ['SELECT 1 FROM public.t WHERE x OPERATOR(public.===) ANY (SELECT 1)', 'operator'],
      ['SELECT 1 FROM public.t WHERE (x, y) OPERATOR(public.<) ANY (SELECT 1, 2)', 'operator'],
      ['SELECT 1 FROM public.t WHERE x ~<~ ALL (SELECT 1)', 'operator'],
      ['SELECT x FROM public.t ORDER BY x USING OPERATOR(public.<)', 'operator'],
      ['SELECT array_agg(x ORDER BY x USING OPERATOR(public.<)) FROM public.t', 'operator'],
      ['SELECT x FROM public.t ORDER BY x USING ~<~', 'operator'],
      ['SELECT row_number() OVER (ORDER BY x USING OPERATOR(public.<)) FROM public.t', 'operator'],
      // A scalar function in FROM is its own whole row: `q.f` is `f(q)` for any function f.
      [
        "SELECT q.ts_stat FROM pg_catalog.lower('select pg_catalog.to_tsvector(''x'')') AS q",
        'function',
      ],
      ['SELECT g.pg_sleep FROM pg_catalog.generate_series(1, 1) AS g', 'function'],
      ['SELECT g.pg_advisory_lock FROM pg_catalog.generate_series(1, 1) AS g', 'function'],
      ['SELECT g.pg_terminate_backend FROM pg_catalog.generate_series(1, 1) AS g', 'function'],
      ["SELECT u.nextval FROM pg_catalog.unnest(ARRAY['public.s']) u", 'function'],
      ['SELECT generate_series.pg_sleep FROM generate_series(1, 1)', 'function'],
      ['SELECT g.x FROM generate_series(1, 1) AS g(y)', 'function'],
      [
        "SELECT r.pg_sleep FROM ROWS FROM (generate_series(1, 2), lower('x')) AS r(a, b)",
        'function',
      ],
    ])('refuses %s (%s)', (text, reason) => {
      expect(admitReadSync(major, text)).toMatchObject({
        ok: false,
        code: 'QUERY_CONSTRUCT_UNSUPPORTED',
        reason,
      })
    })

    it.each([
      'SELECT t.id, t.name FROM public.t t',
      'SELECT public.t.id FROM public.t',
      'SELECT t.to_json, t.count FROM public.t t',
      'SELECT (ARRAY[1, 2])[1], (t.a)[1], (t.r).* FROM public.t t',
      'SELECT 1 FROM public.t WHERE x = ANY (SELECT 1) AND x OPERATOR(pg_catalog.<) ALL (SELECT 2)',
      'SELECT x FROM public.t ORDER BY x USING <, y USING OPERATOR(pg_catalog.>)',
      'SELECT g.g, g FROM pg_catalog.generate_series(1, 3) AS g',
      'SELECT generate_series.generate_series FROM generate_series(1, 2)',
      'SELECT u.v, u.n FROM pg_catalog.unnest(ARRAY[1]) WITH ORDINALITY AS u(v, n)',
      'SELECT u.u, u.ordinality FROM pg_catalog.unnest(ARRAY[1]) WITH ORDINALITY AS u',
      'SELECT r.a, r.b FROM ROWS FROM (generate_series(1, 2), generate_series(3, 4)) AS r(a, b)',
    ])('still admits %s', (text) => {
      expect(admitReadSync(major, text)).toMatchObject({ ok: true })
    })

    it('names the offending construct (capped) and its position', () => {
      const a = admitReadSync(major, `SELECT 1 + pg_sleep(${'1'.repeat(300)})`)
      expect(a).toMatchObject({
        ok: false,
        reason: 'function',
        construct: 'pg_sleep',
        position: 11,
      })
    })
  },
)

describe('grammar per major', () => {
  it('parses PostgreSQL 18 syntax with the 18 grammar only', () => {
    const virtual = 'SELECT 1'
    expect(admitReadSync(18, virtual).ok).toBe(true)
    // JSON_TABLE (17+) is refused as a parse error by 16 and as unsupported by 17 and 18.
    const jsonTable = "SELECT * FROM JSON_TABLE('[]'::jsonb, '$[*]' COLUMNS (a int PATH '$.a')) jt"
    expect(admitReadSync(16, jsonTable)).toMatchObject({ ok: false, code: 'QUERY_PARSE_ERROR' })
    expect(admitReadSync(17, jsonTable)).toMatchObject({
      ok: false,
      code: 'QUERY_CONSTRUCT_UNSUPPORTED',
    })
    expect(admitReadSync(18, jsonTable)).toMatchObject({
      ok: false,
      code: 'QUERY_CONSTRUCT_UNSUPPORTED',
    })
  })
})

describe('whole-row calls on PostgreSQL 18', () => {
  it('refuses the statistics writers reachable as t.pg_restore_relation_stats', () => {
    for (const name of ['pg_restore_relation_stats', 'pg_restore_attribute_stats']) {
      expect(admitReadSync(18, `SELECT t.${name} FROM public.t t`)).toMatchObject({
        ok: false,
        reason: 'function',
        construct: `t.${name}`,
      })
    }
  })
})

describe('relation kinds', () => {
  it('admits tables, partitions, materialized views and sequences, refuses views and foreign tables', () => {
    const relations = [
      { schema: 'public', name: 't' },
      { schema: 'pg_catalog', name: 'pg_roles' },
    ]
    expect(checkRelationKinds(relations, new Map([['public.t', 'r']]))).toBeUndefined()
    expect(checkRelationKinds(relations, new Map([['public.t', 'v']]))).toMatchObject({
      reason: 'relation_kind',
    })
    expect(checkRelationKinds(relations, new Map([['public.t', 'f']]))).toMatchObject({
      reason: 'relation_kind',
    })
    expect(checkRelationKinds(relations, new Map())).toMatchObject({ reason: 'relation_kind' })
  })
})

describe('verify.sql admission', () => {
  it('admits checks with ok and detail columns only', () => {
    const a = admitVerifySync(
      17,
      "-- check: a\nSELECT count(*) = 1 AS ok FROM pg_catalog.pg_class;\nSELECT true AS ok, 'x' AS detail",
    )
    expect(a).toMatchObject({ ok: true, statements: 2 })
  })

  it.each([
    ['SELECT 1', 'output_columns'],
    ['SELECT true AS ok, 1 AS other', 'output_columns'],
    ['SELECT * FROM pg_catalog.pg_class', 'output_columns'],
    ['TABLE pg_catalog.pg_class', 'output_columns'],
    ['SHOW work_mem', 'statement_class'],
    ['VALUES (true)', 'statement_class'],
    ['EXPLAIN SELECT true AS ok', 'statement_class'],
    ['SELECT pg_sleep(1) IS NULL AS ok', 'function'],
    ['SELECT true AS ok FROM pg_catalog.pg_class FOR UPDATE', 'locking_clause'],
    ['DELETE FROM public.t', 'statement_class'],
  ])('refuses %s', (text, reason) => {
    expect(admitVerifySync(17, text)).toMatchObject({ ok: false, reason })
  })

  it('admits a declared own function only under its qualified name', () => {
    const text = "SELECT audit.ac1('x') = 'y' AS ok"
    expect(admitVerifySync(17, text)).toMatchObject({ ok: false, reason: 'function' })
    expect(admitVerifySync(17, text, { extraFunctions: new Set(['audit.ac1']) })).toMatchObject({
      ok: true,
    })
    expect(
      admitVerifySync(17, "SELECT other.ac1('x') = 'y' AS ok", {
        extraFunctions: new Set(['audit.ac1']),
      }),
    ).toMatchObject({ ok: false, reason: 'function' })
  })

  it('requires qualified relations unless the profile allows unqualified ones', () => {
    expect(admitVerifySync(17, 'SELECT count(*) > 0 AS ok FROM t')).toMatchObject({
      ok: false,
      reason: 'relation_unqualified',
    })
    expect(
      admitVerifySync(17, 'SELECT count(*) > 0 AS ok FROM t', { unqualifiedRelations: true }),
    ).toMatchObject({ ok: true })
  })
})
