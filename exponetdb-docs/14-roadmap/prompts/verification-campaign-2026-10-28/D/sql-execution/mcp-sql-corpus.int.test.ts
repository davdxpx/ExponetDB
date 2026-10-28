import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import type { Scope } from '@exponetdb/contracts'
import { runAsSuperuser, serverFor, superuserClient } from '@exponetdb/testkit'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { McpCaller, type McpWorld, mcpWorld } from './support/mcp-int-world.ts'

/**
 * D2: the whole corpus through the real program: `sql_query` / `sql_explain` over /mcp (an agent) and
 * `POST /api/v1/targets/{target}/queries` / `/explain` (a person: the CLI and the Web SQL editor call
 * these routes), with the sealed lane and the worker's reader session on a real PostgreSQL 17 target.
 * Copy into apps/server/test/ of a worktree, then:
 *   D2_OUT=<dir> EXDB_TEST_PG_URL=... EXDB_TEST_TARGETS=... EXDB_TEST_S3_*=... \
 *   bunx vitest run --config vitest.integration.config.ts test/mcp-sql-corpus.int.test.ts
 * Nothing may change in the staging database; every refusal must be a refusal, not a result.
 */
const OUT = process.env['D2_OUT'] ?? '.'
const READ: Scope[] = ['targets.read', 'schema.read', 'diagnostics.read']
const pg17 = serverFor(17)
const CORPUS = process.env['D2_CORPUS'] ?? `${__dirname}/corpus.jsonl`

interface Entry {
  id: string
  class: string
  kind: 'query' | 'explain'
  sql: string
  expected: string
  analyze?: boolean
  callerClass?: 'agent' | 'human'
  gen?: { prefix: string; unit: string; count: number }
}
const entries: Entry[] = readFileSync(CORPUS, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l) as Entry)
  .filter((e) => e.class !== 'limit')
  // D2_STRIDE=n takes every n-th statement of each class (the real program is slow: every call is audited)
  .filter((e, _i, all) => {
    const stride = Number(process.env['D2_STRIDE'] ?? '1')
    const same = all.filter((x) => x.class === e.class)
    return same.indexOf(e) % stride === 0
  })
const sqlOf = (e: Entry) => (e.gen ? e.gen.prefix + e.gen.unit.repeat(e.gen.count) : e.sql)

const FIXTURE = [
  'CREATE SEQUENCE public.s',
  'CREATE TABLE public.sidefx_log (n int)',
  "CREATE FUNCTION public.writer() RETURNS integer LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN INSERT INTO public.sidefx_log VALUES (1); RETURN 1; END $$",
  'CREATE VIEW public.v AS SELECT id FROM public.accounts',
  'CREATE VIEW public.v_nextval AS SELECT nextval(\'public.s\') AS n',
]

let w: McpWorld
let agent: McpCaller
let cliToken: string
let database = ''

async function state(): Promise<string> {
  const c = await superuserClient(pg17, database)
  try {
    const r = await c.query(`SELECT json_build_object(
      'accounts', (SELECT md5(string_agg(a::text, ',' ORDER BY id)) FROM public.accounts a),
      'log', (SELECT count(*) FROM public.sidefx_log),
      'seq', (SELECT last_value::text || ':' || is_called::text FROM public.s),
      'lo', (SELECT count(*) FROM pg_largeobject_metadata),
      'objects', (SELECT md5(string_agg(c.relname || c.relkind::text, ',' ORDER BY c.relname)) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public'),
      'roles', (SELECT md5(string_agg(r::text, ',' ORDER BY oid)) FROM pg_roles r),
      'advisory', (SELECT count(*) FROM pg_locks WHERE locktype = 'advisory')
    )::text AS s`)
    return String(r.rows[0].s)
  } finally {
    await c.end()
  }
}

beforeAll(async () => {
  w = await mcpWorld('exdb_it_d2_sql')
  const clientId = await w.mcpClient('D2 Agent')
  agent = new McpCaller(
    w.app,
    (await w.mcpToken(clientId, [...READ, 'data.read:nonprod'], ['nonprod'])).access_token,
  )
  cliToken = await w.apiToken(['targets.read', 'data.read:nonprod', 'data.read:prod'], ['nonprod', 'prod'])
  database = w.ids.stagingDatabase
  await runAsSuperuser(pg17, database, [
    "INSERT INTO public.accounts (id, owner_id, note) VALUES (1, NULL, 'one'), (2, NULL, 'two')",
    ...FIXTURE,
  ])
}, 300_000)

afterAll(async () => {
  await w?.stop()
})

