import { ROLE_NAMES } from '@exponetdb/postgres'
import {
  loginClient,
  loginPassword,
  runAsSuperuser,
  serverFor,
  testRolePassword,
  withSuperuser,
} from '@exponetdb/testkit'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { McpCaller, type McpWorld, mcpWorld } from './support/mcp-int-world.ts'

/**
 * The Wave 9 Part B diagnostics over the real program (performance.md) on a
 * PostgreSQL 17 Control Store and a PostgreSQL 17 target with
 * `pg_stat_statements`: the sampled statement statistics, the live table
 * statistics, an advisor run and its findings in the findings list and the
 * summary, cluster findings, the same reads through MCP, and cancel and
 * terminate through the Operations Engine with the operator credential.
 * Refusals: a grant without `diagnostics.read` (403), a person without
 * `connections.operate` planning a termination (403).
 */
const pg17 = serverFor(17)
let w: McpWorld
const appRole = `exdb_http_perf_app_${Date.now().toString(36)}`

beforeAll(async () => {
  w = await mcpWorld('exdb_it_http_performance')
  await runAsSuperuser(pg17, w.ids.stagingDatabase, [
    'CREATE EXTENSION IF NOT EXISTS pg_stat_statements',
    'CREATE TABLE public.notes (id bigint, account_id bigint REFERENCES public.accounts (id))',
  ])
  await runAsSuperuser(pg17, 'postgres', [
    `CREATE ROLE ${appRole} LOGIN PASSWORD '${testRolePassword(appRole)}'`,
    `GRANT CONNECT ON DATABASE ${w.ids.stagingDatabase} TO ${appRole}`,
  ])
  // The operator login is the only ExponetDB role with pg_signal_backend.
  await w.owner.reauth()
  const submitted = await w.owner.browser.call(
    'POST',
    `/api/v1/clusters/${w.ids.cluster}/credentials/operator`,
    { password: loginPassword(ROLE_NAMES.operator) },
  )
  expect(submitted.status, submitted.text).toBeLessThan(300)
  await w.observation.verifyCredentials()
}, 600_000)

afterAll(async () => {
  await w?.stop()
})

const t = () => w.ids.stagingTarget

