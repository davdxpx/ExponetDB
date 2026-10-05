import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StoredAuditEventSchema } from '@exponetdb/contracts'
import type { ControlStore, ControlStoreRole } from '@exponetdb/control-store'
import { type MigratedTestDatabase, migratedTestDatabase } from '@exponetdb/control-store/testing'
import { parseJson, systemClock } from '@exponetdb/kernel'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  AUDIT_RETENTION_SETTING,
  appendAuditEvent,
  createCheckpoint,
  ensureAuditPartitions,
  expiredAuditPartitions,
  exportPendingCheckpoints,
  fileCheckpointExporter,
  genesisPrevHash,
  pruneAuditPartitions,
  readAuditRetention,
  verifyAuditChain,
} from '../src/index.ts'
import { INSERT_RAW, input, rawParams, rawRow, sqlstateAs, storedEvent } from './support.ts'

/**
 * Retention against real PostgreSQL 17. Old months are simulated the only
 * way possible: the bootstrap superuser creates partitions for 2024 (as the
 * owner role would) and the chain starts with events dated then; the
 * database chain guard accepts them because they form a valid chain. The
 * short retention of 400 days is set only here; the default stays
 * `permanent`.
 */
let db: MigratedTestDatabase
let maint: ControlStore
let worker: ControlStore
let dir = ''
const OLD = ['audit_events_y2024m01', 'audit_events_y2024m02', 'audit_events_y2024m03'] as const

async function setRetention(value: string): Promise<void> {
  await db.asSuperuser((c) =>
    c.query(
      `INSERT INTO control.settings (key, value) VALUES ($1, $2::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = clock_timestamp()`,
      [AUDIT_RETENTION_SETTING, value],
    ),
  )
}

/** `SQLSTATE: message` of a refused drop, or `ok`. */
const dropAs = (role: ControlStoreRole, partition: string, days = 400): Promise<string> =>
  db.asRole(role, async (client) => {
    try {
      await client.query('SELECT * FROM audit.drop_expired_partition($1, $2)', [partition, days])
      return 'ok'
    } catch (error) {
      const code: unknown =
        typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : ''
      return `${String(code)}: ${error instanceof Error ? error.message : ''}`
    }
  })

beforeAll(async () => {
  db = await migratedTestDatabase('exdb_it_audit_retention')
  maint = db.store('exdb_audit_maint')
  worker = db.store('exdb_worker')
  dir = await mkdtemp(join(tmpdir(), 'exdb-retention-'))
  await db.asSuperuser(async (c) => {
    for (const [i, name] of OLD.entries()) {
      const from = `2024-0${i + 1}-01 00:00:00+00`
      const to = `2024-0${i + 2}-01 00:00:00+00`
      await c.query(
        `CREATE TABLE audit.${name} PARTITION OF audit.audit_events FOR VALUES FROM ('${from}') TO ('${to}')`,
      )
      await c.query(`ALTER TABLE audit.${name} OWNER TO exdb_migrate`)
      await c.query(`REVOKE ALL ON audit.${name} FROM PUBLIC`)
      await c.query(
        `CREATE TRIGGER no_truncate BEFORE TRUNCATE ON audit.${name} FOR EACH STATEMENT EXECUTE FUNCTION control.reject_change()`,
      )
    }
  })
  let prev = genesisPrevHash(db.installationId)
  for (const [seq, at] of [
    [1, '2024-01-10T08:00:00.000001Z'],
    [2, '2024-01-20T08:00:00.000002Z'],
    [3, '2024-02-05T08:00:00.000003Z'],
    [4, '2024-02-25T08:00:00.000004Z'],
  ] as const) {
    const row = rawRow(prev, storedEvent(seq, at))
    expect(await sqlstateAs(worker, INSERT_RAW, rawParams(row))).toBeUndefined()
    prev = row.hash
  }
})

afterAll(async () => {
  await db?.drop()
  await rm(dir, { recursive: true, force: true })
})

