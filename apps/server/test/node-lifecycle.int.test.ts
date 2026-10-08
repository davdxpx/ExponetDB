import type { ControlStore, Tx } from '@exponetdb/control-store'
import { type MigratedTestDatabase, migratedTestDatabase } from '@exponetdb/control-store/testing'
import { type IdentityId, newId, systemClock } from '@exponetdb/kernel'
import {
  initPki,
  nodeKinds,
  planNodeDecommission,
  planNodeEnroll,
  planNodeRevoke,
} from '@exponetdb/nodes'
import {
  type DriverResult,
  KindRegistry,
  OperationError,
  type PlanRecord,
  processNextOperation,
  WORKER_ACTOR,
} from '@exponetdb/operations'
import { applyRegistryPlan, type RegistryActor } from '@exponetdb/registry'
import {
  generateKeyringText,
  type Keyring,
  parseKeyring,
  registerActiveKey,
} from '@exponetdb/secrets'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { codeVersion, POLICY_RULES } from '../src/composition/access.ts'
import { registryPolicy } from '../src/composition/registry.ts'
import { registryWorld, simulatedNode, storeOf } from './support/node-world.ts'

/**
 * Wave 5 correction F3: a node lifecycle mutation (enrollment token,
 * revocation, decommissioning) happens only while its worker still holds the
 * operation's lease, checked in the transaction that writes it. Two real
 * worker leases on the Control Store: worker A is held at a barrier right
 * before its write, its lease runs out, worker B takes the operation over and
 * reconciles it; then A is let go. Nothing A would have written appears, and
 * no audit event says it did. Real PostgreSQL 17; no sleeps decide anything.
 */

let db: MigratedTestDatabase
let keyring: Keyring
let worker: ControlStore

beforeAll(async () => {
  db = await migratedTestDatabase('exdb_it_node_lifecycle')
  const parsed = parseKeyring(generateKeyringText('test-key'))
  if (!parsed.ok) throw new Error('keyring')
  keyring = parsed.value
  worker = storeOf(db, 'exdb_worker')
  await registerActiveKey(worker, keyring)
  await worker.transaction('test.pki', (tx) =>
    initPki(tx, keyring, systemClock, {
      gatewayUrl: 'https://10.8.2.2:7443',
      serverName: 'gateway.exdb.test',
    }),
  )
}, 120_000)

afterAll(async () => {
  await db?.drop()
})

const policy = () => registryPolicy(POLICY_RULES, codeVersion(), systemClock)

const ACTOR: RegistryActor = {
  identityId: newId('idn', Date.now()) as IdentityId,
  label: 'human #1',
  reauthAt: new Date().toISOString(),
  client: 'web',
}

/** Plans and accepts a lifecycle operation as a person who just re-authenticated. */
async function accepted(plan: (tx: Tx) => Promise<PlanRecord>): Promise<string> {
  const serve = storeOf(db, 'exdb_serve')
  const result = await serve.transaction('test.accept', async (tx) => {
    const p = await plan(tx)
    return applyRegistryPlan(
      tx,
      {
        policy: policy(),
        kinds: new KindRegistry(nodeKinds({ store: worker, clock: systemClock })),
        systemActor: WORKER_ACTOR,
      },
      { ...ACTOR, reauthAt: new Date().toISOString() },
      p.planId,
    )
  })
  if (result.status !== 'accepted') throw result.error
  return result.operation.operationId
}

/**
 * Worker A's store: its lifecycle write transaction waits at a barrier until
 * released; everything else (claim, transitions, lease) is the real store.
 */
