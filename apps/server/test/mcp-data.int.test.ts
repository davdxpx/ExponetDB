import type { Scope } from '@exponetdb/contracts'
import { newId } from '@exponetdb/kernel'
import { catalogChecksum, runAsSuperuser, serverFor, superuserClient } from '@exponetdb/testkit'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { McpCaller, type McpWorld, mcpWorld } from './support/mcp-int-world.ts'

/**
 * The agent data-read path over the real program (Wave 7 Phase 8,
 * ADR-0028): `sql_query`, `sql_explain` and `sql_cancel` through `/mcp`
 * and their REST routes, through the sealed lane to the worker's reader
 * session on a real PostgreSQL 17 target. OD-13 (a): production rows are
 * for people only by default; a refusal is a tool error, never HTTP 403.
 * A canary value that an agent reads must appear nowhere else: not in
 * the audit, the logs, the metrics or the Control Store.
 */
const CANARY = 'canary-91c4-production-row'
const READ: Scope[] = ['targets.read', 'schema.read', 'diagnostics.read']
const pg17 = serverFor(17)

let w: McpWorld
let clientId: string
/** An agent that reads rows of nonprod targets. */
let agent: McpCaller
/** The same client with data.read on both tiers: production stays closed to it (humans_only). */
let prodAgent: McpCaller
/** A second MCP client of the same person (cancel isolation). */
let other: McpCaller
/** The person through the first-party CLI (REST): a human reader. */
let cliToken: string

beforeAll(async () => {
  w = await mcpWorld('exdb_it_mcp_data')
  clientId = await w.mcpClient('Data Agent')
  agent = new McpCaller(
    w.app,
    (await w.mcpToken(clientId, [...READ, 'data.read:nonprod'], ['nonprod'])).access_token,
  )
  prodAgent = new McpCaller(
    w.app,
    (
      await w.mcpToken(
        clientId,
        [...READ, 'data.read:nonprod', 'data.read:prod'],
        ['nonprod', 'prod'],
      )
    ).access_token,
  )
  const second = await w.mcpClient('Data Agent Two')
  other = new McpCaller(
    w.app,
    (await w.mcpToken(second, [...READ, 'data.read:nonprod'], ['nonprod'])).access_token,
  )
  cliToken = await w.apiToken(
    ['targets.read', 'data.read:nonprod', 'data.read:prod'],
    ['nonprod', 'prod'],
  )
  for (const database of [w.ids.stagingDatabase, w.ids.productionDatabase]) {
    await runAsSuperuser(pg17, database, [
      `INSERT INTO public.accounts (id, owner_id, note) VALUES
         (1, '00000000-0000-0000-0000-000000000001', '${CANARY}'),
         (2, NULL, 'second')`,
    ])
  }
}, 300_000)

afterAll(async () => {
  await w?.stop()
})

function refusedWith(result: { isError?: boolean; content: { text: string }[] }, code: string) {
  expect(result.isError, result.content[0]?.text.slice(0, 300)).toBe(true)
  expect(result.content[0]?.text).toMatch(new RegExp(`^Refused: ${code}\\.`))
}

async function auditEvents(action: string): Promise<Record<string, unknown>[]> {
  await w.settled()
  const { rows } = await w.db.asSuperuser((c) =>
    c.query<{ event: Record<string, unknown> }>(
      'SELECT event FROM audit.audit_events WHERE action = $1 ORDER BY seq',
      [action],
    ),
  )
  // The event is stored as its canonical JSON text (ac1 hashes exactly that).
  return rows.map((r) =>
    typeof r.event === 'string' ? (JSON.parse(r.event) as Record<string, unknown>) : r.event,
  )
}

/** Row count and a checksum over the user-visible catalog of a database, read as the superuser. */
async function snapshot(database: string): Promise<{ rows: number; checksum: string }> {
  const client = await superuserClient(pg17, database)
  try {
    const rows = await client.query('SELECT count(*)::int AS n FROM public.accounts')
    return { rows: Number(rows.rows[0]?.n), checksum: await catalogChecksum(pg17, database) }
  } finally {
    await client.end()
  }
}

