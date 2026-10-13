import {
  type AccessRole,
  clusterBootstrapStatements,
  databaseBootstrapStatements,
  passwordStatements,
  ROLE_NAMES,
  sql,
  TargetSession,
} from '@exponetdb/postgres'
import {
  createDatabase,
  loginPassword,
  matrix,
  provisionRoles,
  runAsSuperuser,
  superuserClient,
  type TestServer,
  testTargets,
} from '@exponetdb/testkit'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { executeDataRead } from '../src/data-read/executor.ts'
import type { DataReadRequest } from '../src/data-read/outcome.ts'

/**
 * The worker's executor of data reads (Wave 7, ADR-0028, sql-execution-security.md
 * §2, §3, §5) on PostgreSQL 16, 17 and 18 as the real `exponetdb_reader`
 * (`pg_read_all_data`, `BYPASSRLS`): typed values and caps, masking, the RLS
 * annotation, every escape case of §5 and of published incidents, timeouts,
 * a cancel that reaches only its own backend, errors without server text,
 * a redacted EXPLAIN, and a canary value that must never appear where it
 * was masked or redacted. After all of it, nothing in the database changed.
 */
const CANARY = 'canary-7f3a9c1e@example.test'

function open(server: TestServer, database: string, role: AccessRole): Promise<TargetSession> {
  const t = testTargets()
  return TargetSession.open({
    endpoint: { host: server.host, port: server.port, tlsServerName: t.serverName, caPem: t.caPem },
    database,
    role,
    user: ROLE_NAMES[role],
    password: loginPassword(ROLE_NAMES[role]),
    applicationName: `exponetdb/test/${role}`,
  })
}

function request(sqlText: string, overrides: Partial<DataReadRequest> = {}): DataReadRequest {
  return {
    kind: 'query',
    sql: sqlText,
    params: [],
    callerClass: 'agent',
    maxRows: 500,
    maxBytes: 5 * 1024 * 1024,
    statementTimeoutMs: 10_000,
    analyze: false,
    sensitiveColumns: [],
    requestId: 'req_01M4S9000000000000000000AA',
    ...overrides,
  }
}

