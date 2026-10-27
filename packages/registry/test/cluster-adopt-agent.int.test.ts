import { ControlStoreError } from '@exponetdb/control-store'
import { newId, systemClock } from '@exponetdb/kernel'
import { readOperation } from '@exponetdb/operations'
import { dropDatabase, serverFor, withSuperuser } from '@exponetdb/testkit'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ClusterAdoptAgentKind,
  getCluster,
  noBackupEngine,
  planClusterAdoptAgent,
  planClusterConfirm,
  planClusterDeclareTier,
  planClusterRegister,
  planEnvironmentCreate,
  planProductCreate,
  planProjectCreate,
  planServerCreate,
  planTargetRegister,
  type RegistryActor,
} from '../src/index.ts'
import {
  accept,
  actor,
  drive,
  endpointFor,
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
  targets,
  verifyCredentials,
} from './harness.ts'

/**
 * OD-54 option (a), the owner's Wave 9 Part B order (2026-10-26), registry.md
 * §4.5: an external cluster becomes agent-managed by one controlled, one-way
 * operation. The enrolled, live node of the cluster's server must report the
 * pinned system identifier exactly once, at plan and again at apply; the
 * Control Store guard admits external → agent by this operation and nothing
 * else; targets keep placement, generation and identity marker.
 */
const pg17 = serverFor(17)
let h: Harness
let a: RegistryActor
let serverA = ''
let clusterId = ''
let systemIdentifier = ''
let targetId = ''
let databaseName = ''
let port = 46_000

beforeAll(async () => {
  h = await harness('exdb_it_adopt_agent')
  a = actor()
  serverA = await newServer('host a')
  await ensureRoles(pg17)
  const reg = await run(h, a, (tx) =>
    planClusterRegister(tx, h.context, a, {
      displayName: 'pg17 on host a',
      serverId: serverA as never,
      caBundle: targets().caPem,
      endpoints: [endpointFor(pg17)],
    }),
  )
  expect(reg.operation.state).toBe('succeeded')
  clusterId = String((await planContent(h, reg.plan.planId))['clusterId'])
  await submit(h, a, clusterId, 'observer')
  await verifyCredentials(h)
  const confirm = await run(h, a, (tx) => planClusterConfirm(tx, h.context, a, clusterId, {}))
  expect(confirm.operation.state).toBe('succeeded')
  systemIdentifier = String((await getCluster(h.worker, clusterId))?.systemIdentifier)
  await submit(h, a, clusterId, 'migrator')
  await submit(h, a, clusterId, 'verifier')
  await verifyCredentials(h)

  // A target on the cluster: its placement, generation and identity marker must not move.
  const slug = `adopt${Date.now().toString(36)}`
  const product = await run(h, a, (tx) =>
    planProductCreate(tx, h.context, a, { slug, displayName: 'Adopt' }),
  )
  const productId = String((await planContent(h, product.plan.planId))['productId'])
  const env = await run(h, a, (tx) =>
    planEnvironmentCreate(tx, h.context, a, productId, {
      slug: 'staging',
      displayName: 'Staging',
      tier: 'nonprod',
    }),
  )
  const environmentId = String((await planContent(h, env.plan.planId))['environmentId'])
  const project = await run(h, a, (tx) =>
    planProjectCreate(tx, h.context, a, { product: slug, slug: 'platform', displayName: 'P' }),
  )
  const projectId = String((await planContent(h, project.plan.planId))['projectId'])
  databaseName = await targetDatabase(pg17, 'adopt_me')
  const databaseId = await registerDatabase(h, a, clusterId, databaseName)
  const registered = await run(h, a, (tx) =>
    planTargetRegister(tx, h.context, a, {
      projectId: projectId as never,
      environmentId: environmentId as never,
      databaseId: databaseId as never,
    }),
  )
  expect(registered.operation.state).toBe('succeeded')
  targetId = String((await planContent(h, registered.plan.planId))['targetId'])
}, 180_000)

