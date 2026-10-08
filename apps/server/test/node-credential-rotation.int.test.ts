import type { AccessRole } from '@exponetdb/contracts'
import type { ControlStore } from '@exponetdb/control-store'
import { type MigratedTestDatabase, migratedTestDatabase } from '@exponetdb/control-store/testing'
import { type IdentityId, isJsonObject, newId, parseId, systemClock } from '@exponetdb/kernel'
import { scramSha256Verifier } from '@exponetdb/kernel/hash'
import {
  initPki,
  livePolicySubject,
  type NodeError,
  planCredentialRotation,
  planNodeInspection,
  rotationOwner,
} from '@exponetdb/nodes'
import {
  type DispatchAdmission,
  KindRegistry,
  type OperationKind,
  processNextOperation,
  readOperation,
  WORKER_ACTOR,
} from '@exponetdb/operations'
import { clusterBootstrapStatements, passwordStatements, ROLE_NAMES } from '@exponetdb/postgres'
import {
  applyRegistryPlan,
  Connector,
  consumerOf,
  type RegistryActor,
  submitCredential,
  verifyPendingCredentials,
} from '@exponetdb/registry'
import {
  generateKeyringText,
  type Keyring,
  parseKeyring,
  readSecret,
  registerActiveKey,
} from '@exponetdb/secrets'
import {
  createDatabase,
  loginClient,
  loginPassword,
  logsIn,
  provisionRoles,
  type TestServer,
  testTargets,
  withRolesHeld,
  withSuperuser,
} from '@exponetdb/testkit'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  codeVersion,
  POLICY_RULES,
  workerDispatchAdmission,
  workerKinds,
} from '../src/composition/access.ts'
import { registryPolicy } from '../src/composition/registry.ts'
import {
  agentClusterOn,
  placeTarget,
  type SimulatedNode,
  simulatedNode,
  storeOf,
  type World,
} from './support/node-world.ts'

/**
 * Wave 5 corrections F4 and F5: `credential.rotate` on a real PostgreSQL
 * 17 (the TLS test server). The worker generates the password and seals its
 * verifier for the node; the simulated node opens it and sets it on the
 * server as the agent does (or stops without a statement, before or after
 * setting it). Logins over verified TLS decide what happened, never the
 * registry's metadata; the plan is bound to the active credential at
 * acceptance, at dispatch and, locked, where the password is prepared.
 *
 * Only `exponetdb_verifier` is rotated (no other suite logs in with it), and
 * the role lock of the test kit is held for the whole file, so no suite
 * resets the role passwords meanwhile; the password is put back after.
 */

const ROLE: AccessRole = 'verifier'
const LOGIN = ROLE_NAMES[ROLE]
const ACTOR: RegistryActor = {
  identityId: newId('idn', Date.now()) as IdentityId,
  label: 'human #1',
  reauthAt: null,
  client: 'web',
}

let db: MigratedTestDatabase
let keyring: Keyring
let worker: ControlStore
let serve: ControlStore
let server: TestServer
let w: World & { readonly endpointId: string }
let node: SimulatedNode
let kinds: readonly OperationKind[]
let registry: KindRegistry
let admit: DispatchAdmission
let connector: Connector
let releaseRoles: () => void = () => undefined
let rolesHeld: Promise<unknown> = Promise.resolve()

/** How the simulated node treats the next `postgres.roles.apply@2` job. */
let mode: 'apply' | 'hold_after_set' | 'hold_before_set' | 'apply_then_widen' = 'apply'
let set: () => void = () => undefined
let wasSet: Promise<void> = Promise.resolve()
const passwordsSeen: string[] = []

function armSet() {
  wasSet = new Promise<void>((r) => {
    set = r
  })
}

const ROLES_RESULT = {
  rolesDigest: `kd1:${'a'.repeat(64)}`,
  roles: [
    {
      name: LOGIN,
      login: true,
      superuser: false,
      inherit: true,
      createdb: false,
      createrole: false,
      replication: false,
      bypassrls: true,
      connectionLimit: -1,
      validUntil: null,
      password: 'scram-sha-256',
    },
  ],
  memberships: [
    {
      role: 'pg_read_all_data',
      member: LOGIN,
      grantor: null,
      admin: false,
      inherit: true,
      set: false,
    },
  ],
  settings: [],
  expectations: [],
}

