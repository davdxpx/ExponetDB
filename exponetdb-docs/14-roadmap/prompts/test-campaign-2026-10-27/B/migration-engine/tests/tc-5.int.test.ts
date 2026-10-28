import type { MigrationId } from '@exponetdb/kernel'
import { findTarget } from '@exponetdb/registry'
import { afterAll, beforeAll, describe, it } from 'vitest'
import { runDriftCheck } from '../../diagnostics/src/index.ts'
import { ingestBundles, migrationStatus } from '../src/index.ts'
import { attempt, ledgerOf, rec, server, su } from './tc-util.ts'
import { DEFAULTS, migrationWorld, type Target, type World } from './tc-world.ts'

let w: World

beforeAll(async () => {
  w = await migrationWorld('tc_mig_cs5', server)
}, 300_000)

afterAll(async () => {
  await w?.close()
})

const deps = () => ({ store: w.h.worker, connector: w.h.workerConnector, installationId: w.h.db.installationId })
const drift = async (t: Target) => {
  const f = await findTarget(w.h.worker, t.record.targetId)
  if (f === undefined) throw new Error('t')
  const r = await runDriftCheck(deps(), f, 'schedule')
  return { status: r.check.status, drifted: r.check.drifted, items: r.items.map((i) => `${i.item.code}:${i.item.entry.class}`) }
}
const status = async (t: Target) => {
  const f = await findTarget(w.h.worker, t.record.targetId)
  if (f === undefined) throw new Error('t')
  return migrationStatus({ store: w.h.worker, connector: w.h.workerConnector, installationId: w.h.db.installationId }, f)
}

describe('(j) a stored bundle with an unknown dependency poisons the project stream', () => {
  it('ingest endpoint path (no graph validation) then plan an unrelated bundle', async () => {
    const t = await w.registerTarget('tc5a', 'nonprod')
    const base = w.ulid()
    const op = await w.apply(await w.plan(t, { bundles: [w.bundle({ id: base, name: 'items', up: 'CREATE TABLE public.items (id int PRIMARY KEY);\n' })] }))
    const ghost = w.ulid()
    const bad = w.ulid()
    const ingest = (b: ReturnType<World['bundle']>) =>
      w.h.serve.transaction('tc.ingest', (tx) => ingestBundles(tx, { projectId: t.record.projectId, bundles: [b], defaults: DEFAULTS, identityId: w.a.identityId }))
    const stored = await attempt(() => ingest(w.bundle({ id: bad, name: 'typo-dependency', up: 'CREATE TABLE public.typo (id int);\n', dependsOn: [ghost] })))
    rec('j', 'j3.ingest_with_unknown_dependency', stored.ok ? 'STORED (no graph validation at ingest)' : 'REFUSED', stored.ok ? { status: stored.value[0]?.status } : stored)
    const unrelated = await attempt(() => w.plan(t, { bundles: [w.bundle({ name: 'unrelated', up: 'CREATE TABLE public.unrelated (id int);\n', dependsOn: [base] })] }))
    rec('j', 'j3.unrelated_plan_after_poison', unrelated.ok ? 'PLAN CREATED' : 'BLOCKED', unrelated.ok ? {} : { ...unrelated, op: op.state, ghost, bad })
    const t2 = await w.registerTarget('tc5b', 'nonprod')
    const other = await attempt(() => w.plan(t2, { bundles: [w.bundle({ name: 'other-target', up: 'CREATE TABLE public.other_target (id int);\n' })] }))
    rec('j', 'j3.other_target_same_project', other.ok ? 'PLAN CREATED' : 'BLOCKED', other.ok ? {} : other)
    // the author can repair by storing a corrected revision of the same id
    const fixed = await attempt(() => ingest(w.bundle({ id: bad, name: 'typo-dependency', up: 'CREATE TABLE public.typo (id int);\n', dependsOn: [base] })))
    rec('j', 'j3.repair_by_new_revision', fixed.ok ? 'REPAIRED' : 'NOT-REPAIRED', fixed.ok ? { status: fixed.value[0]?.status } : fixed)
    const after = await attempt(() => w.plan(t, { bundles: [w.bundle({ name: 'unrelated-again', up: 'CREATE TABLE public.unrelated2 (id int);\n', dependsOn: [base] })] }))
    rec('j', 'j3.plan_after_repair', after.ok ? 'PLAN CREATED' : 'BLOCKED', after.ok ? {} : after)
  }, 300_000)
})

