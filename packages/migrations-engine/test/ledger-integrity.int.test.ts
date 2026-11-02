import { readLedgerRows } from '@exponetdb/postgres'
import { serverFor, superuserClient } from '@exponetdb/testkit'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ledgerDivergence } from '../src/divergence.ts'
import { ledgerDivergenceOf, planLedgerReconcile, planMigrationVerify } from '../src/index.ts'
import { writeMirror } from '../src/records.ts'
import { migrationWorld, type Target, type World } from './world.ts'

/**
 * Verification campaign group G, the integrity of the ledger mirror and of the evidence built on it
 * (VC-063, VC-023, VC-045, VC-102, VC-079): each case writes to the target or the store what a
 * restore, a hand edit or a compromised role would, on PostgreSQL 17.
 */
const pg17 = serverFor(17)
let w: World

beforeAll(async () => {
  w = await migrationWorld('exdb_it_mig_integrity', pg17)
}, 240_000)

afterAll(async () => {
  await w?.close()
})

async function applied(t: Target, name: string, dependsOn: string[], up: string) {
  const id = w.ulid()
  const op = await w.apply(await w.plan(t, { bundles: [w.bundle({ id, name, up, dependsOn })] }))
  expect(op).toMatchObject({ state: 'succeeded' })
  return { id, operationId: op.operationId }
}

async function threeMigrations(slug: string) {
  const t = await w.registerTarget(slug, 'nonprod')
  const base = await applied(t, 'items', [], 'CREATE TABLE public.items (id int PRIMARY KEY);\n')
  const m2 = await applied(t, 'second', [base.id], 'CREATE TABLE public.second (id int);\n')
  const m3 = await applied(t, 'third', [m2.id], 'CREATE TABLE public.third (id int);\n')
  return { t, base, m2, m3 }
}

/** What the target's superuser does that no operation of ExponetDB explains, past the ledger's guards. */
async function asSuperuser(t: Target, statements: readonly { sql: string; params?: unknown[] }[]) {
  const c = await superuserClient(pg17, t.database)
  try {
    await c.query('BEGIN')
    await c.query('SET LOCAL session_replication_role = replica')
    for (const s of statements) await c.query(s.sql, s.params ?? [])
    await c.query('COMMIT')
  } catch (error) {
    await c.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    await c.end()
  }
}

/** A ledger row copied from `from` under another migration id, as a hand-written one would be. */
const handRow = (from: string, id: string, extra = '', params: unknown[] = []) => [
  {
    sql: `CREATE TEMP TABLE hand_row ON COMMIT DROP AS SELECT * FROM exponetdb.schema_migrations WHERE migration_id = $1`,
    params: [from],
  },
  {
    sql: `UPDATE hand_row SET migration_id = $1, applied_seq = 99999${extra}`,
    params: [id, ...params],
  },
  {
    sql: 'INSERT INTO exponetdb.schema_migrations OVERRIDING SYSTEM VALUE SELECT * FROM hand_row',
  },
]

const refusal = async (p: Promise<unknown>) => {
  try {
    await p
  } catch (error) {
    return error as { code?: string; details?: unknown }
  }
  throw new Error('expected a refusal')
}

const sqlstateOf = (error: unknown): string | undefined => {
  let current: unknown = error
  while (typeof current === 'object' && current !== null) {
    const code: unknown = Reflect.get(current, 'sqlstate')
    if (typeof code === 'string') return code
    current = Reflect.get(current, 'cause')
  }
  return undefined
}

describe('a ledger row counts as recorded only when the operation listed its migration (VC-063)', () => {
  it('a hand-written row with the id of a genuine operation of the target that never listed it blocks planning and can be reconciled', async () => {
    const { t, base, m2 } = await threeMigrations('li-a')
    const stranger = w.ulid()
    // The periodic watch (VC-022) reads the same comparison: nothing before the row, the row after.
    const watch = () =>
      ledgerDivergenceOf({ store: w.h.worker, connector: w.h.workerConnector }, t.record)
    expect(await watch()).toBeNull()
    // The id of a real apply of this target: it applied m2, not the stranger.
    await asSuperuser(t, handRow(base.id, stranger, `, operation_id = '${m2.operationId}'`))
    expect(await watch()).toMatchObject({ unrecorded: [stranger] })
    expect(await refusal(w.plan(t, { migrationIds: [m2.id] }))).toMatchObject({
      code: 'LEDGER_DIVERGENCE',
      details: { unrecorded: [stranger] },
    })
    const plan = await w.h.serve.transaction('test.integrity.reconcile', (tx) =>
      planLedgerReconcile(tx, w.ctx, w.a, t.record.targetId, {
        decision: 'adopt_target',
        note: 'A row was written by hand; adopting the target ledger as the truth.',
      }),
    )
    expect(
      (plan.body['content'] as { divergence: { unrecorded: string[] } }).divergence,
    ).toMatchObject({
      unrecorded: [stranger],
    })
  })

  it('a row the operation did list is healed (a crash between the commit and the mirror)', async () => {
    const { t, m3 } = await threeMigrations('li-b')
    // The mirror misses the row of the last apply, as after a crash before the mirror write.
    await w.h.worker
      .query(
        'test.integrity.heal',
        `DELETE FROM migrations.ledger_mirror WHERE target_id = $1 AND migration_id = $2`,
        [t.record.targetId, m3.id],
      )
      .catch(() => undefined)
    // The worker cannot delete a mirror row (VC-045 keeps it so): the superuser plays the crash.
    await w.h.db.asSuperuser((c) =>
      c.query('DELETE FROM migrations.ledger_mirror WHERE target_id = $1 AND migration_id = $2', [
        t.record.targetId,
        m3.id,
      ]),
    )
    const live = await w.h.workerConnector.forTarget(t.record, 'observer', 'test')
    try {
      const rows = await live.session.readOnly((tx) => readLedgerRows(tx))
      expect(
        await ledgerDivergence(w.h.serve, t.record.targetId, t.record.generation, rows),
      ).toBeNull()
    } finally {
      await live.session.close()
    }
  })
})