describe('statement statistics, table statistics, advisors and findings', () => {
  it('serves the sampled statement statistics with the sampler state', async () => {
    const work = (n: number) =>
      withSuperuser(pg17, w.ids.stagingDatabase, async (c) => {
        for (let i = 0; i < n; i++) {
          await c.query('SELECT count(*) FROM public.accounts WHERE id = $1', [i])
        }
      })
    // A statement gets a delta from the second sample that saw it on.
    await work(1)
    await w.observation.sampleStatements()
    await work(12)
    await w.observation.sampleStatements()
    const r = await w.owner.browser.call(
      'GET',
      `/api/v1/targets/${t()}/query-stats?order=calls&limit=500`,
    )
    expect(r.status, r.text).toBe(200)
    expect(r.body).toMatchObject({
      targetId: t(),
      source: 'sampled',
      sampling: { state: 'active' },
    })
    const s = r.body.statements.find((x: { normalizedText: string }) =>
      x.normalizedText.includes('public.accounts WHERE id = $1'),
    )
    expect(s).toMatchObject({ calls: 12, textRedacted: false })
    const bad = await w.owner.browser.call('GET', `/api/v1/targets/${t()}/query-stats?limit=501`)
    expect([bad.status, bad.body.code]).toEqual([422, 'VALIDATION_FAILED'])
  })

  it('serves table statistics live', async () => {
    const r = await w.owner.browser.call('GET', `/api/v1/targets/${t()}/table-stats?schema=public`)
    expect(r.status, r.text).toBe(200)
    expect(r.body).toMatchObject({ source: 'live', estimateMethod: 'heuristic_page_estimate' })
    expect(r.body.tables.map((x: { name: string }) => x.name)).toContain('accounts')
  })

  it('runs advisors, records their findings and lists them across kinds', async () => {
    const run = await w.owner.browser.call('POST', `/api/v1/targets/${t()}/advisor-runs`, {
      categories: ['performance'],
    })
    expect(run.status, run.text).toBe(200)
    expect(run.body).toMatchObject({ targetId: t(), catalogVersion: 1 })
    expect(run.body.id).toMatch(/^adv_/)
    const fk = run.body.findings.find((f: { rule: string }) => f.rule === 'unindexed_foreign_key')
    expect(fk).toMatchObject({ category: 'performance', draft: 'migration_draft' })
    expect(fk.findingId).toMatch(/^fnd_/)

    const listed = await w.owner.browser.call(
      'GET',
      `/api/v1/findings?kind=advisor&code=unindexed_foreign_key&target=${t()}`,
    )
    expect(listed.status, listed.text).toBe(200)
    expect(listed.body.items.map((f: { id: string }) => f.id)).toContain(fk.findingId)
    const ofTarget = await w.owner.browser.call('GET', `/api/v1/targets/${t()}/findings`)
    expect(ofTarget.status, ofTarget.text).toBe(200)
    expect(ofTarget.body.items.some((f: { kind: string }) => f.kind === 'advisor')).toBe(true)

    const summary = await w.owner.browser.call('GET', '/api/v1/findings/summary')
    expect(summary.status, summary.text).toBe(200)
    expect(summary.body).toMatchObject({ source: 'control_store' })
    expect(summary.body.open).toBeGreaterThan(0)

    const cluster = await w.owner.browser.call('GET', `/api/v1/clusters/${w.ids.cluster}/findings`)
    expect(cluster.status, cluster.text).toBe(200)
    expect(cluster.body).toEqual({ items: [], nextCursor: null })

    const events = await w.db.asSuperuser((c) =>
      c.query(`SELECT count(*)::int AS n FROM audit.audit_events WHERE action = 'advisor.run'`),
    )
    expect(events.rows[0]?.n).toBeGreaterThanOrEqual(1)
  })

  it('serves the same reads through MCP', async () => {
    const client = await w.mcpClient('perf-agent')
    const token = await w.mcpToken(client, ['targets.read', 'diagnostics.read'], ['nonprod'])
    const mcp = new McpCaller(w.app, token.access_token)
    const stats = await mcp.call('table_stats', { target: t() })
    expect(stats.isError).not.toBe(true)
    expect(stats.structuredContent).toMatchObject({ targetId: t(), source: 'live' })
    const queries = await mcp.call('query_stats', { target: t() })
    expect(queries.structuredContent?.['source']).toBe('sampled')
    for (const s of queries.structuredContent?.['statements'] ?? []) {
      expect(s.normalizedText.length).toBeLessThanOrEqual(500)
    }
    const advisors = await mcp.call('advisors_run', { target: t(), categories: ['security'] })
    expect(advisors.structuredContent?.['catalogVersion']).toBe(1)
  })

  it("serves backups_list through MCP with the REST route's use case", async () => {
    const client = await w.mcpClient('perf-backups-agent')
    const token = await w.mcpToken(client, ['targets.read', 'backups.read'], ['nonprod'])
    const mcp = new McpCaller(w.app, token.access_token)
    const listed = await mcp.request('tools/list')
    expect(listed.body.result.tools.map((x: { name: string }) => x.name)).toContain('backups_list')
    const r = await mcp.call('backups_list', { cluster: w.ids.cluster })
    const rest = await w.owner.browser.call('GET', `/api/v1/clusters/${w.ids.cluster}/backups`)
    if (r.isError === true) {
      expect(r.structuredContent?.['code']).not.toBe('INTERNAL')
    } else {
      expect(rest.status, rest.text).toBe(200)
      expect(r.structuredContent?.['clusterId']).toBe(rest.body.clusterId)
    }
  })

  it('refuses a grant without diagnostics.read', async () => {
    const token = await w.apiToken(['targets.read'], ['nonprod'])
    for (const path of [
      `/api/v1/targets/${t()}/query-stats`,
      `/api/v1/targets/${t()}/table-stats`,
      '/api/v1/findings/summary',
    ]) {
      const r = await w.rest(token, 'GET', path)
      expect(r.status, path).toBe(403)
    }
    const run = await w.rest(token, 'POST', `/api/v1/targets/${t()}/advisor-runs`, {})
    expect(run.status).toBe(403)
  })
})

