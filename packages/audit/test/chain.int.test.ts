import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { ControlStore, ControlStoreRole } from '@exponetdb/control-store'
import { type MigratedTestDatabase, migratedTestDatabase } from '@exponetdb/control-store/testing'
import { isJsonArray, isJsonObject, newId, parseJson, systemClock } from '@exponetdb/kernel'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  AuditWriteError,
  appendAuditEvent,
  createCheckpoint,
  genesisPrevHash,
  verifyAuditChain,
} from '../src/index.ts'
import { INSERT_RAW, input, rawParams, rawRow, sqlstateAs, storedEvent } from './support.ts'

/**
 * The audit chain against real PostgreSQL 17 (G2 security items): the
 * writer, the database chain guard as a second ac1 implementation,
 * immutability for every role including the owner, concurrency, tamper
 * detection and atomicity with the audited change.
 */
let db: MigratedTestDatabase
const stores = new Map<ControlStoreRole, ControlStore>()
const as = (role: ControlStoreRole): ControlStore => {
  let store = stores.get(role)
  if (store === undefined) {
    store = db.store(role)
    stores.set(role, store)
  }
  return store
}

const RUNTIME: readonly ControlStoreRole[] = [
  'exdb_serve',
  'exdb_worker',
  'exdb_gateway',
  'exdb_audit_maint',
]

async function append(role: ControlStoreRole, overrides = {}) {
  return as(role).transaction('test.audit.append', (tx) =>
    appendAuditEvent(tx, input(overrides), { clock: systemClock }),
  )
}

async function head(): Promise<{ seq: number; hash: string; occurredAt: string }> {
  const { rows } = await as('exdb_serve').query(
    'test.audit.head',
    `SELECT seq, hash, to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at
       FROM audit.audit_events ORDER BY seq DESC LIMIT 1`,
  )
  const row = rows[0]
  if (row === undefined) {
    throw new Error('empty chain')
  }
  return { seq: row.int('seq'), hash: row.text('hash'), occurredAt: row.text('at') }
}

/** `iso` moved by `ms` milliseconds, at microsecond precision. */
const shifted = (iso: string, ms: number): string =>
  new Date(Date.parse(iso) + ms).toISOString().replace(/Z$/, '000Z')
const later = (iso: string): string => shifted(iso, 1)

beforeAll(async () => {
  db = await migratedTestDatabase('exdb_it_audit')
})

afterAll(async () => {
  await db?.drop()
})

describe('ac1 in SQL', () => {
  it('reproduces every hashing golden vector (two independent implementations agree)', async () => {
    const file = fileURLToPath(new URL('../../../tooling/golden/audit-chain.json', import.meta.url))
    const parsed = parseJson(readFileSync(file, 'utf8'))
    if (!parsed.ok || !isJsonObject(parsed.value) || !isJsonArray(parsed.value['vectors'])) {
      throw new Error('audit-chain.json is not a vector file')
    }
    let checked = 0
    for (const v of parsed.value['vectors'].filter(isJsonObject)) {
      const expected = v['expected']
      if (!isJsonObject(expected)) {
        continue
      }
      const { rows } = await as('exdb_serve').query(
        'test.audit.ac1',
        'SELECT audit.ac1($1, $2) AS hash',
        [v['prevHash'], expected['canonical']],
      )
      expect(rows[0]?.text('hash'), String(v['id'])).toBe(expected['hash'])
      checked += 1
    }
    expect(checked).toBeGreaterThanOrEqual(9)
  })
})

