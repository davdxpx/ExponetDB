// D2 verification: sql_query / sql_explain must not write or leave the read-only frame.
//
//   export EXDB_TREE=/path/to/worktree-at-d51da5d0          # the tree under test (read only)
//   export EXDB_TEST_TARGETS=/path/to/targets.json          # tooling/dev/targets.sh output (TLS servers 16/17/18)
//   nice bun --conditions @exponetdb/source run.ts [--majors 16,17,18] [--section corpus|limits|sweep|all] [--out DIR]
//
// Per corpus statement and PostgreSQL major it runs, and records the layer that stopped it:
//   guard   admitRead (the pure parser admission) + classifySql (what the Web editor shows)
//   e2e     executeDataRead on a real exponetdb_reader session = what the worker runs for query.run / query.explain
//   R       the statement WITHOUT the guard, as exponetdb_reader, in the product's read-only frame (extended protocol)
//   S       the same, as the superuser (frame only, no role limit)
//   Ss      superuser in the frame over the SIMPLE protocol (multi-statement text; tx/multi classes)
//   R0      reader, no frame, simple protocol (what the role alone prevents; tx/multi/write/func/file/copy/proc/lock)
// After every run a superuser snapshot of the fixture is compared with the one before (rows, log table, sequence,
// large objects, catalog, roles, role settings, advisory locks, prepared xacts, notifications, marker files).
// Raw results go to --out (default: ./out, keep it out of git); results.md is built by report.ts from them.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const TREE = process.env['EXDB_TREE'] ?? ''
if (TREE === '' || process.env['EXDB_TEST_TARGETS'] === undefined) {
  throw new Error('set EXDB_TREE and EXDB_TEST_TARGETS (see the header of run.ts)')
}
const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] !== undefined ? (process.argv[i + 1] as string) : fallback
}
const MAJORS = arg('majors', '16,17,18').split(',').map(Number)
const SECTION = arg('section', 'all')
const OUT = arg('out', join(import.meta.dir, 'out'))
const FILTER = arg('filter', '')
mkdirSync(OUT, { recursive: true })

const here = import.meta.dir
const req = createRequire(`${TREE}/packages/postgres/package.json`)
const pg = req('pg') as typeof import('pg')
const pgp = await import(`${TREE}/packages/postgres/src/index.ts`)
const parser = await import(`${TREE}/packages/postgres/src/parser/index.ts`)
const kit = await import(`${TREE}/packages/testkit/src/index.ts`)
const exec = await import(`${TREE}/packages/diagnostics/src/data-read/executor.ts`)
const outcome = await import(`${TREE}/packages/diagnostics/src/data-read/outcome.ts`)
const classification = await import(`${TREE}/packages/diagnostics/src/sql-classification.ts`)
const { TargetSession, ROLE_NAMES } = pgp
const { admitRead } = parser
const { executeDataRead } = exec
const { dataReadText } = outcome

interface Entry {
  id: string
  class: string
  kind: 'query' | 'explain'
  sql: string
  expected: 'REFUSED_BY_GUARD' | 'RUNS_READ_ONLY' | 'BLOCKED_BY_SERVER_ROLE'
  analyze?: boolean
  callerClass?: 'agent' | 'human'
  gen?: { prefix: string; unit: string; count: number }
}
const corpus: Entry[] = readFileSync(join(here, 'corpus.jsonl'), 'utf8')
  .split('\n')
  .filter((l) => l.length > 0)
  .map((l) => JSON.parse(l) as Entry)
  .filter((e) => FILTER === '' || FILTER.split(',').some((p) => e.id.startsWith(p)))
const sqlOf = (e: Entry): string =>
  e.gen === undefined ? e.sql : e.gen.prefix + e.gen.unit.repeat(e.gen.count)

