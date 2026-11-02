import { type MigratedTestDatabase, migratedTestDatabase } from '@exponetdb/control-store/testing'
import { systemClock } from '@exponetdb/kernel'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { appendAuditEvent, auditClockSkew, verifyAuditChain } from '../src/index.ts'
import { INSERT_RAW, input, rawParams, rawRow, storedEvent } from './support.ts'

/**
 * VC-003: a clock step forward and back leaves the chain head ahead of the
 * database clock. The chain guard then refuses every event (time may not
 * run backwards along the chain, nor more than a minute ahead of the
 * clock), so every audited mutation fails until the clock passes the head.
 * The refusal must name that cause, and a probe must be able to see it.
 * Its own database: a head in the future stops every later append.
 */
let db: MigratedTestDatabase

beforeAll(async () => {
  db = await migratedTestDatabase('exdb_it_audit_skew')
})

afterAll(async () => {
  await db?.drop()
})

const append = () =>
  db
    .store('exdb_serve')
    .transaction('test.audit.append', (tx) => appendAuditEvent(tx, input(), { clock: systemClock }))

describe('an audit chain whose head is ahead of the database clock (VC-003)', () => {
  it('reports no skew while the head is in the past', async () => {
    await append()
    expect(await auditClockSkew(db.store('exdb_serve'))).toBeUndefined()
  })

  it('names the skew on append and to a probe, and the chain itself stays valid', async () => {
    // What the events of a clock step +3 h look like once the clock is back: written while the
    // database clock was ahead, so the guard accepted them then. The test writes one directly.
    const { rows } = await db
      .store('exdb_serve')
      .query(
        'test.audit.head',
        `SELECT seq, hash FROM audit.audit_events ORDER BY seq DESC LIMIT 1`,
      )
    const head = rows[0]
    if (head === undefined) throw new Error('empty chain')
    const ahead = new Date(Date.now() + 3 * 3600_000).toISOString().replace(/Z$/, '000Z')
    const row = rawRow(head.text('hash'), storedEvent(head.int('seq') + 1, ahead))
    await db.asSuperuser(async (c) => {
      await c.query('BEGIN')
      await c.query('SET LOCAL session_replication_role = replica')
      await c.query(INSERT_RAW, rawParams(row))
      await c.query('COMMIT')
    })

    const error = await append().catch((e: unknown) => e)
    expect(error).toMatchObject({
      code: 'AUDIT_CLOCK_SKEW',
      details: { headAt: expect.any(String), databaseNow: expect.any(String) },
    })
    const details = (error as { details: { headAt: string; databaseNow: string } }).details
    expect(Date.parse(details.headAt)).toBe(Date.parse(ahead))
    expect(Date.parse(details.headAt) - Date.parse(details.databaseNow)).toBeGreaterThan(
      2.9 * 3600_000,
    )

    const skew = await auditClockSkew(db.store('exdb_serve'))
    expect(skew?.headAt).toBe(details.headAt)
    // Nothing is broken in the chain: the cause is the clock, not tampering.
    expect(await verifyAuditChain(db.store('exdb_serve'))).toMatchObject({ ok: true })
  })
})
