import type { MigrationId } from '@exponetdb/kernel'
import { findTarget } from '@exponetdb/registry'
import { afterAll, beforeAll, describe, it } from 'vitest'
import { openFindings, runDriftCheck } from '../../diagnostics/src/index.ts'
import { migrationStatus, planMigrationVerify, projectStream } from '../src/index.ts'
import { attempt, ledgerOf, planFacts, planRules, rec, server, su } from './tc-util.ts'
import { migrationWorld, type Target, type World } from './tc-world.ts'

let w: World

beforeAll(async () => {
  w = await migrationWorld('tc_mig_cs4', server)
}, 300_000)

afterAll(async () => {
  await w?.close()
})

const deps = () => ({ store: w.h.worker, connector: w.h.workerConnector, installationId: w.h.db.installationId })
const allFindings = async (t: Target) => {
  const r = await w.h.worker.query('tc.findings', 'SELECT kind, code, severity, state FROM observation.findings WHERE target_id = $1', [t.record.targetId])
  return r.rows.map((x) => `${x.text('kind')}:${x.text('code')}:${x.text('severity')}:${x.text('state')}`)
}
const drift = async (t: Target) => {
  const f = await findTarget(w.h.worker, t.record.targetId)
  if (f === undefined) throw new Error('t')
  const r = await runDriftCheck(deps(), f, 'schedule')
  return { status: r.check.status, drifted: r.check.drifted, items: r.items.map((i) => i.item.code) }
}
const status = async (t: Target) => {
  const f = await findTarget(w.h.worker, t.record.targetId)
  if (f === undefined) throw new Error('t')
  return migrationStatus({ store: w.h.worker, connector: w.h.workerConnector, installationId: w.h.db.installationId }, f)
}

describe('(g) E16 hotfix_without_evidence', () => {
  it('prod has a migration staging lacks', async () => {
    const s = await w.registerTarget('tc4s', 'nonprod')
    const p = await w.registerTarget('tc4p', 'prod', 'tc4s')
    // The state after a break-glass hotfix is simulated by planning and accepting without the
    // overridable migration rules (the real flow needs a break-glass grant and a second person).
    w.setRules('registry-only')
    const base = w.ulid()
    const hot = w.ulid()
    const baseBundle = w.bundle({ id: base, name: 'items', up: 'CREATE TABLE public.items (id int PRIMARY KEY);\n' })
    const hotBundle = w.bundle({ id: hot, name: 'hotfix-col', up: 'ALTER TABLE public.items ADD COLUMN hot int;\n', dependsOn: [base] })
    const so = await w.apply(await w.plan(s, { bundles: [baseBundle] }))
    const po = await w.apply(await w.plan(p, { bundles: [baseBundle] }))
    const ho = await w.apply(await w.plan(p, { bundles: [hotBundle] }))
    w.setRules('all')
    rec('g', 'e16.setup', 'info', { stagingBase: so.state, prodBase: po.state, prodHotfix: ho.state })

    // With the rules back: what does the product say about the hotfix?
    const next = w.ulid()
    const nextBundle = w.bundle({ id: next, name: 'after-hotfix', up: 'CREATE TABLE public.after_hotfix (id int);\n', dependsOn: [hot] })
    const pl = await attempt(() => w.plan(p, { bundles: [nextBundle] }))
    rec('g', 'e16.next_prod_plan', 'info', pl.ok ? {
      decision: pl.value.decision, lineage: planFacts(pl.value)['lineage'], evidence: planFacts(pl.value)['evidence'],
      failing: planRules(pl.value).filter((r) => r.result === 'fail' || r.result === 'unknown'),
    } : pl)
    const stagingPlan = await attempt(() => w.plan(s, { bundles: [nextBundle] }))
    rec('g', 'e16.staging_plan_with_prod_only_dependency', stagingPlan.ok ? 'plan created' : 'refused', stagingPlan.ok ? { decision: stagingPlan.value.decision } : stagingPlan)
    const d = { prod: await drift(p), staging: await drift(s) }
    const st = { prod: await status(p), staging: await status(s) }
    const pf = await findTarget(w.h.worker, p.record.projectId ? p.record.targetId : '')
    const stream = await projectStream(w.h.worker, p.record.projectId, async () => true)
    rec('g', 'e16.detection_search', 'NO-DETECTION', {
      findingsProd: await allFindings(p),
      findingsStaging: await allFindings(s),
      drift: d,
      statusProdApplied: st.prod.applied.map((a) => a.migrationId.slice(-6)),
      statusStagingApplied: st.staging.applied.map((a) => a.migrationId.slice(-6)),
      statusProdKeys: Object.keys(st.prod),
      streamKeys: Object.keys(stream),
      streamSample: JSON.stringify(stream).slice(0, 900),
      codeSearch: "grep -rn hotfix_without_evidence packages apps => 0 matches in source (docs only)",
      pf: pf === undefined ? null : 'found',
    })
    // can the hotfix still be brought to staging (the documented recovery)?
    const back = await attempt(() => w.plan(s, { migrationIds: [hot as never] }))
    rec('g', 'e16.recovery_apply_to_staging', 'info', back.ok ? { decision: back.value.decision } : back)
  }, 400_000)
})

