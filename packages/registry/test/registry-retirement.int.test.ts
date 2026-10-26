import type { Tx } from '@exponetdb/control-store'
import { newId } from '@exponetdb/kernel'
import { serverFor, withSuperuser } from '@exponetdb/testkit'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  clusterRetirement,
  getCluster,
  getServer,
  noBackupEngine,
  planClusterRegister,
  planClusterRetire,
  planDatabaseRetire,
  planEndpointAdd,
  planEndpointRetire,
  planServerCreate,
  planServerRetire,
  type RegistryActor,
  retirementClear,
  serverRetirement,
} from '../src/index.ts'
import {
  accept,
  actor,
  drive,
  type Harness,
  harness,
  plan,
  planContent,
  readyCluster,
  registerDatabase,
  run,
  targetDatabase,
  targets,
} from './harness.ts'

/**
 * Retiring servers and clusters (registry.md §4.4, the owner's UI/UX order of 2026-10-26 §8A):
 * bottom-up and never by cascade. A record with a live child is refused by the planner, by the
 * kind's bindings and by the Control Store's guard; a retirement and a new child serialize on
 * the parent row; a retired record stays, final, and nothing outside the Control Store changes.
 */
const pg17 = serverFor(17)
const backups = noBackupEngine
let h: Harness
let a: RegistryActor
const created: string[] = []

beforeAll(async () => {
  h = await harness('exdb_it_retirement')
  a = actor()
}, 120_000)

afterAll(async () => {
  await h?.close()
})

async function newServer(name: string): Promise<string> {
  const r = await run(h, a, (tx) =>
    planServerCreate(tx, h.context, a, { displayName: name, provider: 'other' }),
  )
  expect(r.operation.state).toBe('succeeded')
  return String((await planContent(h, r.plan.planId))['serverId'])
}

const clusterRequest = (serverId: string | undefined, port: number) => ({
  displayName: `pending ${port}`,
  ...(serverId === undefined ? {} : { serverId: serverId as never }),
  caBundle: targets().caPem,
  endpoints: [
    {
      kind: 'private' as const,
      host: '10.255.0.1',
      port,
      tlsServerName: 'pg.exdb.test',
      label: 'p',
    },
  ],
})

/** A pending cluster on `serverId` (registration needs no connection; confirmation would). */
async function pendingCluster(serverId: string | undefined, port: number): Promise<string> {
  const r = await run(h, a, (tx) =>
    planClusterRegister(tx, h.context, a, clusterRequest(serverId, port)),
  )
  expect(r.operation.state).toBe('succeeded')
  return String((await planContent(h, r.plan.planId))['clusterId'])
}

/** The operation that created the server (any operation satisfies a retirement's foreign key). */
async function operationOf(serverId: string): Promise<string> {
  const { rows } = await h.worker.query(
    'test.retirement.server_op',
    'SELECT created_by_operation_id AS id FROM registry.servers WHERE server_id = $1',
    [serverId],
  )
  return String(rows[0]?.text('id'))
}

/** A transaction on its own connection: it tells its backend pid, then runs `steps`; `done` settles to its error. */
function session(name: string, steps: (tx: Tx) => Promise<unknown>) {
  let tell: (pid: number) => void = () => {}
  const pid = new Promise<number>((resolve) => {
    tell = resolve
  })
  const done = h.worker
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

/** Resolves once the backend `blocked` waits for a lock that `holder` holds (another suite's waiter does not count). */
async function waitsFor(blocked: number, holder: number): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const { rows } = await h.worker.query(
      'test.retirement.waits_for',
      'SELECT $2::int = ANY (pg_catalog.pg_blocking_pids($1::int)) AS waits',
      [blocked, holder],
    )
    if (rows[0]?.bool('waits') === true) return
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`backend ${blocked} never waited for backend ${holder}`)
}

