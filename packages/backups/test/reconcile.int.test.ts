import type { ControlStore } from '@exponetdb/control-store'
import { type MigratedTestDatabase, migratedTestDatabase } from '@exponetdb/control-store/testing'
import { newId } from '@exponetdb/kernel'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type ListResult, listCoverage, protectionFacts, reconcileCatalog } from '../src/index.ts'

/**
 * Review findings on the catalog mirror against a real Control Store
 * (PostgreSQL 17): the newest segment's time is the archiver's only when it
 * archived exactly that segment (C-3/A-3), a future time is not believed,
 * and the cipher the engine reports wins over the declared one (A-8).
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

async function reconcile(
  w: World,
  result: ListResult,
  archive: { lastArchivedWal: string | null; lastArchivedAt: string | null } | null,
  nowMs = Date.now(),
) {
  return worker.transaction('test.reconcile', (tx) =>
    reconcileCatalog(tx, {
      repositoryId: w.repositoryId,
      clusterId: w.clusterId,
      engine: 'pgbackrest',
      clusterSystemIdentifier: w.systemIdentifier,
      jobId: null,
      result,
      archive,
      nowMs,
    }),
  )
}

beforeAll(async () => {
  db = await migratedTestDatabase('exdb_bkp_rec')
  worker = db.store('exdb_worker')
  serve = db.store('exdb_serve')
})

afterAll(async () => {
  await db?.drop()
})

describe('archive times of a repository', () => {
  it('takes the archiver time only for the exact newest segment of the repository', async () => {
    const w = await world()
    await reconcile(w, listing(w), {
      lastArchivedWal: '000000010000000000000009',
      lastArchivedAt: '2026-10-21T02:00:00.000Z',
    })
    expect((await listCoverage(serve, w.clusterId))[0]?.maxArchivedAt?.toISOString()).toBe(
      '2026-10-21T02:00:00.000Z',
    )
  })

  it('records no time when the archiver is ahead of what this repository lists (a lagging copy)', async () => {
    const w = await world()
    await reconcile(w, listing(w), {
      lastArchivedWal: '00000001000000000000002A',
      lastArchivedAt: '2026-10-21T02:00:00.000Z',
    })
    expect((await listCoverage(serve, w.clusterId))[0]?.maxArchivedAt).toBeNull()
  })

  it('does not believe an archiver time in the future', async () => {
    const w = await world()
    await reconcile(w, listing(w), {
      lastArchivedWal: '000000010000000000000009',
      lastArchivedAt: new Date(Date.now() + 3_600_000).toISOString(),
    })
    expect((await listCoverage(serve, w.clusterId))[0]?.maxArchivedAt).toBeNull()
  })
})

describe('cipher of a repository', () => {
  it('uses the cipher the engine reported, not the declared one', async () => {
    const w = await world()
    // Declared unknown at adoption; the engine reports an encrypted stanza.
    await reconcile(w, listing(w), null)
    const facts = await protectionFacts(serve, w.clusterId, Date.now())
    expect(facts.repositories[0]?.cipher).toBe('aes-256-cbc')
    // An unencrypted stanza is reported as such, whatever was declared.
    await reconcile(
      w,
      listing(w, {
        stanza: {
          status: 'ok',
          message: 'ok',
          systemIdentifier: w.systemIdentifier,
          cipher: 'none',
        },
      }),
      null,
    )
    expect((await protectionFacts(serve, w.clusterId, Date.now())).repositories[0]?.cipher).toBe(
      'none',
    )
  })
})
