import { systemClock } from '@exponetdb/kernel'
import { WORKER_ACTOR } from '@exponetdb/operations'
import { CONNECTION_RULES, REGISTRY_RULES, RuleRegistry } from '@exponetdb/policy'
import { databaseBootstrapStatements, TargetSession } from '@exponetdb/postgres'
import {
  findTarget,
  getCluster,
  listCredentials,
  planClusterConfirm,
  planClusterRegister,
  planEndpointAdd,
  planEndpointRetire,
  planEnvironmentCreate,
  planProductCreate,
  planProjectCreate,
  planTargetRegister,
  type RegistryActor,
  RegistryError,
  type RegistryPolicyContext,
  suspendForIdentityMismatch,
  type TargetRecord,
} from '@exponetdb/registry'
import {
  dropDatabase,
  loginPassword,
  runAsSuperuser,
  serverFor,
  type TestServer,
  testTargets,
  withSuperuser,
} from '@exponetdb/testkit'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  actor,
  ensureRoles,
  type Harness,
  harness,
  operationError,
  plan,
  planContent,
  registerDatabase,
  run,
  submit,
  targetDatabase,
  verifyCredentials,
} from '../../registry/test/harness.ts'
import {
  currentBaseline,
  currentSchema,
  DiagnosticsError,
  dueDriftTargets,
  type HealthDeps,
  listSessions,
  planCancel,
  planDriftAccept,
  RegistrationSnapshotStore,
  readRawStatement,
  runDriftCheck,
  sampleTarget,
  tableStats,
  targetsToSample,
} from '../src/index.ts'
import { catalogFootprint } from './footprint.ts'

/**
 * Observed targets on a hosted provider (ADR-0039) on real PostgreSQL 17:
 * a cluster reachable through a session pooler only (the test server
 * stands in for the pooler: a real Supavisor is not available, so the login
 * suffix is proven at the session spec only), an observed registration that
 * needs the observer only and writes nothing to the database, the reads it
 * allows (health, schema, drift, statistics, sessions), the refusals of
 * every write and data read, and its identity by cluster and database oid.
 */
let h: Harness
let a: RegistryActor
const pg17: TestServer = serverFor(17)
const slug = `obs${Date.now().toString(36)}`
let clusterId = ''
let projectId = ''
let environmentId = ''
let databaseId = ''
let databaseName = ''
let target: TargetRecord
let policy: RegistryPolicyContext

const SCHEMA = [
  'CREATE TABLE public.accounts (id bigint PRIMARY KEY, email text NOT NULL)',
  "CREATE FUNCTION public.helper(integer) RETURNS integer LANGUAGE sql IMMUTABLE AS 'SELECT $1 + 1'",
]

const serveDeps = () => ({
  store: h.serve,
  connector: h.serveConnector,
  installationId: h.db.installationId,
})
const workerDeps = () => ({
  store: h.worker,
  connector: h.workerConnector,
  installationId: h.db.installationId,
})
const suspensions: string[] = []
const healthDeps = (): HealthDeps => ({
  ...workerDeps(),
  probeDeadlineMs: 2000,
  suspend: async (targetId, observed) => {
    suspensions.push(targetId)
    await suspendForIdentityMismatch(
      h.worker,
      { policy: h.context.policy, kinds: h.kinds, systemActor: WORKER_ACTOR },
      targetId,
      observed,
    )
  },
})

async function fresh(): Promise<TargetRecord> {
  const found = await findTarget(h.worker, target.targetId)
  if (found === undefined) throw new Error('target vanished')
  return found
}

async function refusal(promise: Promise<unknown>): Promise<{ code: string; details?: unknown }> {
  try {
    await promise
  } catch (error) {
    if (
      error instanceof RegistryError ||
      error instanceof DiagnosticsError ||
      (error instanceof Error && 'code' in error)
    ) {
      return {
        code: String((error as { code: unknown }).code),
        details: (error as { details?: unknown }).details,
      }
    }
    throw error
  }
  throw new Error('expected a refusal')
}

const catalogOf = (database: string) => catalogFootprint(pg17, database)
let footprint: Awaited<ReturnType<typeof catalogOf>>

const pooler = () => ({
  kind: 'pooler' as const,
  poolerMode: 'session' as const,
  host: '127.0.0.1',
  port: pg17.port,
  tlsServerName: testTargets().serverName,
  label: 'session pooler',
})