describe('the writer', () => {
  it('starts the chain at the genesis value of the installation and verifies', async () => {
    const first = await append('exdb_worker', {
      reason: 'Grüße, 日本語, emoji 🎉 and "quotes"',
      changes: { note: 'non-ASCII ✓', nested: { count: 3, flags: [true, false, null] } },
    })
    expect(first.seq).toBe(1)
    const { rows } = await as('exdb_serve').query(
      'test.audit.first',
      'SELECT prev_hash FROM audit.audit_events WHERE seq = 1',
    )
    expect(rows[0]?.text('prev_hash')).toBe(genesisPrevHash(db.installationId))
    const second = await append('exdb_serve')
    expect(second.seq).toBe(2)
    expect(await verifyAuditChain(as('exdb_serve'))).toMatchObject({
      ok: true,
      fromSeq: 1,
      lastSeq: 2,
      lastHash: second.hash,
    })
  })

  it('every runtime login can append', async () => {
    for (const role of RUNTIME) {
      await expect(append(role)).resolves.toMatchObject({
        hash: expect.stringMatching(/^sha256:ac1:/),
      })
    }
  })

  it('refuses an event that does not match exponetdb.audit/v1 before touching the database', async () => {
    await expect(
      as('exdb_worker').transaction('test.audit.invalid', (tx) =>
        appendAuditEvent(
          tx,
          input({ actor: { kind: 'human', identityId: null, label: 'Jane Doe' } }),
          { clock: systemClock },
        ),
      ),
    ).rejects.toMatchObject({ code: 'audit_event_invalid' })
  })

  it('serializes concurrent writers into one gap-free chain', async () => {
    const before = (await head()).seq
    const roles: ControlStoreRole[] = ['exdb_serve', 'exdb_worker', 'exdb_gateway']
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        append(roles[i % roles.length] ?? 'exdb_serve', { reason: `writer ${i}` }),
      ),
    )
    const seqs = results.map((r) => r.seq).sort((a, b) => a - b)
    expect(seqs).toEqual(Array.from({ length: 30 }, (_, i) => before + 1 + i))
    expect(await verifyAuditChain(as('exdb_serve'))).toMatchObject({
      ok: true,
      lastSeq: before + 30,
    })
  })

  it('fails the audited change when the audit append fails (same transaction)', async () => {
    const processId = newId('prc', Date.now())
    await db.asSuperuser((c) => c.query('REVOKE INSERT ON audit.audit_events FROM exdb_worker'))
    try {
      const error = await as('exdb_worker')
        .transaction('test.audit.atomic', async (tx) => {
          await tx.query(
            'test.audit.atomic.change',
            `INSERT INTO control.process_heartbeats (process_id, role, build_version, build_commit)
             VALUES ($1, 'worker', 'test', 'abcdef1')`,
            [processId],
          )
          await appendAuditEvent(tx, input(), { clock: systemClock })
        })
        .catch((e: unknown) => e)
      expect(error).toBeInstanceOf(AuditWriteError)
      expect(error).toMatchObject({ code: 'audit_append_failed' })
    } finally {
      await db.asSuperuser((c) => c.query('GRANT INSERT ON audit.audit_events TO exdb_worker'))
    }
    const { rows } = await as('exdb_serve').query(
      'test.audit.atomic.check',
      'SELECT count(*)::int AS n FROM control.process_heartbeats WHERE process_id = $1',
      [processId],
    )
    expect(rows[0]?.int('n')).toBe(0)
  })

  it('rolls the event back with the change when the caller fails after appending', async () => {
    const before = await head()
    await expect(
      as('exdb_worker').transaction('test.audit.rollback', async (tx) => {
        await appendAuditEvent(tx, input(), { clock: systemClock })
        throw new Error('the change failed after the append')
      }),
    ).rejects.toThrow('the change failed')
    expect(await head()).toEqual(before)
  })
})

describe('the database chain guard', () => {
  it('accepts an independently built event that continues the chain', async () => {
    const h = await head()
    const row = rawRow(h.hash, storedEvent(h.seq + 1, later(h.occurredAt)))
    expect(await sqlstateAs(as('exdb_gateway'), INSERT_RAW, rawParams(row))).toBeUndefined()
  })

  it('refuses a gap, a fork, a forged hash, mismatching columns and time going backwards', async () => {
    const h = await head()
    const at = later(h.occurredAt)
    const ok = rawRow(h.hash, storedEvent(h.seq + 1, at))
    const cases: [string, unknown[], string][] = [
      ['gap', rawParams(rawRow(h.hash, storedEvent(h.seq + 2, at))), 'EXA02'],
      ['fork (old seq)', rawParams(rawRow(h.hash, storedEvent(h.seq, at))), 'EXA02'],
      [
        'wrong previous hash',
        rawParams(rawRow(`sha256:ac1:${'0'.repeat(64)}`, storedEvent(h.seq + 1, at))),
        'EXA02',
      ],
      [
        'genesis value again',
        rawParams({ ...ok, prevHash: genesisPrevHash(db.installationId) }),
        'EXA02',
      ],
      ['forged hash', rawParams({ ...ok, hash: `sha256:ac1:${'f'.repeat(64)}` }), 'EXA03'],
      [
        'event text changed after hashing',
        rawParams({ ...ok, event: ok.event.replace('test.recorded', 'test.recordex') }),
        'EXA03',
      ],
      ['action column differs', rawParams({ ...ok, action: 'test.other' }), 'EXA04'],
      ['actor column differs', rawParams({ ...ok, actorKind: 'human' }), 'EXA04'],
      [
        'time before the head',
        rawParams(rawRow(h.hash, storedEvent(h.seq + 1, shifted(h.occurredAt, -1)))),
        'EXA02',
      ],
      [
        'time in the future',
        rawParams(
          rawRow(h.hash, storedEvent(h.seq + 1, shifted(new Date().toISOString(), 600_000))),
        ),
        'EXA02',
      ],
    ]
    for (const [what, params, code] of cases) {
      for (const role of RUNTIME) {
        expect(await sqlstateAs(as(role), INSERT_RAW, params), `${role}: ${what}`).toBe(code)
      }
    }
    expect(await head()).toEqual(h)
  })
})

