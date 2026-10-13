import { type MigratedTestDatabase, migratedTestDatabase } from '@exponetdb/control-store/testing'
import { newId, systemClock } from '@exponetdb/kernel'
import { createLogger, MetricsRegistry } from '@exponetdb/observability'
import { type DispatchAdmission, KindRegistry, processNextOperation } from '@exponetdb/operations'
import {
  clusterBootstrapStatements,
  databaseBootstrapStatements,
  passwordStatements,
  ROLE_NAMES,
} from '@exponetdb/postgres'
import {
  generateKeyringText,
  type Keyring,
  parseKeyring,
  registerActiveKey,
} from '@exponetdb/secrets'
import {
  createDatabase,
  loginPassword,
  provisionRoles,
  runAsSuperuser,
  serverFor,
  testTargets,
  withClusterTurn,
} from '@exponetdb/testkit'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  codeVersion,
  composeAccess,
  POLICY_RULES,
  workerDispatchAdmission,
  workerKinds,
} from '../src/composition/access.ts'
import { type ObservationTasks, workerObservation } from '../src/composition/registry.ts'
import type { ServeConfig } from '../src/config/env.ts'
import { createPublicApp, httpMetrics } from '../src/interfaces/http/app.ts'
import {
  enrollFromLink,
  enrollOwner,
  ORIGIN,
  type Person,
  type Requester,
  storeOf,
} from './support/node-world.ts'

/**
 * Wave 8, order §9 endpoint 3: drift acceptance over the real public app and
 * the real worker kinds, on a PostgreSQL 17 Control Store and PostgreSQL 17
 * targets. Drift is made out of band with a superuser on a disposable target
 * database, found by a drift check, and accepted through
 * `POST /findings/{finding}/accept` and `plan.apply`: the target's current
 * snapshot becomes its baseline (`drift_accept`), the covered findings are
 * resolved `accepted`, the operation is verified, and the next drift check
 * is clean. A changed schema makes the plan stale (at apply and again before
 * execution); a health finding is not accepted (422); a resolved one is a
 * conflict; a person without `schema.manage` and a service account are
 * refused; production needs an approval (`drift.accept-prod`); critical
 * drift needs a reason; the audit names no catalog object.
 */
const pg17 = serverFor(17)
const slug = `da${Date.now().toString(36)}`

let db: MigratedTestDatabase
let app: ReturnType<typeof createPublicApp>
let request: Requester
let keyring: Keyring
let kinds: KindRegistry
let admit: DispatchAdmission
let observation: ObservationTasks
let owner: Person

const ids = {
  product: '',
  staging: '',
  production: '',
  project: '',
  cluster: '',
  stagingTarget: '',
  productionTarget: '',
  stagingDb: '',
  productionDb: '',
}
/** Plans and operations of drift acceptances in this run (their audit is checked at the end). */
const acceptPlans: string[] = []
const acceptOperations: string[] = []

beforeAll(async () => {
  db = await migratedTestDatabase('exdb_it_http_drift_accept')
  const parsed = parseKeyring(generateKeyringText('test-key'))
  if (!parsed.ok) throw new Error('keyring')
  keyring = parsed.value
  const serve = storeOf(db, 'exdb_serve')
  const worker = storeOf(db, 'exdb_worker')
  await registerActiveKey(worker, keyring)
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
  const access = composeAccess(config, { store: serve, keyring }, { clock: systemClock })
  expect((await access.roleCatalogCheck.run()).status).toBe('pass')
  expect((await access.scopeCatalogCheck.run()).status).toBe('pass')
  const logger = createLogger({ role: 'serve', level: 'warn', write: () => undefined })
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
  request = (input, init) => app.request(input, init)
  const list = workerKinds({ store: worker, keyring }, { clock: systemClock }, db.installationId)
  kinds = new KindRegistry(list)
  admit = workerDispatchAdmission(list, { clock: systemClock })
  observation = workerObservation(
    { store: worker, keyring, clock: systemClock, installationId: db.installationId },
    list,
    POLICY_RULES,
    codeVersion(),
    createLogger({ role: 'worker', level: 'warn', write: () => undefined }),
  )
  await provisionRoles(pg17, {
    roles: ROLE_NAMES,
    cluster: (v) => clusterBootstrapStatements(v),
    passwords: (v) => passwordStatements(v),
  })
}, 120_000)