afterAll(async () => {
  await h?.close()
  if (databaseName !== '') await dropDatabase(pg17, databaseName).catch(() => undefined)
})

async function newServer(name: string): Promise<string> {
  const r = await run(h, a, (tx) =>
    planServerCreate(tx, h.context, a, { displayName: name, provider: 'other' }),
  )
  expect(r.operation.state).toBe('succeeded')
  return String((await planContent(h, r.plan.planId))['serverId'])
}

/**
 * An active external cluster with a made-up system identifier: registered
 * through its operation, then confirmed past the guards (confirmation needs a
 * real cluster, which the happy path uses).
 */
async function syntheticCluster(serverId: string | undefined, sysid: string): Promise<string> {
  port += 1
  const r = await run(h, a, (tx) =>
    planClusterRegister(tx, h.context, a, {
      displayName: `synthetic ${port}`,
      ...(serverId === undefined ? {} : { serverId: serverId as never }),
      caBundle: targets().caPem,
      endpoints: [
        { kind: 'private', host: '10.255.0.1', port, tlsServerName: 'pg.exdb.test', label: 'p' },
      ],
    }),
  )
  expect(r.operation.state).toBe('succeeded')
  const id = String((await planContent(h, r.plan.planId))['clusterId'])
  await h.db.asSuperuser(async (c) => {
    await c.query('BEGIN')
    await c.query("SET LOCAL session_replication_role = 'replica'")
    await c.query(
      `UPDATE registry.clusters SET state = 'active', system_identifier = $2, confirmed_at = now(),
              confirmed_by_operation_id = created_by_operation_id WHERE cluster_id = $1`,
      [id, sysid],
    )
    await c.query('COMMIT')
  })
  return id
}

/** A node row as the gateway leaves it after hello (the enrollment is proven in the nodes suite). */
async function node(options: {
  serverId: string
  clusters: readonly object[]
  state?: string
  heartbeatAgoMs?: number
}): Promise<string> {
  const nodeId = newId('nod', Date.now() + Math.floor(Math.random() * 100_000))
  await h.db.asSuperuser(async (c) => {
    await c.query('BEGIN')
    await c.query("SET LOCAL session_replication_role = 'replica'")
    await c.query(
      `INSERT INTO nodes.nodes (node_id, server_id, token_id, state, tls_key, node_signing_key, node_encryption_key,
         bind_proof, bound_at, certificate, certificate_expires_at, host, agent_version, protocol_major,
         capabilities, clusters, in_flight, heartbeat, last_hello_at, last_heartbeat_at, enrolled_at,
         state_changed_at, trusted_job_keys)
       VALUES ($1, $2, $3, $4, decode(repeat('01', 32), 'hex'), $5, $6, NULL, now(), decode(repeat('ab', 100), 'hex'),
               now() + interval '30 days', '{}', '1.0.0', 1, '[]', $7::jsonb, '[]', NULL, now(),
               now() - make_interval(secs => $8::double precision / 1000), now(), now(), '["k1"]')`,
      [
        nodeId,
        options.serverId,
        newId('ent', Date.now() + Math.floor(Math.random() * 100_000)),
        options.state ?? 'active',
        Buffer.from(nodeId.slice(4, 36).padEnd(32, '0')),
        Buffer.from(`${nodeId.slice(4, 35)}x`.padEnd(32, '1')),
        JSON.stringify(options.clusters),
        options.heartbeatAgoMs ?? 1_000,
      ],
    )
    await c.query('COMMIT')
  })
  return nodeId
}

async function setNode(nodeId: string, set: string, params: readonly unknown[] = []) {
  await h.db.asSuperuser(async (c) => {
    await c.query('BEGIN')
    await c.query("SET LOCAL session_replication_role = 'replica'")
    await c.query(`UPDATE nodes.nodes SET ${set} WHERE node_id = $1`, [nodeId, ...params])
    await c.query('COMMIT')
  })
}

const adopt = (id: string, nodeId?: string) =>
  plan(h, (tx) =>
    planClusterAdoptAgent(tx, h.context, a, id, {
      acknowledgeOneWay: true,
      ...(nodeId === undefined ? {} : { nodeId: nodeId as never }),
    }),
  )

