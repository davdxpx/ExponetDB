import { createCheckpoint } from '@exponetdb/audit'
import { buildOpenApi, ROUTE_LIST } from '@exponetdb/contracts'
import { claimDueTask, finishTask, registerProcess, registerTasks } from '@exponetdb/control-store'
import { type MigratedTestDatabase, migratedTestDatabase } from '@exponetdb/control-store/testing'
import { type JsonObject, newId, systemClock } from '@exponetdb/kernel'
import { initPki } from '@exponetdb/nodes'
import { createLogger, MetricsRegistry, pass, Readiness, warn } from '@exponetdb/observability'
import { KindRegistry, processNextOperation } from '@exponetdb/operations'
import {
  generateKeyringText,
  type Keyring,
  parseKeyring,
  registerActiveKey,
} from '@exponetdb/secrets'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { composeAccess, workerKinds } from '../src/composition/access.ts'
import type { ServeConfig } from '../src/config/env.ts'
import { createPublicApp, httpMetrics } from '../src/interfaces/http/app.ts'
import {
  enrollOwner,
  ORIGIN,
  type Person,
  placeTarget,
  registryWorld,
  type SimulatedNode,
  simulatedNode,
  storeOf,
  type World,
} from './support/node-world.ts'

/**
 * The Wave 8 server batch S1 over the real public app (order §9), on
 * PostgreSQL 17: installation health, the health history of a target, the
 * audit chain, node jobs and certificates, the plan to operation link and the
 * retry flag of an operation, the promotion stream of a project and the
 * OpenAPI document. Authorization is the central engine's: a person with a
 * role, a service account with an API key restricted in tier or without the
 * permission, and nobody at all.
 */
let db: MigratedTestDatabase
let keyring: Keyring
let app: ReturnType<typeof createPublicApp>
let owner: Person
let registry: KindRegistry
let readiness: Readiness
let world: World
let node: SimulatedNode
let nonprodTarget = ''
let prodTarget = ''

const STATUS = {
  running: true,
  acceptingConnections: true,
  version: '17.6',
  postmasterStartTime: '2026-10-01T03:12:44Z',
  inRecovery: false,
  dataDirectory: '/var/lib/postgresql/17/main',
}

const answer = (capability: string): JsonObject => {
  if (capability === 'postgres.status@1') return STATUS
  throw new Error(`no answer for ${capability}`)
}

beforeAll(async () => {
  db = await migratedTestDatabase('exdb_it_http_wave8')
  const parsed = parseKeyring(generateKeyringText('test-key'))
  if (!parsed.ok) throw new Error('keyring')
  keyring = parsed.value
  const worker = storeOf(db, 'exdb_worker')
  await registerActiveKey(worker, keyring)
  await worker.transaction('test.pki', (tx) =>
    initPki(tx, keyring, systemClock, {
      gatewayUrl: 'https://10.8.2.2:7443',
      serverName: 'gateway.exdb.test',
    }),
  )
  const config: ServeConfig = {
    role: 'serve',
    logLevel: 'warn',
    otlpEndpoint: undefined,
    controlStoreUrl: db.url('exdb_serve'),
    installationId: db.installationId,
    keyringEnv: {},
    internalListen: { host: '127.0.0.1', port: 0 },
    shutdownTimeoutMs: 10_000,
    listen: { host: '127.0.0.1', port: 0 },
    publicUrl: ORIGIN,
    webauthnRpId: undefined,
    trustedProxies: [],
    egressAddresses: [],
    mcpAllowedOrigins: [],
    clientRegistration: 'review',
  }
  const logger = createLogger({ role: 'serve', level: 'warn', write: () => undefined })
  // serve's own readiness, as the role composes it: the checks its probes run.
  readiness = new Readiness(systemClock)
  readiness.register({ name: 'control_store', severity: 'critical', run: async () => pass() })
  readiness.register({ name: 'schema', severity: 'critical', run: async () => pass() })
  await readiness.evaluate()
  const access = composeAccess(
    config,
    { store: storeOf(db, 'exdb_serve'), keyring, readiness },
    { clock: systemClock },
  )
  expect((await access.roleCatalogCheck.run()).status).toBe('pass')
  expect((await access.scopeCatalogCheck.run()).status).toBe('pass')
  app = createPublicApp(
    {
      readiness: () => ({ status: 'ready', evaluatedAt: new Date().toISOString(), checks: [] }),
      version: '0.0.0-test',
      logger,
      metrics: httpMetrics(new MetricsRegistry()),
      clock: systemClock,
    },
    {
      api: {
        application: access.application,
        publicOrigin: ORIGIN,
        trustedProxies: [],
        logger,
        available: access.available,
      },
    },
  )
  owner = await enrollOwner(db, (input, init) => app.request(input, init))
  registry = new KindRegistry(
    workerKinds({ store: worker, keyring }, { clock: systemClock }, db.installationId),
  )
  world = await registryWorld(db)
  nonprodTarget = await placeTarget(db, world, 'nonprod')
  prodTarget = await placeTarget(db, world, 'prod')
}, 240_000)

afterAll(async () => {
  await node?.stop()
  await db?.drop()
})

async function drive() {
  for (let i = 0; i < 20; i++) {
    const r = await processNextOperation(storeOf(db, 'exdb_worker'), {
      workerId: newId('prc', Date.now()),
      kinds: registry,
      clock: systemClock,
    })
    if (r.status === 'idle') return
  }
}

/** Sets a target's lifecycle state directly (the registry workflows have their own tests). */
async function setTargetState(targetId: string, state: 'registered' | 'active') {
  await db.asSuperuser(async (c) => {
    await c.query('BEGIN')
    await c.query("SET LOCAL session_replication_role = 'replica'")
    await c.query(
      'UPDATE registry.targets SET state = $2, state_changed_at = now() WHERE target_id = $1',
      [targetId, state],
    )
    await c.query('COMMIT')
  })
}