describe('(g) E25 a ledger restored to a point older than the mirror', () => {
  it('construct, detect, recover', async () => {
    const t = await w.registerTarget('tc4r', 'nonprod')
    const base = w.ulid()
    const m2 = w.ulid()
    const m3 = w.ulid()
    const ob = await w.apply(await w.plan(t, { bundles: [w.bundle({ id: base, name: 'items', up: 'CREATE TABLE public.items (id int PRIMARY KEY);\n' })] }))
    rec('g', 'e25.base', 'info', { state: ob.state, apply: ob.applyOutcome })
    await w.apply(await w.plan(t, { bundles: [w.bundle({ id: m2, name: 'second', up: 'CREATE TABLE public.second (id int);\n', dependsOn: [base] })] }))
    await w.apply(await w.plan(t, { bundles: [w.bundle({ id: m3, name: 'third', up: 'CREATE TABLE public.third (id int);\n', dependsOn: [m2] })] }))
    const mirrorBefore = await w.h.worker.query('tc.m', 'SELECT migration_id FROM migrations.ledger_mirror WHERE target_id = $1 ORDER BY applied_seq', [t.record.targetId]).catch(() => w.h.worker.query('tc.m2', 'SELECT migration_id FROM migrations.ledger_mirror WHERE target_id = $1', [t.record.targetId]))
    // The "restore" to the point after the base migration: the target forgets m2 and m3 (ledger rows, events, runs, schema).
    await su(t, async (c) => {
      await c.query('BEGIN')
      await c.query('SET LOCAL session_replication_role = replica')
      await c.query('DELETE FROM exponetdb.migration_verifications WHERE migration_id = ANY($1)', [[m2, m3]])
      await c.query('DELETE FROM exponetdb.migration_events WHERE migration_id = ANY($1)', [[m2, m3]])
      await c.query('DELETE FROM exponetdb.schema_migrations WHERE migration_id = ANY($1)', [[m2, m3]])
      await c.query('DROP TABLE public.second, public.third')
      await c.query('COMMIT')
    })
    const flag = await w.h.worker.query('tc.flag', 'SELECT divergent FROM migrations.ledger_state WHERE target_id = $1', [t.record.targetId])
    const redo = await attempt(() => w.plan(t, { migrationIds: [m2 as never] }))
    const fresh = await attempt(() => w.plan(t, { bundles: [w.bundle({ name: 'fresh', up: 'CREATE TABLE public.fresh (id int);\n', dependsOn: [base] })] }))
    const stt = await attempt(() => status(t))
    rec('g', 'e25.restored_ledger', redo.ok ? 'REPLANNABLE' : 'BLOCKED', {
      mirrorRows: mirrorBefore.rows.length,
      ledgerRows: (await ledgerOf(w, t)).length,
      ledgerStateDivergentFlagBeforeAnyPlan: flag.rows[0]?.bool('divergent'),
      replanLostMigration: redo.ok ? 'plan created' : redo,
      planOther: fresh.ok ? 'plan created' : fresh,
      statusRead: stt.ok ? { divergence: (stt.value as { mirror?: unknown }).mirror } : stt,
      driftCheck: await drift(t),
      documented: 'failure-and-recovery.md E25: ledger reflects the restored state; mirror reconciled; re-plan; later migrations show as pending again',
      recoveryPath: 'ledger.reconcile is planned (gates/6.md section 8); only undoing the hand change is possible',
    })
  }, 300_000)
})