const FIXTURE = [
  'CREATE EXTENSION IF NOT EXISTS dblink',
  'CREATE EXTENSION IF NOT EXISTS postgres_fdw',
  'CREATE EXTENSION IF NOT EXISTS file_fdw',
  'CREATE TABLE public.accounts (id int PRIMARY KEY, email text, note text)',
  "INSERT INTO public.accounts VALUES (1,'a@example.test','one'),(2,'b@example.test','two'),(3,'c@example.test','three'),(4,'d@example.test','four'),(5,'e@example.test','five')",
  'CREATE TABLE public.sidefx_log (n int)',
  'CREATE SEQUENCE public.s',
  'CREATE VIEW public.v AS SELECT id FROM public.accounts',
  "CREATE VIEW public.v_nextval AS SELECT nextval('public.s') AS n",
  'CREATE VIEW public.v_advisory AS SELECT pg_advisory_lock(424242) IS NULL AS l',
  'CREATE VIEW public.v_sleep AS SELECT pg_sleep(0.01) IS NULL AS s',
  'CREATE MATERIALIZED VIEW public.mv_accounts AS SELECT * FROM public.accounts',
  'CREATE FUNCTION public.writer() RETURNS integer LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN INSERT INTO public.sidefx_log VALUES (1); RETURN 1; END $$',
  'CREATE SCHEMA shadow',
  "CREATE FUNCTION shadow.lower(text) RETURNS text LANGUAGE plpgsql AS $$ BEGIN INSERT INTO public.sidefx_log VALUES (2); RETURN 'shadowed'; END $$",
  "CREATE FUNCTION public.lower(text) RETURNS text LANGUAGE plpgsql AS $$ BEGIN INSERT INTO public.sidefx_log VALUES (3); RETURN 'shadowed'; END $$",
  'CREATE FUNCTION public.d2_plus(int, int) RETURNS int LANGUAGE plpgsql AS $$ BEGIN INSERT INTO public.sidefx_log VALUES (4); RETURN 0; END $$',
  'CREATE OPERATOR public.+ (LEFTARG = int, RIGHTARG = int, FUNCTION = public.d2_plus)',
  'CREATE OPERATOR shadow.+ (LEFTARG = int, RIGHTARG = int, FUNCTION = public.d2_plus)',
  "CREATE TYPE public.d2_type AS ENUM ('a')",
  'CREATE DOMAIN public.d2_dom AS text',
  'CREATE PROCEDURE public.d2_proc() LANGUAGE plpgsql AS $$ BEGIN INSERT INTO public.sidefx_log VALUES (5); END $$',
  'CREATE SERVER fs FOREIGN DATA WRAPPER file_fdw',
  "CREATE FOREIGN TABLE public.ft_passwd (line text) SERVER fs OPTIONS (filename '/etc/passwd', format 'text', delimiter E'\\x01')",
  "CREATE SERVER loop FOREIGN DATA WRAPPER postgres_fdw OPTIONS (host '127.0.0.1', dbname 'postgres')",
  "CREATE FOREIGN TABLE public.ft_loop (id int) SERVER loop OPTIONS (table_name 'x')",
  'CREATE TABLE public.part_parent (id int) PARTITION BY RANGE (id)',
  'CREATE FOREIGN TABLE public.part_child PARTITION OF public.part_parent FOR VALUES FROM (0) TO (10) SERVER loop',
]

const STATE_SQL = `SELECT json_build_object(
  'accounts', (SELECT md5(coalesce(string_agg(a::text, ',' ORDER BY id), '')) FROM public.accounts a),
  'log', (SELECT count(*) FROM public.sidefx_log),
  'seq', (SELECT last_value::text || ':' || is_called::text FROM public.s),
  'lo', (SELECT count(*) FROM pg_largeobject_metadata),
  'catalog', (SELECT md5(string_agg(x, ',' ORDER BY x)) FROM (
      SELECT 'rel:' || n.nspname || '.' || c.relname || ':' || c.relkind::text || ':' || c.relnatts::text AS x FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema'
      UNION ALL SELECT 'fn:' || p.oid::text || p.proname FROM pg_proc p WHERE p.oid >= 16384
      UNION ALL SELECT 'ns:' || nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema') t),
  'roles', (SELECT md5(string_agg(r::text, ',' ORDER BY oid)) FROM pg_roles r),
  'role_settings', (SELECT md5(coalesce(string_agg(setrole::text || ':' || setdatabase::text || ':' || setconfig::text, ',' ORDER BY setrole, setdatabase), '')) FROM pg_db_role_setting),
  'memberships', (SELECT md5(coalesce(string_agg(m::text, ',' ORDER BY oid), '')) FROM pg_auth_members m),
  'advisory_locks', (SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND pid <> pg_backend_pid()),
  'prepared_xacts', (SELECT count(*) FROM pg_prepared_xacts),
  'extensions', (SELECT md5(string_agg(extname, ',' ORDER BY extname)) FROM pg_extension)
)::text AS s`

