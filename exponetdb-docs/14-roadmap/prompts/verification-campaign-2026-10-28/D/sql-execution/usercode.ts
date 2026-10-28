// User code on the read path: does an admitted SELECT make the reader run a tenant's function?
// Each probe has a function that raises 'D2-SENTINEL' (SQLSTATE P0001) so execution is visible as
// QUERY_FAILED P0001 in the product's outcome. Expected per probe: refused (`user_code`) or ran without the sentinel.
//   EXDB_TREE=... EXDB_TEST_TARGETS=... nice bun --conditions @exponetdb/source usercode.ts --out DIR
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const TREE = process.env['EXDB_TREE'] ?? ''
const argv = process.argv
const OUT = argv[argv.indexOf('--out') + 1] ?? '.'
const pgp = await import(`${TREE}/packages/postgres/src/index.ts`)
const kit = await import(`${TREE}/packages/testkit/src/index.ts`)
const exec = await import(`${TREE}/packages/diagnostics/src/data-read/executor.ts`)
const { TargetSession, ROLE_NAMES } = pgp
const targets = kit.testTargets()

const BOOM = (sig: string, ret: string, extra = '') =>
  `CREATE FUNCTION public.${sig} RETURNS ${ret} ${extra} LANGUAGE plpgsql AS $$ BEGIN IF current_user = 'exponetdb_reader' THEN RAISE EXCEPTION 'D2-SENTINEL'; END IF; RETURN NULL; END $$`

interface Probe {
  id: string
  note: string
  setup: string[]
  reads: string[]
  /** 'refuse' = the product must refuse the database or statement; 'run' = it must run and never execute the function */
  expect: 'refuse' | 'run'
  minMajor?: number
}
const probes: Probe[] = [
  { id: 'cast-implicit', note: 'implicit cast of a user enum runs a user function', expect: 'refuse', setup: ["CREATE TYPE public.e AS ENUM ('a')", BOOM('e_text(public.e)', 'text'), 'CREATE CAST (public.e AS text) WITH FUNCTION public.e_text(public.e) AS IMPLICIT', 'CREATE TABLE public.t (c public.e)', "INSERT INTO public.t VALUES ('a')"], reads: ['SELECT lower(c) FROM public.t', 'SELECT count(*) FROM public.t'] },
  { id: 'cast-json', note: 'to_json / row_to_json use a user cast to json', expect: 'refuse', setup: ["CREATE TYPE public.e AS ENUM ('a')", BOOM('e_json(public.e)', 'json'), 'CREATE CAST (public.e AS json) WITH FUNCTION public.e_json(public.e)', 'CREATE TABLE public.t (c public.e)', "INSERT INTO public.t VALUES ('a')"], reads: ['SELECT to_json(c) FROM public.t', 'SELECT row_to_json(t) FROM public.t t', 'SELECT json_agg(t) FROM public.t t', 'SELECT to_jsonb(t) FROM public.t t'] },
  { id: 'index-predicate', note: 'partial index predicate with a constant call is folded by the planner', expect: 'refuse', setup: [BOOM('f(int)', 'int', 'IMMUTABLE'), 'CREATE TABLE public.t (x int)', 'INSERT INTO public.t VALUES (1)', 'CREATE INDEX ON public.t (x) WHERE x > public.f(1)'], reads: ['SELECT count(*) FROM public.t WHERE x = 1'] },
  { id: 'index-expression', note: 'expression index over a column (coarse rule)', expect: 'refuse', setup: [BOOM('f(int)', 'int', 'IMMUTABLE'), 'CREATE TABLE public.t (x int)', 'INSERT INTO public.t VALUES (1)', 'CREATE INDEX ON public.t ((public.f(x)))'], reads: ['SELECT count(*) FROM public.t'] },
  { id: 'ext-statistics', note: 'extended statistics expression', expect: 'refuse', setup: [BOOM('f(int)', 'int', 'IMMUTABLE'), 'CREATE TABLE public.t (x int)', 'INSERT INTO public.t VALUES (1)', 'CREATE STATISTICS public.st ON (public.f(x)), x FROM public.t'], reads: ['SELECT count(*) FROM public.t WHERE x = 1'] },
  { id: 'partition-key', note: 'partition key expression', expect: 'refuse', setup: [BOOM('f(int)', 'int', 'IMMUTABLE'), 'CREATE TABLE public.t (x int) PARTITION BY RANGE ((public.f(x)))'], reads: ['SELECT count(*) FROM public.t'] },
  { id: 'range-subtype-diff', note: 'range type subtype_diff', expect: 'refuse', setup: [BOOM('sd(a float8, b float8)', 'float8', 'IMMUTABLE'), 'CREATE TYPE public.r AS RANGE (subtype = float8, subtype_diff = public.sd)', 'CREATE TABLE public.t (r public.r)', "INSERT INTO public.t SELECT public.r(i, i + 1) FROM generate_series(1, 5) i"], reads: ['SELECT count(*) FROM public.t a, public.t b WHERE a.r && b.r'] },
  { id: 'virtual-generated', note: 'PG18 virtual generated column computes its expression on read', expect: 'refuse', minMajor: 18, setup: [BOOM('f(int)', 'int', 'IMMUTABLE'), 'CREATE TABLE public.t (a int, b int GENERATED ALWAYS AS (public.f(a)) VIRTUAL)', 'INSERT INTO public.t (a) VALUES (1)'], reads: ['SELECT * FROM public.t', 'SELECT b FROM public.t', 'SELECT a FROM public.t', 'SELECT count(*) FROM public.t', 'SELECT row_to_json(t) FROM public.t t'] },
  { id: 'domain-check', note: 'domain CHECK runs on writes only', expect: 'run', setup: [BOOM('f(text)', 'boolean', 'IMMUTABLE'), 'CREATE DOMAIN public.d AS text', 'CREATE TABLE public.t (c public.d)', "INSERT INTO public.t VALUES ('a')", 'ALTER DOMAIN public.d ADD CONSTRAINT dc CHECK (public.f(VALUE) IS NOT FALSE)'], reads: ['SELECT * FROM public.t', 'SELECT count(*) FROM public.t WHERE c = \'a\''] },
  { id: 'check-constraint-children', note: 'CHECK of inheritance children, constraint_exclusion pinned off', expect: 'run', setup: [BOOM('f(int)', 'boolean', 'IMMUTABLE'), 'CREATE TABLE public.p (x int)', 'CREATE TABLE public.c1 () INHERITS (public.p)', 'INSERT INTO public.c1 VALUES (1)', 'ALTER TABLE public.c1 ADD CONSTRAINT k CHECK (public.f(x) IS NOT FALSE) NOT VALID'], reads: ['SELECT * FROM public.p WHERE x = 5', 'SELECT count(*) FROM public.p'] },
  { id: 'default-trigger-policy', note: 'defaults, triggers and RLS policies do not run on a reader (BYPASSRLS) read', expect: 'run', setup: [BOOM('f()', 'int'), 'CREATE TABLE public.t (a int DEFAULT public.f())', 'INSERT INTO public.t VALUES (1)', BOOM('trg()', 'trigger'), 'CREATE TRIGGER tg BEFORE INSERT ON public.t FOR EACH ROW EXECUTE FUNCTION public.trg()', 'ALTER TABLE public.t ENABLE ROW LEVEL SECURITY', 'CREATE POLICY pl ON public.t USING (public.f() = 1)'], reads: ['SELECT * FROM public.t', 'SELECT count(*) FROM public.t'] },
  { id: 'security-invoker-view', note: 'a security_invoker view would run its body as the reader', expect: 'refuse', setup: [BOOM('f()', 'int'), 'CREATE TABLE public.t (a int)', 'CREATE VIEW public.vi WITH (security_invoker = true) AS SELECT public.f() AS x FROM public.t'], reads: ['SELECT * FROM public.vi'] },
]