async function activeBackend(application: string) {
  for (let i = 0; i < 50; i++) {
    const row = await withSuperuser(pg17, 'postgres', async (c) => {
      const r = await c.query(
        `SELECT pid, to_char(backend_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS bs,
                to_char(query_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS qs
           FROM pg_stat_activity WHERE application_name = $1 AND state = 'active'`,
        [application],
      )
      return r.rows[0] as { pid: number; bs: string; qs: string } | undefined
    })
    if (row !== undefined) return row
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('no active backend')
}

async function sleeper(application: string) {
  const client = await loginClient(pg17, appRole, testRolePassword(appRole), w.ids.stagingDatabase)
  await client.query(`SET application_name = '${application}'`)
  const sleeping = client.query('SELECT pg_sleep(30)').then(
    () => 'finished',
    (e: { code?: string }) => e.code ?? 'error',
  )
  return { client, sleeping, backend: await activeBackend(application) }
}

describe('cancel and terminate', () => {
  it('cancels a running query as an inline plan the worker executes and verifies', async () => {
    const s = await sleeper('http-perf-cancel')
    try {
      const r = await w.owner.browser.call(
        'POST',
        `/api/v1/targets/${t()}/sessions/${s.backend.pid}/cancel`,
        { backendStart: s.backend.bs, queryStart: s.backend.qs },
      )
      expect(r.status, r.text).toBe(202)
      await w.drive()
      const op = await w.owner.browser.call('GET', `/api/v1/operations/${r.body.id}`)
      expect(op.body).toMatchObject({
        state: 'succeeded',
        applyOutcome: 'applied',
        verificationOutcome: 'passed',
      })
      expect(await s.sleeping).toBe('57014')
    } finally {
      await s.client.end().catch(() => undefined)
    }
  })

  it('refuses a cancel bound to another query as stale', async () => {
    const s = await sleeper('http-perf-stale')
    try {
      const r = await w.owner.browser.call(
        'POST',
        `/api/v1/targets/${t()}/sessions/${s.backend.pid}/cancel`,
        { backendStart: s.backend.bs, queryStart: '2000-01-01T00:00:00.000Z' },
      )
      expect([r.status, r.body.code], r.text).toEqual([409, 'PLAN_STALE'])
      expect(r.body.details.changedBindings[0].binding).toBe('query')
    } finally {
      await s.client.end().catch(() => undefined)
    }
  })

  it('plans a termination, applies it and the backend is gone', async () => {
    const s = await sleeper('http-perf-terminate')
    try {
      const { plan, operation } = await w.planAndApply(
        `/api/v1/targets/${t()}/sessions/${s.backend.pid}/terminate`,
        { backendStart: s.backend.bs, condition: 'any', reason: 'test' },
      )
      expect(plan).toMatchObject({ kind: 'connections.terminate', class: 'standard' })
      const op = await w.owner.browser.call('GET', `/api/v1/operations/${String(operation['id'])}`)
      expect(op.body).toMatchObject({ state: 'succeeded', verificationOutcome: 'passed' })
      expect(await s.sleeping).toBe('57P01')
    } finally {
      await s.client.end().catch(() => undefined)
    }
  })

  it('refuses a termination plan by a person without connections.operate', async () => {
    const dev = await w.invitePerson(`dev-${Date.now()}@example.test`, 'developer', {
      kind: 'global',
    })
    const r = await dev.browser.call('POST', `/api/v1/targets/${t()}/sessions/1/terminate`, {
      backendStart: '2026-01-01T00:00:00.000Z',
      condition: 'any',
    })
    expect(r.status, r.text).toBe(403)
  })
})