describe('the corpus through /mcp and REST', () => {
  it('refuses or contains every statement; the target does not change', async () => {
    const target = w.ids.stagingTarget
    const file = `${OUT}/mcp-rest-results.jsonl`
    writeFileSync(file, '')
    const before = await state()
    const failures: string[] = []
    let i = 0
    for (const e of entries) {
      const sql = sqlOf(e)
      const analyze = e.analyze === true
      const rec: Record<string, unknown> = { id: e.id, expected: e.expected }
      // agent over MCP (an explain with analyze is the agent's refusal case; a human gets the REST route)
      const tool = e.kind === 'explain' ? 'sql_explain' : 'sql_query'
      const mcp = await agent.call(tool, { target, sql, ...(e.kind === 'explain' ? { analyze } : {}) })
      const text = mcp.content[0]?.text ?? ''
      rec['mcp'] = mcp.isError ? text.slice(0, 40).replace(/\s+/g, ' ') : `ok rows=${(mcp.structuredContent?.['rows'] as unknown[] | undefined)?.length ?? 'plan'}`
      // person over REST
      const path = e.kind === 'explain' ? `/api/v1/targets/${target}/explain` : `/api/v1/targets/${target}/queries`
      const rest = await w.rest(cliToken, 'POST', path, e.kind === 'explain' ? { sql, analyze } : { sql })
      rec['rest'] = rest.status === 200 ? 'ok' : `${rest.status} ${String(rest.body?.code ?? '')}`
      rec['mcpOk'] = !mcp.isError
      rec['restOk'] = rest.status === 200
      appendFileSync(file, `${JSON.stringify(rec)}\n`)
      // An agent never runs EXPLAIN ANALYZE; the person's REST route may (a clean read), so the
      // 'agent-analyze' group is only asserted for the agent.
      const agentMustFail = e.expected === 'REFUSED_BY_GUARD' || analyze
      const restMustFail = e.expected === 'REFUSED_BY_GUARD' && !e.class.startsWith('explain-agent-analyze')
      if (agentMustFail && !mcp.isError) failures.push(`${e.id}: agent got a result: ${rec['mcp']}`)
      if (restMustFail && rest.status === 200) failures.push(`${e.id}: REST got a result`)
      if (++i % 40 === 0 && (await state()) !== before) {
        failures.push(`state changed at ${e.id}`)
        break
      }
    }
    expect(await state()).toBe(before)
    writeFileSync(`${OUT}/mcp-rest-failures.json`, `${JSON.stringify(failures, null, 2)}\n`)
    expect(failures).toEqual([])
  }, 1_800_000)

  it('a read whose backend is terminated returns, and the cluster keeps serving reads', async () => {
    const target = w.ids.stagingTarget
    const long = 'SELECT count(*) FROM generate_series(1, 1000000000000)'
    const answers: string[] = []
    const calls = [0, 1].map(async (i) => {
      const started = Date.now()
      const r = await agent.call('sql_query', { target, sql: long, queryId: `qry_01M4S9000000000000000000W${i}` } as never)
      answers.push(`read ${i}: ${r.isError ? (r.content[0]?.text ?? '').slice(0, 60) : 'rows'} after ${Date.now() - started} ms`)
    })
    await new Promise((res) => setTimeout(res, 4000))
    const c = await superuserClient(pg17, 'postgres')
    const killed = await c.query(
      "SELECT count(*)::int AS n FROM (SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = 'exponetdb_reader' AND query LIKE '%generate_series%') t",
    )
    await c.end()
    const within = (ms: number) => new Promise<'timeout'>((res) => setTimeout(() => res('timeout'), ms))
    const t0 = Date.now()
    const both = await Promise.race([Promise.all(calls).then(() => 'answered' as const), within(25_000)])
    // The caller's own wait ends at the statement timeout plus 30 s; then the lane rows are gone and a new read can be tried.
    const late = await Promise.race([Promise.all(calls).then(() => 'answered' as const), within(150_000)])
    const next = await Promise.race([
      agent.call('sql_query', { target, sql: 'SELECT 1 AS one' }).then((r) => (r.isError ? `error: ${(r.content[0]?.text ?? '').slice(0, 80)}` : 'rows')),
      within(150_000),
    ])
    writeFileSync(
      `${OUT}/mcp-wedge.json`,
      `${JSON.stringify({ backendsTerminated: killed.rows[0]?.n, bothReadsAnsweredWithin25s: both === 'answered', bothAnsweredAfterLaneGaveUp: late === 'answered', msUntilAnswered: Date.now() - t0, answers, nextReadAfterwards: next }, null, 1)}\n`,
    )
    expect(both).toBe('answered')
    expect(next).toBe('rows')
  }, 600_000)
})