describe('immutability', () => {
  const partition = async (): Promise<string> => {
    const { rows } = await as('exdb_serve').query(
      'test.audit.partition',
      `SELECT partition FROM audit.partition_inventory
        WHERE lower_bound <= clock_timestamp() AND clock_timestamp() < upper_bound`,
    )
    return rows[0]?.text('partition') ?? 'missing'
  }

  it('no runtime login can update, delete, truncate or switch off the triggers', async () => {
    const p = await partition()
    const statements = [
      "UPDATE audit.audit_events SET action = 'x.y' WHERE seq = 1",
      'DELETE FROM audit.audit_events WHERE seq = 1',
      'TRUNCATE audit.audit_events',
      `UPDATE audit.${p} SET action = 'x.y' WHERE seq = 1`,
      `DELETE FROM audit.${p}`,
      `TRUNCATE audit.${p}`,
      'ALTER TABLE audit.audit_events DISABLE TRIGGER audit_events_append_only',
      'ALTER TABLE audit.audit_events DISABLE TRIGGER USER',
      `ALTER TABLE audit.${p} DISABLE TRIGGER ALL`,
      'DROP TABLE audit.audit_events',
      `DROP TABLE audit.${p}`,
      `ALTER TABLE audit.audit_events DETACH PARTITION audit.${p}`,
      'DROP TRIGGER audit_events_chain_guard ON audit.audit_events',
      'CREATE OR REPLACE FUNCTION audit.chain_guard() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW; END$$',
      "UPDATE audit.audit_chain_checkpoints SET hash = 'x'",
      'DELETE FROM audit.audit_chain_checkpoints',
      'TRUNCATE audit.checkpoint_exports',
      "SET session_replication_role = 'replica'",
    ]
    for (const role of RUNTIME) {
      for (const sql of statements) {
        expect(await sqlstateAs(as(role), sql), `${role}: ${sql}`).toBe('42501')
      }
    }
  })

  it('the owner (exdb_migrate) cannot change rows either: the triggers fire for it', async () => {
    const p = await partition()
    await createCheckpoint(as('exdb_worker'), 'manual')
    const owner = as('exdb_migrate')
    for (const sql of [
      "UPDATE audit.audit_events SET action = 'x.y' WHERE seq = 1",
      'DELETE FROM audit.audit_events WHERE seq = 1',
      'TRUNCATE audit.audit_events',
      `UPDATE audit.${p} SET action = 'x.y' WHERE seq = 1`,
      `DELETE FROM audit.${p} WHERE seq = 1`,
      `TRUNCATE audit.${p}`,
      'DELETE FROM audit.audit_chain_checkpoints',
      'TRUNCATE audit.audit_chain_checkpoints CASCADE',
      'TRUNCATE audit.checkpoint_exports',
    ]) {
      expect(await sqlstateAs(owner, sql), sql).toBe('EXA01')
    }
    expect(await sqlstateAs(owner, "SET session_replication_role = 'replica'")).toBe('42501')
  })

  it('the chain still verifies after every refused attempt', async () => {
    expect(await verifyAuditChain(as('exdb_serve'))).toMatchObject({ ok: true })
  })
})

describe('checkpoints', () => {
  it('records the head; the database refuses a checkpoint that is not on the chain', async () => {
    const h = await head()
    const checkpoint = await createCheckpoint(as('exdb_worker'), 'manual')
    expect(checkpoint).toMatchObject({ seq: h.seq, hash: h.hash })
    expect(
      await sqlstateAs(
        as('exdb_worker'),
        "INSERT INTO audit.audit_chain_checkpoints (seq, hash, reason) VALUES (1, $1, 'manual')",
        [`sha256:ac1:${'0'.repeat(64)}`],
      ),
    ).toBe('EXA06')
    expect(
      await sqlstateAs(
        as('exdb_serve'),
        "INSERT INTO audit.audit_chain_checkpoints (seq, hash, reason) VALUES ($1, $2, 'manual')",
        [h.seq, h.hash],
      ),
    ).toBe('42501')
  })

  it('verification can start from a checkpoint and refuses an unknown one', async () => {
    const h = await head()
    await append('exdb_worker')
    expect(await verifyAuditChain(as('exdb_serve'), { fromCheckpointSeq: h.seq })).toMatchObject({
      ok: true,
      fromSeq: h.seq + 1,
      verifiedEvents: 1,
    })
    expect(await verifyAuditChain(as('exdb_serve'), { fromCheckpointSeq: 1 })).toMatchObject({
      ok: false,
      reason: 'anchor_missing',
    })
  })
})

