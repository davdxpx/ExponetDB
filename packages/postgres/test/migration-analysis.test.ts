import { beforeAll, describe, expect, it } from 'vitest'
import {
  analyzeMigrationSql,
  type Expectation,
  loadParser,
  MAX_MIGRATION_PARSE_BYTES,
  MAX_PARSE_BYTES,
  mostSevere,
  parseWith,
  type StatementFacts,
  survivingExpectations,
  worstSeverity,
} from '../src/parser/index.ts'
import { SUPPORTED_MAJORS } from '../src/versions.ts'

/**
 * G6 (order §11, §16 to §18, §25): migration statements are split by the
 * parser of the target's major, classified (forbidden, autocommit, locks,
 * compatibility, objects) and turned into structural expectations, on
 * every supported grammar. Unclassified statements are `unknown`, never
 * safe (C-30).
 */
beforeAll(async () => {
  for (const major of SUPPORTED_MAJORS) await loadParser(major)
})

function analyze(
  sql: string,
  major: (typeof SUPPORTED_MAJORS)[number] = 17,
  trusted: string[] = [],
) {
  const r = analyzeMigrationSql(major, sql, { trustedExtensions: trusted })
  if (!r.ok) throw new Error(`parse failed: ${JSON.stringify(r)}`)
  return r.statements
}

function one(sql: string, trusted: string[] = []): StatementFacts {
  const s = analyze(sql, 17, trusted)
  expect(s).toHaveLength(1)
  return s[0] as StatementFacts
}

describe('splitting by the parser, never by `;` or comment markers', () => {
  it('keeps semicolons inside literals, dollar quotes and comments in one statement', () => {
    for (const major of SUPPORTED_MAJORS) {
      const sql = [
        "INSERT INTO public.t (a) VALUES ('x; DROP TABLE y');",
        '-- a comment; with a semicolon',
        'CREATE FUNCTION public.f() RETURNS int LANGUAGE plpgsql AS $body$ BEGIN RETURN 1; END $body$;',
        '/* nested /* comment; */ still */ SELECT 1;',
        '--> statement-breakpoint',
        'CREATE TABLE public.u (id int);',
      ].join('\n')
      const s = analyze(sql, major)
      expect(s.map((x) => x.type)).toEqual([
        'InsertStmt',
        'CreateFunctionStmt',
        'SelectStmt',
        'CreateStmt',
      ])
      expect(s[3]?.line).toBe(6)
    }
  })

  it('reports byte offsets in UTF-8 and lines and columns in code points', () => {
    const sql = "SELECT 'äöü😀';\nCREATE TABLE public.t (id int);"
    const s = analyze(sql)
    expect(s[1]?.line).toBe(2)
    expect(s[1]?.column).toBe(1)
    expect(s[1]?.byteOffset).toBe(new TextEncoder().encode("SELECT 'äöü😀';\n").length)
  })

  it('refuses NUL, empty input and reports a syntax error with its position', () => {
    expect(analyzeMigrationSql(17, 'SELECT 1;\u0000')).toMatchObject({
      ok: false,
      failure: { kind: 'nul' },
    })
    expect(analyzeMigrationSql(17, '-- only a comment')).toMatchObject({
      ok: false,
      failure: { kind: 'empty' },
    })
    const bad = analyzeMigrationSql(
      17,
      'CREATE TABLE public.ok (id int);\nCREATE TABEL x (id int);',
    )
    expect(bad).toMatchObject({ ok: false, failure: { kind: 'syntax' }, line: 2 })
  })

  it('maps the parser error position (0-based, in characters) to a string index, also after non-ASCII text', () => {
    const text = "SELECT 'äöü😀' FROM ;"
    const bad = analyzeMigrationSql(17, text)
    expect(bad.ok).toBe(false)
    if (bad.ok || bad.failure.kind !== 'syntax') throw new Error('expected a syntax error')
    // The error is at the semicolon.
    expect(bad.failure.position).toBe(text.indexOf(';'))
    expect(bad).toMatchObject({ line: 1, column: [...text].indexOf(';') + 1 })
  })

  it('parses a valid 3 MiB migration while the data-read budget stays 1 MiB', () => {
    const line = `INSERT INTO public.t (a) VALUES ('${'x'.repeat(1000)}');\n`
    const sql = line.repeat(Math.floor((3 * 1024 * 1024) / line.length))
    expect(new TextEncoder().encode(sql).length).toBeGreaterThan(MAX_PARSE_BYTES)
    expect(parseWith(17, sql)).toMatchObject({ ok: false, failure: { kind: 'too_large' } })
    const r = analyzeMigrationSql(17, sql)
    expect(r.ok).toBe(true)
    expect(analyzeMigrationSql(17, `${sql}${'-'.repeat(MAX_MIGRATION_PARSE_BYTES)}`)).toMatchObject(
      {
        ok: false,
        failure: { kind: 'too_large' },
      },
    )
  })
})

