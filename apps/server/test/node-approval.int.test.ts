import { operationView } from '@exponetdb/application'
import { type MigratedTestDatabase, migratedTestDatabase } from '@exponetdb/control-store/testing'
import { type JsonObject, newId, systemClock } from '@exponetdb/kernel'
import { initPki, planNodeOperation } from '@exponetdb/nodes'
import { createLogger, MetricsRegistry } from '@exponetdb/observability'
import {
  type DispatchAdmission,
  KindRegistry,
  type OperationKind,
  processNextOperation,
  WORKER_ACTOR,
} from '@exponetdb/operations'
import { ACCESS_RULES, REGISTRY_RULES, RuleRegistry } from '@exponetdb/policy'
import { applyRegistryPlan } from '@exponetdb/registry'
import {
  generateKeyringText,
  type Keyring,
  parseKeyring,
  registerActiveKey,
} from '@exponetdb/secrets'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  codeVersion,
  composeAccess,
  workerDispatchAdmission,
  workerKinds,
} from '../src/composition/access.ts'
import { registryPolicy } from '../src/composition/registry.ts'
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
 * Wave 5 correction F2: a change through the node agent on a production (or
 * unknown-tier) cluster runs only after a human approval, through the real
 * plan, apply, approval and worker path: the REST API of `serve`, the
 * worker's kinds and dispatch admission as `runWorker` composes them, and a
 * simulated node that signs what it answers. Real PostgreSQL 17.
 */

let db: MigratedTestDatabase
let keyring: Keyring
let app: ReturnType<typeof createPublicApp>
let owner: Person
let kinds: readonly OperationKind[]
let registry: KindRegistry
let admit: DispatchAdmission

const STATUS = {
  running: true,
  acceptingConnections: true,
  version: '17.6',
  postmasterStartTime: '2026-10-01T03:12:44Z',
  inRecovery: false,
  dataDirectory: '/var/lib/postgresql/17/main',
}

function answers(capability: string): JsonObject {
  switch (capability) {
    case 'postgres.status@1':
      return STATUS
    case 'postgres.reload@2':
      return { reloadedAt: new Date().toISOString(), pendingRestart: [], fileErrors: [] }
    default:
      throw new Error(`no answer for ${capability}`)
  }
}

beforeAll(async () => {
  db = await migratedTestDatabase('exdb_it_node_approval')
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
  }
  const logger = createLogger({ role: 'serve', level: 'warn', write: () => undefined })
  const access = composeAccess(
    config,
    { store: storeOf(db, 'exdb_serve'), keyring },
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
  // The worker as runWorker composes it: its kinds and its dispatch admission.
  kinds = workerKinds({ store: worker, keyring }, { clock: systemClock }, db.installationId)
  registry = new KindRegistry(kinds)
  admit = workerDispatchAdmission(kinds, { clock: systemClock })
}, 180_000)

afterAll(async () => {
  await db?.drop()
})

/** Runs the worker until it is idle (each step of a node operation waits for the simulated node). */
async function drive(options: { readonly admit?: DispatchAdmission | null } = {}) {
  for (let i = 0; i < 20; i++) {
    const r = await processNextOperation(storeOf(db, 'exdb_worker'), {
      workerId: newId('prc', Date.now()),
      kinds: registry,
      clock: systemClock,
      ...(options.admit === null ? {} : { admit: options.admit ?? admit }),
    })
    if (r.status === 'idle') return
  }
}

async function view(operationId: string) {
  return operationView(storeOf(db, 'exdb_serve'), operationId, ORIGIN)
}

async function jobsOf(operationId: string): Promise<string[]> {
  const { rows } = await db.asSuperuser((c) =>
    c.query('SELECT capability FROM nodes.jobs WHERE operation_id = $1 ORDER BY created_at', [
      operationId,
    ]),
  )
  return rows.map((r) => String(r.capability))
}

/** A world, its node, and a fresh node-signed status observation of the cluster. */
async function setup(tier: 'prod' | 'nonprod' | 'unknown'): Promise<{
  w: World
  node: SimulatedNode
}> {
  const w = await registryWorld(db)
  if (tier !== 'unknown') {
    await placeTarget(db, w, tier)
  }
  const node = await simulatedNode(db, keyring, w, answers)
  node.start()
  const inspected = await owner.browser.call('POST', `/api/v1/nodes/${node.nodeId}/inspections`, {
    capability: 'postgres.status@1',
    clusterId: w.clusterId,
    args: {},
  })
  expect([inspected.status, inspected.body?.code]).toEqual([202, undefined])
  await drive()
  expect((await view(inspected.body.id)).state).toBe('succeeded')
  return { w, node }
}