describe('audit retention', () => {
  it('defaults to permanent: nothing is expired, nothing is pruned', async () => {
    expect(await readAuditRetention(maint)).toEqual({ kind: 'permanent' })
    expect(await expiredAuditPartitions(maint, { kind: 'permanent' })).toEqual([])
    expect(await pruneAuditPartitions(maint, { clock: systemClock, maxPartitions: 10 })).toEqual({
      retention: { kind: 'permanent' },
      pruned: [],
      remaining: 0,
    })
  })

  it('refuses an invalid or too short setting (fails closed: nothing is pruned)', async () => {
    for (const value of ['"forever"', '399', '400.5', '{"days":400}']) {
      await setRetention(value)
      await expect(readAuditRetention(maint)).rejects.toMatchObject({
        code: 'audit_retention_invalid',
      })
      await expect(pruneAuditPartitions(maint, { clock: systemClock })).rejects.toMatchObject({
        code: 'audit_retention_invalid',
      })
    }
    await setRetention('400')
    expect(await readAuditRetention(maint)).toEqual({ kind: 'days', days: 400 })
  })

  it('lists whole months outside the period, oldest first', async () => {
    const expired = await expiredAuditPartitions(maint, { kind: 'days', days: 400 })
    expect(expired.map((p) => p.partition)).toEqual([...OLD])
    expect(expired[0]?.lowerBound.toISOString()).toBe('2024-01-01T00:00:00.000Z')
  })

  it('never drops the partition that holds the chain head', async () => {
    expect(await dropAs('exdb_audit_maint', 'audit_events_y2024m02')).toBe(
      'EXA05: the partition holds the chain head',
    )
  })

  it('refuses everything else that is not a safe drop', async () => {
    await worker.transaction('test.audit.append', (tx) =>
      appendAuditEvent(tx, input(), { clock: systemClock }),
    )
    const current = await maint.query(
      'test.audit.current_partition',
      `SELECT partition FROM audit.partition_inventory
        WHERE lower_bound <= clock_timestamp() AND clock_timestamp() < upper_bound`,
    )
    const cases: [string, number, string][] = [
      ['audit_events_y2024m02', 400, 'older audit events must be pruned first'],
      [
        current.rows[0]?.text('partition') ?? 'missing',
        400,
        'the partition is inside the retention period',
      ],
      ['audit_events_y2024m01', 399, 'audit retention is never shorter than 400 days'],
      ['audit_events', 400, 'not an audit partition name'],
      ['audit_events_y2024m01; DROP TABLE audit.audit_events', 400, 'not an audit partition name'],
      ['audit_chain_checkpoints', 400, 'not an audit partition name'],
      ['audit_events_y2024m04', 400, 'not a partition of audit.audit_events'],
      ['audit_events_y2024m01', 400, 'no exported checkpoint covers the partition'],
    ]
    for (const [partition, days, reason] of cases) {
      expect(await dropAs('exdb_audit_maint', partition, days), partition).toBe(`EXA05: ${reason}`)
    }
    // A checkpoint that is recorded but not exported does not count.
    await createCheckpoint(worker, 'scheduled')
    expect(await dropAs('exdb_audit_maint', 'audit_events_y2024m01')).toBe(
      'EXA05: no exported checkpoint covers the partition',
    )
  })

  it('only exdb_audit_maint may drop partitions', async () => {
    for (const role of ['exdb_serve', 'exdb_worker', 'exdb_gateway'] as const) {
      expect(await dropAs(role, 'audit_events_y2024m01'), role).toMatch(/^42501: permission denied/)
    }
  })

  it('drops a covered month and records the boundary in a retention.pruned event', async () => {
    await exportPendingCheckpoints(worker, db.installationId, fileCheckpointExporter(dir))
    const second = await maint.query(
      'test.audit.seq2',
      'SELECT hash FROM audit.audit_events WHERE seq = 2',
    )
    const report = await pruneAuditPartitions(maint, { clock: systemClock, maxPartitions: 1 })
    expect(report.pruned).toHaveLength(1)
    expect(report.pruned[0]).toMatchObject({
      partition: 'audit_events_y2024m01',
      rows: 2,
      droppedThroughSeq: 2,
      boundaryHash: second.rows[0]?.text('hash'),
    })
    expect(report.remaining).toBe(2)
    const event = await maint.query(
      'test.audit.pruned_event',
      'SELECT event FROM audit.audit_events WHERE seq = $1',
      [report.pruned[0]?.eventSeq],
    )
    const parsed = parseJson(event.rows[0]?.text('event') ?? '')
    const stored = parsed.ok ? StoredAuditEventSchema.parse(parsed.value) : undefined
    expect(stored).toMatchObject({
      action: 'retention.pruned',
      phase: 'completed',
      actor: { kind: 'system', label: 'system:maintenance' },
      refs: { droppedThroughSeq: 2, boundaryHash: second.rows[0]?.text('hash') },
      changes: { class: 'audit', partition: 'audit_events_y2024m01', rows: 2, retentionDays: 400 },
    })
    expect(await verifyAuditChain(maint)).toMatchObject({ ok: true, fromSeq: 3 })
  })

  it('drops the rest, empty months included, ends with a retention checkpoint, and reruns as a no-op', async () => {
    await createCheckpoint(worker, 'scheduled')
    await exportPendingCheckpoints(worker, db.installationId, fileCheckpointExporter(dir))
    const report = await pruneAuditPartitions(maint, { clock: systemClock, maxPartitions: 10 })
    expect(report.pruned.map((p) => [p.partition, p.rows, p.droppedThroughSeq])).toEqual([
      ['audit_events_y2024m02', 2, 4],
      ['audit_events_y2024m03', 0, null],
    ])
    expect(report.remaining).toBe(0)
    const verified = await verifyAuditChain(maint)
    expect(verified).toMatchObject({ ok: true, fromSeq: 5 })
    const checkpoint = await maint.query(
      'test.audit.retention_checkpoint',
      'SELECT seq, reason FROM audit.audit_chain_checkpoints ORDER BY seq DESC LIMIT 1',
    )
    expect(checkpoint.rows[0]?.text('reason')).toBe('retention')
    expect(verified.ok && checkpoint.rows[0]?.int('seq')).toBe(verified.ok && verified.lastSeq)
    expect(await pruneAuditPartitions(maint, { clock: systemClock, maxPartitions: 10 })).toEqual({
      retention: { kind: 'days', days: 400 },
      pruned: [],
      remaining: 0,
    })
  })

  it('partition upkeep is idempotent and bounded', async () => {
    expect(await ensureAuditPartitions(worker, 3)).toBe(0)
    expect(await ensureAuditPartitions(worker, 6)).toBe(3)
    expect(await sqlstateAs(worker, 'SELECT audit.ensure_partitions(0)')).toBe('22023')
    expect(await sqlstateAs(worker, 'SELECT audit.ensure_partitions(25)')).toBe('22023')
    expect(await sqlstateAs(db.store('exdb_serve'), 'SELECT audit.ensure_partitions(3)')).toBe(
      '42501',
    )
  })
})
