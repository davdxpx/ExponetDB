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
    await expect(
      worker.query(
        'test.proven',
        `UPDATE backups.repositories SET lock_capability = 'proven' WHERE repository_id = $1`,
        [w.repositoryId],
      ),
    ).rejects.toMatchObject({ sqlstate: '23514' })
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
})