interface Ctx {
  major: 16 | 17 | 18
  server: { host: string; port: number; container?: string }
  database: string
  su: import('pg').Client // superuser, state checks (database)
  listener: import('pg').Client
  notified: number
  terminated?: boolean
  baseline: Record<string, unknown>
  dropList: string[]
}

const targets = kit.testTargets()
const sslConfig = kit.testTls()

function rawClient(ctx: Ctx, user: string, password: string, extraOptions = '') {
  const reader = user === ROLE_NAMES.reader
  const options = [
    'search_path=',
    'TimeZone=UTC',
    'DateStyle=ISO,YMD',
    'IntervalStyle=postgres',
    'extra_float_digits=1',
    'bytea_output=hex',
    'standard_conforming_strings=on',
    'quote_all_identifiers=off',
    'lc_monetary=C',
    'statement_timeout=4000',
    'lock_timeout=1000',
    'idle_in_transaction_session_timeout=30000',
    `default_transaction_read_only=${reader ? 'on' : 'off'}`,
    ...(reader ? ['constraint_exclusion=off'] : []),
  ]
    .map((s) => `-c ${s}`)
    .join(' ')
  const c = new pg.Client({
    host: ctx.server.host,
    port: ctx.server.port,
    user,
    password,
    database: ctx.database,
    ssl: sslConfig,
    options: `${options} ${extraOptions}`.trim(),
    connectionTimeoutMillis: 10_000,
  })
  c.on('error', () => undefined)
  return c
}

type Raw = { ok: true; rows: number } | { ok: false; sqlstate: string; message: string }

/** Runs `text` as the product's read-only frame does (BEGIN ... READ ONLY, SELECT 1, SET LOCAL) or bare. */
async function rawRun(
  c: import('pg').Client,
  text: string,
  mode: { frame: boolean; simple: boolean },
): Promise<Raw> {
  try {
    await c.connect()
    if (mode.frame) {
      await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
      await c.query('SELECT 1')
      await c.query("SELECT pg_catalog.set_config('statement_timeout', '4000ms', true)")
    }
    const r = (await c.query(
      (mode.simple ? { text } : { text, values: [], queryMode: 'extended' }) as never,
    )) as import('pg').QueryResult | import('pg').QueryResult[]
    const last = Array.isArray(r) ? r[r.length - 1] : r
    return { ok: true, rows: last?.rowCount ?? 0 }
  } catch (e) {
    const err = e as { code?: string; message?: string }
    return { ok: false, sqlstate: err.code ?? 'client', message: String(err.message ?? '').slice(0, 160) }
  } finally {
    if (mode.frame) await c.query('ROLLBACK').catch(() => undefined)
    await c.end().catch(() => undefined)
  }
}

/** A statement run as the superuser can end this checker's own session (pg_terminate_backend): reconnect and say so. */
async function snapshot(ctx: Ctx): Promise<Record<string, unknown>> {
  let r: import('pg').QueryResult | undefined
  for (let attempt = 0; attempt < 5 && r === undefined; attempt++) {
    try {
      r = await ctx.su.query(STATE_SQL)
    } catch {
      ctx.terminated = true
      await new Promise((res) => setTimeout(res, 500))
      ctx.su = await kit.superuserClient(ctx.server, ctx.database).catch(() => ctx.su)
      ctx.listener = await kit.superuserClient(ctx.server, 'postgres').catch(() => ctx.listener)
      await ctx.listener.query('LISTEN d2').catch(() => undefined)
      ctx.listener.on('notification', () => {
        ctx.notified += 1
      })
    }
  }
  if (r === undefined) throw new Error('the checker cannot reconnect')
  const s = JSON.parse(r.rows[0].s) as Record<string, unknown>
  s['notified'] = ctx.notified
  return s
}

async function markers(ctx: Ctx): Promise<number> {
  if (ctx.server.container === undefined) return 0
  const { spawnSync } = await import('node:child_process')
  const r = spawnSync('docker', ['exec', ctx.server.container, 'sh', '-c', 'ls /tmp | grep -c "^d2-marker" ; rm -f /tmp/d2-marker*'], { encoding: 'utf8' })
  return Number.parseInt(r.stdout.trim().split('\n')[0] ?? '0', 10) || 0
}

