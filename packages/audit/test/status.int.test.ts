import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ControlStore } from '@exponetdb/control-store'
import { type MigratedTestDatabase, migratedTestDatabase } from '@exponetdb/control-store/testing'
import { systemClock } from '@exponetdb/kernel'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  appendAuditEvent,
  chainHead,
  createCheckpoint,
  exportKind,
  exportPendingCheckpoints,
  exportSinks,
  fileCheckpointExporter,
  latestCheckpoints,
  verifyChainBounded,
} from '../src/index.ts'
import { input } from './support.ts'

/**
 * The chain state the Web App reads (Wave 8, order §9): the head, the newest
 * checkpoints, the export progress per exporter without its name, and a
 * verification bounded in the events it walks, from the latest checkpoint,
 * read-only. Real PostgreSQL 17.
 */
let db: MigratedTestDatabase
let worker: ControlStore
let serve: ControlStore
let dir: string

const append = (n = 1) =>
  (async () => {
    for (let i = 0; i < n; i++) {
      await worker.transaction('test.audit.append', (tx) =>
        appendAuditEvent(tx, input({ changes: { n: i } }), { clock: systemClock }),
      )
    }
  })()

const tamper = (sql: string) =>
  db.asSuperuser(async (c) => {
    await c.query('BEGIN')
    await c.query("SET LOCAL session_replication_role = 'replica'")
    await c.query(sql)
    await c.query('COMMIT')
  })

beforeAll(async () => {
  db = await migratedTestDatabase('exdb_it_audit_status')
  worker = db.store('exdb_worker')
  serve = db.store('exdb_serve')
  dir = await mkdtemp(join(tmpdir(), 'exdb-audit-status-'))
})

afterAll(async () => {
  await db?.drop()
  await rm(dir, { recursive: true, force: true })
})

describe('an empty chain', () => {
  it('has no head and nothing to verify, and says so', async () => {
    expect(await chainHead(serve)).toBeNull()
    expect(await latestCheckpoints(serve, 5)).toEqual([])
    expect(await exportSinks(serve)).toEqual([])
    expect(await verifyChainBounded(serve)).toEqual({
      status: 'not_verified',
      reason: 'empty_chain',
      anchorCheckpointSeq: null,
      eventsSinceAnchor: 0,
      limit: 10_000,
    })
  })
})

describe('bounded verification', () => {
  it('walks the whole chain when no checkpoint exists and it is small', async () => {
    await append(5)
    const head = await chainHead(serve)
    expect(head).toMatchObject({ seq: 5, hash: expect.stringMatching(/^sha256:ac1:/) })
    expect(await verifyChainBounded(serve)).toEqual({
      status: 'verified',
      scope: 'full',
      anchorCheckpointSeq: null,
      fromSeq: 1,
      throughSeq: 5,
      verifiedEvents: 5,
    })
  })

  it('refuses to walk more events than the bound, with or without a checkpoint', async () => {
    expect(await verifyChainBounded(serve, { limit: 3 })).toEqual({
      status: 'not_verified',
      reason: 'too_many_events',
      anchorCheckpointSeq: null,
      eventsSinceAnchor: 5,
      limit: 3,
    })
  })

  it('verifies from the latest checkpoint: only the events after it are walked', async () => {
    const checkpoint = await createCheckpoint(worker, 'scheduled')
    expect(checkpoint?.seq).toBe(5)
    expect(await verifyChainBounded(serve)).toEqual({
      status: 'verified',
      scope: 'from_checkpoint',
      anchorCheckpointSeq: 5,
      fromSeq: 6,
      throughSeq: 5,
      verifiedEvents: 0,
    })
    await append(3)
    expect(await verifyChainBounded(serve)).toEqual({
      status: 'verified',
      scope: 'from_checkpoint',
      anchorCheckpointSeq: 5,
      fromSeq: 6,
      throughSeq: 8,
      verifiedEvents: 3,
    })
    expect(await verifyChainBounded(serve, { limit: 2 })).toMatchObject({
      status: 'not_verified',
      reason: 'too_many_events',
      anchorCheckpointSeq: 5,
      eventsSinceAnchor: 3,
      limit: 2,
    })
  })

  it('reports a break after the checkpoint with the failing sequence and the reason', async () => {
    await tamper(`UPDATE audit.audit_events SET action = 'test.other' WHERE seq = 7`)
    expect(await verifyChainBounded(serve)).toMatchObject({
      status: 'broken',
      scope: 'from_checkpoint',
      anchorCheckpointSeq: 5,
      failingSeq: 7,
      reason: 'columns_mismatch',
    })
    await tamper(`UPDATE audit.audit_events SET action = 'test.recorded' WHERE seq = 7`)
    expect(await verifyChainBounded(serve)).toMatchObject({ status: 'verified' })
  })

  it('reports a checkpoint that no longer matches its event', async () => {
    await tamper(
      `UPDATE audit.audit_events SET hash = 'sha256:ac1:${'0'.repeat(64)}' WHERE seq = 5`,
    )
    expect(await verifyChainBounded(serve)).toMatchObject({
      status: 'broken',
      failingSeq: 5,
      reason: 'checkpoint_mismatch',
    })
    await tamper(
      `UPDATE audit.audit_events SET hash = (SELECT hash FROM audit.audit_chain_checkpoints WHERE seq = 5) WHERE seq = 5`,
    )
    expect(await verifyChainBounded(serve)).toMatchObject({ status: 'verified' })
  })

  it('runs read-only, in one snapshot: a writer racing the verification does not break it', async () => {
    const run = verifyChainBounded(serve)
    await append(2)
    const result = await run
    expect(result.status).toBe('verified')
  })
})

