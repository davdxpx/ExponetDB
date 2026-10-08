import { type Application, type Caller, operationView } from '@exponetdb/application'
import { type MigratedTestDatabase, migratedTestDatabase } from '@exponetdb/control-store/testing'
import {
  type ClusterId,
  type IdentityId,
  type JsonObject,
  newId,
  systemClock,
} from '@exponetdb/kernel'
import { initPki, nodePolicySubject, planNodeOperation } from '@exponetdb/nodes'
import { createLogger, MetricsRegistry } from '@exponetdb/observability'
import {
  type DispatchAdmission,
  KindRegistry,
  type OperationKind,
  processNextOperation,
  WORKER_ACTOR,
} from '@exponetdb/operations'
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
  POLICY_RULES,
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
let application: Application
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

/** Holds the node's next answer of one capability until the test releases it. */
let gate:
  | { readonly capability: string; readonly reached: () => void; readonly released: Promise<void> }
  | undefined

async function respond(capability: string): Promise<JsonObject> {
  const g = gate
  if (g !== undefined && g.capability === capability) {
    gate = undefined
    g.reached()
    await g.released
  }
  return answers(capability)
}

function answers(capability: string): JsonObject {
  switch (capability) {
    case 'postgres.status@1':
      return STATUS
    case 'postgres.reload@2':
      return { reloadedAt: new Date().toISOString(), pendingRestart: [], fileErrors: [] }
    case 'postgres.roles.inspect@2':
      return {
        rolesDigest: `kd1:${'c'.repeat(64)}`,
        roles: [],
        memberships: [],
        settings: [],
        expectations: [],
      }
    case 'postgres.roles.apply@2':
      return { rolesDigest: `kd1:${'d'.repeat(64)}`, appliedSteps: 1 }
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
  const logger = createLogger({
    role: 'serve',
    level: 'warn',
    write: (line) => {
      if (process.env['EXDB_TEST_LOGS'] === '1') process.stderr.write(`${line}\n`)
    },
  })
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
  application = access.application
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
  const node = await simulatedNode(db, keyring, w, respond)
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

  it('releases a critical production change a person approved themself once its cooling ends (OD-9)', async () => {
    const { w, node } = await setup('prod')
    const inspected = await owner.browser.call('POST', `/api/v1/nodes/${node.nodeId}/inspections`, {
      capability: 'postgres.roles.inspect@2',
      clusterId: w.clusterId,
      args: { expectSettings: [] },
    })
    expect([inspected.status, inspected.body?.code]).toEqual([202, undefined])
    await drive()
    // A role setting of a parameter only a superuser may set: critical.
    const planned = await owner.browser.call('POST', `/api/v1/nodes/${node.nodeId}/plans`, {
      clusterId: w.clusterId,
      change: {
        kind: 'postgres.roles.apply',
        steps: [
          {
            op: 'set_role_setting',
            role: 'app_user',
            attributes: null,
            verifier: null,
            member: null,
            admin: null,
            inherit: null,
            set: null,
            database: null,
            setting: 'lo_compat_privileges',
            value: 'on',
          },
        ],
      },
    })
    expect([planned.status, planned.body?.code], JSON.stringify(planned.body)).toEqual([
      201,
      undefined,
    ])
    const plan = planned.body as { id: string; planHash: string }
    const { rows } = await db.asSuperuser((c) =>
      c.query('SELECT action_class FROM operations.plans WHERE plan_id = $1', [plan.id]),
    )
    expect(rows[0]?.action_class).toBe('critical')
    await owner.reauth()
    const applied = await owner.browser.call('POST', `/api/v1/plans/${plan.id}/apply`, {})
    expect(applied.body).toMatchObject({ state: 'awaiting_approval' })
    const approved = await approve(applied.body.id, plan.planHash)
    expect(approved.status, JSON.stringify(approved.body)).toBe(200)
    expect(approved.body).toMatchObject({ selfApproval: true })
    // Before the cooling ends the apply is refused; the operation waits.
    await owner.reauth()
    const early = await owner.browser.call('POST', `/api/v1/plans/${plan.id}/apply`, {})
    expect(early.body?.code).toBe('APPROVAL_COOLING_PERIOD')
    expect((await view(applied.body.id)).state).toBe('awaiting_approval')
    // The cooling period over (moved back), a fresh apply releases it.
    await asReplica(
      `UPDATE approvals.plan_approvals
          SET decided_at = decided_at - interval '11 minutes', not_before = not_before - interval '11 minutes'
        WHERE operation_id = $1`,
      [applied.body.id],
    )
    await owner.reauth()
    const released = await owner.browser.call('POST', `/api/v1/plans/${plan.id}/apply`, {})
    expect([released.status, released.body?.state], JSON.stringify(released.body)).toEqual([
      202,
      'queued',
    ])
    await drive()
    expect(await jobsOf(applied.body.id)).toContain('postgres.roles.apply@2')
    await node.stop()
  })

  it('releases a critical change a person planned through the CLI and approved themself in the Web App (OD-9)', async () => {
    const { w, node } = await setup('prod')
    const inspected = await owner.browser.call('POST', `/api/v1/nodes/${node.nodeId}/inspections`, {
      capability: 'postgres.roles.inspect@2',
      clusterId: w.clusterId,
      args: { expectSettings: [] },
    })
    expect([inspected.status, inspected.body?.code]).toEqual([202, undefined])
    await drive()
    const { rows } = await db.asSuperuser((c) =>
      c.query('SELECT label_number FROM auth.identities WHERE identity_id = $1', [
        owner.identityId,
      ]),
    )
    const cli: Caller = {
      kind: 'bearer',
      principal: {
        kind: 'delegated',
        identityId: owner.identityId as IdentityId,
        identityKind: 'human',
        label: `human #${rows[0]?.label_number}`,
        client: 'cli',
        delegation: {
          credential: {
            type: 'access_token',
            grantId: newId('grt', Date.now()),
            clientId: newId('cli', Date.now()),
            grantKind: 'delegated',
          },
          resource: 'api',
          scopes: new Set(['nodes.read', 'nodes.plan', 'nodes.operate:prod'] as const),
          restrictions: { targets: { kind: 'all' }, tiers: ['prod', 'nonprod'] },
        },
      },
      resource: 'api',
    }
    const plan = await application.nodes.planOperation(cli, node.nodeId, {
      clusterId: w.clusterId,
      change: {
        kind: 'postgres.roles.apply',
        steps: [
          {
            op: 'set_role_setting',
            role: 'app_user',
            attributes: null,
            verifier: null,
            member: null,
            admin: null,
            inherit: null,
            set: null,
            database: null,
            setting: 'lo_compat_privileges',
            value: 'on',
          },
        ],
      },
    })
    const applied = await application.apply(cli, plan.id)
    expect(applied.state).toBe('awaiting_approval')
    const approved = await approve(applied.id, plan.planHash)
    expect(approved.status, JSON.stringify(approved.body)).toBe(200)
    expect(approved.body).toMatchObject({ selfApproval: true })
    await asReplica(
      `UPDATE approvals.plan_approvals
          SET decided_at = decided_at - interval '11 minutes', not_before = not_before - interval '11 minutes'
        WHERE operation_id = $1`,
      [applied.id],
    )
    // The CLI cannot give the fresh proof: the operation keeps waiting.
    expect((await application.apply(cli, plan.id)).state).toBe('awaiting_approval')
    // The same person in the Web App, freshly re-authenticated, releases it.
    await owner.reauth()
    const released = await owner.browser.call('POST', `/api/v1/plans/${plan.id}/apply`, {})
    expect([released.status, released.body?.state], JSON.stringify(released.body)).toEqual([
      202,
      'queued',
    ])
    await drive()
    expect(await jobsOf(applied.id)).toContain('postgres.roles.apply@2')
    await node.stop()
  })

  it('counts a server with a cluster of unknown tier as unknown for a node-wide change', async () => {
    const w = await registryWorld(db)
    await placeTarget(db, w, 'nonprod')
    const store = storeOf(db, 'exdb_worker')
    expect(await nodePolicySubject(store, { serverId: w.serverId })).toEqual({ tier: 'nonprod' })
    // A second cluster on the server, with no live target yet.
    await db.asSuperuser((c) =>
      c.query(
        `INSERT INTO registry.clusters (cluster_id, server_id, management_mode, display_name, state, ca_bundle,
                                        created_by_operation_id)
         SELECT $1, server_id, 'agent', 'second', 'pending', ca_bundle, created_by_operation_id
           FROM registry.clusters WHERE cluster_id = $2`,
        [newId('cls', Date.now()), w.clusterId],
      ),
    )
    expect(await nodePolicySubject(store, { serverId: w.serverId })).toEqual({})
  })

  it('creates no apply job when the cluster became production while the operation ran its reads', async () => {
    const { w, node } = await setup('nonprod')
    const plan = await planReload(w, node)
    expect(plan.requirements).toEqual([])
    await owner.reauth()
    const applied = await owner.browser.call('POST', `/api/v1/plans/${plan.id}/apply`, {})
    expect(applied.body).toMatchObject({ state: 'queued' })
    // The operation starts (nonprod: admitted) and reads the fresh basis;
    // meanwhile a production target is placed on the cluster.
    let reached: () => void = () => undefined
    let release: () => void = () => undefined
    const atBasis = new Promise<void>((r) => {
      reached = r
    })
    gate = {
      capability: 'postgres.status@1',
      reached,
      released: new Promise<void>((r) => {
        release = r
      }),
    }
    const run = drive()
    await atBasis
    await placeTarget(db, w, 'prod')
    release()
    await run
    expect(await view(applied.body.id)).toMatchObject({
      state: 'failed',
      applyOutcome: 'not_applied',
      errorCode: 'PLAN_STALE',
    })
    expect(await jobsOf(applied.body.id)).toEqual(['postgres.status@1'])
    // The changed bindings are named as a list, as at the start of an
    // operation (correction review, round 2).
    const { rows } = await db.asSuperuser((c) =>
      c.query(
        `SELECT detail -> 'changedBindings' AS changed FROM operations.operation_events
          WHERE operation_id = $1 AND detail ? 'changedBindings'`,
        [applied.body.id],
      ),
    )
    expect(rows.map((r) => r.changed)).toEqual([['policy']])
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
      POLICY_RULES.filter((r) => r.id !== 'node.prod-apply-approval'),
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

// ----- F9: the authorized caller stays itself through node operations -----

async function bearer(token: string, path: string, method = 'GET', body?: unknown) {
  const response = await app.request(`${ORIGIN}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  return { status: response.status, body: text.length === 0 ? undefined : JSON.parse(text) }
}

/** A service account bound to a role, through the planned access change the owner applies. */
async function serviceAccount(
  name: string,
  roleId: string,
): Promise<{ id: string; binding: string }> {
  await owner.reauth()
  const created = await owner.browser.call('POST', '/api/v1/service-accounts', {
    displayName: name,
  })
  expect(created.status).toBe(201)
  const planned = await owner.browser.call('POST', '/api/v1/role-bindings', {
    identityId: created.body.id,
    roleId,
    scope: { kind: 'global' },
  })
  expect(planned.status).toBe(201)
  await owner.reauth()
  expect(
    (await owner.browser.call('POST', `/api/v1/plans/${planned.body.id}/apply`, {})).status,
  ).toBe(202)
  await drive()
  const { rows } = await db.asSuperuser((c) =>
    c.query(
      `SELECT binding_id FROM auth.role_bindings WHERE identity_id = $1 AND state = 'active'`,
      [created.body.id],
    ),
  )
  return { id: String(created.body.id), binding: String(rows[0]?.binding_id) }
}

async function apiKey(
  account: string,
  scopes: string[],
  tiers: ('prod' | 'nonprod')[] = ['prod', 'nonprod'],
): Promise<{ secret: string; id: string }> {
  await owner.reauth()
  const key = await owner.browser.call('POST', `/api/v1/service-accounts/${account}/api-keys`, {
    scopes,
    restrictions: { tiers, targets: { kind: 'all' } },
    lifetimeDays: 30,
    // Production authority (the prod tier, a prod scope) is confirmed explicitly.
    ...(tiers.includes('prod') ? { acknowledgeProductionWrite: true } : {}),
  })
  expect(key.status, JSON.stringify(key.body)).toBe(201)
  return { secret: String(key.body.secret), id: String(key.body.apiKey.id) }
}

async function recorded(operationId: string) {
  const { rows } = await db.asSuperuser((c) =>
    c.query(
      `SELECT p.actor_kind AS plan_kind, p.actor_id AS plan_actor, p.client_kind AS plan_client, p.client_id AS plan_client_id,
              o.actor_kind, o.actor_id, o.client_kind, o.client_id,
              (SELECT a.actor_kind || '/' || coalesce(a.actor_id, '') FROM audit.audit_events a
                WHERE a.action = 'operation.accepted' AND a.event::jsonb -> 'refs' ->> 'operationId' = o.operation_id) AS audit
         FROM operations.operations o JOIN operations.plans p USING (plan_id) WHERE o.operation_id = $1`,
      [operationId],
    ),
  )
  return rows[0]
}

describe('the authorized caller through node operations (F9)', () => {
  it('lets a service account with nodes.plan inspect a node, recorded as itself', async () => {
    const { w, node } = await setup('nonprod')
    const account = await serviceAccount('Inspector', 'operator')
    const key = await apiKey(account.id, ['nodes.read', 'nodes.plan'])
    const r = await bearer(key.secret, `/api/v1/nodes/${node.nodeId}/inspections`, 'POST', {
      capability: 'postgres.status@1',
      clusterId: w.clusterId,
      args: {},
    })
    expect([r.status, r.body?.code], JSON.stringify(r.body)).toEqual([202, undefined])
    await drive()
    expect((await view(r.body.id)).state).toBe('succeeded')
    expect(await recorded(r.body.id)).toEqual({
      plan_kind: 'service',
      plan_actor: account.id,
      plan_client: 'ci',
      plan_client_id: null,
      actor_kind: 'service',
      actor_id: account.id,
      client_kind: 'ci',
      client_id: null,
      audit: `service/${account.id}`,
    })
    // The same request in a person's Web App session stays the person's.
    const own = await owner.browser.call('POST', `/api/v1/nodes/${node.nodeId}/inspections`, {
      capability: 'postgres.status@1',
      clusterId: w.clusterId,
      args: {},
    })
    await drive()
    expect(await recorded(own.body.id)).toMatchObject({
      plan_kind: 'human',
      plan_actor: owner.identityId,
      plan_client: 'web',
      audit: `human/${owner.identityId}`,
    })
    await node.stop()
  })

  it('never lets an inspection compare role settings to values the caller names', async () => {
    const { w, node } = await setup('nonprod')
    const asked = await owner.browser.call('POST', `/api/v1/nodes/${node.nodeId}/inspections`, {
      capability: 'postgres.roles.inspect@2',
      clusterId: w.clusterId,
      args: {
        expectSettings: [{ role: 'app', database: null, name: 'app.token', value: 'a guess' }],
      },
    })
    expect([asked.status, asked.body?.code]).toEqual([422, 'VALIDATION_FAILED'])
    await node.stop()
  })

  it('refuses a key without the scope, outside its tier, revoked, or of an account that lost its role', async () => {
    const { w, node } = await setup('nonprod')
    const request = { capability: 'postgres.status@1', clusterId: w.clusterId, args: {} }
    const path = `/api/v1/nodes/${node.nodeId}/inspections`
    const account = await serviceAccount('Limited', 'operator')
    const noScope = await apiKey(account.id, ['nodes.read'])
    expect((await bearer(noScope.secret, path, 'POST', request)).status).toBe(403)
    const prodOnly = await apiKey(account.id, ['nodes.read', 'nodes.plan'], ['prod'])
    expect([403, 404]).toContain((await bearer(prodOnly.secret, path, 'POST', request)).status)
    const revoked = await apiKey(account.id, ['nodes.read', 'nodes.plan'])
    await owner.reauth()
    expect(
      (await owner.browser.call('POST', `/api/v1/api-keys/${revoked.id}/revoke`, {})).status,
    ).toBe(200)
    expect((await bearer(revoked.secret, path, 'POST', request)).status).toBe(401)
    // The role is gone: the key's scopes no longer reach anything (live permissions).
    const keyed = await apiKey(account.id, ['nodes.read', 'nodes.plan'])
    const removal = await owner.browser.call('DELETE', `/api/v1/role-bindings/${account.binding}`)
    expect(removal.status).toBe(201)
    await owner.reauth()
    expect(
      (await owner.browser.call('POST', `/api/v1/plans/${removal.body.id}/apply`, {})).status,
    ).toBe(202)
    await drive()
    expect((await bearer(keyed.secret, path, 'POST', request)).status).toBe(403)
    const { rows } = await db.asSuperuser((c) =>
      c.query(`SELECT count(*)::int AS n FROM operations.plans WHERE actor_id = $1`, [account.id]),
    )
    expect(rows[0]?.n).toBe(0)
    await node.stop()
  })

  it('never lets a machine make a human-only node change', async () => {
    const { w, node } = await setup('nonprod')
    const account = await serviceAccount('Automation', 'operator')
    const key = await apiKey(account.id, ['nodes.read', 'nodes.plan', 'nodes.operate:nonprod'])
    for (const [method, path, body] of [
      [
        'POST',
        `/api/v1/nodes/${node.nodeId}/config-updates`,
        { addJobKeys: ['k2027a'], retireJobKeys: [] },
      ],
      ['POST', `/api/v1/nodes/${node.nodeId}/revoke`, {}],
      ['POST', `/api/v1/nodes/${node.nodeId}/decommission`, {}],
      ['POST', `/api/v1/clusters/${w.clusterId}/credentials/observer/rotate`, {}],
    ] as const) {
      expect((await bearer(key.secret, path, method, body)).status, path).toBe(403)
    }
    await node.stop()
  })

  it('keeps a person acting through the first-party CLI a person with that client', async () => {
    const { w, node } = await setup('nonprod')
    const { rows } = await db.asSuperuser((c) =>
      c.query('SELECT label_number FROM auth.identities WHERE identity_id = $1', [
        owner.identityId,
      ]),
    )
    const clientId = newId('cli', Date.now())
    // What bearer authentication hands the application for a person's CLI
    // access token at the REST resource (the token itself is the OAuth suites').
    const cli: Caller = {
      kind: 'bearer',
      principal: {
        kind: 'delegated',
        identityId: owner.identityId as IdentityId,
        identityKind: 'human',
        label: `human #${rows[0]?.label_number}`,
        client: 'cli',
        delegation: {
          credential: {
            type: 'access_token',
            grantId: newId('grt', Date.now()),
            clientId,
            grantKind: 'delegated',
          },
          resource: 'api',
          scopes: new Set(['nodes.read', 'nodes.plan'] as const),
          restrictions: { targets: { kind: 'all' }, tiers: ['prod', 'nonprod'] },
        },
      },
      resource: 'api',
    }
    const op = await application.nodes.inspect(cli, node.nodeId, {
      capability: 'postgres.status@1',
      clusterId: w.clusterId as ClusterId,
      args: {},
    })
    await drive()
    expect((await view(op.id)).state).toBe('succeeded')
    expect(await recorded(op.id)).toEqual({
      plan_kind: 'human',
      plan_actor: owner.identityId,
      plan_client: 'cli',
      plan_client_id: clientId,
      actor_kind: 'human',
      actor_id: owner.identityId,
      client_kind: 'cli',
      client_id: clientId,
      audit: `human/${owner.identityId}`,
    })
    // The same person's grant without nodes.plan reaches nothing.
    const narrow: Caller = {
      ...cli,
      principal: {
        ...cli.principal,
        delegation: { ...cli.principal.delegation, scopes: new Set(['nodes.read'] as const) },
      },
    }
    await expect(
      application.nodes.inspect(narrow, node.nodeId, {
        capability: 'postgres.status@1',
        clusterId: w.clusterId as ClusterId,
        args: {},
      }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/PERMISSION_DENIED|SCOPE/) })
    await node.stop()
  })

  it("holds a machine's production change for a human approval, then runs it as the machine's", async () => {
    const { w, node } = await setup('prod')
    const account = await serviceAccount('Deployer', 'operator')
    const key = await apiKey(account.id, ['nodes.read', 'nodes.plan', 'nodes.operate:prod'])
    const planned = await bearer(key.secret, `/api/v1/nodes/${node.nodeId}/plans`, 'POST', {
      clusterId: w.clusterId,
      change: { kind: 'postgres.reload' },
    })
    expect([planned.status, planned.body?.code], JSON.stringify(planned.body)).toEqual([
      201,
      undefined,
    ])
    expect(planned.body.actor).toEqual({ kind: 'service', identityId: account.id, via: 'ci' })
    const applied = await bearer(key.secret, `/api/v1/plans/${planned.body.id}/apply`, 'POST', {})
    expect(applied.body).toMatchObject({ state: 'awaiting_approval' })
    await drive()
    expect(await jobsOf(applied.body.id)).toEqual([])
    // Not a self-approval: the owner approves what the machine proposed.
    await owner.reauth()
    const approved = await owner.browser.call(
      'POST',
      `/api/v1/approvals/${applied.body.id}/approve`,
      {
        planHash: planned.body.planHash,
      },
    )
    expect(approved.status, JSON.stringify(approved.body)).toBe(200)
    expect(approved.body.selfApproval).toBe(false)
    await drive()
    expect((await view(applied.body.id)).state).toBe('succeeded')
    expect(await recorded(applied.body.id)).toMatchObject({
      plan_kind: 'service',
      actor_kind: 'service',
      actor_id: account.id,
      client_kind: 'ci',
    })
    await node.stop()
  })
})
