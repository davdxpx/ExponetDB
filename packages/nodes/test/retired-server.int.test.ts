import type { ControlStore, Tx } from '@exponetdb/control-store'
import { type MigratedTestDatabase, migratedTestDatabase } from '@exponetdb/control-store/testing'
import { type IdentityId, newId } from '@exponetdb/kernel'
import type { PlanRecord } from '@exponetdb/operations'
import { generateKeyringText, parseKeyring, registerActiveKey } from '@exponetdb/secrets'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createEnrollmentToken,
  initPki,
  NodeEnrollKind,
  type NodePlanContext,
  planNodeEnroll,
} from '../src/index.ts'

/**
 * A retired server gets no node (registry.md §4.4): `node.enroll` is refused by its planner, goes
 * stale at apply, and its token record is refused by the worker; a retirement and a new token
 * serialize on the server row (the token locks it FOR SHARE, the retirement's guard FOR UPDATE).
 */

let db: MigratedTestDatabase
let worker: ControlStore
const clock = { nowMs: () => Date.now() }

beforeAll(async () => {
  db = await migratedTestDatabase('exdb_nodes_retired')
  worker = db.store('exdb_worker')
  const parsed = parseKeyring(generateKeyringText('k1'))
  if (!parsed.ok) {
    throw new Error('test keyring')
  }
  await registerActiveKey(worker, parsed.value)
  // A job key exists, so a token on an active server can be created.
  await worker.transaction('test.pki', (tx) =>
    initPki(tx, parsed.value, clock, {
      gatewayUrl: 'https://10.8.2.2:7443',
      serverName: 'gw.exdb.internal',
    }),
  )
}, 60_000)

afterAll(async () => {
  await db?.drop()
})

async function operation(): Promise<string> {
  const id = newId('op', Date.now())
  await db.asSuperuser((c) =>
    c.query(
      `INSERT INTO operations.operations (operation_id, kind, kind_version, state, apply_outcome, verification_outcome,
                                          actor_kind, client_kind)
       VALUES ($1, 'node.test', 1, 'queued', 'not_started', 'pending', 'system', 'system')`,
      [id],
    ),
  )
  return id
}

async function server(): Promise<string> {
  const id = newId('srv', Date.now())
  await worker.query(
    'test.server',
    `INSERT INTO registry.servers (server_id, display_name, provider, labels, created_by_operation_id)
     VALUES ($1, 'db host', 'other', '{}', $2)`,
    [id, await operation()],
  )
  return id
}

const retire = (serverId: string, operationId: string) => (tx: Tx) =>
  tx.query(
    'test.retire',
    `UPDATE registry.servers SET state = 'retired', retired_by_operation_id = $2 WHERE server_id = $1`,
    [serverId, operationId],
  )

const token = (serverId: string, operationId: string) => (tx: Tx) =>
  createEnrollmentToken(tx, clock, {
    tokenId: newId('ent', Date.now()),
    serverId,
    revealBy: newId('idn', Date.now()),
    operationId,
  })

const tokensOf = async (serverId: string) =>
  (
    await worker.query(
      'test.tokens',
      'SELECT count(*)::int AS n FROM nodes.enrollment_tokens WHERE server_id = $1',
      [serverId],
    )
  ).rows[0]?.int('n')

/** A transaction on its own connection: it tells its backend pid, then runs `steps`; `done` settles to its error. */
function session(name: string, steps: (tx: Tx) => Promise<unknown>) {
  let tell: (pid: number) => void = () => {}
  const pid = new Promise<number>((resolve) => {
    tell = resolve
  })
  const done = worker
    .transaction(name, async (tx) => {
      const { rows } = await tx.query(
        `${name}.pid`,
        'SELECT pg_catalog.pg_backend_pid() AS pid',
        [],
      )
      tell(rows[0]?.int('pid') ?? -1)
      await steps(tx)
    })
    .then(
      () => undefined,
      (error: unknown) => error,
    )
  return { pid, done }
}