async function newDatabase(ctx: Ctx): Promise<void> {
  const database = await kit.createDatabase(ctx.server, 'd2')
  await kit.runAsSuperuser(ctx.server, database, [
    ...pgp.databaseBootstrapStatements(database),
    ...FIXTURE,
  ])
  ctx.dropList.push(database)
  ctx.database = database
  await ctx.su.end().catch(() => undefined)
  ctx.su = await kit.superuserClient(ctx.server, database)
  ctx.baseline = await snapshot(ctx)
}

/** Compares the state with the baseline; on a change, reports it and starts from a fresh fixture database. */
async function effects(ctx: Ctx, checkMarkers = true): Promise<string[]> {
  const now = await snapshot(ctx)
  const changed = Object.keys(now).filter((k) => JSON.stringify(now[k]) !== JSON.stringify(ctx.baseline[k]))
  const m = checkMarkers ? await markers(ctx) : 0
  if (m > 0) changed.push(`marker_files:${m}`)
  if (ctx.terminated === true) {
    changed.push('other_sessions_terminated')
    ctx.terminated = false
  }
  if (changed.length > 0) {
    const notified = ctx.notified
    await newDatabase(ctx)
    ctx.notified = notified
    ctx.baseline = await snapshot(ctx)
  }
  return changed
}

function openReader(ctx: Ctx) {
  return TargetSession.open({
    endpoint: { host: ctx.server.host, port: ctx.server.port, tlsServerName: targets.serverName, caPem: targets.caPem },
    database: ctx.database,
    role: 'reader',
    user: ROLE_NAMES.reader,
    password: kit.loginPassword(ROLE_NAMES.reader),
    applicationName: 'exponetdb/d2/reader',
  })
}

const GUARD_CODES = new Set(['QUERY_NOT_READ_ONLY', 'QUERY_CONSTRUCT_UNSUPPORTED', 'QUERY_PARSE_ERROR'])

async function e2e(ctx: Ctx, e: Entry, timeoutMs: number, maxRows = 500, signal?: AbortSignal) {
  const session = await openReader(ctx)
  const started = Date.now()
  try {
    const o = await executeDataRead(
      session,
      {
        kind: e.kind,
        sql: sqlOf(e),
        params: [],
        callerClass: e.callerClass ?? 'agent',
        maxRows,
        maxBytes: 5 * 1024 * 1024,
        statementTimeoutMs: timeoutMs,
        analyze: e.analyze ?? false,
        sensitiveColumns: [],
        requestId: 'req_01M4S9000000000000000000D2',
      },
      signal,
    )
    return { o, ms: Date.now() - started }
  } finally {
    await session.close().catch(() => undefined)
  }
}

function slimOutcome(o: any) {
  if (o.kind === 'refused') {
    return { kind: 'refused', code: o.code, reason: o.reason ?? null, sqlstate: o.details?.sqlstate ?? null, construct: o.details?.construct ?? null }
  }
  if (o.kind === 'query') return { kind: 'query', rows: o.rowCount, truncated: o.truncated, truncation: o.truncation, columns: o.columns.length }
  return { kind: 'explain', cost: o.summary?.totalCost ?? null }
}

