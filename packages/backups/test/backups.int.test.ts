import type { ControlStore } from '@exponetdb/control-store'
import { type MigratedTestDatabase, migratedTestDatabase } from '@exponetdb/control-store/testing'
import { newId } from '@exponetdb/kernel'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  backupDependencies,
  computeProtection,
  getRepository,
  type ListResult,
  listCatalog,
  listCoverage,
  protectionFacts,
  reconcileCatalog,
} from '../src/index.ts'

/**
 * The backup mirror against a real, migrated Control Store (PostgreSQL 17,
 * EXDB_TEST_PG_URL): catalog reconciliation from a `backup.list@1` result,
 * the dependency port the registry's retirement asks, and the guards of
 * bundle `backup-catalog`. The engine is not run here (the lab suite
 * `runbook.lab.test.ts` runs pgBackRest); these tests prove what the
 * Control Store keeps and refuses.
 */

let db: MigratedTestDatabase
let worker: ControlStore
let serve: ControlStore

let worlds = 0

async function systemOperation(kind = 'registry.test'): Promise<string> {
  const id = newId('op', Date.now())
  await db.asSuperuser((c) =>
    c.query(
      `INSERT INTO operations.operations (operation_id, kind, kind_version, state, apply_outcome, verification_outcome,
                                          actor_kind, client_kind)
       VALUES ($1, $2, 1, 'queued', 'not_started', 'pending', 'system', 'system')`,
      [id, kind],
    ),
  )
  return id
}

interface World {
  readonly serverId: string
  readonly clusterId: string
  readonly repositoryId: string
  readonly systemIdentifier: string
}

async function world(): Promise<World> {
  const o = await systemOperation()
  const now = Date.now()
  const w = {
    serverId: newId('srv', now),
    clusterId: newId('cls', now),
    repositoryId: newId('bkr', now),
    systemIdentifier: String(7_400_000_000_000_000_000n + BigInt(++worlds)),
  }
  await db.asSuperuser(async (c) => {
    await c.query(
      `INSERT INTO registry.servers (server_id, display_name, provider, labels, created_by_operation_id)
       VALUES ($1, 'db host', 'other', '{}', $2)`,
      [w.serverId, o],
    )
    await c.query(
      `INSERT INTO registry.clusters (cluster_id, server_id, management_mode, display_name, state, ca_bundle, created_by_operation_id)
       VALUES ($1, $2, 'agent', 'main', 'pending', $3, $4)`,
      [
        w.clusterId,
        w.serverId,
        '-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----\n',
        o,
      ],
    )
    await c.query(
      `UPDATE registry.clusters SET state = 'active', system_identifier = $2, server_version_num = 170000,
              confirmed_by_operation_id = $3 WHERE cluster_id = $1`,
      [w.clusterId, w.systemIdentifier, o],
    )
  })
  await worker.query(
    'test.repository',
    `INSERT INTO backups.repositories (repository_id, cluster_id, layer, engine, provider, endpoint_host, region, bucket,
       prefix, stanza, repo_index, priority, purpose, ownership, secret_source, lock_mode, lock_capability, cipher,
       state, revision, created_by_operation_id)
     VALUES ($1, $2, 'l1_physical', 'pgbackrest', 's3_compatible', 'objects.example.test', 'eu-central', 'backups-test',
       'main/', 'main', 1, 1, 'primary', 'adopted_observed', 'host_config', 'unknown', 'unknown', 'unknown',
       'observing', 1, $3)`,
    [w.repositoryId, w.clusterId, await systemOperation('backup.repository.adopt')],
  )
  return w
}

const WAL_START = '000000010000000000000003'