describe('(g) E18 applied_not_in_source', () => {
  it('an applied migration whose bundle is gone from the source', async () => {
    const t = await w.registerTarget('tc4g', 'nonprod')
    const x = w.ulid()
    const y = w.ulid()
    const xb = w.bundle({ id: x, name: 'applied-x', up: 'CREATE TABLE public.x (id int);\n' })
    const o = await w.apply(await w.plan(t, { bundles: [xb] }))
    // (a) the "source" of the next request no longer carries x
    const yb = w.bundle({ id: y, name: 'later-y', up: 'CREATE TABLE public.y (id int);\n', dependsOn: [x] })
    const pa = await attempt(() => w.plan(t, { bundles: [yb] }))
    rec('g', 'e18.plan_without_x_in_request', 'info', pa.ok ? {
      decision: pa.value.decision,
      analysisKeys: Object.keys(pa.value.body['analysis'] as object),
      lintFindings: JSON.stringify((pa.value.body['analysis'] as { perMigration: { lint: unknown[] }[] }).perMigration.map((m) => m.lint)).slice(0, 300),
      note: 'no finding mentions x being absent from the submitted source',
    } : pa)
    // (b) the bundle is gone from the Control Store (restored from an older backup, for example)
    await w.h.db.asSuperuser(async (c) => {
      await c.query('BEGIN')
      await c.query('SET LOCAL session_replication_role = replica')
      await c.query('DELETE FROM migrations.bundle_revisions WHERE migration_id = $1', [x])
      await c.query('COMMIT')
    }).catch((e) => rec('g', 'e18.delete_bundle', 'ERROR', { message: String(e).slice(0, 300) }))
    const stillStored = await w.h.worker.query('tc.stored', 'SELECT count(*)::int AS n FROM migrations.bundle_revisions WHERE migration_id = $1', [x])
    const pb = await attempt(() => w.plan(t, { bundles: [yb] }))
    const st = await status(t)
    const stream = await projectStream(w.h.worker, t.record.projectId, async () => true)
    rec('g', 'e18.after_bundle_removed', 'NO-DETECTION', {
      op: o.state, xRevisionsLeft: stillStored.rows[0]?.int('n'),
      planWithoutAnyStoredX: pb.ok ? `plan created (${pb.value.decision})` : pb,
      statusApplied: st.applied.map((a) => `${a.migrationId.slice(-6)}`),
      statusPending: st.pending.map((p) => p.migrationId.slice(-6)),
      xInStream: JSON.stringify(stream).includes(x),
      findings: await allFindings(t), drift: await drift(t),
      verifyPlan: await attempt(() => w.h.serve.transaction('tc.v', (tx) => planMigrationVerify(tx, w.ctx, w.a, t.record.targetId, x, {}))).then((r) => (r.ok ? 'plan created' : r.code)),
    })
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