beforeAll(async () => {
  h = await harness('exdb_it_observed', {
    snapshots: (input) =>
      new RegistrationSnapshotStore({
        store: input.worker,
        connector: input.workerConnector,
        installationId: input.installationId,
      }),
  })
  a = actor()
  policy = {
    registry: new RuleRegistry([...REGISTRY_RULES, ...CONNECTION_RULES]),
    codeVersion: '0.1.0+test',
    clock: systemClock,
  }
  await ensureRoles(pg17)
  const product = await run(h, a, (tx) =>
    planProductCreate(tx, h.context, a, { slug, displayName: 'Observed' }),
  )
  const productId = String((await planContent(h, product.plan.planId))['productId'])
  const env = await run(h, a, (tx) =>
    planEnvironmentCreate(tx, h.context, a, productId, {
      // nonprod: a production registration waits for an approval (the policy of target.register).
      slug: 'staging',
      displayName: 'Staging',
      tier: 'nonprod',
    }),
  )
  environmentId = String((await planContent(h, env.plan.planId))['environmentId'])
  const project = await run(h, a, (tx) =>
    planProjectCreate(tx, h.context, a, { product: slug, slug: 'app', displayName: 'App' }),
  )
  projectId = String((await planContent(h, project.plan.planId))['projectId'])
}, 120_000)

afterAll(async () => {
  await h?.close()
  if (databaseName !== '') await dropDatabase(pg17, databaseName).catch(() => undefined)
})

describe('a cluster reachable through a session pooler only (ADR-0039 §4)', () => {
  it('refuses a cluster of transaction poolers only, and registers one of session poolers', async () => {
    const refused = await refusal(
      plan(h, (tx) =>
        planClusterRegister(tx, h.context, a, {
          displayName: 'transaction only',
          caBundle: testTargets().caPem,
          endpoints: [{ ...pooler(), poolerMode: 'transaction' }],
        }),
      ),
    )
    expect(refused.code).toBe('VALIDATION_FAILED')
    const reg = await run(h, a, (tx) =>
      planClusterRegister(tx, h.context, a, {
        displayName: 'hosted pg17',
        caBundle: testTargets().caPem,
        endpoints: [pooler()],
      }),
    )
    expect(reg.operation.state).toBe('succeeded')
    clusterId = String((await planContent(h, reg.plan.planId))['clusterId'])
  })

  it('verifies the observer and confirms the cluster through the pooler', async () => {
    await submit(h, a, clusterId, 'observer')
    await verifyCredentials(h)
    const confirm = await run(h, a, (tx) => planClusterConfirm(tx, h.context, a, clusterId, {}))
    expect(confirm.operation).toMatchObject({ state: 'succeeded', verificationOutcome: 'passed' })
    expect((await getCluster(h.worker, clusterId))?.state).toBe('active')
    const credentials = await listCredentials(h.worker, clusterId)
    expect(credentials.map((c) => [c.accessRole, c.state])).toEqual([['observer', 'active']])
  })

  it('opens observer sessions only: every other role is refused as cluster_pooler_only', async () => {
    const opened = await h.workerConnector.open({
      clusterId,
      database: 'postgres',
      role: 'observer',
      purpose: 'test/pooler-only',
    })
    try {
      expect(opened.endpoint.kind).toBe('pooler')
    } finally {
      await opened.session.close()
    }
    for (const role of ['reader', 'migrator', 'operator', 'verifier'] as const) {
      const refused = await refusal(
        h.workerConnector.open({ clusterId, database: 'postgres', role, purpose: 'test/refused' }),
      )
      expect(refused, role).toEqual({
        code: 'REGISTRY_CONFLICT',
        details: { reason: 'cluster_pooler_only' },
      })
    }
  })

  it('logs in through a suffixed pooler endpoint as exponetdb_<role>.<suffix>; the server session is the plain role (NOT PROVEN live)', async () => {
    // The seam stands in for a pooler that routes by the login: it receives the suffixed login and
    // opens the server session as the plain role. A real Supavisor is not available here.
    const original = TargetSession.open.bind(TargetSession)
    const logins: string[] = []
    let mapTo = (user: string) => user.replace(/\.[a-z0-9]+$/, '')
    const spy = vi.spyOn(TargetSession, 'open').mockImplementation((spec, options) => {
      logins.push(spec.user)
      const user = mapTo(spec.user)
      return original(
        { ...spec, user, password: user === spec.user ? spec.password : loginPassword(user) },
        options,
      )
    })
    try {
      const added = await run(h, a, (tx) =>
        planEndpointAdd(tx, h.context, a, clusterId, {
          ...pooler(),
          host: 'localhost',
          tlsServerName: undefined,
          label: 'suffixed pooler',
          loginSuffix: 'ref123',
        }),
      )
      expect(added.operation.state).toBe('succeeded')
      const endpoint = (await planContent(h, added.plan.planId))['endpoint'] as {
        endpointId: string
      }
      logins.length = 0
      const opened = await h.workerConnector.open({
        clusterId,
        database: 'postgres',
        role: 'observer',
        purpose: 'test/suffix',
        endpointId: endpoint.endpointId,
      })
      try {
        expect(logins).toEqual(['exponetdb_observer.ref123'])
        expect(opened.session.facts.user).toBe('exponetdb_observer')
        expect(opened.endpoint.loginSuffix).toBe('ref123')
      } finally {
        await opened.session.close()
      }
      // A pooler that maps the login to another role is refused before the session is used.
      mapTo = (user: string) => user.replace(/^exponetdb_observer\.[a-z0-9]+$/, 'exponetdb_reader')
      const mapped = await refusal(
        h.workerConnector.open({
          clusterId,
          database: 'postgres',
          role: 'observer',
          purpose: 'test/suffix',
          endpointId: endpoint.endpointId,
        }),
      )
      expect(mapped.code).toBe('TARGET_CREDENTIAL_INVALID')
      mapTo = (user: string) => user.replace(/\.[a-z0-9]+$/, '')
      const retired = await run(h, a, (tx) =>
        planEndpointRetire(tx, h.context, a, clusterId, endpoint.endpointId),
      )
      expect(retired.operation.state).toBe('succeeded')
    } finally {
      spy.mockRestore()
    }
  })
})

