import type { MigrationId } from '@exponetdb/kernel'
import { readLedgerRows } from '@exponetdb/postgres'
import { serverFor, superuserClient } from '@exponetdb/testkit'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { planLedgerReconcile } from '../src/index.ts'
import { migrationWorld, type Target, type World } from './world.ts'

/**
 * `ledger.reconcile` (TC-007, MIG-03, failure case E25;
 * [ledger.md §5](../../../exponetdb-docs/04-migrations/ledger.md#5-mirror-and-reconciliation)):
 * a target restored to a point older than the Control Store's mirror, or a
 * ledger changed by hand, refuses every schema plan with `LEDGER_DIVERGENCE`.
 * The operator's explicit decision (`adopt_target`) makes the live ledger the
 * truth: the mirror rows that differ move to a history table (nothing is
 * deleted), the live rows are mirrored, and the lost migrations are pending
 * again. Each case causes the divergence for real on PostgreSQL 17.
 */
const pg17 = serverFor(17)
let w: World

beforeAll(async () => {
  w = await migrationWorld('exdb_it_mig_reconcile', pg17)
}, 240_000)

afterAll(async () => {
  await w?.close()
})

const NOTE = 'The staging database was restored to the backup taken before the second migration.'

async function applied(
  t: Target,
  name: string,
  dependsOn: string[],
  up: string,
): Promise<MigrationId> {
  const id = w.ulid()
  const op = await w.apply(await w.plan(t, { bundles: [w.bundle({ id, name, up, dependsOn })] }))
  expect(op).toMatchObject({ state: 'succeeded' })
  return id
}