describe('forbidden statements (migration-bundles.md §4)', () => {
  const forbidden: [string, string][] = [
    ['BEGIN', 'transaction_control'],
    ['COMMIT', 'transaction_control'],
    ['SAVEPOINT a', 'transaction_control'],
    ['PREPARE TRANSACTION $$x$$', 'transaction_control'],
    ['SET TRANSACTION ISOLATION LEVEL SERIALIZABLE', 'transaction_control'],
    ['SET work_mem = 1', 'session_setting'],
    ['RESET ALL', 'session_setting'],
    ['SET ROLE postgres', 'role_switch'],
    ['SET LOCAL ROLE postgres', 'role_switch'],
    ['RESET ROLE', 'role_switch'],
    ['SET SESSION AUTHORIZATION postgres', 'role_switch'],
    ['SET LOCAL search_path = public', 'engine_setting'],
    ['SET LOCAL statement_timeout = 0', 'engine_setting'],
    ['SET LOCAL lock_timeout = 0', 'engine_setting'],
    ['RESET lock_timeout', 'engine_setting'],
    ['SET LOCAL standard_conforming_strings = off', 'engine_setting'],
    ["SELECT set_config('role', 'postgres', true)", 'engine_setting'],
    ["SELECT pg_catalog.set_config('search_path', 'evil', true)", 'engine_setting'],
    ["SELECT set_config('app.tenant', 'x', false)", 'engine_setting'],
    ['DISCARD ALL', 'discard'],
    ['CREATE ROLE r', 'role_management'],
    ['ALTER ROLE r SUPERUSER', 'role_management'],
    ['DROP ROLE r', 'role_management'],
    ['GRANT r TO s', 'role_management'],
    ["ALTER SYSTEM SET work_mem = '1MB'", 'alter_system'],
    ['CREATE DATABASE d', 'database'],
    ['DROP DATABASE d', 'database'],
    ["CREATE TABLESPACE t LOCATION '/tmp'", 'tablespace'],
    ["LOAD 'x'", 'load'],
    ["COPY public.t FROM PROGRAM 'id'", 'copy_server_file'],
    ["COPY public.t TO '/tmp/x'", 'copy_server_file'],
    ['CREATE EXTENSION dblink', 'extension_not_trusted'],
    ['INSERT INTO exponetdb.schema_migrations (migration_id) VALUES ($$x$$)', 'ledger_schema'],
    ['DROP SCHEMA exponetdb CASCADE', 'ledger_schema'],
    ['ALTER SCHEMA exponetdb RENAME TO x', 'ledger_schema'],
    ['GRANT USAGE ON SCHEMA exponetdb TO app', 'ledger_schema'],
    ['CREATE TABLE exponetdb.shadow (id int)', 'ledger_schema'],
    ['UPDATE exponetdb.target_identity SET generation = 9', 'ledger_schema'],
    ['ALTER TABLE public.t SET SCHEMA exponetdb', 'ledger_schema'],
    ['DECLARE c CURSOR FOR SELECT 1', 'cursor_or_prepared'],
    ['PREPARE p AS SELECT 1', 'cursor_or_prepared'],
    ['CHECKPOINT', 'privileged'],
    ['CREATE EVENT TRIGGER e ON ddl_command_start EXECUTE FUNCTION public.f()', 'privileged'],
  ]
  for (const [sql, reason] of forbidden) {
    it(`${sql} → ${reason}`, () => {
      for (const major of SUPPORTED_MAJORS) {
        const s = analyze(sql, major)
        expect(s[0]?.forbidden?.reason, `${major}`).toBe(reason)
        expect(s[0]?.compatibility).toContain('unknown')
      }
    })
  }

  it('does not take a column or value named exponetdb for the ledger schema', () => {
    expect(one('ALTER TABLE public.t ADD COLUMN exponetdb int').forbidden).toBeNull()
    expect(one("INSERT INTO public.t (a) VALUES ('exponetdb')").forbidden).toBeNull()
  })

  it('allows a local setting the executor does not pin, and a trusted extension', () => {
    expect(one('SET LOCAL maintenance_work_mem = $$256MB$$').forbidden).toBeNull()
    expect(one('CREATE EXTENSION IF NOT EXISTS pg_trgm', ['pg_trgm']).forbidden).toBeNull()
    expect(one("SELECT set_config('app.tenant', 'x', true)").forbidden).toBeNull()
  })
})