afterAll(async () => {
  await db?.drop()
})

async function drive() {
  // Parallel suites share the target cluster and its per-role connection limits: take turns.
  await withClusterTurn(pg17, async () => {
    for (let i = 0; i < 30; i++) {
      const r = await processNextOperation(storeOf(db, 'exdb_worker'), {
        workerId: newId('prc', Date.now()),
        kinds,
        clock: systemClock,
        admit,
      })
      if (r.status === 'idle') return
    }
  })
}

async function planAndApply(path: string, body: unknown, options: { reauth?: boolean } = {}) {
  const planned = await owner.browser.call('POST', path, body)
  expect([planned.status, planned.body?.code], planned.text).toEqual([201, undefined])
  if (options.reauth === true) await owner.reauth()
  const applied = await owner.browser.call('POST', `/api/v1/plans/${planned.body.id}/apply`, {})
  expect([applied.status, applied.body?.code], applied.text).toEqual([202, undefined])
  await drive()
  return { plan: planned.body, operation: applied.body }
}

async function operation(id: string) {
  return (await owner.browser.call('GET', `/api/v1/operations/${id}`)).body
}

async function registerDatabase(label: string): Promise<{ id: string; name: string }> {
  const name = await createDatabase(pg17, label)
  await runAsSuperuser(pg17, name, databaseBootstrapStatements(name))
  await planAndApply(`/api/v1/clusters/${ids.cluster}/databases`, { name })
  const dbs = await owner.browser.call('GET', `/api/v1/clusters/${ids.cluster}/databases`)
  return { id: dbs.body.items.find((d: { name: string }) => d.name === name).id, name }
}

/** Runs a drift check and returns the open drift findings of the target, newest first. */
async function driftFindings(targetId: string) {
  const check = await owner.browser.call('POST', `/api/v1/targets/${targetId}/drift-checks`, {})
  expect(check.status, check.text).toBe(201)
  const list = await owner.browser.call(
    'GET',
    `/api/v1/targets/${targetId}/findings?kind=drift&limit=200`,
  )
  expect(list.status).toBe(200)
  return { check: check.body, open: list.body.items as { id: string; severity: string }[] }
}

async function rows<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
  return db.asSuperuser(async (c) => (await c.query(sql, params)).rows as T[])
}