describe('a bumped generation is a divergence, never a fresh start (VC-023)', () => {
  it('a mirror of an earlier generation and none for the current one is a divergence, and nothing is mirrored for it', async () => {
    const { t, base } = await threeMigrations('li-c')
    const live = await w.h.workerConnector.forTarget(t.record, 'observer', 'test')
    let rows: Awaited<ReturnType<typeof readLedgerRows>>
    try {
      rows = await live.session.readOnly((tx) => readLedgerRows(tx))
    } finally {
      await live.session.close()
    }
    const next = t.record.generation + 1
    const found = await ledgerDivergence(w.h.serve, t.record.targetId, next, rows)
    expect(found?.unrecorded).toContain(base.id)
    // The next apply's mirror write starts from nothing at the new generation: it adopts nothing.
    await w.h.worker.transaction('test.integrity.generation', (tx) =>
      writeMirror(tx, {
        targetId: t.record.targetId,
        generation: next,
        rows,
        ledgerStateHash: `sha256:${'0'.repeat(64)}`,
        baselineId: null,
      }),
    )
    const mirrored = await w.h.worker.query(
      'test.integrity.generation.rows',
      'SELECT count(*)::int AS n FROM migrations.ledger_mirror WHERE target_id = $1 AND generation = $2',
      [t.record.targetId, next],
    )
    expect(mirrored.rows[0]?.int('n')).toBe(0)
  })
})

describe('the worker cannot rewrite a mirror row (VC-045)', () => {
  it('refuses to change what the divergence check compares against, and allows the three columns of a revert', async () => {
    const { t, base } = await threeMigrations('li-d')
    const update = (set: string) =>
      w.h.worker
        .query(
          'test.integrity.mirror_update',
          `UPDATE migrations.ledger_mirror SET ${set} WHERE target_id = $1 AND migration_id = $2`,
          [t.record.targetId, base.id],
        )
        .then(() => undefined)
        .catch((e: unknown) => e)
    for (const set of [
      "checksum = 'FORGED'",
      'generation = 99',
      "migration_id = 'X'",
      "operation_id = 'op_x'",
    ]) {
      expect(sqlstateOf(await update(set)), set).toBe('EXM03')
    }
    // The columns a revert records stay writable.
    expect(await update('mirrored_at = clock_timestamp()')).toBeUndefined()
    const row = await w.h.worker.query(
      'test.integrity.mirror_row',
      'SELECT checksum FROM migrations.ledger_mirror WHERE target_id = $1 AND migration_id = $2',
      [t.record.targetId, base.id],
    )
    expect(row.rows[0]?.text('checksum')).not.toBe('FORGED')
  })
})