describe('autocommit-only statements (migration-bundles.md §5)', () => {
  it('classifies CONCURRENTLY, VACUUM and REINDEX CONCURRENTLY', () => {
    expect(one('CREATE INDEX CONCURRENTLY i ON public.t (a)').autocommitOnly).toBe(true)
    expect(one('DROP INDEX CONCURRENTLY public.i').autocommitOnly).toBe(true)
    expect(one('REINDEX INDEX CONCURRENTLY public.i').autocommitOnly).toBe(true)
    expect(one('VACUUM public.t').autocommitOnly).toBe(true)
    expect(one('CREATE INDEX i ON public.t (a)').autocommitOnly).toBe(false)
    expect(one('ANALYZE public.t').autocommitOnly).toBe(false)
  })
})

describe('locks, rewrites and compatibility (analysis.md §2, §3)', () => {
  it('follows the rule table', () => {
    const cases: [string, string, string, string][] = [
      ['CREATE INDEX i ON public.t (a)', 'SHARE', 'high', 'additive'],
      ['CREATE INDEX CONCURRENTLY i ON public.t (a)', 'SHARE UPDATE EXCLUSIVE', 'low', 'additive'],
      ['CREATE UNIQUE INDEX i ON public.t (a)', 'SHARE', 'high', 'potentially_breaking'],
      ['ALTER TABLE public.t ADD COLUMN c int', 'ACCESS EXCLUSIVE', 'high', 'additive'],
      [
        'ALTER TABLE public.t ADD COLUMN c timestamptz DEFAULT now()',
        'ACCESS EXCLUSIVE',
        'critical',
        'data_rewrite',
      ],
      [
        'ALTER TABLE public.t ALTER COLUMN c TYPE bigint',
        'ACCESS EXCLUSIVE',
        'critical',
        'data_rewrite',
      ],
      [
        'ALTER TABLE public.t ALTER COLUMN c SET NOT NULL',
        'ACCESS EXCLUSIVE',
        'critical',
        'potentially_breaking',
      ],
      [
        'ALTER TABLE public.t ADD CONSTRAINT k CHECK (c > 0) NOT VALID',
        'ACCESS EXCLUSIVE',
        'high',
        'potentially_breaking',
      ],
      [
        'ALTER TABLE public.t ADD CONSTRAINT k CHECK (c > 0)',
        'ACCESS EXCLUSIVE',
        'critical',
        'potentially_breaking',
      ],
      [
        'ALTER TABLE public.t ADD CONSTRAINT f FOREIGN KEY (a) REFERENCES public.u (id) NOT VALID',
        'SHARE ROW EXCLUSIVE',
        'medium',
        'potentially_breaking',
      ],
      [
        'ALTER TABLE public.t VALIDATE CONSTRAINT k',
        'SHARE UPDATE EXCLUSIVE',
        'low',
        'potentially_breaking',
      ],
      [
        'ALTER TABLE public.t ENABLE ROW LEVEL SECURITY',
        'ACCESS EXCLUSIVE',
        'high',
        'potentially_breaking',
      ],
      [
        'CREATE POLICY p ON public.t FOR SELECT USING (true)',
        'ACCESS EXCLUSIVE',
        'high',
        'additive',
      ],
      ['ALTER TABLE public.t DROP COLUMN c', 'ACCESS EXCLUSIVE', 'high', 'destructive'],
      ['DROP TABLE public.t', 'ACCESS EXCLUSIVE', 'high', 'destructive'],
      ['VACUUM FULL public.t', 'ACCESS EXCLUSIVE', 'critical', 'data_rewrite'],
      ['REFRESH MATERIALIZED VIEW CONCURRENTLY public.m', 'EXCLUSIVE', 'medium', 'data_rewrite'],
      ['TRUNCATE public.t', 'ACCESS EXCLUSIVE', 'high', 'destructive'],
    ]
    for (const [sql, mode, severity, compatibility] of cases) {
      const s = one(sql)
      expect([sql, s.locks[0]?.mode, s.locks[0]?.severity, mostSevere(s.compatibility)]).toEqual([
        sql,
        mode,
        severity,
        compatibility,
      ])
    }
  })

  it('never calls an unclassified statement safe', () => {
    for (const sql of [
      'DO $$ BEGIN PERFORM 1; END $$',
      'CALL public.p()',
      'SELECT public.anything()',
      'CREATE CAST (int AS text) WITH INOUT',
      'ALTER TABLE public.t SET ACCESS METHOD heap',
    ]) {
      const s = one(sql)
      expect(mostSevere(s.compatibility), sql).toBe('unknown')
      expect(s.coverage, sql).not.toBe('derived')
    }
    expect(worstSeverity(['low', 'unknown', 'critical'])).toBe('unknown')
  })

  it('marks DO blocks that branch on the catalog as conditional DDL', () => {
    expect(
      one(
        "DO $$ BEGIN IF to_regclass('public.x') IS NULL THEN CREATE TABLE public.x(); END IF; END $$",
      ).conditional,
    ).toBe(true)
    expect(one('DO $$ BEGIN PERFORM 1; END $$').conditional).toBe(false)
  })

  it('records SECURITY DEFINER with and without a pinned search_path', () => {
    const pinned = one(
      "CREATE FUNCTION public.f() RETURNS int LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$ SELECT 1 $$",
    )
    expect(pinned.details).toMatchObject({ securityDefiner: true, searchPathSet: true })
    const open = one(
      'CREATE FUNCTION public.f() RETURNS int LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1 $$',
    )
    expect(open.details).toMatchObject({ securityDefiner: true, searchPathSet: false })
  })
})

