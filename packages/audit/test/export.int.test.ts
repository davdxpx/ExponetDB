import { randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ControlStore } from '@exponetdb/control-store'
import { type MigratedTestDatabase, migratedTestDatabase } from '@exponetdb/control-store/testing'
import { systemClock } from '@exponetdb/kernel'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  appendAuditEvent,
  CheckpointExportError,
  type CheckpointExporter,
  checkpointExportState,
  checkpointKey,
  createCheckpoint,
  exportPendingCheckpoints,
  fileCheckpointExporter,
  s3CheckpointExporter,
  signS3Request,
} from '../src/index.ts'
import { input, sqlstateAs } from './support.ts'

/**
 * Checkpoint export through the integration contract: a file sink and an
 * S3-compatible server (versitygw in CI and locally). This proves the
 * protocol (SigV4, conditional writes, no overwrite, idempotent reruns), not
 * a real off-host store: export to the production bucket is a deployment
 * fact and is recorded separately in the G2 gate record.
 */
const S3_ENV = [
  'EXDB_TEST_S3_ENDPOINT',
  'EXDB_TEST_S3_ACCESS_KEY',
  'EXDB_TEST_S3_SECRET_KEY',
] as const

function s3Env(): { endpoint: string; accessKeyId: string; secretAccessKey: string } {
  const missing = S3_ENV.filter((name) => (process.env[name] ?? '').length === 0)
  if (missing.length > 0) {
    throw new Error(
      `${missing.join(', ')} not set. The export suite needs an S3-compatible test server (see exponetdb-docs/12-operations/local-development.md).`,
    )
  }
  return {
    endpoint: process.env['EXDB_TEST_S3_ENDPOINT'] ?? '',
    accessKeyId: process.env['EXDB_TEST_S3_ACCESS_KEY'] ?? '',
    secretAccessKey: process.env['EXDB_TEST_S3_SECRET_KEY'] ?? '',
  }
}

async function s3Request(
  method: 'PUT' | 'GET',
  path: string,
  body: Uint8Array = new Uint8Array(),
): Promise<Response> {
  const env = s3Env()
  const url = new URL(env.endpoint)
  url.pathname = path
  const signed = signS3Request({
    method,
    url,
    headers: {},
    payload: body,
    region: 'us-east-1',
    accessKeyId: env.accessKeyId,
    secretAccessKey: env.secretAccessKey,
    date: new Date(),
  })
  const { host: _host, ...headers } = signed.headers
  return fetch(signed.url, { method, headers, ...(method === 'PUT' ? { body } : {}) })
}

let db: MigratedTestDatabase
let worker: ControlStore
let dir = ''

beforeAll(async () => {
  db = await migratedTestDatabase('exdb_it_audit_export')
  worker = db.store('exdb_worker')
  dir = await mkdtemp(join(tmpdir(), 'exdb-export-'))
})

afterAll(async () => {
  await db?.drop()
  await rm(dir, { recursive: true, force: true })
})

const appendOne = () =>
  worker.transaction('test.audit.append', (tx) =>
    appendAuditEvent(tx, input(), { clock: systemClock }),
  )

describe('checkpoint export', () => {
  it('exports pending checkpoints oldest first, records them and is idempotent', async () => {
    await appendOne()
    const first = await createCheckpoint(worker, 'scheduled')
    await appendOne()
    const second = await createCheckpoint(worker, 'scheduled')
    const sink = fileCheckpointExporter(dir)
    const run = await exportPendingCheckpoints(worker, db.installationId, sink)
    expect(run).toEqual({ exported: [first?.seq, second?.seq], failed: undefined })
    const text = await readFile(
      join(
        dir,
        checkpointKey({
          format: 'exponetdb.audit-checkpoint/v1',
          installationId: db.installationId,
          seq: second?.seq ?? 0,
          hash: '',
          createdAt: '',
        }),
      ),
      'utf8',
    )
    expect(JSON.parse(text)).toMatchObject({
      format: 'exponetdb.audit-checkpoint/v1',
      installationId: db.installationId,
      seq: second?.seq,
      hash: second?.hash,
    })
    expect(await exportPendingCheckpoints(worker, db.installationId, sink)).toEqual({
      exported: [],
      failed: undefined,
    })
    expect(await checkpointExportState(worker, 'file')).toEqual({
      latestCheckpointSeq: second?.seq,
      latestExportedSeq: second?.seq,
      unexported: 0,
    })
  })

  it('a failing sink is reported, retried later and never blocks audit writes', async () => {
    await appendOne()
    const pending = await createCheckpoint(worker, 'scheduled')
    let attempts = 0
    const broken: CheckpointExporter = {
      sink: 'broken',
      async export() {
        attempts += 1
        throw new CheckpointExportError('http_503')
      },
    }
    const run = await exportPendingCheckpoints(worker, db.installationId, broken)
    expect(run.exported).toEqual([])
    expect(run.failed).toBeGreaterThan(0)
    expect(attempts).toBe(1)
    await expect(appendOne()).resolves.toMatchObject({ seq: (pending?.seq ?? 0) + 1 })
    const state = await checkpointExportState(worker, 'broken')
    expect(state.latestExportedSeq).toBeNull()
    expect(state.unexported).toBeGreaterThan(0)
  })

  it('only the worker records checkpoints and exports; the records are append-only', async () => {
    const serve = db.store('exdb_serve')
    expect(
      await sqlstateAs(
        serve,
        "INSERT INTO audit.checkpoint_exports (checkpoint_seq, sink, location) VALUES (1, 'x', 'y')",
      ),
    ).toBe('42501')
    expect(await sqlstateAs(worker, 'DELETE FROM audit.checkpoint_exports')).toBe('42501')
    expect(
      await sqlstateAs(
        db.store('exdb_migrate'),
        "UPDATE audit.checkpoint_exports SET location = 'z'",
      ),
    ).toBe('EXA01')
  })
})