describe('setup over REST', () => {
  it('builds the registry, the cluster with its credentials and a nonprod and a production target', async () => {
    owner = await enrollOwner(db, request)
    await planAndApply('/api/v1/products', { slug, displayName: 'Drift acceptance' })
    const products = await owner.browser.call('GET', '/api/v1/products')
    ids.product = products.body.items.find((p: { slug: string }) => p.slug === slug).id
    await planAndApply(`/api/v1/products/${ids.product}/environments`, {
      slug: 'staging',
      displayName: 'Staging',
      tier: 'nonprod',
    })
    await planAndApply(`/api/v1/products/${ids.product}/environments`, {
      slug: 'production',
      displayName: 'Production',
      tier: 'prod',
      evidenceFrom: 'staging',
    })
    const envs = await owner.browser.call('GET', `/api/v1/products/${ids.product}/environments`)
    for (const e of envs.body.items) {
      if (e.slug === 'staging') ids.staging = e.id
      if (e.slug === 'production') ids.production = e.id
    }
    await planAndApply('/api/v1/projects', {
      product: slug,
      slug: 'platform',
      displayName: 'Platform',
    })
    const projects = await owner.browser.call('GET', `/api/v1/projects?product=${slug}`)
    ids.project = projects.body.items[0].id

    await planAndApply(
      '/api/v1/clusters',
      {
        displayName: 'pg17 drift',
        caBundle: testTargets().caPem,
        endpoints: [
          {
            kind: 'private',
            host: '127.0.0.1',
            port: pg17.port,
            tlsServerName: testTargets().serverName,
            label: 'direct',
          },
        ],
      },
      { reauth: true },
    )
    const clusters = await owner.browser.call('GET', '/api/v1/clusters')
    ids.cluster = clusters.body.items.find(
      (c: { displayName: string }) => c.displayName === 'pg17 drift',
    ).id
    await owner.reauth()
    expect(
      (
        await owner.browser.call('POST', `/api/v1/clusters/${ids.cluster}/credentials/observer`, {
          password: loginPassword(ROLE_NAMES.observer),
        })
      ).status,
    ).toBe(202)
    await observation.verifyCredentials()
    await planAndApply(`/api/v1/clusters/${ids.cluster}/confirm`, {}, { reauth: true })
    await owner.reauth()
    for (const role of ['migrator', 'reader', 'verifier'] as const) {
      const r = await owner.browser.call(
        'POST',
        `/api/v1/clusters/${ids.cluster}/credentials/${role}`,
        { password: loginPassword(ROLE_NAMES[role]) },
      )
      expect(r.status).toBe(202)
    }
    await observation.verifyCredentials()

    const staging = await registerDatabase('e2e_drift_staging')
    ids.stagingDb = staging.name
    await planAndApply('/api/v1/targets', {
      projectId: ids.project,
      environmentId: ids.staging,
      databaseId: staging.id,
    })
    ids.stagingTarget = (
      await owner.browser.call(
        'GET',
        `/api/v1/targets/${encodeURIComponent(`${slug}/platform/staging`)}`,
      )
    ).body.id
    const prod = await registerDatabase('e2e_drift_prod')
    ids.productionDb = prod.name
    const planned = await owner.browser.call('POST', '/api/v1/targets', {
      projectId: ids.project,
      environmentId: ids.production,
      databaseId: prod.id,
    })
    await owner.reauth()
    const applied = await owner.browser.call('POST', `/api/v1/plans/${planned.body.id}/apply`, {})
    expect(applied.body).toMatchObject({ state: 'awaiting_approval' })
    await owner.reauth()
    expect(
      (
        await owner.browser.call('POST', `/api/v1/approvals/${applied.body.id}/approve`, {
          planHash: planned.body.planHash,
          acknowledgeSelfApproval: true,
        })
      ).status,
    ).toBe(200)
    await drive()
    ids.productionTarget = (
      await owner.browser.call(
        'GET',
        `/api/v1/targets/${encodeURIComponent(`${slug}/platform/production`)}`,
      )
    ).body.id
    expect(ids.stagingTarget).toMatch(/^tgt_/)
    expect(ids.productionTarget).toMatch(/^tgt_/)
    // Both start clean against their registration baseline.
    expect((await driftFindings(ids.stagingTarget)).check.status).toBe('clean')
    expect((await driftFindings(ids.productionTarget)).check.status).toBe('clean')
  }, 240_000)
})