describe('archive_mirror_rows moves only what its running operation is entitled to (VC-102)', () => {
  it('refuses another generation, ids outside the plan, a missing reason and an expired lease', async () => {
    const { t, base, m3 } = await threeMigrations('li-e')
    await asSuperuser(t, [
      {
        sql: 'DELETE FROM exponetdb.migration_verifications WHERE migration_id = $1',
        params: [m3.id],
      },
      { sql: 'DELETE FROM exponetdb.migration_events WHERE migration_id = $1', params: [m3.id] },
      { sql: 'DELETE FROM exponetdb.schema_migrations WHERE migration_id = $1', params: [m3.id] },
      { sql: 'DROP TABLE public.third' },
    ])
    const plan = await w.h.serve.transaction('test.integrity.archive.plan', (tx) =>
      planLedgerReconcile(tx, w.ctx, w.a, t.record.targetId, {
        decision: 'adopt_target',
        note: 'The target was restored to a point before the third migration.',
      }),
    )
    const op = await w.apply(plan)
    expect(op).toMatchObject({ state: 'succeeded' })
    // The operation is running again, with a lease, as it would be while it archives.
    const running = (lease: string) =>
      w.h.db.asSuperuser(async (c) => {
        await c.query('BEGIN')
        await c.query('SET LOCAL session_replication_role = replica')
        await c.query(
          `UPDATE operations.operations SET state = 'running', lease_owner = 'prc_01ARZ3NDEKTSV4RRFFQ69G5FAV',
                  lease_expires_at = clock_timestamp() + $2::interval WHERE operation_id = $1`,
          [op.operationId, lease],
        )
        await c.query('COMMIT')
      })
    const call = (generation: number, ids: string[], reason: string | null) =>
      w.h.worker
        .transaction('test.integrity.archive.call', (tx) =>
          tx.query(
            'test.integrity.archive.raw',
            'SELECT migrations.archive_mirror_rows($1, $2, $3, $4::text[], $5) AS moved',
            [op.operationId, t.record.targetId, generation, ids, reason],
          ),
        )
        .then((r) => r.rows[0]?.int('moved'))
        .catch((e: unknown) => sqlstateOf(e))
    const generation = t.record.generation
    await running('5 minutes')
    // Another generation, and an id the plan never named: refused. An absent reason too (not a NOT NULL error).
    expect(await call(generation + 1, [m3.id], 'missing')).toBe('EXM01')
    expect(await call(generation, [base.id], 'missing')).toBe('EXM01')
    expect(await call(generation, [m3.id], null)).toBe('EXM01')
    // The lease ran out: the worker no longer owns the operation.
    await running('-1 minute')
    expect(await call(generation, [m3.id], 'missing')).toBe('EXM01')
    // What the plan names, under a live lease, is accepted (the row was moved already: 0).
    await running('5 minutes')
    expect(await call(generation, [m3.id], 'missing')).toBe(0)
  })
})

describe('immutability holds between the target commit and the mirror write (VC-027)', () => {
  it('refuses other bytes under an applied id although the mirror does not hold its row yet', async () => {
    const t = await w.registerTarget('li-f', 'nonprod')
    const x = await applied(t, 'x', [], 'CREATE TABLE public.x (id int);\n')
    // The window: committed on the target, crashed before the mirror was written.
    await w.h.db.asSuperuser((c) =>
      c.query('DELETE FROM migrations.ledger_mirror WHERE target_id = $1 AND migration_id = $2', [
        t.record.targetId,
        x.id,
      ]),
    )
    const other = await w.registerTarget('li-g', 'nonprod')
    const error = await refusal(
      w.plan(other, {
        bundles: [
          w.bundle({ id: x.id, name: 'x', up: 'CREATE TABLE public.x (id int, extra int);\n' }),
        ],
      }),
    )
    expect(error).toMatchObject({ code: 'MIGRATION_CHECKSUM_MISMATCH' })
  })
})