beforeAll(async () => {
  const targets = testTargets()
  const found = targets.servers.find((s) => s.major === 17)
  if (found === undefined) throw new Error('no PostgreSQL 17 test server')
  server = found
  await provisionRoles(server, {
    roles: ROLE_NAMES,
    cluster: (v) => clusterBootstrapStatements(v),
    passwords: (v) => passwordStatements(v),
  })
  // Held until afterAll: no suite resets the roles' passwords meanwhile.
  await new Promise<void>((acquired) => {
    rolesHeld = withRolesHeld(server, async () => {
      acquired()
      await new Promise<void>((r) => {
        releaseRoles = r
      })
    })
  })
  db = await migratedTestDatabase('exdb_it_credential_rotation')
  const parsed = parseKeyring(generateKeyringText('test-key'))
  if (!parsed.ok) throw new Error('keyring')
  keyring = parsed.value
  worker = storeOf(db, 'exdb_worker')
  serve = storeOf(db, 'exdb_serve')
  await registerActiveKey(worker, keyring)
  await worker.transaction('test.pki', (tx) =>
    initPki(tx, keyring, systemClock, {
      gatewayUrl: 'https://10.8.2.2:7443',
      serverName: 'gateway.exdb.test',
    }),
  )
  const sysid = await withSuperuser(server, 'postgres', async (c) => {
    const r = await c.query('SELECT system_identifier::text AS s FROM pg_control_system()')
    return String(r.rows[0]?.s)
  })
  w = await agentClusterOn(db, {
    systemIdentifier: sysid,
    caPem: targets.caPem,
    host: server.host === 'localhost' ? '127.0.0.1' : server.host,
    port: server.port,
    serverName: targets.serverName,
  })
  // A nonprod target on a real database of the server: no approval, and the
  // worker logs in to that database.
  await placeTarget(db, { ...w }, 'nonprod', await createDatabase(server, 'rotation'))
  node = await simulatedNode(db, keyring, w, async (capability, args, job) => {
    switch (capability) {
      case 'postgres.roles.inspect@2':
        return ROLES_RESULT
      case 'postgres.roles.apply@2': {
        if (mode === 'hold_before_set') {
          set()
          return 'hold'
        }
        const steps = Array.isArray(args['steps']) ? args['steps'] : []
        const step = isJsonObject(steps[0]) ? steps[0] : {}
        const verifier = new TextDecoder().decode(job.open('verifier', step['verifier']))
        expect(verifier.startsWith('SCRAM-SHA-256$')).toBe(true)
        await withSuperuser(server, 'postgres', async (c) => {
          await c.query(`ALTER ROLE ${LOGIN} PASSWORD ${c.escapeLiteral(verifier)}`)
          if (mode === 'apply_then_widen') {
            await c.query(`ALTER ROLE ${LOGIN} CREATEDB`)
          }
        })
        set()
        return mode === 'hold_after_set'
          ? 'hold'
          : { rolesDigest: `kd1:${'b'.repeat(64)}`, appliedSteps: 1 }
      }
      default:
        throw new Error(`no answer for ${capability}`)
    }
  })
  node.start()
  kinds = workerKinds({ store: worker, keyring }, { clock: systemClock }, db.installationId)
  registry = new KindRegistry(kinds)
  admit = workerDispatchAdmission(kinds, { clock: systemClock })
  connector = new Connector(worker, {
    keyring,
    process: 'worker',
    installationId: db.installationId,
  })
}, 180_000)

afterAll(async () => {
  await node?.stop()
  if (server !== undefined) {
    await withSuperuser(server, 'postgres', (c) =>
      c.query(
        `ALTER ROLE ${LOGIN} NOCREATEDB PASSWORD ${c.escapeLiteral(scramSha256Verifier(loginPassword(LOGIN)))}`,
      ),
    )
  }
  releaseRoles()
  await rolesHeld
  await db?.drop()
})

const policy = () => registryPolicy(POLICY_RULES, codeVersion(), systemClock)
const accept = {
  policy: policy(),
  kinds: new KindRegistry([]),
  systemActor: WORKER_ACTOR,
  liveSubject: livePolicySubject,
}

async function drive() {
  for (let i = 0; i < 30; i++) {
    const r = await processNextOperation(worker, {
      workerId: newId('prc', Date.now()),
      kinds: registry,
      clock: systemClock,
      admit,
    })
    if (r.status === 'idle') return
  }
}

