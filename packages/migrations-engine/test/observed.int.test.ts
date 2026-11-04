import { serverFor, superuserClient } from '@exponetdb/testkit'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  migrationDetail,
  migrationStatus,
  planBaseline,
  planImportAnalysis,
  planLedgerReconcile,
  planMigrationResume,
  planMigrationRollback,
  planMigrationVerify,
} from '../src/index.ts'
import { migrationWorld, type Target, type World } from './world.ts'

/**
 * An observed target (ADR-0039 §3) has no ExponetDB ledger and is never
 * written to: every migration plan and the ledger reads refuse it with
 * `TARGET_OBSERVED_ONLY` at plan time, and nothing reaches its database.
 * PostgreSQL 17.
 */
const pg17 = serverFor(17)
let w: World
let t: Target

beforeAll(async () => {
  w = await migrationWorld('exdb_it_mig_observed', pg17)
  t = await w.registerTarget('observed', 'nonprod', undefined, 'observed')
}, 240_000)

afterAll(async () => {
  await w?.close()
})

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p
  } catch (error) {
    return String((error as { code?: unknown }).code)
  }
  throw new Error('expected a refusal')
}

describe('migrations on an observed target', () => {
  it('refuses every migration plan (apply, verify, resume, rollback, baseline, import, reconcile) and the ledger reads, and writes nothing', async () => {
    expect([t.record.state, t.record.mode]).toEqual(['registered', 'observed'])
    expect(
      await code(w.plan(t, { bundles: [w.bundle({ up: 'CREATE TABLE public.x (id int);\n' })] })),
    ).toBe('TARGET_OBSERVED_ONLY')
    expect(
      await code(
        w.h.serve.transaction('test.observed.reconcile', (tx) =>
          planLedgerReconcile(tx, w.ctx, w.a, t.record.targetId, {
            decision: 'adopt_target',
            note: 'An observed target has no ledger to reconcile with the mirror.',
          }),
        ),
      ),
    ).toBe('TARGET_OBSERVED_ONLY')
    const plans = (label: string, fn: Parameters<typeof w.h.serve.transaction>[1]) =>
      code(w.h.serve.transaction(`test.observed.${label}`, fn))
    const id = w.ulid()
    const refused = {
      verify: await plans('verify', (tx) =>
        planMigrationVerify(tx, w.ctx, w.a, t.record.targetId, id, {}),
      ),
      verifyBaseline: await plans('verify_baseline', (tx) =>
        planMigrationVerify(tx, w.ctx, w.a, t.record.targetId, 'baseline:initial', {}),
      ),
      resume: await plans('resume', (tx) =>
        planMigrationResume(tx, w.ctx, w.a, t.record.targetId, id, {}),
      ),
      rollback: await plans('rollback', (tx) =>
        planMigrationRollback(tx, w.ctx, w.a, t.record.targetId, id),
      ),
      baseline: await plans('baseline', (tx) =>
        planBaseline(tx, w.ctx, w.a, t.record.targetId, 'rpt_01M6HQW7JQYHC8YR9KNTQ4PFFZ'),
      ),
      importAnalysis: await plans('import', (tx) =>
        planImportAnalysis(tx, w.ctx, w.a, t.record.targetId, {
          scratchTarget: t.record.targetId,
          baseline: 'baseline:initial',
          files: [],
        }),
      ),
    }
    expect(refused).toEqual({
      verify: 'TARGET_OBSERVED_ONLY',
      verifyBaseline: 'TARGET_OBSERVED_ONLY',
      resume: 'TARGET_OBSERVED_ONLY',
      rollback: 'TARGET_OBSERVED_ONLY',
      baseline: 'TARGET_OBSERVED_ONLY',
      importAnalysis: 'TARGET_OBSERVED_ONLY',
    })
    const deps = {
      store: w.h.serve,
      connector: w.h.serveConnector,
      installationId: w.h.db.installationId,
    }
    expect(await code(migrationStatus(deps, t.record))).toBe('TARGET_OBSERVED_ONLY')
    expect(await code(migrationDetail(deps, t.record, w.ulid()))).toBe('TARGET_OBSERVED_ONLY')
    const c = await superuserClient(pg17, t.database)
    try {
      const r = await c.query(
        `SELECT EXISTS (SELECT FROM pg_catalog.pg_namespace WHERE nspname = 'exponetdb') AS ledger,
                to_regclass('public.x') IS NOT NULL AS table`,
      )
      expect(r.rows[0]).toEqual({ ledger: false, table: false })
    } finally {
      await c.end()
    }
  })
})