describe('an observed target (ADR-0039 §1)', () => {
  it('registers with the observer only, says it writes nothing, and writes nothing', async () => {
    databaseName = await targetDatabase(pg17, 'observed', SCHEMA)
    databaseId = await registerDatabase(h, a, clusterId, databaseName)
    // Neither the managed path (no migrator credential, no direct endpoint) nor a write happens.
    const managed = await refusal(
      plan(h, (tx) =>
        planTargetRegister(tx, h.context, a, {
          projectId: projectId as never,
          environmentId: environmentId as never,
          databaseId: databaseId as never,
        }),
      ),
    )
    expect(managed).toEqual({
      code: 'REGISTRY_CONFLICT',
      details: { reason: 'credential_missing' },
    })
    const before = await catalogOf(databaseName)
    footprint = before
    const r = await run(h, a, (tx) =>
      planTargetRegister(tx, h.context, a, {
        projectId: projectId as never,
        environmentId: environmentId as never,
        databaseId: databaseId as never,
        mode: 'observed',
      }),
    )
    expect(r.plan.body['analysis']).toMatchObject({ mode: 'observed', writes: [] })
    expect(String((r.plan.body['analysis'] as Record<string, unknown>)['noWrites'])).toMatch(
      /^no writes/,
    )
    expect(r.plan.body['expectedState']).toMatchObject({ credentials: { observer: 1 } })
    expect(
      r.operation,
      JSON.stringify(await operationError(h, r.operation.operationId)),
    ).toMatchObject({
      state: 'succeeded',
      verificationOutcome: 'passed',
    })
    const t = await findTarget(h.worker, String((await planContent(h, r.plan.planId))['targetId']))
    if (t === undefined) throw new Error('target not recorded')
    target = t
    expect([t.state, t.mode]).toEqual(['registered', 'observed'])
    expect(await catalogOf(databaseName)).toEqual(before)
    expect(before?.schemas).not.toContain('exponetdb')
    // The registration snapshot is the drift reference.
    expect(await currentBaseline(h.worker, t)).toMatchObject({ reason: 'registration' })
  })

  it('refuses every write path and every row read with TARGET_OBSERVED_ONLY', async () => {
    for (const role of ['migrator', 'operator', 'verifier', 'reader'] as const) {
      expect((await refusal(h.workerConnector.forTarget(target, role, 'test'))).code, role).toBe(
        'TARGET_OBSERVED_ONLY',
      )
    }
    // An observed target never becomes managed, and is not registered again.
    expect(
      (
        await refusal(
          plan(h, (tx) =>
            planTargetRegister(tx, h.context, a, {
              projectId: projectId as never,
              environmentId: environmentId as never,
              databaseId: databaseId as never,
            }),
          ),
        )
      ).code,
    ).toBe('TARGET_OBSERVED_ONLY')
    expect(
      await refusal(
        plan(h, (tx) =>
          planTargetRegister(tx, h.context, a, {
            projectId: projectId as never,
            environmentId: environmentId as never,
            databaseId: databaseId as never,
            mode: 'observed',
          }),
        ),
      ),
    ).toEqual({ code: 'REGISTRY_CONFLICT', details: { reason: 'path_taken' } })
    const context = { policy, observation: serveDeps() }
    expect(
      (
        await refusal(
          plan(h, (tx) =>
            planCancel(tx, context, a, target.targetId, {
              pid: 1,
              backendStart: '2026-11-03T00:00:00.000Z',
              queryStart: '2026-11-03T00:00:00.000Z',
            }),
          ),
        )
      ).code,
    ).toBe('TARGET_OBSERVED_ONLY')
    expect(
      (await refusal(readRawStatement(serveDeps(), target, { queryId: '1' } as never))).code,
    ).toBe('TARGET_OBSERVED_ONLY')
  })

  it('reads its schema, statistics and sessions as the observer', async () => {
    const live = await currentSchema(serveDeps(), target, 0)
    expect(live.source).toBe('live')
    expect(live.document.entries.some((e) => e.key.includes('accounts'))).toBe(true)
    const stats = await tableStats(serveDeps(), target, {})
    expect(stats.tables.some((t) => t.name === 'accounts')).toBe(true)
    const sessions = await listSessions(serveDeps(), target)
    expect(Array.isArray(sessions.sessions)).toBe(true)
  })

  it('is sampled by health, healthy, and never suspended', async () => {
    expect(await targetsToSample(h.worker)).toContain(target.targetId)
    const o = await sampleTarget(healthDeps(), await fresh())
    expect(o?.result.state).not.toBe('suspended')
    expect(o?.result.conditions.some((c) => c.condition === 'identity_mismatch')).toBe(false)
    expect(o?.result.probes.find((p) => p.probe === 'identity')?.outcome).toBe('ok')
    expect((await fresh()).state).toBe('registered')
    expect(await catalogOf(databaseName)).toEqual(footprint)
  })

  it('finds drift against the registration snapshot, on demand and on schedule', async () => {
    expect(await dueDriftTargets(h.worker, 100)).toContain(target.targetId)
    const clean = await runDriftCheck(workerDeps(), target, 'schedule')
    expect(clean.check.status).toBe('clean')
    expect(await catalogOf(databaseName)).toEqual(footprint)
    await runAsSuperuser(pg17, databaseName, ['CREATE TABLE public.planted (id integer)'])
    const drifted = await runDriftCheck(workerDeps(), target, a.identityId)
    expect(drifted.check.status).toBe('drifted')
    expect(drifted.items.length).toBeGreaterThan(0)
    expect(JSON.stringify(drifted)).toContain('planted')
    // Accepting drift is a plan, and an observed target takes none.
    const finding = drifted.items[0]
    expect(finding).toBeDefined()
    if (finding !== undefined) {
      expect(
        (
          await refusal(
            plan(h, (tx) =>
              planDriftAccept(
                tx,
                { policy, observation: serveDeps() } as never,
                a,
                finding.findingId,
                {},
              ),
            ),
          )
        ).code,
      ).toBe('TARGET_OBSERVED_ONLY')
    }
  })

  it('knows the database by its oid: the same name re-created is a mismatch, a finding, never a suspension', async () => {
    const recorded = target.placement?.databaseOid
    await withSuperuser(pg17, 'postgres', async (c) => {
      await c.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`)
      await c.query(`CREATE DATABASE "${databaseName}"`)
    })
    await runAsSuperuser(pg17, databaseName, [
      ...databaseBootstrapStatements(databaseName),
      ...SCHEMA,
    ])
    // The connector checks the oid itself before any reader does.
    const connector = await refusal(h.workerConnector.forTarget(target, 'observer', 'test/oid'))
    expect(connector).toMatchObject({
      code: 'TARGET_IDENTITY_MISMATCH',
      details: { reason: 'database_oid', recordedOid: recorded },
    })
    const refused = await refusal(currentSchema(serveDeps(), target, 0))
    expect(refused.code).toBe('TARGET_IDENTITY_MISMATCH')
    expect(refused.details).toMatchObject({ reason: 'database_oid', recordedOid: recorded })
    expect((refused.details as { observedOid: string }).observedOid).not.toBe(recorded)
    const o = await sampleTarget(healthDeps(), await fresh())
    expect(o?.result.state).toBe('unhealthy')
    expect(o?.result.conditions).toContainEqual(
      expect.objectContaining({ condition: 'identity_mismatch', severity: 'critical' }),
    )
    expect(o?.suspensionRequested).toBe(false)
    expect(suspensions).toEqual([])
    expect((await fresh()).state).toBe('registered')
  })
})
