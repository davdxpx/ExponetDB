import { serverFor, superuserClient } from '@exponetdb/testkit'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type McpWorld, mcpWorld } from './support/mcp-int-world.ts'
import type { Person } from './support/node-world.ts'

/**
 * `GET /api/v1/statements/{digest}/raw?target=…` over the real program
 * (Wave 8, owner decision S2) on a PostgreSQL 17 Control Store and a
 * PostgreSQL 17 target: the text is read live from the target's
 * `pg_stat_activity` through serve's observer session, checked against the
 * digest the session list shows, its secrets removed; a person in the Web
 * App with `diagnostics.read_sensitive`, re-authenticated within 15
 * minutes; one audit event per view without the text; nothing persisted.
 *
 * The disposable test servers preload `pg_stat_statements` since Wave 9
 * Part B (the statement sampler needs it; `tooling/dev/targets.sh`): an
 * installed extension is then searched, and an unknown digest is
 * `not_held`. On a server that does not preload it, the same step proves
 * "installed but not loaded" (SQLSTATE 55000) is `extension_missing`; the
 * test reads the server's setting and checks the case it is.
 */
const pg17 = serverFor(17)
// Markers no code path of ours produces; the text must never be stored or logged.
const MARKER = 'zq7rawmarker'
const SECRET = 'zq7secretpw'

let w: McpWorld
let held: Awaited<ReturnType<typeof superuserClient>>
let heldPid: number

const path = (digest: string, query: Record<string, string> = {}) =>
  `/api/v1/statements/${digest}/raw?${new URLSearchParams({ target: w.ids.stagingTarget, ...query })}`

/** The digest the session list shows for the held session's current statement. */
async function digestOf(pid = heldPid): Promise<{ digest: string; backendStart: string }> {
  const list = await w.owner.browser.call(
    'GET',
    `/api/v1/targets/${w.ids.stagingTarget}/sessions?limit=1000`,
  )
  expect(list.status, list.text).toBe(200)
  const session = list.body.sessions.find((s: { pid: number }) => s.pid === pid)
  expect(session?.statement?.digest).toMatch(/^sha256:[0-9a-f]{64}$/)
  return { digest: session.statement.digest, backendStart: session.backendStart }
}

async function age(minutes: number) {
  await w.db.asSuperuser(async (c) => {
    // Test-only aging, as the auth suites do: the guards would refuse an edited time.
    await c.query('BEGIN')
    await c.query('SET LOCAL session_replication_role = replica')
    await c.query(
      `UPDATE auth.reauth_events SET occurred_at = occurred_at - make_interval(mins => $1)`,
      [minutes],
    )
    await c.query(
      `UPDATE auth.web_sessions SET reauth_at = reauth_at - make_interval(mins => $1)
        WHERE reauth_at IS NOT NULL`,
      [minutes],
    )
    await c.query('COMMIT')
  })
}

/** The view events in chain order: the stored event (parsed) and its whole text. */
const viewEvents = async () =>
  (
    await w.db.asSuperuser(async (c) =>
      c.query(
        `SELECT phase, event FROM audit.audit_events
          WHERE action = 'diagnostics.raw_statement_viewed' ORDER BY seq`,
      ),
    )
  ).rows.map((r: { phase: string; event: string }) => ({
    ...(JSON.parse(r.event) as Record<string, unknown>),
    phase: r.phase,
    whole: r.event,
  })) as unknown as {
    phase: string
    whole: string
    changes: Record<string, unknown>
  }[]

beforeAll(async () => {
  w = await mcpWorld('exdb_it_http_raw_statement')
  // A client of the target's database whose last statement stays in pg_stat_activity.
  held = await superuserClient(pg17, w.ids.stagingDatabase)
  heldPid = Number((await held.query('SELECT pg_backend_pid() AS pid')).rows[0]?.pid)
}, 600_000)

afterAll(async () => {
  await held?.end().catch(() => undefined)
  await w?.stop()
})