const BAD_TEXT = [/127\.0\.0\.1/, /\/var\/lib\/postgresql/, /postgres(ql)?:\/\//i, /d2-pg\d\d/, /pg\.exdb\.test/, /sslmode/i, /password=/i, /exponetdb_reader/, /\/etc\/passwd/]
function leaks(o: unknown): string[] {
  const t = JSON.stringify(o)
  return BAD_TEXT.filter((re) => re.test(t)).map((re) => re.source)
}

async function runCorpus(ctx: Ctx): Promise<void> {
  const out = join(OUT, `corpus-pg${ctx.major}.jsonl`)
  const done = new Set<string>()
  if (existsSync(out)) {
    for (const l of readFileSync(out, 'utf8').split('\n').filter(Boolean)) done.add((JSON.parse(l) as { id: string }).id)
  } else writeFileSync(out, '')
  const rootPass = kit.loginPassword(ROLE_NAMES.reader)
  const suPass = targets.superuserPassword
  for (const e of corpus) {
    if (done.has(e.id)) continue
    if (e.class === 'limit') continue // resource-limit statements run in limits.ts (container memory limit, reconnects)
    const text = sqlOf(e)
    const heavy = false
    const rec: Record<string, unknown> = { id: e.id, class: e.class, major: ctx.major, expected: e.expected }
    // guard: the pure admission, and what the Web editor's classifier says
    const g = await admitRead(ctx.major, dataReadText(e.kind, text, e.analyze ?? false))
    rec['guard'] = g.ok ? { ok: true, cls: g.statementClass, analyze: g.analyze } : { ok: false, code: g.code, reason: g.reason }
    if (e.kind === 'query' && e.gen === undefined) {
      try {
        const c = await classification.classifySql(ctx.major, text, { maxStatements: 200 })
        rec['classify'] =
          c.kind === 'classified'
            ? { admitted: c.result.readOnlyPath?.admitted ?? null, classes: [...new Set(c.result.statements.flatMap((s: any) => s.classes))] }
            : { kind: c.kind }
      } catch (err) {
        rec['classify'] = { error: String(err).slice(0, 80) }
      }
    }
    // e2e through the worker's executor on a real reader session
    try {
      const { o, ms } = await e2e(ctx, e, heavy ? 2500 : 4000)
      rec['e2e'] = { ...slimOutcome(o), ms, leaks: leaks(o) }
    } catch (err) {
      rec['e2e'] = { kind: 'throw', error: String(err).slice(0, 120) }
    }
    const mk = e.class === 'copy' || e.class === 'file' || e.class === 'proc'
    rec['fx_e2e'] = await effects(ctx, mk)
    if (!heavy) {
      const bareClass = new Set(['tx', 'multi', 'write', 'func', 'file', 'copy', 'proc', 'lock'])
      const modes: [string, string, { frame: boolean; simple: boolean }, string][] = [
        ['R', ROLE_NAMES.reader, { frame: true, simple: false }, rootPass],
        ['S', 'postgres', { frame: true, simple: false }, suPass],
      ]
      if (e.class === 'tx' || e.class === 'multi') modes.push(['Ss', 'postgres', { frame: true, simple: true }, suPass])
      if (bareClass.has(e.class)) modes.push(['R0', ROLE_NAMES.reader, { frame: false, simple: true }, rootPass])
      for (const [name, user, mode, password] of modes) {
        const c = rawClient(ctx, user, password)
        rec[name] = e.kind === 'explain' ? { skipped: 'explain kind' } : await rawRun(c, text, mode)
        rec[`fx_${name}`] = await effects(ctx, mk)
      }
    }
    appendFileSync(out, `${JSON.stringify(rec)}\n`)
  }
}

async function main(): Promise<void> {
  await kit.runAsSuperuser // ensure import
  const ctxs: Ctx[] = []
  for (const major of MAJORS as (16 | 17 | 18)[]) {
    const server = kit.serverFor(major)
    await kit.provisionRoles(server, {
      roles: ROLE_NAMES,
      cluster: (v: any) => pgp.clusterBootstrapStatements(v),
      passwords: (v: any) => pgp.passwordStatements(v),
    })
    const su = await kit.superuserClient(server, 'postgres')
    const listener = await kit.superuserClient(server, 'postgres')
    const ctx: Ctx = { major, server, database: '', su, listener, notified: 0, baseline: {}, dropList: [] }
    await listener.query('LISTEN d2')
    listener.on('notification', () => {
      ctx.notified += 1
    })
    await newDatabase(ctx)
    ctxs.push(ctx)
  }
  if (SECTION === 'corpus' || SECTION === 'all') {
    await Promise.all(ctxs.map((c) => runCorpus(c)))
  }
  if (SECTION === 'limits' || SECTION === 'all') {
    const { runLimits } = await import('./limits.ts')
    for (const c of ctxs) await runLimits(c, { kit, pgp, e2e, rawClient, rawRun, effects, OUT, executeDataRead, openReader, slimOutcome, leaks })
  }
  if (SECTION === 'sweep' || SECTION === 'all') {
    const { runSweep } = await import('./sweep.ts')
    for (const c of ctxs) await runSweep(c, { kit, pgp, rawClient, rawRun, parser, OUT, e2e })
  }
  for (const c of ctxs) {
    await c.su.end().catch(() => undefined)
    await c.listener.end().catch(() => undefined)
    for (const d of c.dropList) await kit.dropDatabase(c.server, d).catch(() => undefined)
  }
}

await main()
