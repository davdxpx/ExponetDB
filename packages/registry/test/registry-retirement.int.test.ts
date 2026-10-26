import { newId } from '@exponetdb/kernel'
import { serverFor, withSuperuser } from '@exponetdb/testkit'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  clusterRetirement,
  getCluster,
  getServer,
  planClusterRegister,
  planClusterRetire,
  planDatabaseRetire,
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

/** A pending cluster on `serverId` (registration needs no connection; confirmation would). */
async function pendingCluster(serverId: string | undefined, port: number): Promise<string> {
  const r = await run(h, a, (tx) =>
    planClusterRegister(tx, h.context, a, {
      displayName: `pending ${port}`,
      ...(serverId === undefined ? {} : { serverId: serverId as never }),
      caBundle: targets().caPem,
      endpoints: [
        { kind: 'private', host: '10.255.0.1', port, tlsServerName: 'pg.exdb.test', label: 'p' },
      ],
    }),
  )
  expect(r.operation.state).toBe('succeeded')
  return String((await planContent(h, r.plan.planId))['clusterId'])
}

describe('registry.server.retire', () => {
  it('retires a server with no child once, keeps the record, and gives a retired server no cluster', async () => {
    const serverId = await newServer('lonely host')
    const before = await serverRetirement(h.worker, serverId)
    expect(before === undefined ? false : retirementClear(before)).toBe(true)
    expect(before?.backups).toBe('not_installed')

    const retired = await run(h, a, (tx) =>
      planServerRetire(tx, h.context, a, serverId, 'host_returned'),
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
      plan(h, (tx) => planServerRetire(tx, h.context, a, serverId, undefined)),
    ).rejects.toMatchObject({ code: 'REGISTRY_CONFLICT', details: { reason: 'server_retired' } })
    // A cluster registered on it now is refused by the Control Store (EXG06): not applied.
    const late = await run(h, a, (tx) =>
      planClusterRegister(tx, h.context, a, {
        displayName: 'too late',
        serverId: serverId as never,
        caBundle: targets().caPem,
        endpoints: [
          {
            kind: 'private',
            host: '10.255.0.9',
            port: 5999,
            tlsServerName: 'pg.exdb.test',
            label: 'x',
          },
        ],
      }),
    )
    expect(late.operation.applyOutcome).toBe('not_applied')
    // A server record never changes otherwise: the worker may not, and the guard would refuse.
    await expect(
      h.worker.query(
        'test.retirement.server.rename',
        `UPDATE registry.servers SET display_name = 'x' WHERE server_id = $1`,
        [serverId],
      ),
    ).rejects.toMatchObject({ sqlstate: '42501' })
  })

  it('refuses a server while a cluster on it is not retired, and retires bottom-up: the cluster, then the server', async () => {
    const serverId = await newServer('busy host')
    const clusterId = await pendingCluster(serverId, 6001)
    await expect(
      plan(h, (tx) => planServerRetire(tx, h.context, a, serverId, undefined)),
    ).rejects.toMatchObject({ code: 'REGISTRY_CONFLICT', details: { reason: 'server_in_use' } })
    const blocked = await serverRetirement(h.worker, serverId)
    expect(blocked?.blockers.map((g) => [g.kind, g.total])).toEqual([['cluster', 1]])
    expect(blocked?.blockers[0]?.items[0]).toMatchObject({
      kind: 'cluster',
      id: clusterId,
      state: 'pending',
    })

    // The cluster's own endpoint only says how to reach it: it goes with the cluster.
    const plannedCluster = await clusterRetirement(h.worker, clusterId)
    expect(plannedCluster?.blockers).toEqual([])
    expect(plannedCluster?.retiredWith.map((g) => [g.kind, g.total])).toEqual([['endpoint', 1]])
    const cluster = await run(h, a, (tx) =>
      planClusterRetire(tx, h.context, a, clusterId, undefined),
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

    const clear = await serverRetirement(h.worker, serverId)
    expect(clear?.blockers).toEqual([])
    expect(clear?.retiredChildren).toBe(1)
    const server = await run(h, a, (tx) => planServerRetire(tx, h.context, a, serverId, undefined))
    expect(server.operation.state).toBe('succeeded')
    // History stays: the cluster record and its endpoint are still there, retired.
    expect((await getCluster(h.worker, clusterId))?.retiredAt).not.toBeNull()
  })
})

describe('registry.cluster.retire', () => {
  it('refuses a cluster with a registered database, then retires it with its credentials; PostgreSQL is untouched', async () => {
    const clusterId = await readyCluster(h, a, pg17, 'ip', 'retire me')
    const name = await targetDatabase(pg17, 'cluster_retire')
    created.push(name)
    const databaseId = await registerDatabase(h, a, clusterId, name)
    await expect(
      plan(h, (tx) => planClusterRetire(tx, h.context, a, clusterId, undefined)),
    ).rejects.toMatchObject({ code: 'REGISTRY_CONFLICT', details: { reason: 'cluster_in_use' } })
    const blocked = await clusterRetirement(h.worker, clusterId)
    expect(blocked?.blockers.map((g) => [g.kind, g.total])).toEqual([['database', 1]])
    expect(blocked?.blockers[0]?.items[0]).toMatchObject({
      id: databaseId,
      label: name,
      targetId: null,
    })

    const db = await run(h, a, (tx) => planDatabaseRetire(tx, h.context, a, clusterId, databaseId))
    expect(db.operation.state).toBe('succeeded')
    const ready = await clusterRetirement(h.worker, clusterId)
    expect(ready?.blockers).toEqual([])
    expect(ready?.retiredWith.find((g) => g.kind === 'credential')?.total).toBe(3)
    const retired = await run(h, a, (tx) => planClusterRetire(tx, h.context, a, clusterId, 'moved'))
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
      plan(h, (tx) => planClusterRetire(tx, h.context, a, clusterId, undefined)),
    ).rejects.toMatchObject({ code: 'REGISTRY_CONFLICT', details: { reason: 'cluster_retired' } })
  })

  it('makes a plan stale when a database is registered after it was made', async () => {
    const clusterId = await readyCluster(h, a, pg17, 'localhost', 'stale me')
    const p = await plan(h, (tx) => planClusterRetire(tx, h.context, a, clusterId, undefined))
    const name = await targetDatabase(pg17, 'stale_retire')
    created.push(name)
    await registerDatabase(h, a, clusterId, name)
    await expect(accept(h, p, a)).rejects.toMatchObject({ code: 'PLAN_STALE' })
    expect((await getCluster(h.worker, clusterId))?.state).toBe('active')
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

    const waiting = async () => {
      for (let i = 0; i < 100; i++) {
        const { rows } = await h.worker.query(
          'test.retirement.waiting',
          'SELECT count(*)::int AS n FROM pg_catalog.pg_locks WHERE NOT granted',
          [],
        )
        if ((rows[0]?.int('n') ?? 0) > 0) return
        await new Promise((r) => setTimeout(r, 50))
      }
      throw new Error('nothing waited for the lock')
    }
    const insertEndpoint = (port: number) =>
      [
        `INSERT INTO registry.endpoints (endpoint_id, cluster_id, kind, host, port, tls_server_name, label, state,
                                      created_by_operation_id)
       VALUES ($1, $2, 'private', '10.255.0.2', $3, 'pg.exdb.test', 'race', 'active', $4)`,
        [newId('end', Date.now()), clusterId, port, operationId],
      ] as const
    const retire = [
      `UPDATE registry.clusters SET state = 'retired', retired_by_operation_id = $2 WHERE cluster_id = $1`,
      [clusterId, operationId],
    ] as const

    // The child first: the retirement waits for its lock, then its guard sees the active endpoint.
    let release: () => void = () => {}
    let gate = new Promise<void>((r) => (release = r))
    const child = h.worker.transaction('test.retirement.child_first', async (tx) => {
      const [sql, params] = insertEndpoint(6003)
      await tx.query('test.retirement.child', sql, [...params])
      await gate
    })
    await new Promise((r) => setTimeout(r, 100))
    const late = h.worker.query('test.retirement.retire_second', retire[0], [...retire[1]])
    await waiting()
    release()
    await child
    await expect(late).rejects.toMatchObject({ sqlstate: 'EXG07' })
    expect((await getCluster(h.worker, clusterId))?.state).toBe('pending')

    // Retire the new endpoint again; then the retirement first: the child waits, then sees retired.
    await h.worker.query(
      'test.retirement.endpoint_back',
      `UPDATE registry.endpoints SET state = 'retired', retired_by_operation_id = $2
        WHERE cluster_id = $1 AND state = 'active'`,
      [clusterId, operationId],
    )
    gate = new Promise<void>((r) => (release = r))
    const first = h.worker.transaction('test.retirement.retire_first', async (tx) => {
      await tx.query('test.retirement.retire', retire[0], [...retire[1]])
      await gate
    })
    await new Promise((r) => setTimeout(r, 100))
    const [sql, params] = insertEndpoint(6004)
    const childLate = h.worker.query('test.retirement.child_second', sql, [...params])
    await waiting()
    release()
    await first
    await expect(childLate).rejects.toMatchObject({ sqlstate: 'EXG07' })
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