function open(server: any, database: string) {
  return TargetSession.open({
    endpoint: { host: server.host, port: server.port, tlsServerName: targets.serverName, caPem: targets.caPem },
    database,
    role: 'reader',
    user: ROLE_NAMES.reader,
    password: kit.loginPassword(ROLE_NAMES.reader),
    applicationName: 'exponetdb/d2/usercode',
  })
}

const results: any[] = []
for (const major of [16, 17, 18] as const) {
  const server = kit.serverFor(major)
  await kit.provisionRoles(server, { roles: ROLE_NAMES, cluster: (v: any) => pgp.clusterBootstrapStatements(v), passwords: (v: any) => pgp.passwordStatements(v) })
  for (const p of probes) {
    if ((p.minMajor ?? 0) > major) continue
    const database = await kit.createDatabase(server, 'd2uc')
    try {
      try {
        await kit.runAsSuperuser(server, database, [...pgp.databaseBootstrapStatements(database), ...p.setup])
      } catch (err) {
        results.push({ major, probe: p.id, sql: '(setup)', outcome: 'setup refused by the server', verdict: `n/a: ${(err as any).code ?? ''} ${String((err as Error).message).slice(0, 80)}` })
        continue
      }
      for (const sql of p.reads) {
        const session = await open(server, database)
        try {
          const o = await exec.executeDataRead(session, { kind: 'query', sql, params: [], callerClass: 'agent', maxRows: 50, maxBytes: 1 << 20, statementTimeoutMs: 4000, analyze: false, sensitiveColumns: [], requestId: 'req_01M4S9000000000000000000D3' })
          const executed = o.kind === 'refused' && o.details?.sqlstate === 'P0001'
          const refused = o.kind === 'refused' && o.reason === 'user_code'
          const verdict = executed ? 'FAIL user code ran' : p.expect === 'refuse' ? (refused ? 'ok' : o.kind === 'refused' ? `ok (refused: ${o.reason ?? o.code})` : 'FAIL ran (no refusal)') : o.kind === 'query' ? 'ok' : `unexpected ${o.kind} ${o.code ?? ''}`
          results.push({ major, probe: p.id, sql, outcome: o.kind === 'refused' ? `${o.code}/${o.reason ?? ''}/${o.details?.sqlstate ?? ''}` : o.kind, verdict })
        } finally {
          await session.close()
        }
      }
    } finally {
      await kit.dropDatabase(server, database).catch(() => undefined)
    }
  }
}
writeFileSync(join(OUT, 'usercode.json'), `${JSON.stringify(results, null, 1)}\n`)
for (const r of results) console.log(r.major, r.probe.padEnd(24), r.verdict.padEnd(32), r.sql.slice(0, 50), '=>', r.outcome)