describe('S3-compatible export (versitygw)', () => {
  const bucket = `exdb-audit-${randomBytes(4).toString('hex')}`

  beforeAll(async () => {
    const created = await s3Request('PUT', `/${bucket}`)
    expect(created.status, await created.text()).toBe(200)
  })

  it('writes each checkpoint once with a SigV4-signed conditional PUT', async () => {
    await appendOne()
    const checkpoint = await createCheckpoint(worker, 'scheduled')
    const sink = s3CheckpointExporter({
      ...s3Env(),
      region: 'us-east-1',
      bucket,
      prefix: 'exponetdb',
    })
    const run = await exportPendingCheckpoints(worker, db.installationId, sink)
    expect(run.failed).toBeUndefined()
    expect(run.exported).toContain(checkpoint?.seq)
    const key = `exponetdb/${db.installationId}/audit-checkpoints/${String(checkpoint?.seq).padStart(20, '0')}.json`
    const stored = await s3Request('GET', `/${bucket}/${key}`)
    expect(stored.status).toBe(200)
    expect(JSON.parse(await stored.text())).toMatchObject({
      seq: checkpoint?.seq,
      hash: checkpoint?.hash,
      installationId: db.installationId,
    })
    const { rows } = await worker.query(
      'test.audit.export_location',
      'SELECT location FROM audit.checkpoint_exports WHERE checkpoint_seq = $1 AND sink = $2',
      [checkpoint?.seq, `s3.${bucket}`],
    )
    expect(rows[0]?.text('location')).toBe(`s3://${bucket}/${key}`)
  })

  it('accepts an identical object again and refuses to overwrite a different one', async () => {
    const sink = s3CheckpointExporter({ ...s3Env(), region: 'us-east-1', bucket })
    const document = {
      format: 'exponetdb.audit-checkpoint/v1',
      installationId: db.installationId,
      seq: 1,
      hash: `sha256:ac1:${'1'.repeat(64)}`,
      createdAt: '2026-10-05T12:00:00.000001Z',
    } as const
    const first = await sink.export(document)
    await expect(sink.export(document)).resolves.toEqual(first)
    await expect(
      sink.export({ ...document, hash: `sha256:ac1:${'2'.repeat(64)}` }),
    ).rejects.toMatchObject({ code: 'audit_export_failed', detailCode: 'conflict' })
  })

  it('reports wrong credentials as an HTTP status, never the secret', async () => {
    const env = s3Env()
    const sink = s3CheckpointExporter({
      ...env,
      secretAccessKey: `${env.secretAccessKey}-wrong`,
      region: 'us-east-1',
      bucket,
    })
    const error = await sink
      .export({
        format: 'exponetdb.audit-checkpoint/v1',
        installationId: db.installationId,
        seq: 99,
        hash: `sha256:ac1:${'3'.repeat(64)}`,
        createdAt: '2026-10-05T12:00:00.000001Z',
      })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(CheckpointExportError)
    expect(error).toMatchObject({ detailCode: 'http_403' })
    expect(JSON.stringify(error)).not.toContain(env.secretAccessKey)
    expect(String(error)).not.toContain(env.secretAccessKey)
  })
})