/**
 * `first` takes its locks and holds them until `second` provably waits for exactly that
 * transaction; then `first` commits and `second` goes on. Each settles to its error (or undefined).
 */
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
  const one = session('test.retirement.first', async (tx) => {
    await first(tx)
    locked()
    await gate
  })
  await Promise.race([holding, one.done])
  const two = session('test.retirement.second', second)
  try {
    await waitsFor(await two.pid, await one.pid)
  } finally {
    release()
  }
  return { first: await one.done, second: await two.done }
}

const retireServerSql = (serverId: string, operationId: string) => (tx: Tx) =>
  tx.query(
    'test.retirement.retire_server',
    `UPDATE registry.servers SET state = 'retired', retired_by_operation_id = $2 WHERE server_id = $1`,
    [serverId, operationId],
  )

describe('registry.server.retire', () => {
  it('retires a server with no child once, keeps the record, and gives a retired server no cluster', async () => {
    const serverId = await newServer('lonely host')
    const before = await serverRetirement(h.worker, serverId, { backups })
    expect(before === undefined ? false : retirementClear(before)).toBe(true)
    expect(before?.backups).toBe('not_installed')

    const retired = await run(h, a, (tx) =>
      planServerRetire(tx, h.context, a, serverId, 'host_returned', backups),
    )
    expect(retired.operation).toMatchObject({ state: 'succeeded', verificationOutcome: 'passed' })
    const record = await getServer(h.worker, serverId)
    expect(record?.state).toBe('retired')
    expect(record?.retiredAt).not.toBeNull()
    const audit = await h.worker.query(
      'test.retirement.server.audit',
      `SELECT (event::jsonb)->'changes'->>'reason' AS reason FROM audit.audit_events
        WHERE operation_id = $1 AND action = 'registry.server.retire'`,
      [retired.operation.operationId],
    )
    expect(audit.rows.map((r) => r.text('reason'))).toEqual(['host_returned'])

    await expect(
      plan(h, (tx) => planServerRetire(tx, h.context, a, serverId, undefined, backups)),
    ).rejects.toMatchObject({ code: 'REGISTRY_CONFLICT', details: { reason: 'server_retired' } })
    // A cluster on a retired server is refused up front, by its planner.
    await expect(
      plan(h, (tx) => planClusterRegister(tx, h.context, a, clusterRequest(serverId, 5999))),
    ).rejects.toMatchObject({ code: 'REGISTRY_CONFLICT', details: { reason: 'server_retired' } })
    // A server record never changes otherwise: the worker may not, and the guard would refuse.
    await expect(
      h.worker.query(
        'test.retirement.server.rename',
        `UPDATE registry.servers SET display_name = 'x' WHERE server_id = $1`,
        [serverId],
      ),
    ).rejects.toMatchObject({ sqlstate: '42501' })
  })

  it('makes a cluster registration stale when its server is retired after the plan was made', async () => {
    const serverId = await newServer('retired under a plan')
    const p = await plan(h, (tx) =>
      planClusterRegister(tx, h.context, a, clusterRequest(serverId, 5998)),
    )
    const retired = await run(h, a, (tx) =>
      planServerRetire(tx, h.context, a, serverId, undefined, backups),
    )
    expect(retired.operation.state).toBe('succeeded')
    await expect(accept(h, p, a)).rejects.toMatchObject({ code: 'PLAN_STALE' })
  })

  it('refuses a server while a cluster on it is not retired, and retires bottom-up: the cluster, then the server', async () => {
    const serverId = await newServer('busy host')
    const clusterId = await pendingCluster(serverId, 6001)
    await expect(
      plan(h, (tx) => planServerRetire(tx, h.context, a, serverId, undefined, backups)),
    ).rejects.toMatchObject({ code: 'REGISTRY_CONFLICT', details: { reason: 'server_in_use' } })
    const blocked = await serverRetirement(h.worker, serverId, { backups })
    expect(blocked?.blockers.map((g) => [g.kind, g.total])).toEqual([['cluster', 1]])
    expect(blocked?.blockers[0]?.items[0]).toMatchObject({
      kind: 'cluster',
      id: clusterId,
      state: 'pending',
    })

    // The cluster's own endpoint only says how to reach it: it goes with the cluster.
    const plannedCluster = await clusterRetirement(h.worker, clusterId, { backups })
    expect(plannedCluster?.blockers).toEqual([])
    expect(plannedCluster?.retiredWith.map((g) => [g.kind, g.total])).toEqual([['endpoint', 1]])
    const cluster = await run(h, a, (tx) =>
      planClusterRetire(tx, h.context, a, clusterId, undefined, backups),
    )
    expect(cluster.operation).toMatchObject({ state: 'succeeded', verificationOutcome: 'passed' })
    expect((await getCluster(h.worker, clusterId))?.state).toBe('retired')
    const endpoints = await h.worker.query(
      'test.retirement.endpoints',
      `SELECT state, retired_by_operation_id FROM registry.endpoints WHERE cluster_id = $1`,
      [clusterId],
    )
    expect(endpoints.rows.map((r) => r.text('state'))).toEqual(['retired'])
    expect(endpoints.rows[0]?.text('retired_by_operation_id')).toBe(cluster.operation.operationId)

    const clear = await serverRetirement(h.worker, serverId, { backups })
    expect(clear?.blockers).toEqual([])
    expect(clear?.retiredChildren).toBe(1)
    const server = await run(h, a, (tx) =>
      planServerRetire(tx, h.context, a, serverId, undefined, backups),
    )
    expect(server.operation.state).toBe('succeeded')
    // History stays: the cluster record and its endpoint are still there, retired.
    expect((await getCluster(h.worker, clusterId))?.retiredAt).not.toBeNull()
  })

  it('holds an enrollment token that expired only just now as a blocker, in the preflight and in the guard alike', async () => {
    const serverId = await newServer('token host')
    const operationId = await operationOf(serverId)
    // Created tokens past their reveal window: one a minute ago (within the margin), one long ago.
    const token = (minutesAgo: number) =>
      h.worker.query(
        'test.retirement.token',
        `INSERT INTO nodes.enrollment_tokens (token_id, server_id, job_keys, state, reveal_by, reveal_until,
                                              created_by_operation_id)
         VALUES ($1, $2, '[{"keyId": "jk_test"}]', 'created', $3, clock_timestamp() - make_interval(mins => $4), $5)`,
        [newId('ent', Date.now()), serverId, newId('idn', Date.now()), minutesAgo, operationId],
      )
    await token(30)
    const old = await serverRetirement(h.worker, serverId, { backups })
    expect(old?.blockers).toEqual([])
    await token(1)
    const recent = await serverRetirement(h.worker, serverId, { backups })
    expect(recent?.blockers.map((g) => [g.kind, g.total])).toEqual([['enrollment_token', 1]])
    await expect(
      plan(h, (tx) => planServerRetire(tx, h.context, a, serverId, undefined, backups)),
    ).rejects.toMatchObject({ code: 'REGISTRY_CONFLICT', details: { reason: 'server_in_use' } })
    // The guard agrees with the preflight: it refuses while the recent token is within the margin.
    await expect(
      h.worker.transaction('test.retirement.token_guard', retireServerSql(serverId, operationId)),
    ).rejects.toMatchObject({ sqlstate: 'EXG06' })
  })

  it('serializes a retirement with a new cluster on the server row, in either order', async () => {
    const insertCluster = (serverId: string, operationId: string) => (tx: Tx) =>
      tx.query(
        'test.retirement.insert_cluster',
        `INSERT INTO registry.clusters (cluster_id, server_id, management_mode, display_name, state, ca_bundle,
                                        created_by_operation_id)
         VALUES ($1, $2, 'external', 'race', 'pending', $3, $4)`,
        [newId('cls', Date.now()), serverId, targets().caPem, operationId],
      )

    // The cluster first: the retirement waits for its lock, then its guard sees the cluster.
    const busy = await newServer('race: cluster first')
    const busyOp = await operationOf(busy)
    const childFirst = await race(insertCluster(busy, busyOp), retireServerSql(busy, busyOp))
    expect(childFirst.first).toBeUndefined()
    expect(childFirst.second).toMatchObject({ sqlstate: 'EXG06' })
    expect((await getServer(h.worker, busy))?.state).toBe('active')

    // The retirement first: the cluster waits for the server row, then sees it retired.
    const idle = await newServer('race: retirement first')
    const idleOp = await operationOf(idle)
    const retireFirst = await race(retireServerSql(idle, idleOp), insertCluster(idle, idleOp))
    expect(retireFirst.first).toBeUndefined()
    expect(retireFirst.second).toMatchObject({ sqlstate: 'EXG06' })
    expect((await getServer(h.worker, idle))?.state).toBe('retired')
    const clusters = await h.worker.query(
      'test.retirement.clusters_of',
      'SELECT count(*)::int AS n FROM registry.clusters WHERE server_id = $1',
      [idle],
    )
    expect(clusters.rows[0]?.int('n')).toBe(0)
  })

  it('reads open operations even when a stored plan body holds an escaped NUL character', async () => {
    const named = await newServer('named by a NUL plan')
    const other = await newServer('unrelated to it')
    // A queued operation whose plan body carries "\u0000" (jsonb cannot hold it).
    const p = await plan(h, (tx) =>
      planServerRetire(tx, h.context, a, named, 'nul \u0000 inside', backups),
    )
    const queued = await accept(h, p, a)
    expect(queued.state).toBe('queued')

    const unrelated = await serverRetirement(h.worker, other, { backups })
    expect(unrelated?.blockers).toEqual([])
    const subject = await serverRetirement(h.worker, named, { backups })
    expect(subject?.blockers.map((g) => [g.kind, g.total])).toEqual([['operation', 1]])
    expect(subject?.blockers[0]?.items[0]?.id).toBe(queued.operationId)
    await drive(h)
  })
})

