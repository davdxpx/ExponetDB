import { type MigratedTestDatabase, migratedTestDatabase } from '@exponetdb/control-store/testing'
import { systemClock } from '@exponetdb/kernel'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { appendAuditEvent, auditPartitionState, ensureAuditPartitions } from '../src/index.ts'
import { input } from './support.ts'

/**
 * VC-042: a missing audit partition stops every audited change, but readiness stayed `ready`
 * because no probe looked at the partitions. The state is read from the partition inventory:
 * the current month and now + 7 days must be covered; less than 30 days of cover is a warning.
 * Its own database: detaching the current partition stops every later append.
 */
let db: MigratedTestDatabase

beforeAll(async () => {
  db = await migratedTestDatabase('exdb_it_audit_partitions')
})

afterAll(async () => {
  await db?.drop()
})

const state = () => auditPartitionState(db.store('exdb_serve'))

const monthName = (offset: number) => {
  const d = new Date()
  const at = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + offset, 1))
  return `audit_events_y${at.getUTCFullYear()}m${String(at.getUTCMonth() + 1).padStart(2, '0')}`
}

describe('the audit partitions a probe can see (VC-042)', () => {
  it('are fine while the worker keeps three months ahead', async () => {
    expect(await state()).toMatchObject({ status: 'ok' })
    expect((await state()).coveredDays).toBeGreaterThan(60)
  })

  it('warn under 30 days of cover and fail when now + 7 days is not covered', async () => {
    // Keep the current month only: 1 to 31 days of cover, depending on the day of the month.
    await db.asSuperuser(async (c) => {
      for (const offset of [3, 2, 1]) {
        await c.query(`ALTER TABLE audit.audit_events DETACH PARTITION audit.${monthName(offset)}`)
      }
    })
    const s = await state()
    expect(s.coveredDays).toBeLessThanOrEqual(31)
    // The status follows the cover: under 7 days is ending, under 30 is a margin warning, else ok.
    expect(s.status).toBe(s.coveredDays < 7 ? 'ending' : s.coveredDays < 30 ? 'margin_low' : 'ok')
  })

  it('fail as missing, and the append is refused with a named error, when the current month is gone', async () => {
    await db.asSuperuser((c) =>
      c.query(`ALTER TABLE audit.audit_events DETACH PARTITION audit.${monthName(0)}`),
    )
    expect(await state()).toMatchObject({ status: 'missing' })
    await expect(
      db
        .store('exdb_serve')
        .transaction('test.audit.append', (tx) =>
          appendAuditEvent(tx, input(), { clock: systemClock }),
        ),
    ).rejects.toMatchObject({ code: 'audit_append_failed' })
  })

  it('are fine again once the worker ensures the partitions', async () => {
    await db.asSuperuser(async (c) => {
      for (const offset of [0, 1, 2, 3]) {
        await c.query(`DROP TABLE IF EXISTS audit.${monthName(offset)}`)
      }
    })
    expect(await ensureAuditPartitions(db.store('exdb_worker'), 3)).toBeGreaterThan(0)
    expect(await state()).toMatchObject({ status: 'ok' })
  })
})