describe('drift acceptance on a nonprod target', () => {
  let accepted = ''

  it('records the current snapshot as the baseline, resolves the findings accepted and verifies', async () => {
    await runAsSuperuser(pg17, ids.stagingDb, [
      'CREATE TABLE public.drift_one (id bigint PRIMARY KEY, note text)',
    ])
    const { check, open } = await driftFindings(ids.stagingTarget)
    // The table and its key, index and sequence objects: one finding per drifted object.
    expect(check.status).toBe('drifted')
    expect(open.length).toBeGreaterThanOrEqual(1)
    expect(open).toHaveLength(check.counts.drifted)
    accepted = open[0]?.id ?? ''

    const planned = await owner.browser.call('POST', `/api/v1/findings/${accepted}/accept`, {})
    expect(planned.status, planned.text).toBe(201)
    expect(planned.body).toMatchObject({
      kind: 'drift.accept',
      class: 'standard',
      state: 'active',
      decision: 'allow',
      requirements: [],
      subject: { targetId: ids.stagingTarget, tier: 'nonprod' },
    })
    const content = planned.body.change.content
    expect(content).toMatchObject({
      targetId: ids.stagingTarget,
      findingId: accepted,
      reason: null,
    })
    // Every open drift finding of the target is covered (the new baseline is the whole schema).
    expect([...content.covered].sort()).toEqual(open.map((f) => f.id).sort())
    expect(content.fingerprint).toMatch(/^fp1:/)
    // The plan names ids and fingerprints, never the drifted object.
    expect(JSON.stringify(planned.body)).not.toContain('drift_one')
    acceptPlans.push(planned.body.id)

    const applied = await owner.browser.call('POST', `/api/v1/plans/${planned.body.id}/apply`, {})
    expect([applied.status, applied.body.state], applied.text).toEqual([202, 'queued'])
    acceptOperations.push(applied.body.id)
    await drive()
    expect(await operation(applied.body.id)).toMatchObject({
      state: 'succeeded',
      applyOutcome: 'applied',
      verificationOutcome: 'passed',
    })

    const baselines = await rows<{ reason: string; fingerprint: string; purpose: string }>(
      `SELECT b.reason, b.fingerprint, s.purpose FROM observation.schema_baselines b
         JOIN observation.schema_snapshots s ON s.snapshot_id = b.snapshot_id
        WHERE b.operation_id = $1`,
      [applied.body.id],
    )
    expect(baselines).toEqual([
      { reason: 'drift_accept', fingerprint: content.fingerprint, purpose: 'drift_accept' },
    ])
    const resolved = await rows<{ state: string; resolution: string }>(
      'SELECT state, resolution FROM observation.findings WHERE finding_id = ANY($1::text[])',
      [open.map((f) => f.id)],
    )
    expect(resolved).toEqual(open.map(() => ({ state: 'resolved', resolution: 'accepted' })))
    // The accepted schema is the expected one now: the next check is clean.
    const after = await driftFindings(ids.stagingTarget)
    expect([after.check.status, after.check.baselineFingerprint]).toEqual([
      'clean',
      content.fingerprint,
    ])
    expect(after.open).toEqual([])
  })

  it('refuses a finding that is already resolved (409 REGISTRY_CONFLICT, finding_resolved)', async () => {
    const again = await owner.browser.call('POST', `/api/v1/findings/${accepted}/accept`, {})
    expect([again.status, again.body.code, again.body.details]).toEqual([
      409,
      'REGISTRY_CONFLICT',
      { reason: 'finding_resolved' },
    ])
  })

  it('refuses a finding that is not a drift finding (422) and an unknown one (404)', async () => {
    const health = newId('fnd', Date.now())
    await rows(
      `INSERT INTO observation.findings (finding_id, target_id, kind, code, severity, dedup_key, summary, state)
       VALUES ($1, $2, 'health', 'probe_failed', 'warning', 'H:probe_failed', 'A probe failed', 'open')`,
      [health, ids.stagingTarget],
    )
    const refused = await owner.browser.call('POST', `/api/v1/findings/${health}/accept`, {})
    expect([refused.status, refused.body.code]).toEqual([422, 'VALIDATION_FAILED'])
    expect(refused.body.details.errors[0]).toMatchObject({
      path: '/finding',
      code: 'not_drift_finding',
    })
    const unknown = await owner.browser.call(
      'POST',
      `/api/v1/findings/${newId('fnd', Date.now())}/accept`,
      {},
    )
    expect([unknown.status, unknown.body.code]).toEqual([404, 'NOT_FOUND'])
    const malformed = await owner.browser.call('POST', '/api/v1/findings/nope/accept', {})
    expect(malformed.status).toBe(422)
  })

  it('is stale at apply when the schema changed after planning (409 PLAN_STALE), nothing recorded', async () => {
    await runAsSuperuser(pg17, ids.stagingDb, ['CREATE TABLE public.drift_two (id bigint)'])
    const { open } = await driftFindings(ids.stagingTarget)
    expect(open.length).toBeGreaterThanOrEqual(1)
    const planned = await owner.browser.call('POST', `/api/v1/findings/${open[0]?.id}/accept`, {})
    expect(planned.status, planned.text).toBe(201)
    acceptPlans.push(planned.body.id)
    const before = await rows('SELECT baseline_id FROM observation.schema_baselines')
    await runAsSuperuser(pg17, ids.stagingDb, [
      'ALTER TABLE public.drift_two ADD COLUMN extra text',
    ])
    const applied = await owner.browser.call('POST', `/api/v1/plans/${planned.body.id}/apply`, {})
    expect([applied.status, applied.body.code], applied.text).toEqual([409, 'PLAN_STALE'])
    expect(applied.body.details.changedBindings).toEqual(
      expect.arrayContaining([expect.objectContaining({ binding: 'schemaFingerprint' })]),
    )
    expect(await rows('SELECT baseline_id FROM observation.schema_baselines')).toHaveLength(
      before.length,
    )
    expect(
      (await owner.browser.call('GET', `/api/v1/plans/${planned.body.id}`)).body.state,
    ).not.toBe('active')
  })

  it('is stale before execution when the schema changes after acceptance: the operation fails, nothing recorded', async () => {
    const { open } = await driftFindings(ids.stagingTarget)
    expect(open.length).toBeGreaterThanOrEqual(1)
    const planned = await owner.browser.call('POST', `/api/v1/findings/${open[0]?.id}/accept`, {})
    expect(planned.status, planned.text).toBe(201)
    acceptPlans.push(planned.body.id)
    const applied = await owner.browser.call('POST', `/api/v1/plans/${planned.body.id}/apply`, {})
    expect([applied.status, applied.body.state], applied.text).toEqual([202, 'queued'])
    acceptOperations.push(applied.body.id)
    await runAsSuperuser(pg17, ids.stagingDb, [
      'ALTER TABLE public.drift_two ADD COLUMN later text',
    ])
    await drive()
    const failed = await operation(applied.body.id)
    expect(failed).toMatchObject({ state: 'failed', errorCode: 'PLAN_STALE' })
    expect(['not_started', 'not_applied']).toContain(failed.applyOutcome)
    expect(
      await rows('SELECT 1 FROM observation.schema_baselines WHERE operation_id = $1', [
        applied.body.id,
      ]),
    ).toEqual([])
  })

  it('requires a reason for critical drift, and covers every open drift finding of the target', async () => {
    await runAsSuperuser(pg17, ids.stagingDb, ['GRANT SELECT ON public.drift_one TO PUBLIC'])
    const { open } = await driftFindings(ids.stagingTarget)
    expect(open.some((f) => f.severity === 'critical')).toBe(true)
    const warning = open.find((f) => f.severity !== 'critical')
    expect(warning).toBeDefined()
    const without = await owner.browser.call('POST', `/api/v1/findings/${warning?.id}/accept`, {})
    expect([without.status, without.body.code]).toEqual([422, 'VALIDATION_FAILED'])
    expect(without.body.details.errors[0]).toMatchObject({
      path: '/reason',
      code: 'reason_required',
    })
    const tooShort = await owner.browser.call('POST', `/api/v1/findings/${warning?.id}/accept`, {
      reason: 'short',
    })
    expect(tooShort.status).toBe(422)
    const planned = await owner.browser.call('POST', `/api/v1/findings/${warning?.id}/accept`, {
      reason: 'Adopted after the incident review of the read grant',
    })
    expect(planned.status, planned.text).toBe(201)
    expect([...planned.body.change.content.covered].sort()).toEqual(open.map((f) => f.id).sort())
    expect(planned.body.change.analysis).toMatchObject({ covered: open.length })
    expect(planned.body.change.analysis.critical).toBeGreaterThanOrEqual(1)
    acceptPlans.push(planned.body.id)
    const applied = await owner.browser.call('POST', `/api/v1/plans/${planned.body.id}/apply`, {})
    expect(applied.status, applied.text).toBe(202)
    acceptOperations.push(applied.body.id)
    await drive()
    expect(await operation(applied.body.id)).toMatchObject({
      state: 'succeeded',
      verificationOutcome: 'passed',
    })
    const resolutions = await rows<{ resolution: string }>(
      'SELECT resolution FROM observation.findings WHERE finding_id = ANY($1::text[])',
      [open.map((f) => f.id)],
    )
    expect(resolutions.map((r) => r.resolution)).toEqual(open.map(() => 'accepted'))
    expect((await driftFindings(ids.stagingTarget)).check.status).toBe('clean')
  })
})