const conflictOf = (reason: string) => ({ code: 'REGISTRY_CONFLICT', details: { reason } })

/** The SQLSTATE a statement fails with as `role`, or null when it succeeds. */
async function refusal(
  role: 'exdb_worker' | 'exdb_serve',
  text: string,
  params: readonly unknown[],
): Promise<string | null> {
  const store = role === 'exdb_worker' ? h.worker : h.serve
  try {
    await store.query('test.adopt.direct', text, params)
    return null
  } catch (error) {
    if (error instanceof ControlStoreError) return error.sqlstate ?? 'unknown'
    throw error
  }
}

/** What adoption must never touch: targets, placements, identity marker. */
async function targetFacts() {
  const t = await h.worker.query(
    'test.adopt.targets',
    `SELECT t.target_id, t.state, t.generation, p.database_id, p.valid_to IS NULL AS live,
            d.cluster_id
       FROM registry.targets t JOIN registry.placements p ON p.target_id = t.target_id
       JOIN registry.databases d ON d.database_id = p.database_id
      WHERE t.target_id = $1 ORDER BY p.valid_from`,
    [targetId],
  )
  const marker = await withSuperuser(pg17, databaseName, (c) =>
    c.query(
      'SELECT installation_id, target_id, generation::text AS generation, stamped_by_op, cluster_system_id FROM exponetdb.target_identity',
    ),
  )
  return {
    targets: t.rows.map((r) => ({
      targetId: r.text('target_id'),
      state: r.text('state'),
      generation: r.int('generation'),
      databaseId: r.text('database_id'),
      live: r.bool('live'),
      clusterId: r.text('cluster_id'),
    })),
    marker: marker.rows,
  }
}