describe('tamper detection (a superuser bypassing every database control)', () => {
  it('finds an edited event, a re-hashed edit and a deleted event', async () => {
    await db.asSuperuser(async (c) => {
      // Keep the original rows in a scratch table for restoring.
      await c.query('CREATE SCHEMA scratch')
      await c.query('CREATE TABLE scratch.audit_original AS SELECT * FROM audit.audit_events')
    })
    const restore = async () =>
      db.asSuperuser(async (c) => {
        await c.query('BEGIN')
        await c.query("SET LOCAL session_replication_role = 'replica'")
        await c.query('DELETE FROM audit.audit_events')
        await c.query('INSERT INTO audit.audit_events SELECT * FROM scratch.audit_original')
        await c.query('COMMIT')
      })
    const edit = async (sql: string) =>
      db.asSuperuser(async (c) => {
        await c.query('BEGIN')
        await c.query("SET LOCAL session_replication_role = 'replica'")
        await c.query(sql)
        await c.query('COMMIT')
      })
    try {
      await edit(
        `UPDATE audit.audit_events SET event = replace(event, 'writer 3"', 'writer 4"') WHERE event LIKE '%writer 3"%'`,
      )
      const edited = await verifyAuditChain(as('exdb_serve'))
      expect(edited).toMatchObject({ ok: false, reason: 'hash_mismatch' })
      await restore()

      // Edit and recompute this event's hash: the next event's link breaks.
      await edit(
        `UPDATE audit.audit_events SET event = replace(event, 'writer 3"', 'writer 4"') WHERE event LIKE '%writer 3"%';
         UPDATE audit.audit_events SET hash = audit.ac1(prev_hash, event) WHERE event LIKE '%writer 4"%'`,
      )
      const rehashed = await verifyAuditChain(as('exdb_serve'))
      expect(rehashed).toMatchObject({ ok: false, reason: 'prev_hash_mismatch' })
      await restore()

      await edit('DELETE FROM audit.audit_events WHERE seq = 5')
      expect(await verifyAuditChain(as('exdb_serve'))).toMatchObject({
        ok: false,
        firstFailingSeq: 5,
        reason: 'sequence_gap',
      })
      await restore()

      await edit(`UPDATE audit.audit_events SET action = 'test.other' WHERE seq = 4`)
      expect(await verifyAuditChain(as('exdb_serve'))).toMatchObject({
        ok: false,
        firstFailingSeq: 4,
        reason: 'columns_mismatch',
      })
      await restore()

      expect(await verifyAuditChain(as('exdb_serve'))).toMatchObject({ ok: true })
    } finally {
      await db.asSuperuser((c) => c.query('DROP SCHEMA scratch CASCADE'))
    }
  })

  it('the exported checkpoint exposes a fully rewritten chain', async () => {
    // A superuser can rewrite the whole chain consistently; verification of
    // the database alone then passes, but the checkpoint taken before (and
    // exported off-host) no longer matches.
    const checkpoint = await createCheckpoint(as('exdb_worker'), 'manual')
    expect(checkpoint).toBeDefined()
    await db.asSuperuser(async (c) => {
      await c.query('BEGIN')
      await c.query("SET LOCAL session_replication_role = 'replica'")
      await c.query('CREATE TEMP TABLE chain AS SELECT * FROM audit.audit_events ORDER BY seq')
      await c.query(`UPDATE pg_temp.chain SET event = replace(event, '"writer 1"', '"writer X"')`)
      const { rows } = await c.query('SELECT seq, event, prev_hash FROM pg_temp.chain ORDER BY seq')
      let prev: string | undefined
      for (const r of rows) {
        const p = prev ?? String(r.prev_hash)
        const h = await c.query('SELECT audit.ac1($1, $2) AS h', [p, r.event])
        prev = String(h.rows[0].h)
        await c.query(
          'UPDATE audit.audit_events SET event = $2, prev_hash = $3, hash = $4 WHERE seq = $1',
          [r.seq, r.event, p, prev],
        )
      }
      await c.query('COMMIT')
    })
    expect(await verifyAuditChain(as('exdb_serve'))).toMatchObject({ ok: true })
    const { rows } = await as('exdb_serve').query(
      'test.audit.rewritten',
      'SELECT hash FROM audit.audit_events WHERE seq = $1',
      [checkpoint?.seq],
    )
    expect(rows[0]?.text('hash')).not.toBe(checkpoint?.hash)
    expect(
      await verifyAuditChain(as('exdb_serve'), { fromCheckpointSeq: checkpoint?.seq ?? 0 }),
    ).toMatchObject({ ok: false, reason: 'checkpoint_mismatch' })
  })
})