describe('who may accept drift', () => {
  let finding = ''

  beforeAll(async () => {
    await runAsSuperuser(pg17, ids.stagingDb, ['CREATE TABLE public.drift_three (id bigint)'])
    finding = (await driftFindings(ids.stagingTarget)).open[0]?.id ?? ''
    expect(finding).toMatch(/^fnd_/)
  })

  it('refuses a person without schema.manage (a viewer)', async () => {
    await owner.reauth()
    const invited = await owner.browser.call('POST', '/api/v1/identities', {
      email: 'viewer@example.test',
    })
    expect(invited.status, invited.text).toBe(201)
    const viewer = await enrollFromLink(request, invited.body.invitation.link)
    const binding = await owner.browser.call('POST', '/api/v1/role-bindings', {
      identityId: viewer.identityId,
      roleId: 'viewer',
      scope: { kind: 'global' },
    })
    expect(binding.status, binding.text).toBe(201)
    await owner.reauth()
    expect(
      (await owner.browser.call('POST', `/api/v1/plans/${binding.body.id}/apply`, {})).status,
    ).toBe(202)
    await drive()
    // The viewer sees the finding, but may not accept it.
    expect(
      (await viewer.browser.call('GET', `/api/v1/targets/${ids.stagingTarget}/findings`)).status,
    ).toBe(200)
    const refused = await viewer.browser.call('POST', `/api/v1/findings/${finding}/accept`, {})
    expect(refused.status, refused.text).toBe(403)
    expect(refused.body.code).toBe('PERMISSION_DENIED')
  })

  it('refuses a service account: schema.manage is never delegated, and its key is refused', async () => {
    await owner.reauth()
    const account = await owner.browser.call('POST', '/api/v1/service-accounts', {
      displayName: 'drift robot',
    })
    expect(account.status, account.text).toBe(201)
    const binding = await owner.browser.call('POST', '/api/v1/role-bindings', {
      identityId: account.body.id,
      roleId: 'admin',
      scope: { kind: 'global' },
    })
    expect(binding.status, binding.text).toBe(201)
    await owner.reauth()
    expect(
      (await owner.browser.call('POST', `/api/v1/plans/${binding.body.id}/apply`, {})).status,
    ).toBe(202)
    await drive()
    await owner.reauth()
    const manage = await owner.browser.call(
      'POST',
      `/api/v1/service-accounts/${account.body.id}/api-keys`,
      {
        scopes: ['schema.manage'],
        restrictions: { tiers: ['nonprod'], targets: { kind: 'all' } },
        lifetimeDays: 30,
      },
    )
    expect([manage.status, manage.body.code], manage.text).toEqual([403, 'SCOPE_NOT_DELEGABLE'])
    await owner.reauth()
    const key = await owner.browser.call(
      'POST',
      `/api/v1/service-accounts/${account.body.id}/api-keys`,
      {
        scopes: ['schema.read', 'diagnostics.read'],
        restrictions: { tiers: ['nonprod'], targets: { kind: 'all' } },
        lifetimeDays: 30,
      },
    )
    expect(key.status, key.text).toBe(201)
    const response = await app.request(`${ORIGIN}/api/v1/findings/${finding}/accept`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key.body.secret}`,
        'content-type': 'application/json',
      },
      body: '{}',
    })
    const body = (await response.json()) as { code: string }
    expect(response.status).toBe(403)
    // A human-only action: a service account's key is refused whatever its role (C-27).
    expect(body.code).toBe('PERMISSION_DENIED')
    // Nothing was planned for the robot.
    expect(
      await rows(`SELECT 1 FROM operations.plans WHERE kind = 'drift.accept' AND actor_id = $1`, [
        account.body.id,
      ]),
    ).toEqual([])
  })
})

describe('drift acceptance on a production target', () => {
  it('needs an approval and a fresh re-authentication (drift.accept-prod), then records the baseline', async () => {
    await runAsSuperuser(pg17, ids.productionDb, ['CREATE TABLE public.drift_prod (id bigint)'])
    const { open } = await driftFindings(ids.productionTarget)
    expect(open.length).toBeGreaterThanOrEqual(1)
    const planned = await owner.browser.call('POST', `/api/v1/findings/${open[0]?.id}/accept`, {})
    expect(planned.status, planned.text).toBe(201)
    expect(planned.body).toMatchObject({
      kind: 'drift.accept',
      class: 'high',
      decision: 'require',
      subject: { tier: 'prod' },
      approvals: { required: 1, given: 0 },
    })
    expect(planned.body.requirements).toEqual(
      expect.arrayContaining([
        { kind: 'approval', count: 1, permission: 'plans.approve' },
        { kind: 'reauth', withinSeconds: 300 },
      ]),
    )
    expect(planned.body.policyRules.map((r: { id: string }) => r.id)).toEqual(['drift.accept-prod'])
    acceptPlans.push(planned.body.id)
    await owner.reauth()
    const applied = await owner.browser.call('POST', `/api/v1/plans/${planned.body.id}/apply`, {})
    expect([applied.status, applied.body.state], applied.text).toEqual([202, 'awaiting_approval'])
    acceptOperations.push(applied.body.id)
    // Nothing runs while the approval is missing.
    await drive()
    expect((await operation(applied.body.id)).state).toBe('awaiting_approval')
    await owner.reauth()
    expect(
      (
        await owner.browser.call('POST', `/api/v1/approvals/${applied.body.id}/approve`, {
          planHash: planned.body.planHash,
          acknowledgeSelfApproval: true,
        })
      ).status,
    ).toBe(200)
    await drive()
    expect(await operation(applied.body.id)).toMatchObject({
      state: 'succeeded',
      verificationOutcome: 'passed',
    })
    expect(
      await rows<{ reason: string }>(
        'SELECT reason FROM observation.schema_baselines WHERE operation_id = $1',
        [applied.body.id],
      ),
    ).toEqual([{ reason: 'drift_accept' }])
    expect((await driftFindings(ids.productionTarget)).check.status).toBe('clean')
  })
})

describe('the audit of drift acceptances', () => {
  it('records each applied acceptance with ids, counts and fingerprints, and never a catalog object', async () => {
    const completed = await rows<{ event: string; operation_id: string }>(
      `SELECT event, operation_id FROM audit.audit_events
        WHERE action = 'drift.accept' AND phase = 'completed' ORDER BY seq`,
    )
    expect(completed).toHaveLength(3)
    for (const row of completed) {
      const event = JSON.parse(row.event)
      expect(Object.keys(event.changes).sort()).toEqual([
        'baselineId',
        'covered',
        'fingerprint',
        'previousBaselineId',
        'resolved',
        'snapshotId',
      ])
      expect(event.changes.fingerprint).toMatch(/^fp1:/)
      expect(event.actor).toMatchObject({ kind: 'system' })
    }
    expect(JSON.parse(completed[1]?.event ?? '{}').reason).toBe(
      'Adopted after the incident review of the read grant',
    )
    const events = await rows<{ event: string }>(
      `SELECT event FROM audit.audit_events
        WHERE plan_id = ANY($1::text[]) OR operation_id = ANY($2::text[])`,
      [acceptPlans, acceptOperations],
    )
    expect(events.length).toBeGreaterThan(completed.length)
    const text = events.map((e) => e.event).join('\n')
    for (const name of ['drift_one', 'drift_two', 'drift_three', 'drift_prod', 'public.']) {
      expect(text, name).not.toContain(name)
    }
    expect(text).toContain('operation.state_changed')
  })
})