function barrier(store: ControlStore) {
  let release: () => void = () => undefined
  let entered: () => void = () => undefined
  const released = new Promise<void>((r) => {
    release = r
  })
  const reached = new Promise<void>((r) => {
    entered = r
  })
  const gated = new Proxy(store, {
    get(target, prop, receiver) {
      if (prop === 'transaction') {
        return async (name: string, fn: (tx: Tx) => Promise<unknown>) => {
          if (name.startsWith('nodes.kind.node.')) {
            entered()
            await released
          }
          return target.transaction(name, fn)
        }
      }
      const value = Reflect.get(target, prop, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  }) as ControlStore
  return { gated, reached, release }
}

/** A stopped by B: it can make no transition (the state or the lease moved on). */
function stopped(a: DriverResult | OperationError): boolean {
  return a instanceof OperationError
    ? a.code === 'operation_state_changed' || a.code === 'operation_lease_lost'
    : a.status === 'lease_lost'
}

/**
 * Runs the interleaving: A claims and stops right before its write; its lease
 * runs out (moved back, as the lease suites do); B takes over and reconciles;
 * then A goes on. Returns what each worker ended with.
 */
async function interleave(
  operationId: string,
): Promise<{ a: DriverResult | OperationError; b: DriverResult }> {
  const gate = barrier(worker)
  const workerA = newId('prc', Date.now())
  const workerB = newId('prc', Date.now() + 1)
  const a = processNextOperation(worker, {
    workerId: workerA,
    kinds: new KindRegistry(nodeKinds({ store: gate.gated, clock: systemClock })),
    clock: systemClock,
    // No renewal decides anything here: the lease is moved back explicitly.
    renewMs: 3_600_000,
  }).catch((error: unknown) => {
    if (error instanceof OperationError) return error
    throw error
  })
  await gate.reached
  await db.asSuperuser((c) =>
    c.query(
      `UPDATE operations.operations SET lease_expires_at = clock_timestamp() - interval '1 second'
        WHERE operation_id = $1 AND lease_owner = $2`,
      [operationId, workerA],
    ),
  )
  const b = await processNextOperation(worker, {
    workerId: workerB,
    kinds: new KindRegistry(nodeKinds({ store: worker, clock: systemClock })),
    clock: systemClock,
  })
  gate.release()
  return { a: await a, b }
}

async function outcome(operationId: string) {
  const { rows } = await db.asSuperuser((c) =>
    c.query('SELECT state, apply_outcome FROM operations.operations WHERE operation_id = $1', [
      operationId,
    ]),
  )
  return rows[0]
}

async function auditOf(operationId: string, action: string): Promise<number> {
  const { rows } = await db.asSuperuser((c) =>
    c.query(
      `SELECT count(*)::int AS n FROM audit.audit_events
        WHERE action = $2 AND event::jsonb -> 'refs' ->> 'operationId' = $1`,
      [operationId, action],
    ),
  )
  return Number(rows[0]?.n)
}

describe('node lifecycle mutations are fenced by their lease (F3)', () => {
  it('issues no enrollment token after the lease is lost', async () => {
    const w = await registryWorld(db)
    const tokenId = { value: '' }
    const operationId = await accepted(async (tx) => {
      const plan = await planNodeEnroll(tx, { policy: policy() }, ACTOR, w.serverId)
      const content = plan.body['content'] as { tokenId: string }
      tokenId.value = content.tokenId
      return plan
    })
    const { a, b } = await interleave(operationId)
    expect(b).toMatchObject({ status: 'done', takenOver: true })
    expect(stopped(a)).toBe(true)
    expect(await outcome(operationId)).toEqual({ state: 'failed', apply_outcome: 'not_applied' })
    const { rows } = await db.asSuperuser((c) =>
      c.query('SELECT count(*)::int AS n FROM nodes.enrollment_tokens WHERE token_id = $1', [
        tokenId.value,
      ]),
    )
    expect(rows[0]?.n).toBe(0)
    expect(await auditOf(operationId, 'node.enroll')).toBe(0)
  })

  for (const kind of ['node.revoke', 'node.decommission'] as const) {
    it(`does not ${kind === 'node.revoke' ? 'revoke' : 'decommission'} a node after the lease is lost`, async () => {
      const w = await registryWorld(db)
      const node = await simulatedNode(db, keyring, w, () => ({}))
      const operationId = await accepted((tx) =>
        kind === 'node.revoke'
          ? planNodeRevoke(tx, { policy: policy() }, ACTOR, node.nodeId)
          : planNodeDecommission(tx, { policy: policy() }, ACTOR, node.nodeId),
      )
      const { a, b } = await interleave(operationId)
      expect(b).toMatchObject({ status: 'done', takenOver: true })
      expect(stopped(a)).toBe(true)
      expect(await outcome(operationId)).toEqual({ state: 'failed', apply_outcome: 'not_applied' })
      const { rows } = await db.asSuperuser((c) =>
        c.query(
          'SELECT state, state_changed_by_operation_id AS op FROM nodes.nodes WHERE node_id = $1',
          [node.nodeId],
        ),
      )
      expect(rows[0]).toEqual({ state: 'active', op: null })
      expect(await auditOf(operationId, kind)).toBe(0)
    })
  }

  it('still writes while the lease is held', async () => {
    const w = await registryWorld(db)
    const node = await simulatedNode(db, keyring, w, () => ({}))
    const operationId = await accepted((tx) =>
      planNodeRevoke(tx, { policy: policy() }, ACTOR, node.nodeId),
    )
    const done = await processNextOperation(worker, {
      workerId: newId('prc', Date.now()),
      kinds: new KindRegistry(nodeKinds({ store: worker, clock: systemClock })),
      clock: systemClock,
    })
    expect(done).toMatchObject({ status: 'done', operation: { state: 'succeeded' } })
    expect(await auditOf(operationId, 'node.revoke')).toBe(1)
  })
})