async function planReload(w: World, node: SimulatedNode) {
  const planned = await owner.browser.call('POST', `/api/v1/nodes/${node.nodeId}/plans`, {
    clusterId: w.clusterId,
    change: { kind: 'postgres.reload' },
  })
  expect([planned.status, planned.body?.code]).toEqual([201, undefined])
  return planned.body as { id: string; planHash: string; decision: string; requirements: unknown[] }
}

async function approve(operationId: string, planHash: string) {
  await owner.reauth()
  return owner.browser.call('POST', `/api/v1/approvals/${operationId}/approve`, {
    planHash,
    acknowledgeSelfApproval: true,
  })
}

/** Test-only change of stored evidence the guards forbid (replica mode skips triggers). */
async function asReplica(sql: string, params: unknown[]) {
  await db.asSuperuser(async (c) => {
    await c.query('BEGIN')
    await c.query('SET LOCAL session_replication_role = replica')
    await c.query(sql, params)
    await c.query('COMMIT')
  })
}

describe('production approval of node operations (F2)', () => {
  it('holds a production reload for a human approval and creates no job before it', async () => {
    const { w, node } = await setup('prod')
    const plan = await planReload(w, node)
    expect(plan.requirements).toEqual([{ kind: 'approval', count: 1, permission: 'plans.approve' }])
    const applied = await owner.browser.call('POST', `/api/v1/plans/${plan.id}/apply`, {})
    expect(applied.body).toMatchObject({ state: 'awaiting_approval' })
    await drive()
    expect((await view(applied.body.id)).state).toBe('awaiting_approval')
    expect(await jobsOf(applied.body.id)).toEqual([])
    // A wrong plan hash approves nothing.
    const wrong = await approve(applied.body.id, `sha256:${'0'.repeat(64)}`)
    expect(wrong.status).not.toBe(200)
    expect(await jobsOf(applied.body.id)).toEqual([])
    expect((await approve(applied.body.id, plan.planHash)).status).toBe(200)
    expect((await view(applied.body.id)).state).toBe('queued')
    await drive()
    expect((await view(applied.body.id)).state).toBe('succeeded')
    expect(await jobsOf(applied.body.id)).toEqual([
      'postgres.status@1',
      'postgres.reload@2',
      'postgres.status@1',
    ])
    await node.stop()
  })

  it('treats a cluster of unknown tier as production', async () => {
    const { w, node } = await setup('unknown')
    const plan = await planReload(w, node)
    expect(plan.requirements).toEqual([{ kind: 'approval', count: 1, permission: 'plans.approve' }])
    const applied = await owner.browser.call('POST', `/api/v1/plans/${plan.id}/apply`, {})
    expect(applied.body).toMatchObject({ state: 'awaiting_approval' })
    await drive()
    expect(await jobsOf(applied.body.id)).toEqual([])
    await node.stop()
  })

  it('runs a nonprod reload without approval', async () => {
    const { w, node } = await setup('nonprod')
    const plan = await planReload(w, node)
    expect(plan.requirements).toEqual([])
    const applied = await owner.browser.call('POST', `/api/v1/plans/${plan.id}/apply`, {})
    expect(applied.body).toMatchObject({ state: 'queued' })
    await drive()
    expect((await view(applied.body.id)).state).toBe('succeeded')
    await node.stop()
  })

  it('makes a plan stale when its cluster became production before apply', async () => {
    const { w, node } = await setup('nonprod')
    const plan = await planReload(w, node)
    await placeTarget(db, w, 'prod')
    const applied = await owner.browser.call('POST', `/api/v1/plans/${plan.id}/apply`, {})
    expect(applied.body).toMatchObject({ code: 'PLAN_STALE' })
    await node.stop()
  })

  it('stops a queued operation whose cluster became production before it started', async () => {
    const { w, node } = await setup('nonprod')
    const plan = await planReload(w, node)
    const applied = await owner.browser.call('POST', `/api/v1/plans/${plan.id}/apply`, {})
    expect(applied.body).toMatchObject({ state: 'queued' })
    await placeTarget(db, w, 'prod')
    await drive()
    const after = await view(applied.body.id)
    expect(after).toMatchObject({ state: 'failed', applyOutcome: 'not_started' })
    expect(after.errorCode).toBe('PLAN_STALE')
    expect(await jobsOf(applied.body.id)).toEqual([])
    await node.stop()
  })

  it('starts nothing when an approval no longer holds at dispatch', async () => {
    for (const change of ['approver', 'hash', 'cooling'] as const) {
      const { w, node } = await setup('prod')
      const plan = await planReload(w, node)
      const applied = await owner.browser.call('POST', `/api/v1/plans/${plan.id}/apply`, {})
      expect((await approve(applied.body.id, plan.planHash)).status).toBe(200)
      expect((await view(applied.body.id)).state).toBe('queued')
      const restore: (() => Promise<void>)[] = []
      switch (change) {
        case 'approver':
          // The approver lost plans.approve after approving.
          await asReplica(
            `UPDATE auth.role_bindings SET state = 'revoked', revoked_at = now(), revoke_reason = 'identity_erased'
              WHERE identity_id = $1 AND state = 'active'`,
            [owner.identityId],
          )
          restore.push(() =>
            asReplica(
              `UPDATE auth.role_bindings SET state = 'active', revoked_at = NULL, revoke_reason = NULL
                WHERE identity_id = $1 AND state = 'revoked'`,
              [owner.identityId],
            ),
          )
          break
        case 'hash':
          await asReplica(
            `UPDATE approvals.plan_approvals SET plan_hash = $2 WHERE operation_id = $1`,
            [applied.body.id, `sha256:${'1'.repeat(64)}`],
          )
          break
        case 'cooling':
          await asReplica(
            `UPDATE approvals.plan_approvals SET cooling_seconds = 600, not_before = decided_at + interval '600 seconds'
              WHERE operation_id = $1`,
            [applied.body.id],
          )
          break
      }
      await drive()
      for (const r of restore) await r()
      const after = await view(applied.body.id)
      expect(after, change).toMatchObject({ state: 'failed', applyOutcome: 'not_started' })
      expect(after.errorCode, change).toBe('PLAN_STALE')
      expect(await jobsOf(applied.body.id), change).toEqual([])
      await node.stop()
    }
  })

  it('never starts an operation accepted before the production rule existed', async () => {
    const { w, node } = await setup('prod')
    // serve as it was: the same planning and acceptance without the node rule.
    const before = registryPolicy(
      new RuleRegistry([...ACCESS_RULES, ...REGISTRY_RULES]),
      codeVersion(),
      systemClock,
    )
    const actor = {
      identityId: owner.identityId as never,
      label: 'human #1',
      reauthAt: null,
      client: 'web' as const,
      clientId: null,
    }
    const serve = storeOf(db, 'exdb_serve')
    const accepted = await serve.transaction('test.legacy', async (tx) => {
      const plan = await planNodeOperation(tx, { policy: before }, actor, node.nodeId, {
        clusterId: w.clusterId,
        change: { kind: 'postgres.reload' },
      })
      return applyRegistryPlan(
        tx,
        { policy: before, kinds: registry, systemActor: WORKER_ACTOR },
        actor,
        plan.planId,
      )
    })
    if (accepted.status !== 'accepted') throw accepted.error
    expect(accepted.operation.state).toBe('queued')
    // The old worker would have run it; the corrected one refuses before anything starts.
    await drive()
    const after = await view(accepted.operation.operationId)
    expect(after).toMatchObject({ state: 'failed', applyOutcome: 'not_started' })
    expect(after.errorCode).toBe('PLAN_STALE')
    expect(await jobsOf(accepted.operation.operationId)).toEqual([])

    // A plan made before the rule and applied after it is stale at apply.
    const legacy = await serve.transaction('test.legacy_plan', (tx) =>
      planNodeOperation(tx, { policy: before }, actor, node.nodeId, {
        clusterId: w.clusterId,
        change: { kind: 'postgres.reload' },
      }),
    )
    const applied = await owner.browser.call('POST', `/api/v1/plans/${legacy.planId}/apply`, {})
    expect(applied.body).toMatchObject({ code: 'PLAN_STALE' })
    await node.stop()
  })
})