/** Three migrations in a row: the base, a second and a third one. */
async function threeMigrations(slug: string) {
  const t = await w.registerTarget(slug, 'nonprod')
  const base = await applied(t, 'items', [], 'CREATE TABLE public.items (id int PRIMARY KEY);\n')
  const m2 = await applied(t, 'second', [base], 'CREATE TABLE public.second (id int);\n')
  const m3 = await applied(t, 'third', [m2], 'CREATE TABLE public.third (id int);\n')
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

/** A restore to the point after the base migration: the target forgets the later migrations. */
const forget = (t: Target, ids: string[], tables: string[]) =>
  asSuperuser(t, [
    {
      sql: 'DELETE FROM exponetdb.migration_verifications WHERE migration_id = ANY($1)',
      params: [ids],
    },
    { sql: 'DELETE FROM exponetdb.migration_events WHERE migration_id = ANY($1)', params: [ids] },
    { sql: 'DELETE FROM exponetdb.schema_migrations WHERE migration_id = ANY($1)', params: [ids] },
    ...tables.map((table) => ({ sql: `DROP TABLE public.${table}` })),
  ])

const reconcile = (
  t: Target,
  request: { decision: 'adopt_target' | 'flag_untrusted'; note: string },
) =>
  w.h.serve.transaction('test.reconcile.plan', (tx) =>
    planLedgerReconcile(tx, w.ctx, w.a, t.record.targetId, request),
  )

const refusal = async (p: Promise<unknown>) => {
  try {
    await p
  } catch (error) {
    return error as { code?: string; details?: unknown }
  }
  throw new Error('expected a refusal')
}

const mirrorIds = async (t: Target) =>
  (
    await w.h.worker.query(
      'test.reconcile.mirror',
      'SELECT migration_id FROM migrations.ledger_mirror WHERE target_id = $1 ORDER BY migration_id',
      [t.record.targetId],
    )
  ).rows.map((r) => r.text('migration_id'))

const history = async (t: Target) =>
  (
    await w.h.worker.query(
      'test.reconcile.history',
      `SELECT migration_id, reason, operation_id FROM migrations.ledger_mirror_history
        WHERE target_id = $1 ORDER BY migration_id`,
      [t.record.targetId],
    )
  ).rows.map((r) => ({
    id: r.text('migration_id'),
    reason: r.text('reason'),
    operationId: r.text('operation_id'),
  }))

const content = (p: { body: Record<string, unknown> }) =>
  p.body['content'] as Record<string, unknown>

describe('a ledger restored to a point older than the mirror (E25)', () => {
  it('refuses every plan, then ledger.reconcile adopts the target and the lost migrations are pending again', async () => {
    const { t, base, m2, m3 } = await threeMigrations('rc-a')
    expect(await mirrorIds(t)).toEqual([base, m2, m3].sort())
    await forget(t, [m2, m3], ['second', 'third'])

    // Detected, and nothing can unblock the target.
    expect(await refusal(w.plan(t, { migrationIds: [m2] }))).toMatchObject({
      code: 'LEDGER_DIVERGENCE',
      details: { missing: expect.arrayContaining([m2, m3]) },
    })

    const plan = await reconcile(t, { decision: 'adopt_target', note: NOTE })
    expect(plan).toMatchObject({ kind: 'ledger.reconcile' })
    expect(content(plan)).toMatchObject({
      decision: 'adopt_target',
      note: NOTE,
      targetId: t.record.targetId,
      generation: t.record.generation,
      divergence: { missing: [m2, m3].sort(), checksumDiffers: [], unrecorded: [] },
      liveRows: 1,
    })
    const op = await w.apply(plan)
    expect(op).toMatchObject({
      state: 'succeeded',
      applyOutcome: 'applied',
      verificationOutcome: 'passed',
    })

    // The mirror is the live ledger; what it held is kept, with the operation that moved it.
    expect(await mirrorIds(t)).toEqual([base])
    expect(await history(t)).toEqual(
      [m2, m3].sort().map((id) => ({ id, reason: 'missing', operationId: op.operationId })),
    )
    const state = await w.h.worker.query(
      'test.reconcile.state',
      'SELECT divergent FROM migrations.ledger_state WHERE target_id = $1',
      [t.record.targetId],
    )
    expect(state.rows[0]?.bool('divergent')).toBe(false)

    // The lost migrations show as pending again: planned, applied, mirrored once more.
    const again = await w.apply(await w.plan(t, { migrationIds: [m2] }))
    expect(again).toMatchObject({ state: 'succeeded', verificationOutcome: 'passed' })
    const c = await superuserClient(pg17, t.database)
    try {
      expect(
        (await c.query(`SELECT to_regclass('public.second') IS NOT NULL AS ok`)).rows[0].ok,
      ).toBe(true)
    } finally {
      await c.end()
    }
    expect(await mirrorIds(t)).toEqual([base, m2].sort())
  })

  it('goes stale when the ledger changes after the plan', async () => {
    const { t, base, m2, m3 } = await threeMigrations('rc-b')
    await forget(t, [m3], ['third'])
    const plan = await reconcile(t, { decision: 'adopt_target', note: NOTE })
    // Another hand change after planning: the plan binds the ledger it saw.
    await forget(t, [m2], ['second'])
    expect(await refusal(w.accept(plan))).toMatchObject({ code: 'PLAN_STALE' })
    expect(await mirrorIds(t)).toEqual([base, m2, m3].sort())
  })
})

describe('other differences between the ledger and the mirror', () => {
  it('adopts a checksum written by hand and a row no operation of the target wrote', async () => {
    const { t, base, m2, m3 } = await threeMigrations('rc-c')
    const stranger = w.ulid()
    await asSuperuser(t, [
      {
        sql: `UPDATE exponetdb.schema_migrations SET checksum = 'sha256:c1:' || repeat('0', 64) WHERE migration_id = $1`,
        params: [m2],
      },
      {
        sql: `CREATE TEMP TABLE hand_row ON COMMIT DROP AS SELECT * FROM exponetdb.schema_migrations WHERE migration_id = $1`,
        params: [base],
      },
      {
        sql: `UPDATE hand_row SET migration_id = $1, operation_id = 'op_01M61AGQKSBZ9VN71DHYFVCQHT', applied_seq = 99999`,
        params: [stranger],
      },
      {
        sql: 'INSERT INTO exponetdb.schema_migrations OVERRIDING SYSTEM VALUE SELECT * FROM hand_row',
      },
    ])
    expect(await refusal(w.plan(t, { migrationIds: [m2] }))).toMatchObject({
      code: 'LEDGER_DIVERGENCE',
    })
    const plan = await reconcile(t, { decision: 'adopt_target', note: NOTE })
    expect(content(plan)['divergence']).toMatchObject({
      checksumDiffers: [m2],
      unrecorded: [stranger],
      missing: [],
    })
    expect(await w.apply(plan)).toMatchObject({ state: 'succeeded', verificationOutcome: 'passed' })
    // The row the mirror held is kept as it was; the mirror now agrees with the target.
    expect((await history(t)).map((h) => [h.id, h.reason])).toEqual([[m2, 'differs']])
    expect(await mirrorIds(t)).toEqual([base, m2, m3, stranger].sort())
    const live = await w.h.workerConnector.forTarget(t.record, 'observer', 'test')
    try {
      const rows = await live.session.readOnly((tx) => readLedgerRows(tx))
      const mirrored = await w.h.worker.query(
        'test.reconcile.checksum',
        'SELECT checksum FROM migrations.ledger_mirror WHERE target_id = $1 AND migration_id = $2',
        [t.record.targetId, m2],
      )
      expect(mirrored.rows[0]?.text('checksum')).toBe(
        rows.find((r) => r.migrationId === m2)?.checksum,
      )
    } finally {
      await live.session.close()
    }
  })
})

describe('what ledger.reconcile refuses', () => {
  it('a target whose identity marker is not this installation, target and cluster', async () => {
    const { t, m3 } = await threeMigrations('rc-d')
    await forget(t, [m3], ['third'])
    await asSuperuser(t, [
      { sql: `UPDATE exponetdb.target_identity SET cluster_system_id = '1234567890123456789'` },
    ])
    expect(await refusal(reconcile(t, { decision: 'adopt_target', note: NOTE }))).toMatchObject({
      code: 'CLUSTER_IDENTITY_MISMATCH',
    })
    await asSuperuser(t, [
      {
        sql: `UPDATE exponetdb.target_identity SET installation_id = 'ins_01M61AGQKSBZ9VN71DHYFVCQHT'`,
      },
    ])
    expect(await refusal(reconcile(t, { decision: 'adopt_target', note: NOTE }))).toMatchObject({
      code: 'TARGET_IDENTITY_MISMATCH',
    })
  })

  it('a ledger that agrees with the mirror', async () => {
    const { t } = await threeMigrations('rc-e')
    expect(await refusal(reconcile(t, { decision: 'adopt_target', note: NOTE }))).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: {
        errors: [expect.objectContaining({ path: '/decision', code: 'nothing_to_reconcile' })],
      },
    })
  })

  it('to move a mirror row for any operation but a running ledger.reconcile of the target', async () => {
    const { t, m3 } = await threeMigrations('rc-g')
    const apply = await w.h.worker.query(
      'test.reconcile.any_operation',
      `SELECT o.operation_id FROM operations.operations o JOIN operations.plans p ON p.plan_id = o.plan_id
        WHERE p.target_id = $1 ORDER BY o.created_at LIMIT 1`,
      [t.record.targetId],
    )
    const sqlstate = async (operationId: string): Promise<string | undefined> => {
      try {
        await w.h.worker.query(
          'test.reconcile.archive_directly',
          `SELECT migrations.archive_mirror_rows($1, $2, $3, ARRAY[$4]::text[], 'missing')`,
          [operationId, t.record.targetId, t.record.generation, m3],
        )
      } catch (error) {
        let current: unknown = error
        while (typeof current === 'object' && current !== null) {
          const code: unknown = Reflect.get(current, 'sqlstate')
          if (typeof code === 'string') return code
          current = Reflect.get(current, 'cause')
        }
        return 'unknown'
      }
      return undefined
    }
    // An apply operation of this target, and one that does not exist: both refused, nothing moved.
    expect(await sqlstate(apply.rows[0]?.text('operation_id') ?? '')).toBe('EXM01')
    expect(await sqlstate('op_01M61AGQKSBZ9VN71DHYFVCQHT')).toBe('EXM01')
    // And the worker has no way to delete or rewrite a mirror row itself.
    const direct = await w.h.worker
      .query(
        'test.reconcile.delete_directly',
        'DELETE FROM migrations.ledger_mirror WHERE target_id = $1',
        [t.record.targetId],
      )
      .catch((error: unknown) => error)
    expect(direct).toBeInstanceOf(Error)
    expect(await mirrorIds(t)).toContain(m3)
    expect(await history(t)).toEqual([])
  })

  it('flag_untrusted, which is not built (OD-59)', async () => {
    const { t, m3 } = await threeMigrations('rc-f')
    await forget(t, [m3], ['third'])
    expect(await refusal(reconcile(t, { decision: 'flag_untrusted', note: NOTE }))).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { errors: [expect.objectContaining({ path: '/decision', code: 'not_built' })] },
    })
  })
})