async function bearer(token: string | undefined, path: string, method = 'GET', body?: unknown) {
  const response = await app.request(`${ORIGIN}${path}`, {
    method,
    headers: {
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  return {
    status: response.status,
    // biome-ignore lint/suspicious/noExplicitAny: a parsed JSON body, asserted by each test.
    body: (text.length === 0 ? undefined : JSON.parse(text)) as any,
    text,
    response,
  }
}

/** A service account bound to a role, through the planned access change the owner applies. */
async function serviceAccount(
  name: string,
  roleId: string,
  scope: object = { kind: 'global' },
): Promise<string> {
  await owner.reauth()
  const created = await owner.browser.call('POST', '/api/v1/service-accounts', {
    displayName: name,
  })
  expect(created.status).toBe(201)
  const planned = await owner.browser.call('POST', '/api/v1/role-bindings', {
    identityId: created.body.id,
    roleId,
    scope,
  })
  expect(planned.status, planned.text).toBe(201)
  await owner.reauth()
  expect(
    (await owner.browser.call('POST', `/api/v1/plans/${planned.body.id}/apply`, {})).status,
  ).toBe(202)
  await drive()
  return String(created.body.id)
}

async function apiKey(
  account: string,
  scopes: string[],
  tiers: ('prod' | 'nonprod')[] = ['nonprod'],
): Promise<string> {
  await owner.reauth()
  const key = await owner.browser.call('POST', `/api/v1/service-accounts/${account}/api-keys`, {
    scopes,
    restrictions: { tiers, targets: { kind: 'all' } },
    lifetimeDays: 30,
    ...(tiers.includes('prod') ? { acknowledgeProductionWrite: true } : {}),
  })
  expect(key.status, key.text).toBe(201)
  return String(key.body.secret)
}

const NEW_ROUTES = [
  '/api/v1/installation/health',
  '/api/v1/audit-events/chain',
  '/api/v1/nodes/certificates',
  '/api/v1/projects/prj_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z/migrations',
  '/api/v1/targets/tgt_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z/health/history',
  '/api/v1/nodes/nod_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z/jobs',
]

describe('the OpenAPI document', () => {
  it('is public, is the contract the generator writes, and says what is not served answers NOT_FOUND', async () => {
    const r = await bearer(undefined, '/api/v1/openapi.json')
    expect(r.status).toBe(200)
    expect(r.response.headers.get('content-type')).toBe(
      'application/vnd.oai.openapi+json;version=3.1.1',
    )
    expect(r.response.headers.get('cache-control')).toBe('no-store')
    expect(r.body).toEqual(JSON.parse(JSON.stringify(buildOpenApi())))
    expect(r.body.openapi).toBe('3.1.1')
    expect(Object.keys(r.body.paths)).toEqual(
      expect.arrayContaining([
        '/installation/health',
        '/audit-events/chain',
        '/nodes/certificates',
        '/nodes/{nodeId}/jobs',
        '/projects/{projectId}/migrations',
        '/targets/{target}/health/history',
      ]),
    )
    expect(r.body.info.description).toContain('answers 404 NOT_FOUND')
    // One path per contracted operation, served or not.
    expect(Object.values(r.body.paths).flatMap((p) => Object.keys(p as object)).length).toBe(
      ROUTE_LIST.length,
    )
    // A path nobody serves answers NOT_FOUND, as the document says; every contracted operation is
    // served now (the ledger reconciliation plan, TC-007, was the last one that was not).
    const unserved = await bearer(
      undefined,
      '/api/v1/targets/tgt_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z/ledger/not-a-route',
      'POST',
      {},
    )
    expect([unserved.status, unserved.body.code]).toEqual([404, 'NOT_FOUND'])
    const reconcile = await bearer(
      undefined,
      '/api/v1/targets/tgt_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z/ledger/reconcile-plans',
      'POST',
      {},
    )
    expect([reconcile.status, reconcile.body.code]).toEqual([401, 'UNAUTHENTICATED'])
    // Only a read: nothing else answers at that path.
    expect((await bearer(undefined, '/api/v1/openapi.json', 'POST', {})).status).toBe(404)
  })

  it('needs no credential, but the routes it lists do', async () => {
    for (const path of NEW_ROUTES) {
      const r = await bearer(undefined, path)
      expect([r.status, r.body.code], path).toEqual([401, 'UNAUTHENTICATED'])
    }
  })
})

describe('installation health', () => {
  const component = (
    body: { components: { component: string; reasons?: string[] }[] },
    name: string,
  ) => body.components.find((c) => c.component === name)

  it('reports each component with its source and time, and what it cannot observe', async () => {
    const r = await owner.browser.call('GET', '/api/v1/installation/health')
    expect(r.status, r.text).toBe(200)
    expect(r.body.state).toBe('degraded')
    // Serve's own readiness: sampled, with the time the loop evaluated it.
    expect(component(r.body, 'control_store')).toMatchObject({
      state: 'operational',
      source: 'sampled',
    })
    expect(component(r.body, 'keyring')).toMatchObject({
      state: 'operational',
      source: 'live',
      values: { missingKeys: 0, mismatchedKeys: 0 },
    })
    // No worker, no data-read worker: said, never "operational" by default.
    expect(component(r.body, 'workers')).toMatchObject({
      state: 'degraded',
      source: 'inferred',
      reasons: ['no_live_worker'],
    })
    expect(component(r.body, 'data_reads')).toMatchObject({
      state: 'degraded',
      reasons: ['no_live_data_read_worker'],
    })
    // A task no worker ever registered and a gateway nobody needs are not observed, and say so.
    expect(r.body.unobserved).toEqual(
      expect.arrayContaining([
        { component: 'maintenance', reason: 'never_registered' },
        { component: 'samplers', reason: 'never_registered' },
        { component: 'gateway', reason: 'not_applicable' },
      ]),
    )
    expect(component(r.body, 'samplers')).toBeUndefined()
    expect(component(r.body, 'gateway')).toBeUndefined()
    // The audit chain has events (the enrollment) and no checkpoint, no export, no verification.
    expect(component(r.body, 'audit_chain')).toMatchObject({ state: 'degraded' })
    expect(component(r.body, 'audit_chain')?.reasons).toEqual(
      expect.arrayContaining([
        'no_checkpoint',
        'export_not_recorded',
        'full_verification_not_recorded',
        'incremental_verification_not_recorded',
      ]),
    )
    for (const c of r.body.components) {
      expect(Date.parse(c.observedAt), c.component).toBeGreaterThan(Date.now() - 60_000)
      expect(['live', 'sampled', 'cached', 'agent_reported', 'inferred']).toContain(c.source)
    }
    // No build, commit, host or address leaves the process.
    expect(r.text).not.toMatch(/commit|build|10\.8\.2\.2|gateway\.exdb\.test|hostname/i)
  })

  it('turns operational as the worker, the data-read worker and the maintenance tasks report', async () => {
    const worker = storeOf(db, 'exdb_worker')
    const workerId = newId('prc', Date.now())
    await registerProcess(worker, {
      processId: workerId,
      role: 'worker',
      buildVersion: '1.2.3',
      buildCommit: 'deadbeef',
    })
    await db.asSuperuser((c) =>
      c.query(
        `INSERT INTO dataread.workers (worker_id, public_key) VALUES ($1, decode(repeat('00', 32), 'hex'))`,
        [workerId],
      ),
    )
    await registerTasks(worker, [
      'health.sample',
      'audit.checkpoint',
      'audit.export',
      'audit.verify_incremental',
      'audit.verify_full',
    ])
    for (const task of [
      'health.sample',
      'audit.checkpoint',
      'audit.export',
      'audit.verify_incremental',
      'audit.verify_full',
    ]) {
      const claimed = await claimDueTask(worker, workerId, [task], 300)
      expect(claimed).toBe(task)
      await finishTask(
        worker,
        task,
        workerId,
        task === 'audit.export' ? 'skipped' : 'succeeded',
        task === 'audit.export' ? 'export_unconfigured' : null,
        15,
      )
    }
    const r = await owner.browser.call('GET', '/api/v1/installation/health')
    expect(component(r.body, 'workers')).toMatchObject({
      state: 'operational',
      source: 'sampled',
      values: { liveWorkers: 1 },
    })
    expect(component(r.body, 'data_reads')).toMatchObject({ state: 'operational' })
    expect(component(r.body, 'samplers')).toMatchObject({ state: 'operational' })
    expect(component(r.body, 'maintenance')).toMatchObject({ state: 'operational' })
    // The export task says it is not configured: degraded with that reason, not "fine".
    expect(component(r.body, 'audit_chain')?.reasons).toContain('export_unconfigured')
    expect(component(r.body, 'audit_chain')?.reasons).not.toContain(
      'incremental_verification_not_recorded',
    )
    expect(r.text).not.toContain('deadbeef')
  })

  it('shows a lagging, a failing and an overdue worker task', async () => {
    await db.asSuperuser((c) =>
      c.query(
        `UPDATE control.maintenance_tasks SET next_run_at = clock_timestamp() - interval '5 minutes' WHERE task = 'health.sample'`,
      ),
    )
    let r = await owner.browser.call('GET', '/api/v1/installation/health')
    expect(component(r.body, 'samplers')).toMatchObject({
      state: 'degraded',
      reasons: ['sampler_lagging'],
    })
    await db.asSuperuser((c) =>
      c.query(
        `UPDATE control.maintenance_tasks SET consecutive_failures = 3, last_outcome = 'failed', last_reason = 'task_failed',
                next_run_at = clock_timestamp() - interval '20 minutes' WHERE task = 'audit.checkpoint'`,
      ),
    )
    r = await owner.browser.call('GET', '/api/v1/installation/health')
    expect(component(r.body, 'maintenance')).toMatchObject({
      state: 'degraded',
      reasons: ['tasks_failing', 'tasks_overdue'],
    })
    expect(r.body.state).toBe('degraded')
    await db.asSuperuser((c) =>
      c.query(
        `UPDATE control.maintenance_tasks SET consecutive_failures = 0, last_outcome = 'succeeded', last_reason = NULL,
                next_run_at = clock_timestamp() + interval '1 minute' WHERE task IN ('health.sample', 'audit.checkpoint')`,
      ),
    )
  })

  it('degrades the control store component when serve itself reports a failing check', async () => {
    readiness.register({
      name: 'role_credential',
      severity: 'critical',
      run: async () => warn('login_unverified'),
    })
    await readiness.evaluate()
    const r = await owner.browser.call('GET', '/api/v1/installation/health')
    expect(component(r.body, 'control_store')).toMatchObject({
      state: 'degraded',
      reasons: ['login_unverified'],
    })
  })

  it('needs nodes.read: a person without a role is refused, a viewer reads it, a restricted key reads it too (it names no target)', async () => {
    const viewer = await serviceAccount('Health viewer', 'viewer')
    const restricted = await apiKey(viewer, ['nodes.read'], ['nonprod'])
    const r = await bearer(restricted, '/api/v1/installation/health')
    expect([r.status, r.body.state === undefined]).toEqual([200, false])
    const bare = await serviceAccount('Health without role', 'viewer', {
      kind: 'target',
      targetId: nonprodTarget,
    })
    // A binding on one target holds nodes.read at that target only: not for the installation.
    const narrow = await apiKey(bare, ['nodes.read'], ['nonprod'])
    expect((await bearer(narrow, '/api/v1/installation/health')).status).toBe(403)
  })
})

describe('the health history of a target', () => {
  const path = (target: string, query = '') =>
    `/api/v1/targets/${encodeURIComponent(target)}/health/history${query}`

  it('answers an empty history of a target never sampled, truthfully', async () => {
    const r = await owner.browser.call('GET', path(nonprodTarget))
    expect(r.status, r.text).toBe(200)
    expect(r.body).toMatchObject({
      targetId: nonprodTarget,
      buckets: [],
      gaps: [],
      gapsTruncated: false,
      firstSampleAt: null,
      samplePeriodSeconds: 15,
      gapThresholdSeconds: 30,
      source: 'sampled',
    })
    expect(Date.parse(r.body.to) - Date.parse(r.body.from)).toBe(24 * 3_600_000)
  })

  it('downsamples what the sampler wrote, with the worst state per bucket and the gaps', async () => {
    // A registered target is not sampled yet, so it has no gaps; an active one is.
    await setTargetState(nonprodTarget, 'active')
    const now = Date.now()
    const start = now - 2 * 3_600_000
    const times: number[] = []
    for (let t = start; t < start + 1_800_000; t += 15_000) times.push(t)
    for (let t = start + 3_000_000; t < now - 60_000; t += 15_000) times.push(t)
    // Partitions start at today (UTC); in the first two hours after midnight these
    // back-dated samples fall on yesterday, which the sampler never writes to.
    await db.asSuperuser((c) =>
      c.query(`DO $$
        DECLARE day date := (date_trunc('day', now() AT TIME ZONE 'UTC') - interval '1 day')::date;
                name text := format('health_samples_d%s', to_char(day, 'YYYYMMDD'));
        BEGIN
          IF to_regclass(format('observation.%I', name)) IS NULL THEN
            EXECUTE format('CREATE TABLE observation.%I PARTITION OF observation.health_samples FOR VALUES FROM (%L) TO (%L)',
                           name, (day::text || ' 00:00:00+00')::timestamptz, ((day + 1)::text || ' 00:00:00+00')::timestamptz);
          END IF;
        END $$`),
    )
    await db.asSuperuser((c) =>
      c.query(
        `INSERT INTO observation.health_samples (sample_id, target_id, observed_at, state, probes, conditions)
         SELECT * FROM unnest($1::text[], $2::text[], $3::timestamptz[], $4::text[], $5::jsonb[], $6::jsonb[])`,
        [
          times.map((t) => newId('smp', t)),
          times.map(() => nonprodTarget),
          times.map((t) => new Date(t).toISOString()),
          times.map((t) => (t === start ? 'unreachable' : 'healthy')),
          times.map(() => '[]'),
          times.map(() => '[]'),
        ],
      ),
    )
    const r = await owner.browser.call('GET', path(nonprodTarget))
    expect(r.status, r.text).toBe(200)
    expect(r.body.bucketSeconds).toBe(300)
    expect(r.body.buckets.length).toBeLessThanOrEqual(501)
    expect(r.body.buckets[0]).toMatchObject({ worst: 'unreachable' })
    expect(r.body.buckets.reduce((n: number, b: { samples: number }) => n + b.samples, 0)).toBe(
      times.length,
    )
    // Between the two runs of samples: a gap; with no worker heartbeat at that time the cause is derived, not invented.
    expect(r.body.gaps.length).toBeGreaterThanOrEqual(1)
    const first = r.body.gaps[0]
    expect(['control_plane_down', 'sampler_lagging', 'unknown']).toContain(first.cause)
    expect(first.durationSeconds).toBeGreaterThanOrEqual(30)
    // The path form of {target} reads the same.
    const byPath = await owner.browser.call(
      'GET',
      path('nonprod-path-does-not-exist/platform/staging'),
    )
    expect([byPath.status, byPath.body.code]).toEqual([404, 'TARGET_NOT_FOUND'])
    await setTargetState(nonprodTarget, 'registered')
  })

  it('refuses a range that is not one, and a target the caller cannot see reads as unknown', async () => {
    const now = new Date()
    const iso = (ms: number) => new Date(ms).toISOString()
    for (const query of [
      `?from=${iso(now.getTime())}&to=${iso(now.getTime() - 1000)}`,
      `?from=${iso(now.getTime() - 61 * 86_400_000)}`,
      `?from=${iso(now.getTime() - 40 * 86_400_000)}&to=${iso(now.getTime() + 3_600_000)}`,
      `?from=${iso(now.getTime() - 3_600_000)}&to=${iso(now.getTime() + 3_600_000)}`,
      '?from=yesterday',
      '?window=24h',
    ]) {
      const r = await owner.browser.call('GET', path(nonprodTarget, query))
      expect([r.status, r.body.code], query).toEqual([422, 'VALIDATION_FAILED'])
    }
    // A key limited to production cannot see the nonprod target: it does not exist for it.
    const account = await serviceAccount('Prod diagnostics', 'viewer')
    const prodOnly = await apiKey(account, ['diagnostics.read'], ['prod'])
    const hidden = await bearer(prodOnly, path(nonprodTarget))
    expect([hidden.status, hidden.body.code]).toEqual([404, 'TARGET_NOT_FOUND'])
    expect((await bearer(prodOnly, path(prodTarget))).status).toBe(200)
    // Without the permission: refused.
    const noDiagnostics = await apiKey(account, ['targets.read'], ['nonprod', 'prod'])
    const refused = await bearer(noDiagnostics, path(nonprodTarget))
    expect(refused.status).toBe(403)
  })
})

describe('the audit chain', () => {
  it("shows the head, verifies it on request and says a full verification is the worker's", async () => {
    const before = await owner.browser.call('GET', '/api/v1/audit-events/chain')
    expect(before.status, before.text).toBe(200)
    expect(before.body.head).toMatchObject({ seq: expect.any(Number) })
    expect(before.body.checkpoints).toEqual([])
    expect(before.body.verification).toMatchObject({ status: 'verified', scope: 'full' })
    expect(before.body.verification.throughSeq).toBe(before.body.head.seq)
    expect(before.body.workerVerification).toMatchObject({
      runsIn: 'worker',
      resultPersisted: false,
      incremental: { outcome: 'succeeded' },
      full: { outcome: 'succeeded' },
    })
    expect(before.body.source).toBe('live')

    // A checkpoint: the next verification starts from it.
    await createCheckpoint(storeOf(db, 'exdb_worker'), 'manual')
    const after = await owner.browser.call('GET', '/api/v1/audit-events/chain')
    expect(after.body.checkpoints).toHaveLength(1)
    expect(after.body.checkpoints[0]).toMatchObject({
      reason: 'manual',
      hash: expect.stringMatching(/^sha256:ac1:/),
    })
    expect(after.body.verification).toMatchObject({
      status: 'verified',
      scope: 'from_checkpoint',
      anchorCheckpointSeq: after.body.checkpoints[0].seq,
    })
    expect(Date.parse(after.body.verification.verifiedAt)).toBeGreaterThan(Date.now() - 60_000)
  })

  it('describes an exporter by kind and progress, never by bucket, location or endpoint', async () => {
    await db.asSuperuser((c) =>
      c.query(
        `INSERT INTO audit.checkpoint_exports (checkpoint_seq, sink, location)
         SELECT max(seq), 's3.private-audit-bucket', 'org/ins/audit-checkpoints/00000000000000000001.json'
           FROM audit.audit_chain_checkpoints`,
      ),
    )
    const r = await owner.browser.call('GET', '/api/v1/audit-events/chain')
    expect(r.body.exports.sinks).toEqual([
      {
        kind: 's3',
        state: 'up_to_date',
        lastExportedSeq: expect.any(Number),
        lastExportedAt: expect.any(String),
        pendingCheckpoints: 0,
      },
    ])
    expect(r.text).not.toMatch(/private-audit-bucket|audit-checkpoints|org\/ins/)
    expect(r.body.exports.task).toMatchObject({ outcome: 'skipped', reason: 'export_unconfigured' })
  })

  it('reports a chain that was rewritten as broken, with the failing sequence, and not as an error', async () => {
    // New events after the checkpoint, then one of them altered by someone who bypasses the database's guards.
    const created = await owner.browser.call('POST', '/api/v1/servers', {
      displayName: 'audit tamper host',
      provider: 'other',
    })
    expect(created.status).toBe(201)
    const head = (await owner.browser.call('GET', '/api/v1/audit-events/chain')).body.head.seq
    await db.asSuperuser(async (c) => {
      await c.query('BEGIN')
      await c.query("SET LOCAL session_replication_role = 'replica'")
      await c.query(`UPDATE audit.audit_events SET action = 'test.other' WHERE seq = $1`, [head])
      await c.query('COMMIT')
    })
    // The altered row was cached 15 s ago at this head only if nothing changed: a new event moves the head.
    await owner.browser.call('POST', '/api/v1/servers', {
      displayName: 'second host',
      provider: 'other',
    })
    const r = await owner.browser.call('GET', '/api/v1/audit-events/chain')
    expect(r.status).toBe(200)
    expect(r.body.verification).toMatchObject({
      status: 'broken',
      failingSeq: head,
      reason: 'columns_mismatch',
    })
    await db.asSuperuser(async (c) => {
      await c.query('BEGIN')
      await c.query("SET LOCAL session_replication_role = 'replica'")
      await c.query(
        `UPDATE audit.audit_events SET action = 'plan.created' WHERE seq = $1 AND action = 'test.other'`,
        [head],
      )
      await c.query('COMMIT')
    })
  })

  it('needs audit.read and the whole installation: a viewer and a restricted delegation are refused', async () => {
    const auditor = await serviceAccount('Auditor bot', 'auditor')
    const unrestricted = await apiKey(auditor, ['audit.read'], ['nonprod', 'prod'])
    expect((await bearer(unrestricted, '/api/v1/audit-events/chain')).status).toBe(200)
    const nonprodOnly = await apiKey(auditor, ['audit.read'], ['nonprod'])
    const restricted = await bearer(nonprodOnly, '/api/v1/audit-events/chain')
    expect([restricted.status, restricted.body.code]).toEqual([403, 'PERMISSION_DENIED'])
    // A viewer holds the metadata reads and not audit.read: the key cannot even carry that scope.
    const viewer = await serviceAccount('Chain viewer', 'viewer')
    const viewerKey = await apiKey(viewer, ['nodes.read'], ['nonprod', 'prod'])
    expect((await bearer(viewerKey, '/api/v1/audit-events/chain')).status).toBe(403)
  })
})

describe('nodes: jobs, certificates and the gateway', () => {
  it('reads the certificates before any node exists: the PKI by its facts, the rest said', async () => {
    const r = await owner.browser.call('GET', '/api/v1/nodes/certificates')
    expect(r.status, r.text).toBe(200)
    expect(r.body.authorities.map((a: { role: string }) => a.role).sort()).toEqual([
      'gateway_server_ca',
      'issuing_ca',
      'root_ca',
    ])
    expect(r.body.notRecorded).toEqual([{ role: 'postgres_ca', reason: 'not_initialized' }])
    expect(r.body.nodes).toEqual([])
    expect(r.body.notKnown).toEqual([
      { subject: 'gateway_leaf', reason: 'in_memory_only' },
      { subject: 'external_server_certificates', reason: 'not_probed' },
    ])
    for (const a of r.body.authorities) {
      expect(a.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/)
      expect(a.subjectCommonName).toMatch(/^ExponetDB /)
      expect(Date.parse(a.notAfter)).toBeGreaterThan(Date.now())
    }
    expect(r.text).not.toMatch(/PRIVATE|BEGIN|sec_[0-7]|10\.8\.2\.2|gateway\.exdb\.test/)
  })

  it('answers /nodes/certificates before /nodes/{nodeId}, which would refuse the word as an id', async () => {
    const asNode = await owner.browser.call('GET', '/api/v1/nodes/certificates')
    expect(asNode.body.code).toBeUndefined()
    const list = await owner.browser.call('GET', '/api/v1/nodes')
    expect(list.status).toBe(200)
  })

  it('lists a node, its jobs newest first and its certificate expiry once a node is enrolled', async () => {
    node = await simulatedNode(db, keyring, world, (capability) => answer(capability))
    node.start()
    const empty = await owner.browser.call('GET', `/api/v1/nodes/${node.nodeId}/jobs`)
    expect(empty.status, empty.text).toBe(200)
    expect(empty.body).toEqual({ items: [], nextCursor: null })
    const inspected = await owner.browser.call('POST', `/api/v1/nodes/${node.nodeId}/inspections`, {
      capability: 'postgres.status@1',
      clusterId: world.clusterId,
      args: {},
    })
    expect(inspected.status, inspected.text).toBe(202)
    await drive()
    const jobs = await owner.browser.call('GET', `/api/v1/nodes/${node.nodeId}/jobs`)
    expect(jobs.body.items).toHaveLength(1)
    expect(jobs.body.items[0]).toMatchObject({
      nodeId: node.nodeId,
      operationId: inspected.body.id,
      capability: 'postgres.status',
      capabilityMajor: 1,
      state: 'completed',
      outcome: 'succeeded',
      resultVerified: true,
    })
    expect(Date.parse(jobs.body.items[0].finishedAt)).toBeGreaterThanOrEqual(
      Date.parse(jobs.body.items[0].startedAt),
    )
    // Never the envelope (it carries the signed arguments), the completion or a signature.
    expect(jobs.text).not.toMatch(/envelope|completion|signature|argsHash|nonce|nodeSignature/i)
    // Paging: one job per page, then the end.
    await owner.browser.call('POST', `/api/v1/nodes/${node.nodeId}/inspections`, {
      capability: 'postgres.status@1',
      clusterId: world.clusterId,
      args: {},
    })
    await drive()
    const page = await owner.browser.call('GET', `/api/v1/nodes/${node.nodeId}/jobs?limit=1`)
    expect(page.body.items).toHaveLength(1)
    expect(page.body.nextCursor).toMatch(/^r1_/)
    const second = await owner.browser.call(
      'GET',
      `/api/v1/nodes/${node.nodeId}/jobs?limit=1&cursor=${page.body.nextCursor}`,
    )
    expect(second.body.items).toHaveLength(1)
    expect(second.body.items[0].id).not.toBe(page.body.items[0].id)
    expect(second.body.nextCursor).toBeNull()
    // An unknown node, and a malformed query.
    const missing = await owner.browser.call(
      'GET',
      `/api/v1/nodes/${newId('nod', Date.now())}/jobs`,
    )
    expect([missing.status, missing.body.code]).toEqual([404, 'NOT_FOUND'])
    const bad = await owner.browser.call('GET', `/api/v1/nodes/${node.nodeId}/jobs?limit=0`)
    expect([bad.status, bad.body.code]).toEqual([422, 'VALIDATION_FAILED'])

    const certificates = await owner.browser.call('GET', '/api/v1/nodes/certificates')
    expect(certificates.body.nodes).toHaveLength(1)
    expect(certificates.body.nodes[0]).toMatchObject({
      nodeId: node.nodeId,
      serverId: world.serverId,
      state: 'active',
      serverCertificates: [],
    })
    expect(Date.parse(certificates.body.nodes[0].certificateExpiresAt)).toBeGreaterThan(Date.now())
  })

  it('reads the gateway from the heartbeats of the gateway process and of the node', async () => {
    const component = (body: { components: { component: string }[] }) =>
      body.components.find((c) => c.component === 'gateway')
    // A node is enrolled and its heartbeat is fresh; no gateway process runs: the agents cannot reach it.
    let r = await owner.browser.call('GET', '/api/v1/installation/health')
    expect(component(r.body)).toMatchObject({
      state: 'down',
      reasons: ['gateway_not_live'],
      values: { liveGateways: 0, enrolledNodes: 1, connectedNodes: 1 },
    })
    expect(r.body.state).toBe('down')
    await registerProcess(storeOf(db, 'exdb_gateway'), {
      processId: newId('prc', Date.now()),
      role: 'gateway',
      buildVersion: '1.2.3',
      buildCommit: 'deadbeef',
    })
    r = await owner.browser.call('GET', '/api/v1/installation/health')
    expect(component(r.body)).toMatchObject({
      state: 'operational',
      values: { liveGateways: 1, enrolledNodes: 1, connectedNodes: 1 },
    })
    expect(r.body.unobserved ?? []).not.toContainEqual({
      component: 'gateway',
      reason: 'not_applicable',
    })
    // The node falls silent: the gateway is up and no agent is connected.
    await db.asSuperuser((c) =>
      c.query(`UPDATE nodes.nodes SET last_heartbeat_at = now() - interval '10 minutes'`),
    )
    r = await owner.browser.call('GET', '/api/v1/installation/health')
    expect(component(r.body)).toMatchObject({ state: 'degraded', reasons: ['no_agent_connected'] })
  })

  it('refuses the certificates to a delegation restricted in tier, and shows them to a viewer without it', async () => {
    const viewer = await serviceAccount('Node viewer', 'viewer')
    const restricted = await apiKey(viewer, ['nodes.read'], ['nonprod'])
    const refused = await bearer(restricted, '/api/v1/nodes/certificates')
    expect([refused.status, refused.body.code]).toEqual([403, 'PERMISSION_DENIED'])
    const all = await apiKey(viewer, ['nodes.read'], ['nonprod', 'prod'])
    expect((await bearer(all, '/api/v1/nodes/certificates')).status).toBe(200)
    expect((await bearer(all, `/api/v1/nodes/${node.nodeId}/jobs`)).status).toBe(200)
    // Without nodes.read among its scopes the key cannot call it.
    const noScope = await apiKey(viewer, ['targets.read'], ['nonprod', 'prod'])
    const missing = await bearer(noScope, '/api/v1/nodes/certificates')
    expect([missing.status, missing.body.code]).toEqual([403, 'INSUFFICIENT_SCOPE'])
  })
})

describe('plans and operations', () => {
  async function planServer(name: string) {
    const planned = await owner.browser.call('POST', '/api/v1/servers', {
      displayName: name,
      provider: 'other',
    })
    expect(planned.status, planned.text).toBe(201)
    return planned.body.id as string
  }

  it('links a plan to the operation that applied it, and a plan not applied to none', async () => {
    const planId = await planServer('link host')
    const before = await owner.browser.call('GET', `/api/v1/plans/${planId}`)
    expect(before.body).toMatchObject({ id: planId, operationId: null })
    const applied = await owner.browser.call('POST', `/api/v1/plans/${planId}/apply`, {})
    expect(applied.status).toBe(202)
    const after = await owner.browser.call('GET', `/api/v1/plans/${planId}`)
    expect(after.body.operationId).toBe(applied.body.id)
    const operation = await owner.browser.call('GET', `/api/v1/operations/${applied.body.id}`)
    expect(operation.body).toMatchObject({ id: applied.body.id, planId })
    const list = await owner.browser.call('GET', '/api/v1/plans?limit=200')
    const listed = list.body.items.find((p: { id: string }) => p.id === planId)
    expect(listed.operationId).toBe(applied.body.id)
    const open = list.body.items.filter(
      (p: { operationId: string | null }) => p.operationId === null,
    )
    expect(open.every((p: { state: string }) => p.state !== 'consumed')).toBe(true)
    await drive()
  })

  it('says retryable exactly when the retry route accepts the operation', async () => {
    const cases: {
      state: string
      apply: string
      verification: string
      kind: string
      retryable: boolean
    }[] = [
      {
        state: 'needs_attention',
        apply: 'applied',
        verification: 'pending',
        kind: 'migration.apply',
        retryable: true,
      },
      {
        state: 'needs_attention',
        apply: 'partially_applied',
        verification: 'error',
        kind: 'migration.resume',
        retryable: true,
      },
      {
        state: 'needs_attention',
        apply: 'applied',
        verification: 'error',
        kind: 'migration.apply',
        retryable: true,
      },
      {
        state: 'needs_attention',
        apply: 'unknown',
        verification: 'pending',
        kind: 'migration.apply',
        retryable: false,
      },
      {
        state: 'needs_attention',
        apply: 'applied',
        verification: 'pending',
        kind: 'node.inspect',
        retryable: false,
      },
      {
        state: 'succeeded',
        apply: 'applied',
        verification: 'passed',
        kind: 'migration.apply',
        retryable: false,
      },
      {
        state: 'verification_failed',
        apply: 'applied',
        verification: 'failed',
        kind: 'migration.apply',
        retryable: false,
      },
      {
        state: 'queued',
        apply: 'not_started',
        verification: 'pending',
        kind: 'migration.apply',
        retryable: false,
      },
    ]
    for (const c of cases) {
      const planId = await planServer(`retry ${c.state} ${c.apply} ${c.kind}`)
      const applied = await owner.browser.call('POST', `/api/v1/plans/${planId}/apply`, {})
      expect(applied.status).toBe(202)
      await drive()
      // The operation as the engine would leave it: written past the state guards, as the suites do.
      await db.asSuperuser(async (client) => {
        await client.query('BEGIN')
        await client.query("SET LOCAL session_replication_role = 'replica'")
        await client.query(
          `UPDATE operations.operations SET state = $2, apply_outcome = $3, verification_outcome = $4, kind = $5,
                  lease_owner = NULL, lease_expires_at = NULL WHERE operation_id = $1`,
          [applied.body.id, c.state, c.apply, c.verification, c.kind],
        )
        await client.query('COMMIT')
      })
      const read = await owner.browser.call('GET', `/api/v1/operations/${applied.body.id}`)
      expect(read.body.retryable, JSON.stringify(c)).toBe(c.retryable)
      const listed = await owner.browser.call('GET', '/api/v1/operations?limit=200')
      expect(
        listed.body.items.find((o: { id: string }) => o.id === applied.body.id)?.retryable,
        `list ${JSON.stringify(c)}`,
      ).toBe(c.retryable)
      const retried = await owner.browser.call(
        'POST',
        `/api/v1/operations/${applied.body.id}/retry-verification`,
        {},
      )
      if (c.retryable) {
        expect([retried.status, retried.body.code], JSON.stringify(c)).toEqual([202, undefined])
      } else {
        expect([retried.status, retried.body.code], JSON.stringify(c)).toEqual([
          409,
          'OPERATION_NOT_RETRYABLE',
        ])
      }
    }
  })
})

describe('the promotion stream of a project', () => {
  const path = (projectId: string) => `/api/v1/projects/${projectId}/migrations`
  const ids: string[] = []

  beforeAll(async () => {
    const sum = (c: string) => `sha256:c1:${c.repeat(64)}`
    const now = Date.now()
    for (const [index, name] of ['first', 'second'].entries()) {
      const id = newId('op', now + index * 10).slice(3)
      ids.push(id)
      await db.asSuperuser((c) =>
        c.query(
          `INSERT INTO migrations.bundle_revisions
             (project_id, migration_id, revision, name, checksum, source_digest, bundle_digest, transactional,
              depends_on, manifest, defaults, manifest_yaml, up_sql, ingested_by)
           VALUES ($1, $2, 1, $3, $4, $5, $4, true, $6::text[], '{}', '{}', ''::bytea, ''::bytea, $7)`,
          [
            world.projectId,
            id,
            name,
            sum(String(index + 1)),
            `sha256:${String(index + 1).repeat(64)}`,
            index === 0 ? [] : [ids[0]],
            owner.identityId,
          ],
        ),
      )
    }
    // The nonprod target's mirror: the first migration applied and verified, the second not applied.
    const operationId = newId('op', Date.now())
    await db.asSuperuser(async (c) => {
      await c.query(
        `INSERT INTO operations.operations (operation_id, kind, kind_version, state, apply_outcome, verification_outcome, actor_kind, client_kind)
         VALUES ($1, 'registry.test', 1, 'queued', 'not_started', 'pending', 'system', 'system')`,
        [operationId],
      )
      await c.query(
        `INSERT INTO migrations.ledger_state (target_id, generation, ledger_state_hash, observed_at, divergent)
         VALUES ($1, 1, $2, now() - interval '5 minutes', false)`,
        [nonprodTarget, `sha256:ls1:${'e'.repeat(64)}`],
      )
      await c.query(
        `INSERT INTO migrations.ledger_mirror (target_id, generation, migration_id, origin, name, checksum, applied_seq, applied_at, operation_id)
         VALUES ($1, 1, $2, 'exponetdb', 'first', $3, 1, now() - interval '1 hour', $4)`,
        [nonprodTarget, ids[0], sum('1'), operationId],
      )
      await c.query(
        `INSERT INTO migrations.verification_mirror (verification_id, target_id, generation, migration_id, operation_id, status,
            started_at, finished_at, structural, engine, fingerprint)
         VALUES ($1, $2, 1, $3, $4, 'passed', now(), now(), '{}', '{}', 'fp')`,
        [newId('vfy', Date.now()), nonprodTarget, ids[0], operationId],
      )
    })
  })

  it('shows the mirror per bundle and environment, labeled as the mirror, to a person who reads the project', async () => {
    const r = await owner.browser.call('GET', path(world.projectId))
    expect(r.status, r.text).toBe(200)
    expect(r.body).toMatchObject({
      projectId: world.projectId,
      source: 'cached',
      graph: { valid: true, errors: [] },
      heads: [ids[1]],
      bundleCount: 2,
      truncated: false,
    })
    expect(r.body.environments.map((e: { slug: string }) => e.slug)).toEqual([
      'staging',
      'production',
    ])
    expect(r.body.environments[0].target).toMatchObject({ id: nonprodTarget })
    expect(r.body.environments[1].target).toMatchObject({ id: prodTarget })
    const cell = (bundle: number, environment: string) =>
      r.body.bundles[bundle].states.find(
        (s: { environment: string }) => s.environment === environment,
      )
    expect(cell(0, 'staging')).toMatchObject({
      state: 'verified',
      verification: { status: 'passed' },
    })
    expect(cell(1, 'staging')).toMatchObject({ state: 'not_applied' })
    // The production target has no mirror: unknown, never "not applied".
    expect(cell(0, 'production')).toMatchObject({ state: 'unknown', observedAt: null })
    expect(cell(1, 'production')).toMatchObject({ state: 'unknown' })
    // No address, credential or file text anywhere.
    expect(r.text).not.toMatch(/up_sql|10\.8\.2\.2|password/i)
  })

  it('is a read of the project: an unknown project is not found, a delegation restricted in tier is refused, and a person who reads one target only does not see the stream', async () => {
    const unknown = await owner.browser.call('GET', path(newId('prj', Date.now())))
    expect([unknown.status, unknown.body.code]).toEqual([404, 'NOT_FOUND'])
    const viewer = await serviceAccount('Stream viewer', 'viewer')
    const restricted = await apiKey(viewer, ['migrations.read'], ['nonprod'])
    const refused = await bearer(restricted, path(world.projectId))
    expect([refused.status, refused.body.code]).toEqual([403, 'PERMISSION_DENIED'])
    const all = await apiKey(viewer, ['migrations.read'], ['nonprod', 'prod'])
    const read = await bearer(all, path(world.projectId))
    expect(read.status, read.text).toBe(200)
    expect(read.body.environments.every((e: { target: unknown }) => e.target !== null)).toBe(true)
    // A role bound to one target covers that target, not the project: the project reads as unknown.
    const narrow = await serviceAccount('Target viewer', 'viewer', {
      kind: 'target',
      targetId: nonprodTarget,
    })
    const narrowKey = await apiKey(narrow, ['migrations.read'], ['nonprod', 'prod'])
    const hidden = await bearer(narrowKey, path(world.projectId))
    expect([hidden.status, hidden.body.code]).toEqual([404, 'NOT_FOUND'])
  })
})