function listing(w: World, over: Partial<ListResult> = {}): ListResult {
  return {
    engineVersion: '2.60.0',
    stanza: {
      status: 'ok',
      message: 'ok',
      systemIdentifier: w.systemIdentifier,
      cipher: 'aes-256-cbc',
    },
    backups: [
      {
        label: '20261020-010000F',
        kind: 'full',
        startedAt: '2026-10-20T01:00:00.000Z',
        finishedAt: '2026-10-20T01:10:00.000Z',
        lsnStart: '0/3000028',
        lsnStop: '0/3000100',
        walStart: WAL_START,
        sizeBytes: 100_000_000,
        repositorySizeBytes: 20_000_000,
        postgresMajor: 17,
        error: false,
      },
      {
        label: '20261020-010000F_20261021-010000I',
        kind: 'incremental',
        startedAt: '2026-10-21T01:00:00.000Z',
        finishedAt: '2026-10-21T01:02:00.000Z',
        lsnStart: '0/5000028',
        lsnStop: '0/5000100',
        walStart: '000000010000000000000005',
        sizeBytes: 100_500_000,
        repositorySizeBytes: 1_000_000,
        postgresMajor: 17,
        error: false,
      },
    ],
    archive: [{ id: '17-1', min: WAL_START, max: '000000010000000000000009' }],
    truncated: false,
    ...over,
  }
}

async function reconcile(w: World, result: ListResult, nowMs = Date.now()) {
  return worker.transaction('test.reconcile', (tx) =>
    reconcileCatalog(tx, {
      repositoryId: w.repositoryId,
      clusterId: w.clusterId,
      engine: 'pgbackrest',
      clusterSystemIdentifier: w.systemIdentifier,
      jobId: null,
      result,
      archive: {
        lastArchivedWal: '000000010000000000000009',
        lastArchivedAt: '2026-10-21T02:00:00.000Z',
      },
      nowMs,
    }),
  )
}

async function findings(
  clusterId: string,
): Promise<{ code: string; state: string; severity: string }[]> {
  const { rows } = await serve.query(
    'test.findings',
    `SELECT code, state, severity FROM observation.subject_findings WHERE cluster_id = $1 ORDER BY code, state`,
    [clusterId],
  )
  return rows.map((r) => ({
    code: r.text('code'),
    state: r.text('state'),
    severity: r.text('severity'),
  }))
}

beforeAll(async () => {
  db = await migratedTestDatabase('exdb_bkp')
  worker = db.store('exdb_worker')
  serve = db.store('exdb_serve')
})

afterAll(async () => {
  await db?.drop()
})