describe('the raw statement view', () => {
  it('returns the live text with its literals, checked against the digest, and audits the view without it', async () => {
    const statement = `SELECT '${MARKER} literal' AS note, 4242 AS n, 'ada@example.test' AS email`
    await held.query(statement)
    const { digest, backendStart } = await digestOf()
    await w.owner.reauth()
    const r = await w.owner.browser.call('GET', path(digest))
    expect(r.status, r.text).toBe(200)
    expect(r.body).toMatchObject({
      targetId: w.ids.stagingTarget,
      digest,
      text: statement,
      untrusted: true,
      truncated: false,
      redaction: { mode: 'literal', removed: 0 },
      origin: { view: 'pg_stat_activity', pid: heldPid, backendStart },
      source: 'live',
    })
    // The same through the named session.
    const named = await w.owner.browser.call(
      'GET',
      path(digest, { pid: String(heldPid), backendStart }),
    )
    expect(named.status, named.text).toBe(200)
    expect(named.body.text).toBe(statement)

    const events = await viewEvents()
    expect(events.length).toBe(2)
    expect(events[0]).toMatchObject({
      phase: 'completed',
      actor: { kind: 'human', identityId: w.owner.identityId },
      client: { kind: 'web' },
      subject: { targetId: w.ids.stagingTarget, tier: 'nonprod' },
      changes: {
        statementDigest: digest,
        view: 'pg_stat_activity',
        pid: heldPid,
        mode: 'literal',
        removed: 0,
        truncated: false,
      },
      result: { status: 'succeeded' },
    })
    for (const e of events) expect(e.whole).not.toContain(MARKER)
  })

  it('removes secrets: a conninfo password, and a secret setting as its summary', async () => {
    await held.query(
      `SELECT 'host=db user=app password=${SECRET} dbname=d' AS conninfo, '${MARKER} kept' AS k`,
    )
    let { digest } = await digestOf()
    await w.owner.reauth()
    const conninfo = await w.owner.browser.call('GET', path(digest))
    expect(conninfo.status, conninfo.text).toBe(200)
    expect(conninfo.body.text).toBe(
      `SELECT 'host=db user=app password=<redacted> dbname=d' AS conninfo, '${MARKER} kept' AS k`,
    )
    expect(conninfo.body.redaction).toEqual({ mode: 'literal', removed: 1 })
    expect(conninfo.text).not.toContain(SECRET)

    await held.query(`SET app.api_token = '${SECRET}'`)
    ;({ digest } = await digestOf())
    const setting = await w.owner.browser.call('GET', path(digest))
    expect(setting.status, setting.text).toBe(200)
    expect(setting.body).toMatchObject({
      text: 'SET <setting> <redacted>',
      redaction: { mode: 'summary', removed: 0 },
    })
    expect(setting.text).not.toContain(SECRET)
  })

  it('answers STATEMENT_NOT_AVAILABLE for a statement the target no longer holds, never old text', async () => {
    await held.query(`SELECT '${MARKER} first' AS v`)
    const first = await digestOf()
    await held.query(`SELECT '${MARKER} second', 2 AS v`)
    await w.owner.reauth()
    // The named session runs another statement now.
    const moved = await w.owner.browser.call(
      'GET',
      path(first.digest, { pid: String(heldPid), backendStart: first.backendStart }),
    )
    expect([moved.status, moved.body.code, moved.body.details]).toEqual([
      404,
      'STATEMENT_NOT_AVAILABLE',
      { reason: 'digest_mismatch' },
    ])
    expect(moved.text).not.toContain(MARKER)
    // A session that is gone (another start time for the pid) holds nothing.
    const gone = await w.owner.browser.call(
      'GET',
      path(first.digest, { pid: String(heldPid), backendStart: '2000-01-01T00:00:00.000Z' }),
    )
    expect([gone.status, gone.body.details]).toEqual([404, { reason: 'not_held' }])
    // Anywhere on the target: not in pg_stat_activity, and no pg_stat_statements to search.
    const unknown = await w.owner.browser.call('GET', path(`sha256:${'0'.repeat(64)}`))
    expect([unknown.status, unknown.body.details]).toEqual([404, { reason: 'extension_missing' }])
    // Installed: searched when it is loaded (an unknown digest is not held there);
    // not in shared_preload_libraries (55000): still not searchable.
    const preload = await held.query(
      "SELECT current_setting('shared_preload_libraries') ~ 'pg_stat_statements' AS loaded",
    )
    const loaded = preload.rows[0]?.loaded === true
    const installedReason = loaded ? 'not_held' : 'extension_missing'
    await held.query('CREATE EXTENSION IF NOT EXISTS pg_stat_statements')
    const installed = await w.owner.browser.call('GET', path(`sha256:${'0'.repeat(64)}`))
    expect([installed.status, installed.body.details]).toEqual([404, { reason: installedReason }])
    await held.query('DROP EXTENSION pg_stat_statements')
    // A digest that is not one is a validation failure, not a lookup.
    const bad = await w.owner.browser.call('GET', path('sha256:abc'))
    expect([bad.status, bad.body.code]).toEqual([422, 'VALIDATION_FAILED'])
    const lone = await w.owner.browser.call(
      'GET',
      path(first.digest, { backendStart: first.backendStart }),
    )
    expect([lone.status, lone.body.code]).toEqual([422, 'VALIDATION_FAILED'])
    const failed = (await viewEvents()).filter((e) => e.phase === 'failed')
    expect(failed.map((e) => e.changes['reason'])).toEqual([
      'digest_mismatch',
      'not_held',
      'extension_missing',
      installedReason,
    ])
    expect(failed[0]).toMatchObject({
      result: { status: 'failed', errorCode: 'STATEMENT_NOT_AVAILABLE' },
      changes: { statementDigest: first.digest, requestedPid: heldPid },
    })
  })

  it('needs a re-authentication within 15 minutes', async () => {
    await held.query(`SELECT '${MARKER} reauth' AS v`)
    const { digest } = await digestOf()
    await w.owner.reauth()
    await age(14)
    // 14 minutes after the proof: inside the window (it is not the default 5 minutes).
    const inside = await w.owner.browser.call('GET', path(digest))
    expect(inside.status, inside.text).toBe(200)
    await age(2)
    const stale = await w.owner.browser.call('GET', path(digest))
    expect([stale.status, stale.body.code]).toEqual([401, 'REAUTH_REQUIRED'])
    expect(stale.text).not.toContain(MARKER)
  })

  it('refuses a person without diagnostics.read_sensitive, and records the denial', async () => {
    await held.query(`SELECT '${MARKER} viewer' AS v`)
    const { digest } = await digestOf()
    const developer: Person = await w.invitePerson('developer@example.test', 'developer', {
      kind: 'global',
    })
    await developer.reauth()
    // The developer reads sessions (diagnostics.read), not the raw text.
    const r = await developer.browser.call('GET', path(digest))
    expect([r.status, r.body.code]).toEqual([403, 'PERMISSION_DENIED'])
    expect(r.text).not.toContain(MARKER)
    await w.settled()
    const denied = (
      await w.db.asSuperuser(async (c) =>
        c.query(
          `SELECT event FROM audit.audit_events WHERE action = 'authz.denied'
            AND (event::jsonb)->'changes'->>'action' = 'statement.raw.get'`,
        ),
      )
    ).rows
    expect(denied.length).toBe(1)
  })

  it('refuses every caller that is not a person in the Web App', async () => {
    await held.query(`SELECT '${MARKER} bearer' AS v`)
    const { digest } = await digestOf()
    // The owner's first-party CLI token: a human, but not the Web App.
    const cli = await w.apiToken(['diagnostics.read'], ['nonprod', 'prod'])
    const viaCli = await w.rest(cli, 'GET', path(digest))
    expect(viaCli.status).toBe(403)
    expect(['PERMISSION_DENIED', 'INSUFFICIENT_SCOPE']).toContain(viaCli.body.code)
    // A service account's API key.
    await w.owner.reauth()
    const account = await w.owner.browser.call('POST', '/api/v1/service-accounts', {
      displayName: 'raw-statement-reader',
    })
    expect(account.status, account.text).toBe(201)
    const binding = await w.owner.browser.call('POST', '/api/v1/role-bindings', {
      identityId: account.body.id,
      roleId: 'developer',
      scope: { kind: 'global' },
    })
    expect(binding.status, binding.text).toBe(201)
    await w.owner.reauth()
    expect(
      (await w.owner.browser.call('POST', `/api/v1/plans/${binding.body.id}/apply`, {})).status,
    ).toBe(202)
    await w.drive()
    await w.owner.reauth()
    const key = await w.owner.browser.call(
      'POST',
      `/api/v1/service-accounts/${account.body.id}/api-keys`,
      {
        scopes: ['diagnostics.read'],
        restrictions: { tiers: ['nonprod'], targets: { kind: 'all' } },
        lifetimeDays: 30,
      },
    )
    expect(key.status, key.text).toBe(201)
    const viaKey = await w.rest(String(key.body.secret), 'GET', path(digest))
    expect(viaKey.status).toBe(403)
    expect(['PERMISSION_DENIED', 'INSUFFICIENT_SCOPE']).toContain(viaKey.body.code)
    expect(viaCli.text + viaKey.text).not.toContain(MARKER)
  })

  it('answers target_unreachable when the target cannot be read, and recovers', async () => {
    await held.query(`SELECT '${MARKER} unreachable' AS v`)
    const { digest } = await digestOf()
    // Point the cluster's endpoint at a closed port in this run's own Control Store.
    const moved = await w.db.asSuperuser(async (c) => {
      await c.query('BEGIN')
      await c.query('SET LOCAL session_replication_role = replica')
      const before = await c.query(
        `SELECT endpoint_id, port FROM registry.endpoints WHERE cluster_id = $1 AND state = 'active'`,
        [w.ids.cluster],
      )
      await c.query(`UPDATE registry.endpoints SET port = 1 WHERE cluster_id = $1`, [w.ids.cluster])
      await c.query('COMMIT')
      return before.rows as { endpoint_id: string; port: number }[]
    })
    try {
      await w.owner.reauth()
      const r = await w.owner.browser.call('GET', path(digest))
      expect([r.status, r.body.code, r.body.details]).toEqual([
        404,
        'STATEMENT_NOT_AVAILABLE',
        { reason: 'target_unreachable' },
      ])
      const last = (await viewEvents()).at(-1)
      expect(last).toMatchObject({ phase: 'failed', changes: { reason: 'target_unreachable' } })
    } finally {
      await w.db.asSuperuser(async (c) => {
        await c.query('BEGIN')
        await c.query('SET LOCAL session_replication_role = replica')
        for (const e of moved) {
          await c.query('UPDATE registry.endpoints SET port = $2 WHERE endpoint_id = $1', [
            e.endpoint_id,
            e.port,
          ])
        }
        await c.query('COMMIT')
      })
    }
  })

  it('never stores or logs the text: no Control Store table and no log line holds a marker', async () => {
    const hits = await w.db.asSuperuser(async (c) => {
      const tables = await c.query(
        `SELECT format('%I.%I', table_schema, table_name) AS t FROM information_schema.tables
          WHERE table_type = 'BASE TABLE'
            AND table_schema NOT IN ('pg_catalog', 'information_schema')`,
      )
      const found: string[] = []
      for (const { t } of tables.rows as { t: string }[]) {
        const n = await c.query(
          `SELECT count(*)::int AS n FROM ${t} x WHERE x::text LIKE '%' || $1 || '%' OR x::text LIKE '%' || $2 || '%'`,
          [MARKER, SECRET],
        )
        if ((n.rows[0]?.n ?? 0) > 0) found.push(t)
      }
      return { found, tables: tables.rowCount ?? 0 }
    })
    expect(hits.tables).toBeGreaterThan(20)
    expect(hits.found).toEqual([])
    expect(w.logLines.filter((l) => l.includes(MARKER) || l.includes(SECRET))).toEqual([])
  })
})