describe('checkpoints and exporters', () => {
  it('lists the newest checkpoints first, bounded', async () => {
    await createCheckpoint(worker, 'manual')
    const list = await latestCheckpoints(serve, 1)
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ reason: 'manual' })
    const all = await latestCheckpoints(serve, 10)
    expect(all.map((c) => c.seq)).toEqual([...all.map((c) => c.seq)].sort((a, b) => b - a))
    expect(all.length).toBeGreaterThanOrEqual(2)
  })

  it('describes an exporter by kind and progress, never by its name or location', async () => {
    const run = await exportPendingCheckpoints(
      worker,
      db.installationId,
      fileCheckpointExporter(dir),
    )
    expect(run.failed).toBeUndefined()
    // A bucket-named sink, as the S3 exporter records it.
    await db.asSuperuser((c) =>
      c.query(
        `INSERT INTO audit.checkpoint_exports (checkpoint_seq, sink, location)
         SELECT min(seq), 's3.very-secret-bucket', 'prefix/ins/audit-checkpoints/x.json'
           FROM audit.audit_chain_checkpoints`,
      ),
    )
    const sinks = await exportSinks(serve)
    expect(sinks.map((s) => s.kind).sort()).toEqual(['file', 's3'])
    expect(JSON.stringify(sinks)).not.toMatch(/very-secret-bucket|audit-checkpoints|prefix/)
    const file = sinks.find((s) => s.kind === 'file')
    const s3 = sinks.find((s) => s.kind === 's3')
    expect(file).toMatchObject({ pendingCheckpoints: 0 })
    expect(file?.lastExportedAt).toBeInstanceOf(Date)
    // The other exporter has exported one checkpoint and is behind by the rest.
    expect(s3?.pendingCheckpoints).toBeGreaterThan(0)
    // The most recent export first.
    expect(sinks[0]?.kind).toBe('s3')
    // A checkpoint at the same head is no new checkpoint; one after another event is.
    await createCheckpoint(worker, 'scheduled')
    await append(1)
    await createCheckpoint(worker, 'scheduled')
    expect((await exportSinks(serve)).find((s) => s.kind === 'file')?.pendingCheckpoints).toBe(1)
  })

  it('derives the kind from the recorded name', () => {
    expect(exportKind('file')).toBe('file')
    expect(exportKind('s3.bucket')).toBe('s3')
    expect(exportKind('s3')).toBe('s3')
    expect(exportKind('broken')).toBe('other')
    expect(exportKind('s3x.bucket')).toBe('other')
  })
})