describe('catalog reconciliation', () => {
  it('mirrors the engine listing, its WAL coverage and the repository state', async () => {
    const w = await world()
    const outcome = await reconcile(w, listing(w))
    expect(outcome).toMatchObject({ outcome: 'ok', entries: 2, inserted: 2, missing: 0 })
    const page = await listCatalog(serve, w.clusterId, { limit: 10 })
    expect(page.items.map((b) => b.view.engineLabel).sort()).toEqual([
      '20261020-010000F',
      '20261020-010000F_20261021-010000I',
    ])
    for (const b of page.items) {
      expect(b.view.verification.state).toBe('pending')
      expect(b.view.divergence).toBe('none')
    }
    const coverage = await listCoverage(serve, w.clusterId)
    expect(coverage).toHaveLength(1)
    expect(coverage[0]).toMatchObject({
      timeline: 1,
      minSegment: WAL_START,
      maxSegment: '000000010000000000000009',
    })
    // The archiver's last archived segment is the newest listed one: its time is known.
    expect(coverage[0]?.maxArchivedAt?.toISOString()).toBe('2026-10-21T02:00:00.000Z')
    const r = await getRepository(serve, w.repositoryId)
    expect(r).toMatchObject({
      state: 'active',
      reconciliationOutcome: 'ok',
      engineAdvisory: 'subkey_check_missing',
    })
    // An encrypted stanza whose subkey check is not recorded stays an advisory, even on 2.60.0.
    expect(await findings(w.clusterId)).toEqual([
      { code: 'backup_engine_advisory', state: 'open', severity: 'warning' },
    ])
  })

  it('marks what the engine no longer lists, never removes it, and does not count it as protection', async () => {
    const w = await world()
    await reconcile(w, listing(w))
    const full = listing(w).backups[0]
    if (full === undefined) throw new Error('fixture')
    const outcome = await reconcile(w, listing(w, { backups: [full] }))
    expect(outcome).toMatchObject({ outcome: 'ok', entries: 1, inserted: 0, missing: 1 })
    const page = await listCatalog(serve, w.clusterId, { limit: 10 })
    expect(page.items).toHaveLength(2)
    const gone = page.items.find((b) => b.view.engineLabel.endsWith('I'))
    expect(gone?.view.divergence).toBe('missing_in_engine')
    expect((await findings(w.clusterId)).map((f) => f.code)).toContain('backup_catalog_divergence')
    // Listed again: divergence clears and the finding resolves.
    await reconcile(w, listing(w))
    const again = await listCatalog(serve, w.clusterId, { limit: 10 })
    expect(again.items.every((b) => b.view.divergence === 'none')).toBe(true)
    expect(await findings(w.clusterId)).toContainEqual({
      code: 'backup_catalog_divergence',
      state: 'resolved',
      severity: 'warning',
    })
  })

  it('a truncated listing is partial and marks nothing missing', async () => {
    const w = await world()
    await reconcile(w, listing(w))
    const outcome = await reconcile(w, listing(w, { backups: [], truncated: true }))
    expect(outcome).toMatchObject({ outcome: 'partial', missing: 0 })
    const page = await listCatalog(serve, w.clusterId, { limit: 10 })
    expect(page.items.every((b) => b.view.divergence === 'none')).toBe(true)
  })

  it('a stanza of another cluster fails closed: nothing is mirrored and a critical finding opens', async () => {
    const w = await world()
    const outcome = await reconcile(
      w,
      listing(w, {
        stanza: {
          status: 'ok',
          message: 'ok',
          systemIdentifier: '7400000000000000999',
          cipher: 'none',
        },
      }),
    )
    expect(outcome).toMatchObject({
      outcome: 'failed',
      errorCode: 'RESTORE_TARGET_MISMATCH',
      entries: 0,
    })
    expect((await listCatalog(serve, w.clusterId, { limit: 10 })).items).toHaveLength(0)
    expect(await getRepository(serve, w.repositoryId)).toMatchObject({ state: 'degraded' })
    expect(await findings(w.clusterId)).toContainEqual({
      code: 'backup_identity_mismatch',
      state: 'open',
      severity: 'critical',
    })
  })

  it('an unreadable stanza is a failure, never an empty catalog', async () => {
    const w = await world()
    await reconcile(w, listing(w))
    const outcome = await reconcile(w, listing(w, { stanza: null, backups: [] }))
    expect(outcome).toMatchObject({ outcome: 'failed', errorCode: 'BACKUP_REPOSITORY_UNAVAILABLE' })
    // What was mirrored stays; nothing was marked missing from a failed read.
    const page = await listCatalog(serve, w.clusterId, { limit: 10 })
    expect(page.items).toHaveLength(2)
    expect(page.items.every((b) => b.view.divergence === 'none')).toBe(true)
  })

  it('an engine below the floor is an advisory', async () => {
    const w = await world()
    await reconcile(w, listing(w, { engineVersion: '2.58.0' }))
    expect(await getRepository(serve, w.repositoryId)).toMatchObject({
      engineAdvisory: 'below_floor',
    })
  })
})

describe('protection from the mirror', () => {
  it('an unverified catalog without a drill is never protected', async () => {
    const w = await world()
    await reconcile(w, listing(w))
    const facts = await protectionFacts(serve, w.clusterId, Date.now())
    const p = computeProtection(facts)
    expect(p.state).not.toBe('protected')
    expect(p.rto.measuredSeconds).toBeNull()
  })
})

