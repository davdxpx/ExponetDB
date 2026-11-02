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

/** Writes the next event `ms` ahead of now directly (as a clock step did), returns its time. */
async function headAhead(ms: number): Promise<string> {
  const { rows } = await db
    .store('exdb_serve')
    .query('test.audit.head', 'SELECT seq, hash FROM audit.audit_events ORDER BY seq DESC LIMIT 1')
  const head = rows[0]
  if (head === undefined) throw new Error('empty chain')
  const ahead = new Date(Date.now() + ms).toISOString().replace(/Z$/, '000Z')
  const row = rawRow(head.text('hash'), storedEvent(head.int('seq') + 1, ahead))
  await db.asSuperuser(async (c) => {
    await c.query('BEGIN')
    await c.query('SET LOCAL session_replication_role = replica')
    await c.query(INSERT_RAW, rawParams(row))
    await c.query('COMMIT')
  })
  return ahead
}

describe('an audit chain whose head is ahead of the database clock (VC-003)', () => {
  it('reports no skew while the head is in the past', async () => {
    await append()
    expect(await auditClockSkew(db.store('exdb_serve'))).toBeUndefined()
  })

  // OD-69 (b), bounded to 24 h: while the head is at most a day ahead, an event is written at the
  // head's time with a clockSkew marker, so audited changes go on through a short clock step.
  it('writes a marked event at the head time while the head is at most 24 h ahead', async () => {
    const ahead = await headAhead(3 * 3600_000)
    const written = await append()
    expect(Date.parse(written.occurredAt)).toBe(Date.parse(ahead))
    const { rows } = await db.store('exdb_serve').query(
      'test.audit.marked',
      `SELECT to_char(database_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS database_at,
                chain_head_at = $2::timestamptz AS at_head
           FROM audit.clock_skew_marks WHERE seq = $1`,
      [written.seq, ahead],
    )
    expect(rows[0]?.bool('at_head')).toBe(true)
    expect(Math.abs(Date.parse(rows[0]?.text('database_at') ?? '') - Date.now())).toBeLessThan(
      60_000,
    )
    expect(await verifyAuditChain(db.store('exdb_serve'))).toMatchObject({ ok: true })
    // The guard accepts the head's time only with the marker: an unmarked event is refused.
    const { rows: head } = await db
      .store('exdb_serve')
      .query(
        'test.audit.head',
        'SELECT seq, hash FROM audit.audit_events ORDER BY seq DESC LIMIT 1',
      )
    const unmarked = rawRow(
      head[0]?.text('hash') ?? '',
      storedEvent((head[0]?.int('seq') ?? 0) + 1, written.occurredAt),
    )
    const refused = await db
      .asSuperuser((c) => c.query(INSERT_RAW, rawParams(unmarked)))
      .catch((e: unknown) => e)
    expect(refused).toMatchObject({ code: 'EXA02' })
    // A mark written earlier (more than a minute before the event) is no mark for it.
    const stale = await db
      .asSuperuser(async (c) => {
        await c.query('BEGIN')
        try {
          await c.query(
            `INSERT INTO audit.clock_skew_marks (seq, database_at, chain_head_at)
             VALUES ($1, clock_timestamp() - interval '2 minutes', $2::timestamptz)`,
            [unmarked.seq, written.occurredAt],
          )
          await c.query(INSERT_RAW, rawParams(unmarked))
        } finally {
          await c.query('ROLLBACK')
        }
      })
      .catch((e: unknown) => e)
    expect(stale).toMatchObject({ code: 'EXA02' })
  })

  it('names the skew on append and to a probe beyond 24 h, and the chain itself stays valid', async () => {
    // What the events of a clock step +30 h look like once the clock is back: written while the
    // database clock was ahead, so the guard accepted them then. The test writes one directly.
    const ahead = await headAhead(30 * 3600_000)

    const error = await append().catch((e: unknown) => e)
    expect(error).toMatchObject({
      code: 'AUDIT_CLOCK_SKEW',
      details: { headAt: expect.any(String), databaseNow: expect.any(String) },
    })
    const details = (error as { details: { headAt: string; databaseNow: string } }).details
    expect(Date.parse(details.headAt)).toBe(Date.parse(ahead))
    expect(Date.parse(details.headAt) - Date.parse(details.databaseNow)).toBeGreaterThan(
      29.9 * 3600_000,
    )

    const skew = await auditClockSkew(db.store('exdb_serve'))
    expect(skew?.headAt).toBe(details.headAt)
    // Nothing is broken in the chain: the cause is the clock, not tampering.
    expect(await verifyAuditChain(db.store('exdb_serve'))).toMatchObject({ ok: true })
  })
})