describe('evidence is produced by this installation, never written by hand (VC-079, VC-153)', () => {
  /** Staging applied and verified `genuine`; `forged` was never applied there. */
  async function pair(slug: string) {
    const staging = await w.registerTarget(`${slug}-stg`, 'nonprod')
    const production = await w.registerTarget(`${slug}-prd`, 'prod', `${slug}-stg`)
    const genuine = await applied(staging, 'genuine', [], 'CREATE TABLE public.genuine (id int);\n')
    const forgedId = w.ulid()
    // Ingested by a plan for staging that is never applied.
    const staged = await w.plan(staging, {
      bundles: [
        w.bundle({
          id: forgedId,
          name: 'forged',
          up: 'CREATE TABLE public.forged (id int);\n',
          dependsOn: [genuine.id],
        }),
      ],
    })
    const item = (
      staged.body['content'] as {
        migrations: { checksum: string; verifyDigest: string | null }[]
      }
    ).migrations[0]
    return {
      staging,
      production,
      genuine,
      forgedId,
      checksum: item?.checksum ?? '',
      verifyDigest: item?.verifyDigest ?? null,
    }
  }

  /** Two hand-written rows on the evidence database: a ledger row and a passed verification. */
  const forge = (
    p: Awaited<ReturnType<typeof pair>>,
    operationId: string,
    verificationId: string,
  ) =>
    asSuperuser(p.staging, [
      ...handRow(
        p.genuine.id,
        p.forgedId,
        `, checksum = '${p.checksum}', verify_digest = $2, operation_id = '${operationId}'`,
        [p.verifyDigest],
      ),
      {
        sql: `INSERT INTO exponetdb.migration_verifications
                (verification_id, migration_id, operation_id, verify_digest, started_at, finished_at, status,
                 structural, runtime, engine, fingerprint)
              SELECT $1, $2, $3, $5, now(), now(), 'passed', '{}'::jsonb, NULL, '{}'::jsonb, fingerprint_after
                FROM exponetdb.schema_migrations WHERE migration_id = $4`,
        params: [verificationId, p.forgedId, operationId, p.genuine.id, p.verifyDigest],
      },
    ])

  const evidenceOf = (plan: { body: Record<string, unknown> }) =>
    (plan.body['content'] as { facts: { evidence: string } }).facts.evidence

  it('does not take two hand-written rows that quote the genuine operation id as evidence', async () => {
    const p = await pair('ev-a')
    await forge(p, p.genuine.operationId, `vfy_${w.ulid()}`)
    const plan = await w.plan(p.production, { migrationIds: [p.forgedId as never] })
    expect(evidenceOf(plan)).not.toBe('present')
    expect(plan.decision).toBe('deny')
  })

  it('does not take the id of an unrelated operation of another kind as evidence either', async () => {
    const p = await pair('ev-b')
    const unrelated = await w.h.worker.query(
      'test.integrity.unrelated_operation',
      `SELECT operation_id FROM operations.operations WHERE kind = 'registry.environment.create' LIMIT 1`,
    )
    await forge(p, unrelated.rows[0]?.text('operation_id') ?? '', `vfy_${w.ulid()}`)
    const plan = await w.plan(p.production, { migrationIds: [p.forgedId as never] })
    expect(evidenceOf(plan)).not.toBe('present')
    expect(plan.decision).toBe('deny')
  })

  it('never creates an allowing plan whose evidence cannot be applied: a malformed verification id is no evidence', async () => {
    const p = await pair('ev-c')
    await forge(p, p.genuine.operationId, 'vfy_forged')
    const plan = await w.plan(p.production, { migrationIds: [p.forgedId as never] })
    expect(evidenceOf(plan)).not.toBe('present')
    expect(plan.decision).not.toBe('allow')
  })

  it('keeps the evidence when staging was verified again: the newer mirrored verification counts', async () => {
    const p = await pair('ev-e')
    expect(evidenceOf(await w.plan(p.production, { migrationIds: [p.genuine.id as never] }))).toBe(
      'present',
    )
    // A person verifies the migration on staging again: a newer, passed, mirrored verification.
    // (The apply-time check of the plan made before it is covered by mcp-plans.int.test.ts.)
    const again = await w.apply(
      await w.h.serve.transaction('test.integrity.reverify', (tx) =>
        planMigrationVerify(tx, w.ctx, w.a, p.staging.record.targetId, p.genuine.id, {}),
      ),
    )
    expect(again).toMatchObject({ state: 'succeeded', verificationOutcome: 'passed' })
    expect(evidenceOf(await w.plan(p.production, { migrationIds: [p.genuine.id as never] }))).toBe(
      'present',
    )
  })

  it('still binds the evidence of a genuine apply and verification', async () => {
    const p = await pair('ev-d')
    const plan = await w.plan(p.production, { migrationIds: [p.genuine.id as never] })
    expect(evidenceOf(plan)).toBe('present')
  })
})

describe('the same id with other bytes is refused at every apply, not only at plan time (VC-080)', () => {
  it('ends the second apply MIGRATION_CHECKSUM_MISMATCH and leaves its ledger empty', async () => {
    const t1 = await w.registerTarget('im-a', 'nonprod')
    const t2 = await w.registerTarget('im-b', 'nonprod')
    const id = w.ulid()
    const variant = (up: string) => w.bundle({ id, name: 'shared', up })
    // Both variants are planned before either is applied: the plan-time check sees nothing yet.
    const planA = await w.plan(t1, { bundles: [variant('CREATE TABLE public.shared (id int);\n')] })
    const planB = await w.plan(t2, {
      bundles: [variant('CREATE TABLE public.shared (id int, extra text);\n')],
    })
    expect(await w.apply(planA)).toMatchObject({ state: 'succeeded' })
    const second = await w.apply(planB)
    expect(second).toMatchObject({ state: 'failed', applyOutcome: 'not_applied' })
    const events = await w.h.worker.query(
      'test.integrity.immutability.error',
      `SELECT detail ->> 'errorCode' AS code FROM operations.operation_events
        WHERE operation_id = $1 AND detail ? 'errorCode' ORDER BY event_id DESC LIMIT 1`,
      [second.operationId],
    )
    expect(events.rows[0]?.text('code')).toBe('MIGRATION_CHECKSUM_MISMATCH')
    const live = await w.h.workerConnector.forTarget(t2.record, 'observer', 'test')
    try {
      expect(await live.session.readOnly((tx) => readLedgerRows(tx))).toEqual([])
    } finally {
      await live.session.close()
    }
  })
})