describe('dependency port (retirement)', () => {
  it('a live repository blocks the cluster and its server; ids only, no location', async () => {
    const w = await world()
    for (const subject of [
      { kind: 'cluster' as const, id: w.clusterId },
      { kind: 'server' as const, id: w.serverId },
    ]) {
      const report = await backupDependencies(serve, subject)
      expect(report.state).toBe('blocking')
      expect(report.dependencies).toEqual([
        { kind: 'repository', id: w.repositoryId, state: 'observing', reason: 'repository_live' },
      ])
      expect(JSON.stringify(report)).not.toMatch(/backups-test|objects\.example|main\//)
    }
  })

  it('an unreadable record set is unknown, never none', async () => {
    const lost = {
      query: async () => {
        throw new Error('connection lost')
      },
    }
    const report = await backupDependencies(lost as never, {
      kind: 'cluster',
      id: newId('cls', Date.now()),
    })
    expect(report.state).toBe('unknown')
    expect(report.dependencies[0]).toMatchObject({
      kind: 'unreadable',
      reason: 'backup_records_unreadable',
    })
  })

  it('the Control Store refuses to retire a cluster with a live repository (EXB07)', async () => {
    const w = await world()
    const o = await systemOperation()
    const retire = await systemOperation('backup.repository.retire')
    await expect(
      db.asSuperuser((c) =>
        c.query(
          `UPDATE registry.clusters SET state = 'retired', retired_at = now(), retired_by_operation_id = $2
            WHERE cluster_id = $1`,
          [w.clusterId, o],
        ),
      ),
    ).rejects.toMatchObject({ code: 'EXB07' })
    // A retired repository no longer binds it.
    await worker.query(
      'test.retire_repository',
      `UPDATE backups.repositories SET state = 'retired', retired_at = now(), retired_by_operation_id = $2,
              revision = revision + 1 WHERE repository_id = $1`,
      [w.repositoryId, retire],
    )
    expect((await backupDependencies(serve, { kind: 'cluster', id: w.clusterId })).state).toBe(
      'none',
    )
  })
})

describe('bundle guards', () => {
  it('a lock capability is never stored as proven, and a secret source is host configuration only', async () => {
    const w = await world()
    // The column's CHECK refuses 'proven' at adoption ...
    await expect(
      worker.query(
        'test.proven_insert',
        `INSERT INTO backups.repositories (repository_id, cluster_id, layer, engine, provider, prefix, priority,
           purpose, ownership, secret_source, lock_mode, lock_capability, cipher, state, revision,
           created_by_operation_id)
         VALUES ($1, $2, 'l2_logical', 'pg_dump', 'posix', 'dumps/', 1, 'secondary', 'adopted_observed',
           'host_config', 'none', 'proven', 'none', 'observing', 1, $3)`,
        [newId('bkr', Date.now()), w.clusterId, await systemOperation('backup.repository.adopt')],
      ),
    ).rejects.toMatchObject({ sqlstate: '23514' })
    // ... and later the guard refuses any change of the declared lock capability before the CHECK is reached.
    await expect(
      worker.query(
        'test.proven',
        `UPDATE backups.repositories SET lock_capability = 'proven' WHERE repository_id = $1`,
        [w.repositoryId],
      ),
    ).rejects.toMatchObject({ sqlstate: 'EXB01' })
    await expect(
      db.asSuperuser((c) =>
        c.query(
          `UPDATE backups.repositories SET secret_source = 'sealed' WHERE repository_id = $1`,
          [w.repositoryId],
        ),
      ),
    ).rejects.toMatchObject({ code: 'EXB01' })
  })

  it('the catalog and the reconciliation history are not deleted', async () => {
    const w = await world()
    await reconcile(w, listing(w))
    await expect(
      worker.query('test.delete', 'DELETE FROM backups.catalog WHERE repository_id = $1', [
        w.repositoryId,
      ]),
    ).rejects.toBeDefined()
    await expect(
      db.asSuperuser((c) =>
        c.query('DELETE FROM backups.reconciliations WHERE repository_id = $1', [w.repositoryId]),
      ),
    ).rejects.toBeDefined()
  })

  /** A statement as `exdb_worker` on a plain connection, for SQLSTATE assertions. */
  function asWorker(sql: string, params: readonly unknown[] = []) {
    return db.asRole('exdb_worker', (c) => c.query(sql, params as unknown[]))
  }

  /** An active node of the world's server (the enrollment is proven in the nodes suite). */
  async function node(w: World): Promise<string> {
    const nodeId = newId('nod', Date.now() + Math.floor(Math.random() * 100_000))
    await db.asSuperuser(async (c) => {
      await c.query('BEGIN')
      await c.query("SET LOCAL session_replication_role = 'replica'")
      await c.query(
        `INSERT INTO nodes.nodes (node_id, server_id, token_id, state, tls_key, node_signing_key, node_encryption_key,
           bind_proof, bound_at, certificate, certificate_expires_at, host, agent_version, protocol_major,
           capabilities, clusters, in_flight, heartbeat, last_hello_at, last_heartbeat_at, enrolled_at,
           state_changed_at, trusted_job_keys)
         VALUES ($1, $2, $3, 'active', decode(repeat('01', 32), 'hex'), $4, $5, NULL, now(), decode(repeat('ab', 100), 'hex'),
                 now() + interval '30 days', '{}', '1.0.0', 1, '[]', '[]'::jsonb, '[]', NULL, now(), now(), now(),
                 now(), '["k1"]')`,
        [
          nodeId,
          w.serverId,
          newId('ent', Date.now() + Math.floor(Math.random() * 100_000)),
          Buffer.from(nodeId.slice(4, 36).padEnd(32, '0')),
          Buffer.from(`${nodeId.slice(4, 35)}x`.padEnd(32, '1')),
        ],
      )
      await c.query('COMMIT')
    })
    return nodeId
  }

  /** A finished verify run of the world's repository, written as the worker writes it. */
  async function verifyRun(
    w: World,
    nodeId: string,
    state: 'succeeded' | 'failed',
    verifyErrors: number,
  ): Promise<string> {
    const runId = newId('run', Date.now() + Math.floor(Math.random() * 100_000))
    await asWorker(
      `INSERT INTO backups.runs (run_id, cluster_id, repository_id, node_id, purpose, operation_id, state)
       VALUES ($1, $2, $3, $4, 'verify', $5, 'starting')`,
      [runId, w.clusterId, w.repositoryId, nodeId, await systemOperation('backup.verify')],
    )
    await asWorker(
      `UPDATE backups.runs SET state = $2, finished_at = clock_timestamp(), outcome = $3::jsonb WHERE run_id = $1`,
      [runId, state, JSON.stringify({ verifyErrors })],
    )
    return runId
  }

  async function backupIds(w: World): Promise<string[]> {
    await reconcile(w, listing(w))
    const { rows } = await serve.query(
      'test.backup_ids',
      'SELECT backup_id FROM backups.catalog WHERE repository_id = $1 ORDER BY started_at',
      [w.repositoryId],
    )
    const ids = rows.map((r) => r.text('backup_id'))
    if (ids.length < 2) throw new Error('fixture')
    return ids
  }

  const VERIFY = `UPDATE backups.catalog SET verification_state = $2, verified_at = clock_timestamp(),
                         verification_run_id = $3 WHERE backup_id = $1`

  it('a verification passes only from a succeeded verify run without errors (EXB04)', async () => {
    const w = await world()
    const nodeId = await node(w)
    const [backupId] = await backupIds(w)
    const failedRun = await verifyRun(w, nodeId, 'failed', 1)
    await expect(asWorker(VERIFY, [backupId, 'passed', failedRun])).rejects.toMatchObject({
      code: 'EXB04',
    })
    // A succeeded run that found errors does not make a pass either.
    const withErrors = await verifyRun(w, nodeId, 'succeeded', 2)
    await expect(asWorker(VERIFY, [backupId, 'passed', withErrors])).rejects.toMatchObject({
      code: 'EXB04',
    })
    // The failed run records a failed verification; a new clean succeeded run records a pass.
    await asWorker(VERIFY, [backupId, 'failed', failedRun])
    await asWorker(VERIFY, [backupId, 'passed', await verifyRun(w, nodeId, 'succeeded', 0)])
    const { rows } = await serve.query(
      'test.verification',
      'SELECT verification_state FROM backups.catalog WHERE backup_id = $1',
      [backupId],
    )
    expect(rows[0]?.text('verification_state')).toBe('passed')
  })

  it('a failed verification is not flipped to passed with the same run, nor undone (EXB04)', async () => {
    const w = await world()
    const nodeId = await node(w)
    const [backupId, other] = await backupIds(w)
    const failedRun = await verifyRun(w, nodeId, 'failed', 1)
    await asWorker(VERIFY, [backupId, 'failed', failedRun])
    await expect(
      asWorker(`UPDATE backups.catalog SET verification_state = 'passed' WHERE backup_id = $1`, [
        backupId,
      ]),
    ).rejects.toMatchObject({ code: 'EXB04' })
    await expect(asWorker(VERIFY, [backupId, 'passed', failedRun])).rejects.toMatchObject({
      code: 'EXB04',
    })
    await expect(
      asWorker(
        `UPDATE backups.catalog SET verification_state = 'pending', verified_at = NULL, verification_run_id = NULL
          WHERE backup_id = $1`,
        [backupId],
      ),
    ).rejects.toMatchObject({ code: 'EXB04' })
    // One run verifies one entry: another entry does not borrow it.
    await expect(asWorker(VERIFY, [other, 'failed', failedRun])).rejects.toMatchObject({
      code: 'EXB04',
    })
    // A new entry never arrives verified.
    await expect(
      asWorker(
        `INSERT INTO backups.catalog (backup_id, repository_id, engine_label, kind, state, started_at,
           verification_state, verified_at, verification_run_id)
         VALUES ($1, $2, 'forged', 'full', 'succeeded', now(), 'failed', now(), $3)`,
        [newId('bkp', Date.now()), w.repositoryId, failedRun],
      ),
    ).rejects.toMatchObject({ code: 'EXB04' })
  })

  it('an ownership operation changes one repository once, and only its ownership (EXB01)', async () => {
    const a = await world()
    const b = await world()
    const ownership = await systemOperation('backup.repository.ownership')
    const OWN = `UPDATE backups.repositories SET ownership = 'adopted_runs', revision = revision + 1,
                        changed_by_operation_id = $2 WHERE repository_id = $1`
    await asWorker(OWN, [a.repositoryId, ownership])
    // The same operation does not change a second repository.
    await expect(asWorker(OWN, [b.repositoryId, ownership])).rejects.toMatchObject({
      code: 'EXB01',
    })
    // Declared facts are not changed by an ownership operation, new or reused.
    for (const set of [
      `cipher = 'none'`,
      'offline_copy_confirmed_at = now()',
      `lock_capability = 'unsupported'`,
      'priority = 2',
    ]) {
      for (const op of [ownership, await systemOperation('backup.repository.ownership')]) {
        await expect(
          asWorker(
            `UPDATE backups.repositories SET ${set}, revision = revision + 1, changed_by_operation_id = $2
              WHERE repository_id = $1`,
            [b.repositoryId, op],
          ),
        ).rejects.toMatchObject({ code: 'EXB01' })
      }
    }
    // The changing operation is new on every change, and of the ownership kind.
    await expect(
      asWorker(
        `UPDATE backups.repositories SET changed_by_operation_id = $2, revision = revision + 1
          WHERE repository_id = $1`,
        [a.repositoryId, await systemOperation('backup.repository.ownership')],
      ),
    ).rejects.toMatchObject({ code: 'EXB01' })
    await expect(
      asWorker(OWN, [b.repositoryId, await systemOperation('backup.repository.retire')]),
    ).rejects.toMatchObject({ code: 'EXB01' })
    // An ownership change carries no observation with it.
    await expect(
      asWorker(
        `UPDATE backups.repositories SET ownership = 'adopted_runs', revision = revision + 1,
                changed_by_operation_id = $2, engine_advisory = 'none', reconciled_at = now(),
                reconciliation_outcome = 'ok' WHERE repository_id = $1`,
        [b.repositoryId, await systemOperation('backup.repository.ownership')],
      ),
    ).rejects.toMatchObject({ code: 'EXB01' })
    expect(await getRepository(serve, b.repositoryId)).toMatchObject({
      ownership: 'adopted_observed',
      revision: 1,
    })
  })

  it('a retirement operation retires one repository, and nothing else changes with it (EXB01)', async () => {
    const a = await world()
    const b = await world()
    const retire = await systemOperation('backup.repository.retire')
    const RETIRE = `UPDATE backups.repositories SET state = 'retired', retired_at = now(), retired_by_operation_id = $2,
                           revision = revision + 1 WHERE repository_id = $1`
    await asWorker(RETIRE, [a.repositoryId, retire])
    await expect(asWorker(RETIRE, [b.repositoryId, retire])).rejects.toMatchObject({
      code: 'EXB01',
    })
    await expect(
      asWorker(
        `UPDATE backups.repositories SET state = 'retired', retired_at = now(), retired_by_operation_id = $2,
                revision = revision + 1, engine_advisory = 'none' WHERE repository_id = $1`,
        [b.repositoryId, await systemOperation('backup.repository.retire')],
      ),
    ).rejects.toMatchObject({ code: 'EXB01' })
  })

  it('the engine advisory changes only with a reconciliation that moves forward (EXB01)', async () => {
    const w = await world()
    await reconcile(w, listing(w))
    expect(await getRepository(serve, w.repositoryId)).toMatchObject({
      engineAdvisory: 'subkey_check_missing',
    })
    await expect(
      asWorker(
        `UPDATE backups.repositories SET engine_advisory = 'none' WHERE repository_id = $1`,
        [w.repositoryId],
      ),
    ).rejects.toMatchObject({ code: 'EXB01' })
    await expect(
      asWorker(
        `UPDATE backups.repositories SET observed_engine_version = '2.61.0' WHERE repository_id = $1`,
        [w.repositoryId],
      ),
    ).rejects.toMatchObject({ code: 'EXB01' })
    // A reconciliation time that does not move forward, or lies in the future, is refused.
    for (const at of [
      'reconciled_at',
      `reconciled_at - interval '1 hour'`,
      `now() + interval '1 day'`,
    ]) {
      await expect(
        asWorker(
          `UPDATE backups.repositories SET engine_advisory = 'none', reconciled_at = ${at}
            WHERE repository_id = $1`,
          [w.repositoryId],
        ),
      ).rejects.toMatchObject({ code: 'EXB01' })
    }
    // The state moves only with a reconciliation's outcome.
    await expect(
      asWorker(
        `UPDATE backups.repositories SET state = 'degraded', reconciled_at = clock_timestamp()
          WHERE repository_id = $1`,
        [w.repositoryId],
      ),
    ).rejects.toMatchObject({ code: 'EXB01' })
    expect(await getRepository(serve, w.repositoryId)).toMatchObject({
      engineAdvisory: 'subkey_check_missing',
      state: 'active',
    })
    // The worker's own refresh still records it.
    await reconcile(w, listing(w, { engineVersion: '2.58.0' }))
    expect(await getRepository(serve, w.repositoryId)).toMatchObject({
      engineAdvisory: 'below_floor',
    })
  })

  it('a drill does not finish, or start, in the future (EXB06)', async () => {
    const w = await world()
    const nodeId = await node(w)
    const restoreId = newId('rst', Date.now())
    // The restore row itself is proven by the restore kinds; here it only anchors the drill.
    await db.asSuperuser(async (c) => {
      await c.query('BEGIN')
      await c.query("SET LOCAL session_replication_role = 'replica'")
      await c.query(
        `INSERT INTO backups.restores (restore_id, cluster_id, purpose, state, repository_id, destination_kind, node_id,
           plan_id) VALUES ($1, $2, 'drill', 'restoring', $3, 'scratch', $4, $5)`,
        [restoreId, w.clusterId, w.repositoryId, nodeId, newId('pln', Date.now())],
      )
      await c.query('COMMIT')
    })
    const drillId = newId('drl', Date.now())
    await asWorker(
      `INSERT INTO backups.drills (drill_id, cluster_id, restore_id, repository_id, selection, mode, outcome, started_at)
       VALUES ($1, $2, $3, $4, 'latest', 'control_plane', 'pending', clock_timestamp())`,
      [drillId, w.clusterId, restoreId, w.repositoryId],
    )
    await expect(
      asWorker(
        `UPDATE backups.drills SET outcome = 'passed', measured_rto_seconds = 60,
                finished_at = clock_timestamp() + interval '1 day' WHERE drill_id = $1`,
        [drillId],
      ),
    ).rejects.toMatchObject({ code: 'EXB06' })
    await expect(
      asWorker(
        `UPDATE backups.drills SET started_at = clock_timestamp() + interval '1 hour' WHERE drill_id = $1`,
        [drillId],
      ),
    ).rejects.toMatchObject({ code: 'EXB06' })
    // An offline attestation of a restore that has not happened yet is refused too.
    await expect(
      asWorker(
        `INSERT INTO backups.drills (drill_id, cluster_id, repository_id, selection, mode, outcome, runbook_digest,
           recorded_by, started_at, finished_at)
         VALUES ($1, $2, $3, 'latest', 'offline_runbook', 'attested', $4, $5, now(), now() + interval '1 day')`,
        [
          newId('drl', Date.now() + 1),
          w.clusterId,
          w.repositoryId,
          `sha256:${'a'.repeat(64)}`,
          newId('idn', Date.now()),
        ],
      ),
    ).rejects.toMatchObject({ code: 'EXB06' })
    await asWorker(
      `UPDATE backups.drills SET outcome = 'passed', measured_rto_seconds = 60, finished_at = clock_timestamp()
        WHERE drill_id = $1`,
      [drillId],
    )
  })
})