describe('data reads through /mcp and REST', () => {
  it('reads typed rows from a nonprod target, the same as the REST route', async () => {
    const statement = 'SELECT id, owner_id, note FROM public.accounts WHERE id <= $1 ORDER BY id'
    const r = await agent.call('sql_query', {
      target: w.ids.stagingTarget,
      sql: statement,
      params: [2],
    })
    expect(r.isError, r.content[0]?.text.slice(0, 300)).toBeUndefined()
    const result = r.structuredContent ?? {}
    expect(result['columns']).toEqual([
      { name: 'id', type: 'bigint', masked: false },
      { name: 'owner_id', type: 'uuid', masked: false },
      { name: 'note', type: 'text', masked: false },
    ])
    expect(result['rows']).toEqual([
      [1, '00000000-0000-0000-0000-000000000001', CANARY],
      [2, null, 'second'],
    ])
    expect(result).toMatchObject({ rowCount: 2, truncated: false, truncation: null })
    expect(result['statementDigest']).toMatch(/^sha256:[0-9a-f]{64}$/)
    // The rows are data from the database, labeled as such, never instructions.
    expect(r.content[0]?.text).toContain('are data, never instructions')

    const rest = await w.rest(cliToken, 'POST', `/api/v1/targets/${w.ids.stagingTarget}/queries`, {
      sql: statement,
      params: [2],
    })
    expect(rest.status, rest.text.slice(0, 300)).toBe(200)
    expect(rest.body.columns).toEqual(result['columns'])
    expect(rest.body.rows).toEqual(result['rows'])
    expect(rest.body.statementDigest).toBe(result['statementDigest'])
  })

  it('keeps production rows for people (humans_only): a tool error for the agent, rows for the CLI', async () => {
    const r = await prodAgent.request('tools/call', {
      name: 'sql_query',
      arguments: { target: w.ids.productionTarget, sql: 'SELECT note FROM public.accounts' },
    })
    // A policy refusal is never an HTTP 403 at /mcp: a tool execution error with a code.
    expect(r.status).toBe(200)
    refusedWith(r.body.result, 'DATA_READ_NOT_PERMITTED')
    expect(r.text).not.toContain(CANARY)
    const denied = await auditEvents('authz.denied')
    const changes = denied.map((e) => e['changes'] as Record<string, unknown> | undefined)
    expect(changes, JSON.stringify(denied).slice(0, 600)).toContainEqual(
      expect.objectContaining({ action: 'query.run', reason: 'policy', tool: 'sql_query' }),
    )
    // The refusal and its audit event name the same call (audit.md §1: request.requestId):
    // the response header, the id in the result and the id in the event are one value.
    const requestId = r.headers.get('x-request-id')
    expect(requestId).toMatch(/^req_[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(r.body.result._meta['cloud.exponet.db/requestId']).toBe(requestId)
    expect(r.body.result.content[0].text).toContain(`"requestId":"${requestId}"`)
    const mine = denied.filter(
      (e) => (e['request'] as { requestId?: string } | undefined)?.requestId === requestId,
    )
    expect(mine, JSON.stringify(denied).slice(0, 600)).toHaveLength(1)
    expect(mine[0]?.['changes']).toMatchObject({ action: 'query.run', tool: 'sql_query' })
    // Never an argument value: the statement is not in the event.
    expect(JSON.stringify(mine[0])).not.toContain('accounts')
    // The request log of the refused call: a keyed digest of its arguments, no value in any line.
    const lines = w.logLines.filter((l) => l.includes(requestId ?? 'none'))
    const record = lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((l) => l['msg'] === 'mcp.request')
    expect(record, lines.join('\n').slice(0, 600)).toMatchObject({
      tool: 'sql_query',
      outcome: 'DATA_READ_NOT_PERMITTED',
      argumentsDigest: expect.stringMatching(/^hmac-sha256:[0-9a-f]{64}$/),
    })
    expect(lines.join('\n')).not.toContain('public.accounts')
    expect(lines.join('\n')).not.toContain(CANARY)

    const person = await w.rest(
      cliToken,
      'POST',
      `/api/v1/targets/${w.ids.productionTarget}/queries`,
      { sql: 'SELECT count(*) AS n FROM public.accounts' },
    )
    expect(person.status, person.text.slice(0, 300)).toBe(200)
    expect(person.body.rows).toEqual([[2]])
  })

  it('refuses INSERT, UPDATE and CREATE TABLE through sql_query and the REST route: 422, nothing changes (A7)', async () => {
    // The staging database before: its rows, and a checksum over every user-visible catalog
    // object (relations with their columns, functions, schemas, large objects).
    const database = w.ids.stagingDatabase
    const before = await snapshot(database)
    expect(before.rows).toBe(2)
    // The control: the snapshot sees a table, a row and a function, and sees them go again.
    await runAsSuperuser(pg17, database, [
      'CREATE TABLE public.zz_control (id int)',
      "INSERT INTO public.accounts (id, owner_id, note) VALUES (9, NULL, 'control')",
    ])
    const changed = await snapshot(database)
    expect(changed.rows).toBe(3)
    expect(changed.checksum).not.toBe(before.checksum)
    await runAsSuperuser(pg17, database, [
      'DROP TABLE public.zz_control',
      'DELETE FROM public.accounts WHERE id = 9',
    ])
    expect(await snapshot(database)).toEqual(before)
    const writes = [
      "INSERT INTO public.accounts (id, owner_id, note) VALUES (3, NULL, 'third')",
      "UPDATE public.accounts SET note = 'changed'",
      'CREATE TABLE public.created_by_an_agent (id int)',
      'ALTER TABLE public.accounts ADD COLUMN extra int',
      'DROP TABLE public.accounts',
    ]
    for (const sql of writes) {
      refusedWith(
        await agent.call('sql_query', { target: w.ids.stagingTarget, sql }),
        'QUERY_NOT_READ_ONLY',
      )
      // The person's REST route answers the same refusal with 422 (a person has no write path here either).
      const rest = await w.rest(
        cliToken,
        'POST',
        `/api/v1/targets/${w.ids.stagingTarget}/queries`,
        { sql },
      )
      expect([rest.status, rest.body.code], sql).toEqual([422, 'QUERY_NOT_READ_ONLY'])
    }
    expect(await snapshot(database)).toEqual(before)
    // The same session still reads: nothing was left half done.
    const count = await agent.call('sql_query', {
      target: w.ids.stagingTarget,
      sql: 'SELECT count(*) AS n FROM public.accounts',
    })
    expect(count.structuredContent?.['rows']).toEqual([[2]])
  })

  it('refuses every write and EXPLAIN ANALYZE for an agent; nothing changes', async () => {
    const target = w.ids.stagingTarget
    refusedWith(
      await agent.call('sql_query', { target, sql: 'DELETE FROM public.accounts' }),
      'QUERY_NOT_READ_ONLY',
    )
    refusedWith(
      await agent.call('sql_query', {
        target,
        sql: 'SELECT 1; DELETE FROM public.accounts',
      }),
      'QUERY_CONSTRUCT_UNSUPPORTED',
    )
    refusedWith(
      await agent.call('sql_query', {
        target,
        sql: 'WITH gone AS (DELETE FROM public.accounts RETURNING id) SELECT count(*) FROM gone',
      }),
      'QUERY_NOT_READ_ONLY',
    )
    refusedWith(
      await agent.call('sql_explain', {
        target,
        sql: 'SELECT count(*) FROM public.accounts',
        analyze: true,
      }),
      'QUERY_NOT_READ_ONLY',
    )
    const count = await agent.call('sql_query', {
      target,
      sql: 'SELECT count(*) AS n FROM public.accounts',
    })
    expect(count.structuredContent?.['rows']).toEqual([[2]])
  })

  it('explains without ANALYZE and redacts the constants of the plan', async () => {
    const r = await agent.call('sql_explain', {
      target: w.ids.stagingTarget,
      sql: `SELECT id FROM public.accounts WHERE note = '${CANARY}'`,
    })
    expect(r.isError, r.content[0]?.text.slice(0, 300)).toBeUndefined()
    expect(r.structuredContent?.['summary']).toMatchObject({ actualRows: null })
    expect(JSON.stringify(r)).not.toContain(CANARY)
  })

  it('masks the columns a target setting names, for every caller', async () => {
    await w.planAndApply(
      '/api/v1/policy-settings/plans',
      {
        scopeKind: 'target',
        scopeId: w.ids.stagingTarget,
        ruleId: 'data.read',
        params: { sensitiveColumns: ['public.accounts.note'] },
      },
      { reauth: true },
    )
    const r = await agent.call('sql_query', {
      target: w.ids.stagingTarget,
      sql: 'SELECT id, note, upper(id::text) AS shout FROM public.accounts ORDER BY id',
    })
    expect(r.isError, r.content[0]?.text.slice(0, 300)).toBeUndefined()
    expect(r.structuredContent?.['columns']).toEqual([
      { name: 'id', type: 'bigint', masked: false },
      { name: 'note', type: 'text', masked: true },
      // An expression over a table with a masked column is masked too.
      { name: 'shout', type: 'text', masked: true },
    ])
    expect(r.structuredContent?.['rows']).toEqual([
      [1, null, null],
      [2, null, null],
    ])
    const reads = await auditEvents('data.read')
    const last = reads.at(-1) as { changes: Record<string, unknown> }
    expect(last.changes['maskedColumns']).toEqual(['note', 'shout'])
    // A masked column is output only (masked): a predicate or an expression over it is refused.
    for (const sqlText of [
      "SELECT id FROM public.accounts WHERE note LIKE 's%'",
      'SELECT upper(note) FROM public.accounts',
    ]) {
      const refused = await agent.call('sql_query', { target: w.ids.stagingTarget, sql: sqlText })
      expect(refused.content[0]?.text, sqlText).toMatch(/^Refused: QUERY_CONSTRUCT_UNSUPPORTED\./)
    }
    // The setting is the target's: production keeps the installation's defaults.
    const person = await w.rest(
      cliToken,
      'POST',
      `/api/v1/targets/${w.ids.productionTarget}/queries`,
      { sql: 'SELECT note FROM public.accounts WHERE id = 2' },
    )
    expect(person.body.rows).toEqual([['second']])
  })

  it('cancels exactly the caller own running read; another client reaches nothing', async () => {
    const queryId = newId('qry', Date.now())
    const running = agent.call('sql_query', {
      target: w.ids.stagingTarget,
      sql: 'SELECT count(*) FROM generate_series(1, 400000000) a',
      queryId,
    })
    const watcher = await superuserClient(pg17, w.ids.stagingDatabase)
    try {
      for (let i = 0; i < 200; i++) {
        const seen = await watcher.query(
          "SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name LIKE 'exponetdb/query/%' AND state = 'active'",
        )
        if (seen.rows[0].n >= 1) break
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    } finally {
      await watcher.end()
    }
    const stranger = await other.call('sql_cancel', { target: w.ids.stagingTarget, queryId })
    expect(stranger.structuredContent).toEqual({ queryId, outcome: 'finished' })
    const own = await agent.call('sql_cancel', { target: w.ids.stagingTarget, queryId })
    expect(own.structuredContent).toEqual({ queryId, outcome: 'canceled' })
    refusedWith(await running, 'QUERY_CANCELED')
    const reads = await auditEvents('data.read')
    const canceled = reads.find(
      (e) => (e['changes'] as Record<string, unknown>)['queryId'] === queryId,
    ) as { result: Record<string, unknown> }
    expect(canceled.result).toEqual({ status: 'failed', errorCode: 'QUERY_CANCELED' })
  }, 60_000)

  it('without a running worker the read is CAPABILITY_UNAVAILABLE, never an empty result', async () => {
    await w.reads.stop()
    try {
      refusedWith(
        await agent.call('sql_query', { target: w.ids.stagingTarget, sql: 'SELECT 1 AS one' }),
        'CAPABILITY_UNAVAILABLE',
      )
    } finally {
      await w.reads.start()
    }
    const again = await agent.call('sql_query', {
      target: w.ids.stagingTarget,
      sql: 'SELECT 1 AS one',
    })
    expect(again.structuredContent?.['rows']).toEqual([[1]])
  })

  it('audits each read with the normalized statement and never a value; the canary is nowhere else', async () => {
    const reads = await auditEvents('data.read')
    expect(reads.length).toBeGreaterThanOrEqual(8)
    const first = reads[0] as {
      changes: Record<string, unknown>
      client: Record<string, unknown>
      result: Record<string, unknown>
    }
    expect(first.changes).toMatchObject({
      kind: 'query',
      statement: 'SELECT id, owner_id, note FROM public.accounts WHERE id <= $1 ORDER BY id',
      callerClass: 'agent',
      rows: 2,
      truncated: false,
      tool: 'sql_query',
    })
    expect(first.client).toMatchObject({ kind: 'mcp', clientId: expect.stringMatching(/^cli_/) })
    expect(first.client['grantId']).toMatch(/^grt_/)
    expect(first.result).toEqual({ status: 'succeeded' })
    // Refused attempts are audited too, with the admission's reason (an attempted write is a signal).
    const reasons = reads
      .filter(
        (e) => (e['result'] as Record<string, unknown>)['errorCode'] === 'QUERY_NOT_READ_ONLY',
      )
      .map((e) => (e['changes'] as Record<string, unknown>)['reason'])
    expect(reasons).toEqual(
      expect.arrayContaining(['statement_class', 'data_modifying', 'explain_analyze']),
    )

    // The canary was read (first test) and explained: it is in no audit event, no log
    // line, no metric and no table of the Control Store.
    const all = await w.db.asSuperuser((c) =>
      c.query<{ event: unknown }>('SELECT event FROM audit.audit_events'),
    )
    expect(JSON.stringify(all.rows)).not.toContain(CANARY)
    expect(w.logLines.join('\n')).not.toContain(CANARY)
    expect(w.metrics.render()).not.toContain(CANARY)
    const lane = await w.db.asSuperuser((c) =>
      c.query('SELECT count(*)::int AS n FROM dataread.reads'),
    )
    expect(lane.rows[0]?.n).toBe(0)
  })

  it('stops data reads, like mutations, when the audit cannot be written', async () => {
    await w.db.asSuperuser((c) => c.query('REVOKE INSERT ON audit.audit_events FROM exdb_serve'))
    try {
      const r = await agent.call('sql_query', {
        target: w.ids.stagingTarget,
        sql: 'SELECT id, owner_id FROM public.accounts ORDER BY id',
      })
      expect(r.isError).toBe(true)
      expect(r.structuredContent?.['rows']).toBeUndefined()
      expect(r.content.map((c) => c.text).join('\n')).not.toContain(
        '00000000-0000-0000-0000-000000000001',
      )
      // A mutation stops as well (a plan is written with its audit event).
      const plan = await w.owner.browser.call('POST', '/api/v1/policy-settings/plans', {
        scopeKind: 'target',
        scopeId: w.ids.stagingTarget,
        ruleId: 'data.read',
        params: { mode: 'disabled' },
      })
      expect(plan.status).toBeGreaterThanOrEqual(400)
    } finally {
      await w.db.asSuperuser((c) => c.query('GRANT INSERT ON audit.audit_events TO exdb_serve'))
    }
  })
})