describe('structural expectations (verification.md §3)', () => {
  it('derives the shape of a created table, IF NOT EXISTS included', () => {
    const s = one(
      'CREATE TABLE IF NOT EXISTS public.lead (id bigint PRIMARY KEY, name varchar(80) NOT NULL, note text)',
    )
    expect(s.conditionalForm).toBe(true)
    expect(s.coverage).toBe('derived')
    expect(s.expectations).toContainEqual({
      kind: 'column',
      schema: 'public',
      table: 'lead',
      column: 'name',
      present: true,
      type: 'pg_catalog.varchar',
      typmods: '80',
      notNull: true,
      hasDefault: null,
    })
    expect(s.expectations).toContainEqual({
      kind: 'columns_exactly',
      schema: 'public',
      table: 'lead',
      columns: ['id', 'name', 'note'],
    })
  })

  it('derives indexes, constraints, policies, grants, functions, enums and drops', () => {
    const kinds = (sql: string) => one(sql).expectations.map((e: Expectation) => e.kind)
    expect(kinds('CREATE UNIQUE INDEX i ON public.t USING btree (a, b) WHERE c')).toEqual(['index'])
    expect(one('CREATE UNIQUE INDEX i ON public.t (a) WHERE c').expectations[0]).toMatchObject({
      unique: true,
      partial: true,
      keyCount: 1,
      method: 'btree',
    })
    expect(kinds('ALTER TABLE public.t ADD CONSTRAINT k CHECK (a > 0) NOT VALID')).toEqual([
      'constraint',
    ])
    expect(
      one('ALTER TABLE public.t ADD CONSTRAINT k CHECK (a > 0) NOT VALID').expectations[0],
    ).toMatchObject({
      validated: false,
    })
    expect(kinds('CREATE POLICY p ON public.t FOR UPDATE TO app USING (true)')).toEqual(['policy'])
    expect(
      one('CREATE POLICY p ON public.t FOR UPDATE TO app USING (true)').details.policyAlwaysTrue,
    ).toBe(true)
    expect(one('GRANT SELECT, INSERT ON public.t TO app').expectations).toEqual([
      {
        kind: 'table_privilege',
        schema: 'public',
        table: 't',
        grantee: 'app',
        privileges: ['SELECT', 'INSERT'],
        granted: true,
      },
    ])
    expect(one("CREATE TYPE public.mood AS ENUM ('a', 'b')").expectations).toEqual([
      { kind: 'enum_labels', schema: 'public', name: 'mood', labels: ['a', 'b'], exact: true },
    ])
    expect(one('DROP TABLE public.old').expectations).toEqual([
      { kind: 'relation', schema: 'public', name: 'old', relkinds: ['r', 'p'], present: false },
    ])
    expect(
      one('CREATE FUNCTION public.f(a int, b text) RETURNS int LANGUAGE sql AS $$ SELECT 1 $$')
        .expectations[0],
    ).toMatchObject({
      kind: 'function',
      args: ['pg_catalog.int4', '"text"'],
      body: ' SELECT 1 ',
    })
  })

  it('leaves data changes and procedural code underived', () => {
    for (const sql of [
      'UPDATE public.t SET a = 1 WHERE b = 2',
      'DELETE FROM public.t',
      'DO $$ BEGIN END $$',
    ]) {
      expect(one(sql).coverage, sql).toBe('underived')
    }
  })

  it('keeps only the expectations that survive the whole file', () => {
    const s = analyze(
      [
        'ALTER TABLE public.t ADD COLUMN c int;',
        'ALTER TABLE public.t ALTER COLUMN c SET NOT NULL;',
        'CREATE TABLE public.a (id int);',
        'ALTER TABLE public.a RENAME TO b;',
        'CREATE INDEX i ON public.t (c);',
      ].join('\n'),
    )
    const surviving = survivingExpectations(s)
    // The added column's own nullability is superseded by SET NOT NULL; the created
    // table a by its rename; the index on t does not supersede the column of t.
    expect(surviving.map((x) => [x.statement, x.expectation.kind])).toEqual([
      [1, 'not_null'],
      [3, 'relation'],
      [3, 'relation'],
      [4, 'index'],
    ])
  })
})