/** A fresh node-signed roles observation, the basis of a rotation plan. */
async function inspectRoles() {
  const accepted = await serve.transaction('test.inspect', async (tx) => {
    const plan = await planNodeInspection(tx, { policy: policy() }, ACTOR, node.nodeId, {
      capability: 'postgres.roles.inspect@2',
      clusterId: w.clusterId as never,
      args: { expectSettings: [] },
    })
    return applyRegistryPlan(tx, { ...accept, kinds: registry }, ACTOR, plan.planId)
  })
  if (accepted.status !== 'accepted') throw accepted.error
  await drive()
}

function planRotation() {
  return serve.transaction('test.plan', (tx) =>
    planCredentialRotation(tx, { policy: policy() }, ACTOR, w.clusterId, ROLE),
  )
}

async function applyPlan(planId: string) {
  return serve.transaction('test.apply', (tx) =>
    applyRegistryPlan(tx, { ...accept, kinds: registry }, ACTOR, planId),
  )
}

async function credentials(): Promise<{ id: string; state: string; failure: string | null }[]> {
  const { rows } = await db.asSuperuser((c) =>
    c.query(
      `SELECT credential_id AS id, state, failure_code AS failure FROM registry.credentials
        WHERE cluster_id = $1 AND access_role = $2 ORDER BY submitted_at, credential_id`,
      [w.clusterId, ROLE],
    ),
  )
  return rows as never
}

async function active(): Promise<string | null> {
  return (await credentials()).find((c) => c.state === 'active')?.id ?? null
}

/** The plaintext of a credential (the worker's secret; read here to test the host). */
async function passwordOf(credentialId: string): Promise<string> {
  const { rows } = await db.asSuperuser((c) =>
    c.query('SELECT secret_id, secret_version FROM registry.credentials WHERE credential_id = $1', [
      credentialId,
    ]),
  )
  const id = parseId('sec', String(rows[0]?.secret_id))
  if (!id.ok) throw new Error('secret id')
  const password = (
    await readSecret(worker, keyring, {
      secretId: id.value,
      consumer: consumerOf(ROLE),
      version: Number(rows[0]?.secret_version),
    })
  ).toString('utf8')
  passwordsSeen.push(password)
  return password
}

async function rotationJobs(operationId: string): Promise<number> {
  const { rows } = await db.asSuperuser((c) =>
    c.query(
      `SELECT count(*)::int AS n FROM nodes.jobs WHERE operation_id = $1 AND capability = 'postgres.roles.apply@2'`,
      [operationId],
    ),
  )
  return Number(rows[0]?.n)
}

/** Test-only change of state the guards protect (replica mode skips triggers). */
async function asReplica(sql: string, params: unknown[]) {
  await db.asSuperuser(async (c) => {
    await c.query('BEGIN')
    await c.query('SET LOCAL session_replication_role = replica')
    await c.query(sql, params)
    await c.query('COMMIT')
  })
}

/**
 * The node stopped without a statement: its job's lease runs out (moved back)
 * and, once swept, it is old enough that nothing about it can still change.
 */
async function loseStatement(operationId: string) {
  const job = async () =>
    (
      await db.asSuperuser((c) =>
        c.query(
          `SELECT job_id, state FROM nodes.jobs WHERE operation_id = $1 AND capability = 'postgres.roles.apply@2'`,
          [operationId],
        ),
      )
    ).rows[0] as { job_id: string; state: string } | undefined
  await asReplica(
    `UPDATE nodes.jobs SET lease_expires_at = clock_timestamp() - interval '1 second',
            started_at = started_at - interval '30 minutes'
      WHERE operation_id = $1 AND capability = 'postgres.roles.apply@2'`,
    [operationId],
  )
  for (let i = 0; i < 200 && (await job())?.state !== 'outcome_unknown'; i++) {
    await new Promise((r) => setTimeout(r, 50))
  }
  await asReplica(
    `UPDATE nodes.jobs SET state_changed_at = state_changed_at - interval '30 minutes' WHERE job_id = $1`,
    [(await job())?.job_id],
  )
}

async function operationOf(id: string) {
  const op = await readOperation(worker, id)
  return { state: op?.state, applyOutcome: op?.applyOutcome }
}