describe('registry.cluster.retire', () => {
  it('refuses a cluster with a registered database, then retires it with its credentials; PostgreSQL is untouched', async () => {
    const clusterId = await readyCluster(h, a, pg17, 'ip', 'retire me')
    const name = await targetDatabase(pg17, 'cluster_retire')
    created.push(name)
    const databaseId = await registerDatabase(h, a, clusterId, name)
    await expect(
      plan(h, (tx) => planClusterRetire(tx, h.context, a, clusterId, undefined, backups)),
    ).rejects.toMatchObject({ code: 'REGISTRY_CONFLICT', details: { reason: 'cluster_in_use' } })
    const blocked = await clusterRetirement(h.worker, clusterId, { backups })
    expect(blocked?.blockers.map((g) => [g.kind, g.total])).toEqual([['database', 1]])
    expect(blocked?.blockers[0]?.items[0]).toMatchObject({
      id: databaseId,
      label: name,
      targetId: null,
    })

    const db = await run(h, a, (tx) => planDatabaseRetire(tx, h.context, a, clusterId, databaseId))
    expect(db.operation.state).toBe('succeeded')
    const ready = await clusterRetirement(h.worker, clusterId, { backups })
    expect(ready?.blockers).toEqual([])
    expect(ready?.retiredWith.find((g) => g.kind === 'credential')?.total).toBe(3)
    const retired = await run(h, a, (tx) =>
      planClusterRetire(tx, h.context, a, clusterId, 'moved', backups),
    )
    expect(retired.operation).toMatchObject({ state: 'succeeded', verificationOutcome: 'passed' })
    const credentials = await h.worker.query(
      'test.retirement.credentials',
      `SELECT DISTINCT state FROM registry.credentials WHERE cluster_id = $1 AND state <> 'failed'`,
      [clusterId],
    )
    expect(credentials.rows.map((r) => r.text('state'))).toEqual(['retired'])
    const exists = await withSuperuser(pg17, 'postgres', (c) =>
      c.query('SELECT 1 FROM pg_catalog.pg_database WHERE datname = $1', [name]),
    )
    expect(exists.rowCount).toBe(1)
    await expect(
      plan(h, (tx) => planClusterRetire(tx, h.context, a, clusterId, undefined, backups)),
    ).rejects.toMatchObject({ code: 'REGISTRY_CONFLICT', details: { reason: 'cluster_retired' } })
  })

  it('makes a plan stale when a database is registered after it was made', async () => {
    const clusterId = await readyCluster(h, a, pg17, 'localhost', 'stale me')
    const p = await plan(h, (tx) =>
      planClusterRetire(tx, h.context, a, clusterId, undefined, backups),
    )
    const name = await targetDatabase(pg17, 'stale_retire')
    created.push(name)
    await registerDatabase(h, a, clusterId, name)
    await expect(accept(h, p, a)).rejects.toMatchObject({ code: 'PLAN_STALE' })
    expect((await getCluster(h.worker, clusterId))?.state).toBe('active')
  })

  it('makes a plan stale when an endpoint that would go with the cluster is added after it was made', async () => {
    const clusterId = await pendingCluster(undefined, 6010)
    const p = await plan(h, (tx) =>
      planClusterRetire(tx, h.context, a, clusterId, undefined, backups),
    )
    const added = await run(h, a, (tx) =>
      planEndpointAdd(tx, h.context, a, clusterId, {
        kind: 'private',
        host: '10.255.0.3',
        port: 6011,
        tlsServerName: 'pg.exdb.test',
        label: 'late',
      }),
    )
    expect(added.operation.state).toBe('succeeded')
    await expect(accept(h, p, a)).rejects.toMatchObject({ code: 'PLAN_STALE' })
    expect((await getCluster(h.worker, clusterId))?.state).toBe('pending')
  })

  it('serializes a retirement with a new child on the cluster row, in either order', async () => {
    // A pending cluster without an active endpoint: nothing blocks it but a new endpoint.
    const clusterId = await pendingCluster(undefined, 6002)
    const [endpoint] = (
      await h.worker.query(
        'test.retirement.endpoint_of',
        'SELECT endpoint_id FROM registry.endpoints WHERE cluster_id = $1',
        [clusterId],
      )
    ).rows.map((r) => r.text('endpoint_id'))
    const retiredEndpoint = await run(h, a, (tx) =>
      planEndpointRetire(tx, h.context, a, clusterId, String(endpoint)),
    )
    expect(retiredEndpoint.operation.state).toBe('succeeded')
    const operationId = retiredEndpoint.operation.operationId

    const insertEndpoint = (port: number) => (tx: Tx) =>
      tx.query(
        'test.retirement.insert_endpoint',
        `INSERT INTO registry.endpoints (endpoint_id, cluster_id, kind, host, port, tls_server_name, label, state,
                                         created_by_operation_id)
         VALUES ($1, $2, 'private', '10.255.0.2', $3, 'pg.exdb.test', 'race', 'active', $4)`,
        [newId('end', Date.now()), clusterId, port, operationId],
      )
    const retire = (tx: Tx) =>
      tx.query(
        'test.retirement.retire_cluster',
        `UPDATE registry.clusters SET state = 'retired', retired_by_operation_id = $2 WHERE cluster_id = $1`,
        [clusterId, operationId],
      )

    // The child first: the retirement waits for its lock, then its guard sees the active endpoint.
    const childFirst = await race(insertEndpoint(6003), retire)
    expect(childFirst.first).toBeUndefined()
    expect(childFirst.second).toMatchObject({ sqlstate: 'EXG07' })
    expect((await getCluster(h.worker, clusterId))?.state).toBe('pending')

    // Retire the new endpoint again; then the retirement first: the child waits, then sees retired.
    await h.worker.query(
      'test.retirement.endpoint_back',
      `UPDATE registry.endpoints SET state = 'retired', retired_by_operation_id = $2
        WHERE cluster_id = $1 AND state = 'active'`,
      [clusterId, operationId],
    )
    const retireFirst = await race(retire, insertEndpoint(6004))
    expect(retireFirst.first).toBeUndefined()
    expect(retireFirst.second).toMatchObject({ sqlstate: 'EXG07' })
    expect((await getCluster(h.worker, clusterId))?.state).toBe('retired')
  })
})

afterAll(async () => {
  for (const name of created) {
    await withSuperuser(pg17, 'postgres', (c) =>
      c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`),
    ).catch(() => undefined)
  }
})