describe('registry.cluster.adopt_agent', () => {
  it('adopts an external cluster by the node of its server, once, and leaves its targets alone', async () => {
    const nodeId = await node({
      serverId: serverA,
      clusters: [{ localName: '17/main', systemIdentifier }],
    })
    // Undeclared: production authority, and the approval rule treats the tier as unknown.
    const undeclared = await adopt(clusterId)
    expect(undeclared.decision).toBe('require')
    await plan(h, (tx) =>
      planClusterDeclareTier(tx, h.context, a, clusterId, { declaredTier: 'nonprod' }),
    ).then((p) => accept(h, p, a))
    await drive(h)
    expect((await getCluster(h.worker, clusterId))?.declaredTier).toBe('nonprod')

    const before = await targetFacts()
    expect(before.targets).toHaveLength(1)
    expect(before.marker).toHaveLength(1)
    const adopted = await run(h, a, () => adopt(clusterId))
    expect(adopted.plan.decision).toBe('allow')
    expect(adopted.operation).toMatchObject({
      state: 'succeeded',
      applyOutcome: 'applied',
      verificationOutcome: 'passed',
    })
    expect(await planContent(h, adopted.plan.planId)).toEqual({
      clusterId,
      nodeId,
      serverId: serverA,
      clusterServerId: serverA,
      systemIdentifier,
      localName: '17/main',
    })
    const cluster = await getCluster(h.worker, clusterId)
    expect(cluster).toMatchObject({
      managementMode: 'agent',
      serverId: serverA,
      state: 'active',
      systemIdentifier,
      declaredTier: 'nonprod',
    })
    const record = await h.worker.query(
      'test.adopt.record',
      `SELECT adopted_at IS NOT NULL AS at, adopted_by_operation_id, adopted_node_id
         FROM registry.clusters WHERE cluster_id = $1`,
      [clusterId],
    )
    expect(record.rows[0]?.bool('at')).toBe(true)
    expect(record.rows[0]?.text('adopted_by_operation_id')).toBe(adopted.operation.operationId)
    expect(record.rows[0]?.text('adopted_node_id')).toBe(nodeId)
    expect(await targetFacts()).toEqual(before)

    const audit = await h.worker.query(
      'test.adopt.audit',
      `SELECT (event::jsonb)->'changes' AS changes FROM audit.audit_events
        WHERE operation_id = $1 AND action = 'registry.cluster.adopt_agent'`,
      [adopted.operation.operationId],
    )
    expect(audit.rows.map((r) => r.json('changes'))).toEqual([
      {
        clusterId,
        nodeId,
        serverId: serverA,
        localName: '17/main',
        systemIdentifier,
        before: { managementMode: 'external', serverId: serverA },
        after: { managementMode: 'agent', serverId: serverA },
      },
    ])

    // Idempotent: applying the plan again returns the same operation, a re-run of that
    // operation writes nothing, and a new plan finds nothing external to adopt.
    expect((await accept(h, adopted.plan, a)).operationId).toBe(adopted.operation.operationId)
    await drive(h)
    const kind = new ClusterAdoptAgentKind({
      store: h.worker,
      clock: systemClock,
      connector: h.workerConnector,
      installationId: h.db.installationId,
      controlStoreSystemIdentifier: async () => h.controlStoreSystemIdentifier,
      snapshots: h.snapshots,
      backupBindings: noBackupEngine,
    })
    const ctx = {
      plan: adopted.plan,
      operationId: adopted.operation.operationId,
      signal: new AbortController().signal,
      leaseOwner: 'test',
    }
    expect(await kind.execute(ctx)).toBe('applied')
    expect(await kind.verify(ctx)).toBe('passed')
    const events = await h.worker.query(
      'test.adopt.audit_count',
      `SELECT count(*)::int AS n FROM audit.audit_events
        WHERE operation_id = $1 AND action = 'registry.cluster.adopt_agent'`,
      [adopted.operation.operationId],
    )
    expect(events.rows[0]?.int('n')).toBe(1)
    await expect(adopt(clusterId)).rejects.toMatchObject(conflictOf('cluster_not_external'))
    expect(await targetFacts()).toEqual(before)

    // The guard: never back to external, never another server, never a second adoption.
    for (const set of [
      `management_mode = 'external'`,
      `server_id = '${await newServer('host z')}'`,
      `adopted_by_operation_id = created_by_operation_id`,
    ]) {
      expect(
        await refusal('exdb_worker', `UPDATE registry.clusters SET ${set} WHERE cluster_id = $1`, [
          clusterId,
        ]),
        set,
      ).toBe('EXG07')
    }
    // serve never writes a cluster's mode.
    expect(
      await refusal(
        'exdb_serve',
        `UPDATE registry.clusters SET management_mode = 'agent' WHERE cluster_id = $1`,
        [clusterId],
      ),
    ).toBe('42501')
  })

  it('refuses a cluster that is not external, not confirmed or retired', async () => {
    await expect(adopt(clusterId)).rejects.toMatchObject(conflictOf('cluster_not_external'))
    port += 1
    const pending = await run(h, a, (tx) =>
      planClusterRegister(tx, h.context, a, {
        displayName: 'pending',
        caBundle: targets().caPem,
        endpoints: [
          { kind: 'private', host: '10.255.0.1', port, tlsServerName: 'pg.exdb.test', label: 'p' },
        ],
      }),
    )
    const pendingId = String((await planContent(h, pending.plan.planId))['clusterId'])
    await expect(adopt(pendingId)).rejects.toMatchObject(conflictOf('cluster_not_confirmed'))
    await expect(adopt(newId('cls', Date.now()))).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(
      plan(h, (tx) =>
        planClusterAdoptAgent(tx, h.context, a, pendingId, { acknowledgeOneWay: false as never }),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
  })

  it('refuses without exactly one live node reporting the pinned system identifier', async () => {
    // No node on the server.
    const lonely = await newServer('host without node')
    const noNode = await syntheticCluster(lonely, '7000000000000000001')
    await expect(adopt(noNode)).rejects.toMatchObject(conflictOf('cluster_unmapped'))

    // A node of the server that does not report the cluster.
    const hostB = await newServer('host b')
    const other = await syntheticCluster(hostB, '7000000000000000002')
    const nodeB = await node({
      serverId: hostB,
      clusters: [{ localName: '17/main', systemIdentifier: '7000000000000000999' }],
    })
    await expect(adopt(other)).rejects.toMatchObject(conflictOf('cluster_unmapped'))
    // The same identifier twice on one host (a standby, a copied data directory).
    await setNode(nodeB, 'clusters = $2::jsonb', [
      JSON.stringify([
        { localName: '17/main', systemIdentifier: '7000000000000000002' },
        { localName: '17/copy', systemIdentifier: '7000000000000000002' },
      ]),
    ])
    await expect(adopt(other)).rejects.toMatchObject(conflictOf('cluster_ambiguous'))
    // Offline (no heartbeat for four intervals) or revoked: not served.
    await setNode(
      nodeB,
      `clusters = $2::jsonb, last_heartbeat_at = now() - interval '10 minutes'`,
      [JSON.stringify([{ localName: '17/main', systemIdentifier: '7000000000000000002' }])],
    )
    await expect(adopt(other)).rejects.toMatchObject(conflictOf('node_not_served'))
    await setNode(nodeB, `state = 'revoked', last_heartbeat_at = now()`)
    await expect(adopt(other, nodeB)).rejects.toMatchObject(conflictOf('node_not_served'))

    // A named node of another server.
    const hostC = await newServer('host c')
    const nodeC = await node({
      serverId: hostC,
      clusters: [{ localName: '17/main', systemIdentifier: '7000000000000000002' }],
    })
    await expect(adopt(other, nodeC)).rejects.toMatchObject(conflictOf('cluster_unmapped'))

    // A cluster without a server: two live nodes on two hosts claim it.
    const serverless = await syntheticCluster(undefined, '7000000000000000003')
    const hostD = await newServer('host d')
    const hostE = await newServer('host e')
    const nodeD = await node({
      serverId: hostD,
      clusters: [{ localName: '17/main', systemIdentifier: '7000000000000000003' }],
    })
    const nodeE = await node({
      serverId: hostE,
      clusters: [{ localName: '17/main', systemIdentifier: '7000000000000000003' }],
    })
    await expect(adopt(serverless)).rejects.toMatchObject(conflictOf('cluster_ambiguous'))
    // Undeclared and without targets: the tier is unknown, which needs an approval.
    expect((await adopt(serverless, nodeD)).decision).toBe('require')
    // Declared nonprod and named, one of them adopts it, and its server becomes the cluster's.
    await setNode(nodeE, `state = 'revoked'`)
    await plan(h, (tx) =>
      planClusterDeclareTier(tx, h.context, a, serverless, { declaredTier: 'nonprod' }),
    )
      .then((p) => accept(h, p, a))
      .then(() => drive(h))
    const adopted = await run(h, a, () => adopt(serverless, nodeD))
    expect(adopted.plan.decision).toBe('allow')
    expect(adopted.operation).toMatchObject({ state: 'succeeded', verificationOutcome: 'passed' })
    expect(await getCluster(h.worker, serverless)).toMatchObject({
      managementMode: 'agent',
      serverId: hostD,
    })
  })

  it('fails PLAN_STALE when the node report changes between plan and apply', async () => {
    const hostF = await newServer('host f')
    const id = await syntheticCluster(hostF, '7000000000000000004')
    const nodeF = await node({
      serverId: hostF,
      clusters: [{ localName: '17/main', systemIdentifier: '7000000000000000004' }],
    })
    await plan(h, (tx) => planClusterDeclareTier(tx, h.context, a, id, { declaredTier: 'nonprod' }))
      .then((p) => accept(h, p, a))
      .then(() => drive(h))
    const p = await adopt(id)
    const accepted = await accept(h, p, a)
    // The node now reports another cluster under that name (a different system identifier).
    await setNode(nodeF, 'clusters = $2::jsonb', [
      JSON.stringify([{ localName: '17/main', systemIdentifier: '7000000000000000444' }]),
    ])
    await drive(h)
    const operation = await readOperation(h.worker, accepted.operationId)
    expect(operation).toMatchObject({ state: 'failed', applyOutcome: 'not_started' })
    expect((await operationError(h, accepted.operationId)).code).toBe('PLAN_STALE')
    expect((await getCluster(h.worker, id))?.managementMode).toBe('external')

    // Under the row locks too: a change after the start is caught before anything is written.
    await setNode(nodeF, 'clusters = $2::jsonb', [
      JSON.stringify([{ localName: '17/main', systemIdentifier: '7000000000000000004' }]),
    ])
    const again = await adopt(id)
    await setNode(nodeF, 'clusters = $2::jsonb', [
      JSON.stringify([{ localName: '17/other', systemIdentifier: '7000000000000000004' }]),
    ])
    const kind = new ClusterAdoptAgentKind({
      store: h.worker,
      clock: systemClock,
      connector: h.workerConnector,
      installationId: h.db.installationId,
      controlStoreSystemIdentifier: async () => h.controlStoreSystemIdentifier,
      snapshots: h.snapshots,
      backupBindings: noBackupEngine,
    })
    expect(await kind.checkBindings(again)).toEqual([
      { binding: 'localName', expected: '17/main', actual: '17/other' },
    ])
    expect(
      await kind.execute({
        plan: again,
        operationId: newId('op', Date.now()),
        signal: new AbortController().signal,
        leaseOwner: 'test',
      }),
    ).toEqual({
      outcome: 'not_applied',
      errorCode: 'PLAN_STALE',
      detail: { changedBindings: ['localName'] },
    })
    expect((await getCluster(h.worker, id))?.managementMode).toBe('external')
  })

  it('lets the guard refuse every other change of mode or server', async () => {
    const hostG = await newServer('host g')
    const id = await syntheticCluster(hostG, '7000000000000000005')
    const nodeG = await node({
      serverId: hostG,
      clusters: [{ localName: '17/main', systemIdentifier: '7000000000000000999' }],
    })
    const ops = await h.worker.query(
      'test.adopt.ops',
      `SELECT (SELECT created_by_operation_id FROM registry.clusters WHERE cluster_id = $1) AS other,
              (SELECT adopted_by_operation_id FROM registry.clusters WHERE cluster_id = $2) AS adoption`,
      [id, clusterId],
    )
    const otherKind = ops.rows[0]?.text('other')
    const adoption = ops.rows[0]?.text('adoption')
    const update = (set: string, params: readonly unknown[] = []) =>
      refusal('exdb_worker', `UPDATE registry.clusters SET ${set} WHERE cluster_id = $1`, [
        id,
        ...params,
      ])
    // A direct change without the operation.
    expect(await update(`management_mode = 'agent'`)).toBe('EXG07')
    // Through an operation of another kind.
    expect(
      await update(
        `management_mode = 'agent', adopted_at = now(), adopted_by_operation_id = $2, adopted_node_id = $3`,
        [otherKind, nodeG],
      ),
    ).toBe('EXG07')
    // Through an adoption operation, but the node does not report the cluster's identifier.
    expect(
      await update(
        `management_mode = 'agent', adopted_at = now(), adopted_by_operation_id = $2, adopted_node_id = $3`,
        [adoption, nodeG],
      ),
    ).toBe('EXG07')
    // An adoption operation that already adopted another cluster, with a node that reports it.
    await setNode(nodeG, 'clusters = $2::jsonb', [
      JSON.stringify([{ localName: '17/main', systemIdentifier: '7000000000000000005' }]),
    ])
    expect(
      await update(
        `management_mode = 'agent', adopted_at = now(), adopted_by_operation_id = $2, adopted_node_id = $3`,
        [adoption, nodeG],
      ),
    ).toBe('23505')
    // A server alone, without the mode.
    expect(await update('server_id = $2', [await newServer('host h')])).toBe('EXG07')
    expect((await getCluster(h.worker, id))?.managementMode).toBe('external')
  })
})