describe('credential rotation through the node (F4, F5)', () => {
  it('with no active credential, activates its password in place of none; a plan made meanwhile is stale', async () => {
    const before = loginPassword(LOGIN)
    await inspectRoles()
    const first = await planRotation()
    const second = await planRotation()
    const accepted = await applyPlan(first.planId)
    if (accepted.status !== 'accepted') throw accepted.error
    await drive()
    expect(await operationOf(accepted.operation.operationId)).toEqual({
      state: 'succeeded',
      applyOutcome: 'applied',
    })
    const b0 = await active()
    expect(b0).not.toBeNull()
    const stale = await applyPlan(second.planId)
    expect(stale.status === 'refused' && stale.error.code).toBe('PLAN_STALE')
    expect(await logsIn(server, LOGIN, await passwordOf(String(b0)))).toBe(true)
    expect(await logsIn(server, LOGIN, before)).toBe(false)
  })

  it('rotates A to B: a fresh login works with B and fails with A; a session opened with A lives on', async () => {
    const a = String(await active())
    const passwordA = await passwordOf(a)
    const session = await loginClient(server, LOGIN, passwordA)
    await inspectRoles()
    const plan = await planRotation()
    const accepted = await applyPlan(plan.planId)
    if (accepted.status !== 'accepted') throw accepted.error
    await drive()
    expect(await operationOf(accepted.operation.operationId)).toEqual({
      state: 'succeeded',
      applyOutcome: 'applied',
    })
    const b = String(await active())
    expect(b).not.toBe(a)
    expect((await credentials()).find((c) => c.id === a)?.state).toBe('retired')
    expect(await logsIn(server, LOGIN, await passwordOf(b))).toBe(true)
    expect(await logsIn(server, LOGIN, passwordA)).toBe(false)
    expect((await session.query('SELECT 1 AS one')).rows[0]?.one).toBe(1)
    await session.end()
  })

  it('two plans against the same credential: the first rotates, the second never starts', async () => {
    const before = String(await active())
    await inspectRoles()
    const one = await planRotation()
    const two = await planRotation()
    const first = await applyPlan(one.planId)
    const second = await applyPlan(two.planId)
    if (first.status !== 'accepted' || second.status !== 'accepted') throw new Error('accept')
    await drive()
    const now = String(await active())
    expect(now).not.toBe(before)
    expect(await operationOf(first.operation.operationId)).toMatchObject({ state: 'succeeded' })
    expect(await operationOf(second.operation.operationId)).toEqual({
      state: 'failed',
      applyOutcome: 'not_started',
    })
    expect(await rotationJobs(second.operation.operationId)).toBe(0)
    expect(await logsIn(server, LOGIN, await passwordOf(now))).toBe(true)
  })

  it('is not planned while another credential waits for its verification', async () => {
    await serve.transaction('test.submit', (tx) =>
      submitCredential(tx, { keyring, clock: systemClock }, ACTOR, {
        clusterId: w.clusterId,
        role: ROLE,
        password: 'not the password of this role 1',
      }),
    )
    await inspectRoles()
    await expect(planRotation()).rejects.toMatchObject({
      code: 'REGISTRY_CONFLICT',
      details: { reason: 'credential_pending' },
    } satisfies Partial<NodeError>)
    await verifyPendingCredentials({
      store: worker,
      connector,
      clock: systemClock,
      owned: rotationOwner,
    })
    expect((await credentials()).some((c) => c.state === 'pending')).toBe(false)
  })

  it('a role check that fails after the password was set: applied, not verified, the credential kept and activated once fixed', async () => {
    const before = String(await active())
    await inspectRoles()
    mode = 'apply_then_widen'
    const plan = await planRotation()
    const accepted = await applyPlan(plan.planId)
    if (accepted.status !== 'accepted') throw accepted.error
    await drive()
    mode = 'apply'
    expect(await operationOf(accepted.operation.operationId)).toEqual({
      state: 'verification_failed',
      applyOutcome: 'applied',
    })
    const pending = (await credentials()).find((c) => c.state === 'pending')
    expect(pending).toBeDefined()
    expect(await active()).toBe(before)
    expect(await logsIn(server, LOGIN, await passwordOf(String(pending?.id)))).toBe(true)
    await withSuperuser(server, 'postgres', (c) => c.query(`ALTER ROLE ${LOGIN} NOCREATEDB`))
    await verifyPendingCredentials({
      store: worker,
      connector,
      clock: systemClock,
      owned: rotationOwner,
    })
    expect(await active()).toBe(pending?.id)
    expect(await rotationJobs(accepted.operation.operationId)).toBe(1)
  })

  it('a password the server refuses while the replaced one still logs in: not applied', async () => {
    const before = String(await active())
    await inspectRoles()
    mode = 'hold_before_set'
    armSet()
    const plan = await planRotation()
    const accepted = await applyPlan(plan.planId)
    if (accepted.status !== 'accepted') throw accepted.error
    const id = accepted.operation.operationId
    const driving = drive()
    await wasSet
    await loseStatement(id)
    await driving
    mode = 'apply'
    expect(await operationOf(id)).toEqual({ state: 'failed', applyOutcome: 'not_applied' })
    expect(await active()).toBe(before)
    const refused = (await credentials()).at(-1)
    expect(refused).toMatchObject({ state: 'failed', failure: 'authentication_failed' })
    expect(await logsIn(server, LOGIN, await passwordOf(before))).toBe(true)
  })

  // Last on this cluster: its operation waits in needs_attention for an
  // operator, holding the cluster's configuration domain.
  it('a lost statement and a broken login never read as not applied; fixed, the password is activated without being set again', async () => {
    const before = String(await active())
    const passwordBefore = await passwordOf(before)
    await inspectRoles()
    mode = 'hold_after_set'
    armSet()
    const plan = await planRotation()
    const accepted = await applyPlan(plan.planId)
    if (accepted.status !== 'accepted') throw accepted.error
    const id = accepted.operation.operationId
    const driving = drive()
    await wasSet
    // The TLS session can no longer be verified (another server name).
    await asReplica(
      `UPDATE registry.endpoints SET tls_server_name = 'wrong.exdb.test' WHERE endpoint_id = $1`,
      [w.endpointId],
    )
    await loseStatement(id)
    await driving
    mode = 'apply'
    expect(await operationOf(id)).toEqual({ state: 'needs_attention', applyOutcome: 'unknown' })
    const pending = (await credentials()).find((c) => c.state === 'pending')
    expect(pending).toBeDefined()
    expect(await active()).toBe(before)
    // The host has the new password; the registry still names the old one as active.
    expect(await logsIn(server, LOGIN, await passwordOf(String(pending?.id)))).toBe(true)
    expect(await logsIn(server, LOGIN, passwordBefore)).toBe(false)

    // Another server answers (a wrong identity): still nothing decided.
    const other = testTargets().servers.find((s) => s.major === 16)
    if (other === undefined) throw new Error('no PostgreSQL 16 test server')
    await asReplica(
      `UPDATE registry.endpoints SET tls_server_name = $2, port = $3 WHERE endpoint_id = $1`,
      [w.endpointId, testTargets().serverName, other.port],
    )
    await verifyPendingCredentials({
      store: worker,
      connector,
      clock: systemClock,
      owned: rotationOwner,
    })
    expect((await credentials()).find((c) => c.id === pending?.id)?.state).toBe('pending')

    // Fixed: the periodic verification activates it in place of the old one.
    await asReplica(`UPDATE registry.endpoints SET port = $2 WHERE endpoint_id = $1`, [
      w.endpointId,
      server.port,
    ])
    await verifyPendingCredentials({
      store: worker,
      connector,
      clock: systemClock,
      owned: rotationOwner,
    })
    expect(await active()).toBe(pending?.id)
    expect((await credentials()).find((c) => c.id === before)?.state).toBe('retired')
    expect(await rotationJobs(id)).toBe(1)
  })

  it('keeps every password and verifier out of jobs, plans, operations and audit', async () => {
    const { rows } = await db.asSuperuser((c) =>
      c.query(
        `SELECT (SELECT string_agg(envelope::text || coalesce(completion::text, ''), ' ') FROM nodes.jobs) AS jobs,
                (SELECT string_agg(body, ' ') FROM operations.plan_bodies) AS plans,
                (SELECT string_agg(coalesce(detail::text, ''), ' ') FROM operations.operation_events) AS events,
                (SELECT string_agg(event, ' ') FROM audit.audit_events) AS audit`,
      ),
    )
    const text = JSON.stringify(rows[0])
    expect(passwordsSeen.length).toBeGreaterThan(3)
    for (const p of passwordsSeen) {
      expect(text.includes(p)).toBe(false)
    }
    expect(text.includes('SCRAM-SHA-256$')).toBe(false)
  })
})