/** `first` holds its locks until `second` provably waits for exactly that transaction, then commits. */
async function race(
  first: (tx: Tx) => Promise<unknown>,
  second: (tx: Tx) => Promise<unknown>,
): Promise<{ readonly first: unknown; readonly second: unknown }> {
  let release: () => void = () => {}
  const gate = new Promise<void>((r) => {
    release = r
  })
  let locked: () => void = () => {}
  const holding = new Promise<void>((r) => {
    locked = r
  })
  const one = session('test.first', async (tx) => {
    await first(tx)
    locked()
    await gate
  })
  await Promise.race([holding, one.done])
  const two = session('test.second', second)
  try {
    const [blocked, holder] = [await two.pid, await one.pid]
    let waits = false
    for (let i = 0; i < 100 && !waits; i++) {
      const { rows } = await worker.query(
        'test.waits_for',
        'SELECT $2::int = ANY (pg_catalog.pg_blocking_pids($1::int)) AS waits',
        [blocked, holder],
      )
      waits = rows[0]?.bool('waits') === true
      if (!waits) await new Promise((r) => setTimeout(r, 50))
    }
    if (!waits) throw new Error(`backend ${blocked} never waited for backend ${holder}`)
  } finally {
    release()
  }
  return { first: await one.done, second: await two.done }
}

describe('a retired server gets no node', () => {
  it('refuses node.enroll in its planner', async () => {
    const serverId = await server()
    await worker.transaction('test.retire', retire(serverId, await operation()))
    const actor = {
      identityId: newId('idn', Date.now()) as IdentityId,
      label: 'human #1',
      reauthAt: new Date().toISOString(),
      client: 'web' as const,
    }
    // Refused before any policy is evaluated, so no policy context is needed.
    await expect(
      worker.transaction('test.plan', (tx) =>
        planNodeEnroll(tx, {} as NodePlanContext, actor, serverId),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT', details: { reason: 'server_retired' } })
  })

  it('makes a node.enroll plan stale when the server is retired after it was made', async () => {
    const serverId = await server()
    const kind = new NodeEnrollKind({ store: worker, clock })
    // The body planNodeEnroll stores for this server (the kind reads only content and expected state).
    const plan = {
      body: {
        content: { serverId, tokenId: newId('ent', Date.now()) },
        expectedState: { liveNode: false },
      },
    } as unknown as PlanRecord
    expect(await kind.checkBindings(plan)).toEqual([])
    await worker.transaction('test.retire', retire(serverId, await operation()))
    expect(await kind.checkBindings(plan)).toEqual([
      { binding: 'server', expected: 'active', actual: 'retired' },
    ])
  })

  it('refuses the token record on a retired server', async () => {
    const serverId = await server()
    const operationId = await operation()
    await worker.transaction('test.retire', retire(serverId, operationId))
    await expect(
      worker.transaction('test.token', token(serverId, operationId)),
    ).rejects.toMatchObject({ code: 'CONFLICT', details: { reason: 'server_retired' } })
    expect(await tokensOf(serverId)).toBe(0)
  })

  it('serializes a retirement with a new enrollment token on the server row, in either order', async () => {
    // The token first: the retirement waits for its lock, then its guard sees a redeemable token.
    const busy = await server()
    const busyOp = await operation()
    const tokenFirst = await race(token(busy, busyOp), retire(busy, busyOp))
    expect(tokenFirst.first).toBeUndefined()
    expect(tokenFirst.second).toMatchObject({ sqlstate: 'EXG06' })
    expect(await tokensOf(busy)).toBe(1)

    // The retirement first: the token waits for the server row, then sees it retired.
    const idle = await server()
    const idleOp = await operation()
    const retireFirst = await race(retire(idle, idleOp), token(idle, idleOp))
    expect(retireFirst.first).toBeUndefined()
    expect(retireFirst.second).toMatchObject({
      code: 'CONFLICT',
      details: { reason: 'server_retired' },
    })
    expect(await tokensOf(idle)).toBe(0)
  })
})