describe.each(matrix().map((s) => [s.major, s] as const))(
  'data reads on PostgreSQL %i',
  (_, server) => {
    let database = ''

    /** One read on a fresh reader session, as the worker runs it. */
    async function read(
      sqlText: string,
      overrides: Partial<DataReadRequest> = {},
      signal?: AbortSignal,
    ) {
      const session = await open(server, database, 'reader')
      try {
        return await executeDataRead(session, request(sqlText, overrides), signal)
      } finally {
        await session.close()
      }
    }

    beforeAll(async () => {
      await provisionRoles(server, {
        roles: ROLE_NAMES,
        cluster: (v) => clusterBootstrapStatements(v),
        passwords: (v) => passwordStatements(v),
      })
      database = await createDatabase(server, 'exdb_t_dataread')
      await runAsSuperuser(server, database, [
        ...databaseBootstrapStatements(database),
        'CREATE EXTENSION IF NOT EXISTS vector',
        `CREATE TABLE public.accounts (
         id integer PRIMARY KEY, email text, password text, note text, data bytea,
         at timestamptz, big bigint, amount numeric, doc jsonb, flag boolean, embedding vector(3))`,
        `INSERT INTO public.accounts VALUES
         (1, '${CANARY}', 'hunter2', 'short', '\\x0001ff', '2026-10-13 08:00:00.123+00',
          9007199254740993, 12.50, '{"a": [1, 2]}', true, '[0.5,1.5,2.5]'),
         (2, 'b@example.test', 'pw', repeat('x', 20000), NULL, NULL, 7, NULL, NULL, false, NULL),
         (3, 'c@example.test', 'pw', 'three', NULL, NULL, 3, NULL, NULL, NULL, NULL),
         (4, 'd@example.test', 'pw', 'four', NULL, NULL, 4, NULL, NULL, NULL, NULL),
         (5, 'e@example.test', 'pw', 'five', NULL, NULL, 5, NULL, NULL, NULL, NULL)`,
        'CREATE TABLE public.secured (id integer)',
        'ALTER TABLE public.secured ENABLE ROW LEVEL SECURITY',
        'INSERT INTO public.secured VALUES (1)',
        'CREATE SEQUENCE public.s',
        'CREATE VIEW public.v AS SELECT id FROM public.accounts',
        `CREATE FUNCTION public.writer() RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
         AS $$ BEGIN DELETE FROM public.accounts; RETURN 1; END $$`,
      ])
    }, 120_000)

    afterAll(async () => {
      // Nothing a read did changed the database.
      const c = await superuserClient(server, database)
      try {
        expect((await c.query('SELECT count(*)::int AS n FROM public.accounts')).rows[0].n).toBe(5)
        expect(
          (await c.query('SELECT last_value::int AS v, is_called FROM public.s')).rows[0],
        ).toEqual({
          v: 1,
          is_called: false,
        })
      } finally {
        await c.end()
      }
    })

    it('returns typed values with visible caps', async () => {
      const r = await read(
        'SELECT id, big, amount, flag, at, data, doc, note, embedding FROM public.accounts WHERE id <= 2 ORDER BY id',
      )
      expect(r.kind).toBe('query')
      if (r.kind !== 'query') return
      expect(r.columns.map((c) => [c.name, c.type])).toEqual([
        ['id', 'integer'],
        ['big', 'bigint'],
        ['amount', 'numeric'],
        ['flag', 'boolean'],
        ['at', 'timestamp with time zone'],
        ['data', 'bytea'],
        ['doc', 'jsonb'],
        ['note', 'text'],
        // Sessions run with an empty search_path: an extension's type is shown qualified.
        ['embedding', 'public.vector'],
      ])
      expect(r.rows[0]).toEqual([
        1,
        '9007199254740993',
        '12.50',
        true,
        '2026-10-13T08:00:00.123Z',
        { hex: '0001ff', bytes: 3 },
        { a: [1, 2] },
        'short',
        { dimension: 3, head: [0.5, 1.5, 2.5] },
      ])
      expect(r.rows[1]?.[7]).toEqual({
        value: 'x'.repeat(10_000),
        truncatedAt: 10_000,
        length: 20_000,
      })
      expect(r).toMatchObject({ rowCount: 2, truncated: false, truncation: null, rlsRelations: [] })
    })

    it('caps rows and bytes, never silently', async () => {
      const rows = await read('SELECT id FROM public.accounts ORDER BY id', { maxRows: 2 })
      expect(rows).toMatchObject({
        rowCount: 2,
        truncated: true,
        truncation: { reason: 'rows', cap: 2 },
      })
      const bytes = await read('SELECT id, note FROM public.accounts ORDER BY id', {
        maxBytes: 200,
      })
      expect(bytes).toMatchObject({ truncated: true, truncation: { reason: 'bytes', cap: 200 } })
      const none = await read("SELECT repeat('y', 5000) AS big", { maxBytes: 100 })
      expect(none).toEqual({
        kind: 'refused',
        code: 'QUERY_RESULT_TOO_LARGE',
        details: { cap: { kind: 'bytes', limit: 100 } },
      })
    })

    it('masks sensitive columns, also through expressions over their table, and names RLS relations', async () => {
      const patterns = ['public.accounts.password', '*.*.email']
      const r = await read(
        'SELECT id, email, password, upper(email) AS shout FROM public.accounts WHERE id = 1',
        {
          sensitiveColumns: patterns,
        },
      )
      expect(r.kind).toBe('query')
      if (r.kind !== 'query') return
      expect(r.columns.map((c) => [c.name, c.masked])).toEqual([
        ['id', false],
        ['email', true],
        ['password', true],
        ['shout', true],
      ])
      expect(r.rows).toEqual([[1, null, null, null]])
      expect(JSON.stringify(r)).not.toContain('canary')
      const rls = await read('SELECT id FROM public.secured')
      expect(rls).toMatchObject({ rowCount: 1, rlsRelations: ['public.secured'] })
    })

    const escapes: [string, string][] = [
      ['SET TRANSACTION READ WRITE', 'transaction control first'],
      ['WITH x AS (DELETE FROM public.accounts RETURNING *) SELECT * FROM x', 'data-modifying CTE'],
      ['SELECT pg_advisory_lock(1)', 'advisory lock'],
      ["SELECT dblink_exec('dbname=postgres', 'DROP TABLE public.accounts')", 'dblink_exec'],
      ["SELECT nextval('public.s')", 'nextval'],
      ['SELECT public.writer()', 'SECURITY DEFINER writer'],
      ['SELECT * FROM public.writer()', 'a writer in FROM'],
      ["COPY public.accounts TO PROGRAM 'id'", 'COPY TO PROGRAM'],
      ['SELECT pg_sleep(1000000)', 'pg_sleep'],
      ['SELECT 1; DROP TABLE public.accounts', 'second statement'],
      ['COMMIT; DELETE FROM public.accounts', 'COMMIT then a write (published incident)'],
      ["SELECT pg_read_file('/etc/passwd')", 'pg_read_file'],
      ["SELECT pg_ls_dir('.')", 'pg_ls_dir'],
      ["SELECT pg_stat_file('postgresql.conf')", 'pg_stat_file'],
      ['SELECT lo_import(1)', 'lo_import'],
      ['SELECT lo_get(1)', 'lo_get'],
      ["SELECT set_config('statement_timeout', '0', false)", 'set_config'],
      ['SELECT pg_terminate_backend(1)', 'pg_terminate_backend'],
      [
        "SELECT query_to_xml('DELETE FROM public.accounts RETURNING 1', true, true, '')",
        'query_to_xml',
      ],
      ["SELECT query_to_xmlschema('SELECT 1', true, true, '')", 'query_to_xmlschema'],
      ["SELECT cursor_to_xml('c', 1, true, true, '')", 'cursor_to_xml'],
      ["SELECT table_to_xml('public.accounts', true, true, '')", 'table_to_xml'],
      ["SELECT schema_to_xml('public', true, true, '')", 'schema_to_xml'],
      ["SELECT database_to_xml(true, true, '')", 'database_to_xml'],
      ['SELECT * FROM public.accounts FOR UPDATE', 'row lock'],
      ['SELECT id FROM public.v', 'a view'],
    ]

    it.each(escapes)('refuses %s (%s)', async (statement) => {
      const r = await read(statement)
      expect(r.kind, statement).toBe('refused')
      if (r.kind === 'refused') {
        expect([
          'QUERY_NOT_READ_ONLY',
          'QUERY_CONSTRUCT_UNSUPPORTED',
          'QUERY_PARSE_ERROR',
        ]).toContain(r.code)
      }
    })

    it('contains comment and dollar-quote tricks as the single read they are', async () => {
      const r = await read('SELECT 1 AS one /* ; DROP TABLE public.accounts */')
      expect(r).toMatchObject({ kind: 'query', rows: [[1]] })
      const quoted = await read('SELECT $$;DELETE FROM public.accounts$$ AS text')
      expect(quoted).toMatchObject({ kind: 'query', rows: [[';DELETE FROM public.accounts']] })
    })

    it('refuses EXPLAIN ANALYZE to an agent and through sql_query; a person gets measured rows', async () => {
      expect(
        await read('SELECT count(*) FROM public.accounts', { kind: 'explain', analyze: true }),
      ).toEqual({
        kind: 'refused',
        code: 'QUERY_NOT_READ_ONLY',
        reason: 'explain_analyze',
      })
      const viaQuery = await read('EXPLAIN SELECT 1')
      expect(viaQuery).toMatchObject({ kind: 'refused', code: 'QUERY_CONSTRUCT_UNSUPPORTED' })
      const human = await read('SELECT count(*) FROM public.accounts', {
        kind: 'explain',
        analyze: true,
        callerClass: 'human',
      })
      expect(human).toMatchObject({ kind: 'explain', summary: { actualRows: 1 } })
    })

    it('redacts the constants of an EXPLAIN plan', async () => {
      const r = await read(`SELECT id FROM public.accounts WHERE email = '${CANARY}' AND id > 3`, {
        kind: 'explain',
      })
      expect(r.kind).toBe('explain')
      expect(JSON.stringify(r)).not.toContain('canary')
      expect(JSON.stringify(r)).toContain("'?'")
      if (r.kind === 'explain') expect(r.summary.sequentialScans.length).toBeGreaterThanOrEqual(0)
    })

    it('answers a runtime error by its SQLSTATE only, and a timeout as QUERY_TIMEOUT', async () => {
      expect(await read('SELECT 1 / 0 AS boom')).toEqual({
        kind: 'refused',
        code: 'QUERY_FAILED',
        details: { sqlstate: '22012' },
      })
      expect(await read("SELECT 'not a number'::integer AS n")).toEqual({
        kind: 'refused',
        code: 'QUERY_FAILED',
        details: { sqlstate: '22P02' },
      })
      const slow = await read('SELECT count(*) FROM generate_series(1, 200000000) a', {
        statementTimeoutMs: 200,
      })
      expect(slow).toEqual({ kind: 'refused', code: 'QUERY_TIMEOUT' })
    })

    it('keeps every limit local to its transaction (no setting leaks into the next read)', async () => {
      const session = await open(server, database, 'reader')
      try {
        const before = (await session.query(sql`SHOW statement_timeout`))[0]?.text(
          'statement_timeout',
        )
        await executeDataRead(session, request('SELECT 1', { statementTimeoutMs: 1234 }))
        const after = (await session.query(sql`SHOW statement_timeout`))[0]?.text(
          'statement_timeout',
        )
        expect(after).toBe(before)
        const name = (await session.query(sql`SHOW application_name`))[0]?.text('application_name')
        expect(name).toBe('exponetdb/test/reader')
      } finally {
        await session.close()
      }
    })

    it('cancels exactly its own backend, while another read goes on', async () => {
      const controller = new AbortController()
      const heavy = 'SELECT count(*) FROM generate_series(1, 300000000) a'
      const victim = read(heavy, { requestId: 'req_01M4S9000000000000000000AB' }, controller.signal)
      const bystander = read('SELECT count(*) FROM generate_series(1, 20000000) b', {
        requestId: 'req_01M4S9000000000000000000AC',
      })
      // Wait until the victim runs under its query's application name.
      const watcher = await superuserClient(server, database)
      try {
        for (let i = 0; i < 100; i++) {
          const seen = await watcher.query(
            "SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = 'exponetdb/query/req_01M4S9000000000000000000AB' AND state = 'active'",
          )
          if (seen.rows[0].n === 1) break
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
      } finally {
        await watcher.end()
      }
      controller.abort()
      expect(await victim).toEqual({ kind: 'refused', code: 'QUERY_CANCELED' })
      expect(await bystander).toMatchObject({ kind: 'query', rows: [[20000000]] })
    }, 60_000)
  },
)
