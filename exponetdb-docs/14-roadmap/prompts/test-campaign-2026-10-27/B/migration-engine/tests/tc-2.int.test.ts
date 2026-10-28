import type { MigrationId } from '@exponetdb/kernel'
import { findTarget } from '@exponetdb/registry'
import { afterAll, beforeAll, describe, it } from 'vitest'
import {
  currentBaseline,
  type DriftResult,
  openFindings,
  runDriftCheck,
} from '../../diagnostics/src/index.ts'
import { attempt, planFacts, rec, server, su } from './tc-util.ts'
import { migrationWorld, type Target, type World } from './tc-world.ts'

let w: World
let t: Target
let base = '' as MigrationId

const deps = () => ({
  store: w.h.worker,
  connector: w.h.workerConnector,
  installationId: w.h.db.installationId,
})
async function fresh() {
  const f = await findTarget(w.h.worker, t.record.targetId)
  if (f === undefined) throw new Error('target')
  return f
}
async function drift(): Promise<DriftResult> {
  return runDriftCheck(deps(), await fresh(), 'schedule')
}
const summary = (r: DriftResult) => ({
  status: r.check.status,
  drifted: r.check.drifted,
  opened: r.check.opened,
  resolved: r.check.resolved,
  items: r.items.map((i) => `${i.item.code}:${i.item.entry.class}:${JSON.stringify(i.item.entry.key)}:${i.item.attributes.join('|')}:${i.item.severity}`),
})

beforeAll(async () => {
  w = await migrationWorld('tc_mig_cs2', server)
  t = await w.registerTarget('tc2', 'nonprod')
  base = w.ulid()
  const op = await w.apply(
    await w.plan(t, {
      bundles: [w.bundle({ id: base, name: 'items', up: 'CREATE TABLE public.items (id int PRIMARY KEY);\n' })],
    }),
  )
  if (op.state !== 'succeeded') throw new Error(`setup ${op.state}`)
}, 300_000)

afterAll(async () => {
  await w?.close()
})

describe('(c) drift', () => {
  it('baseline recorded by the migration, drift clean', async () => {
    const b = await currentBaseline(w.h.worker, await fresh())
    rec('c', 'c0.baseline', b?.reason === 'migration' ? 'PASS' : 'FAIL', { baseline: b })
    const r = await drift()
    rec('c', 'c0.clean_after_migration', r.check.status === 'clean' ? 'PASS' : 'FAIL', summary(r))
  }, 120_000)

  it('out-of-band DDL by a superuser: detected or invisible', async () => {
    await su(t, (c) => c.query('CREATE SCHEMA IF NOT EXISTS outside_scope'))
    await su(t, (c) => c.query('ALTER TABLE public.items ADD COLUMN IF NOT EXISTS v int'))
    // v is part of the baseline? no: drift will show it. Remove again.
    await su(t, (c) => c.query('ALTER TABLE public.items DROP COLUMN v'))
    const cases: readonly [string, string, string, 'detected-expected' | 'invisible-expected'][] = [
      ['add column', 'ALTER TABLE public.items ADD COLUMN oob_a int', 'ALTER TABLE public.items DROP COLUMN oob_a', 'detected-expected'],
      ['add index', 'CREATE INDEX oob_idx ON public.items (id)', 'DROP INDEX public.oob_idx', 'detected-expected'],
      ['comment on table', "COMMENT ON TABLE public.items IS 'oob'", 'COMMENT ON TABLE public.items IS NULL', 'detected-expected'],
      ['grant to PUBLIC', 'GRANT SELECT ON public.items TO PUBLIC', 'REVOKE SELECT ON public.items FROM PUBLIC', 'detected-expected'],
      ['disable RLS -> enable RLS', 'ALTER TABLE public.items ENABLE ROW LEVEL SECURITY', 'ALTER TABLE public.items DISABLE ROW LEVEL SECURITY', 'detected-expected'],
      ['owner change', 'ALTER TABLE public.items OWNER TO postgres', 'ALTER TABLE public.items OWNER TO tc_mig_owner', 'detected-expected'],
      ['new table', 'CREATE TABLE public.oob_t (id int)', 'DROP TABLE public.oob_t', 'detected-expected'],
      ['fillfactor reloption', 'ALTER TABLE public.items SET (fillfactor = 50)', 'ALTER TABLE public.items RESET (fillfactor)', 'detected-expected'],
      ['autovacuum reloption', 'ALTER TABLE public.items SET (autovacuum_enabled = false)', 'ALTER TABLE public.items RESET (autovacuum_enabled)', 'detected-expected'],
      ['replica identity full', 'ALTER TABLE public.items REPLICA IDENTITY FULL', 'ALTER TABLE public.items REPLICA IDENTITY DEFAULT', 'detected-expected'],
      ['column statistics target', 'ALTER TABLE public.items ALTER COLUMN id SET STATISTICS 500', 'ALTER TABLE public.items ALTER COLUMN id SET STATISTICS -1', 'detected-expected'],
      ['column storage', 'ALTER TABLE public.items ALTER COLUMN id SET STORAGE EXTERNAL', 'ALTER TABLE public.items ALTER COLUMN id SET STORAGE PLAIN', 'detected-expected'],
      ['extended statistics', 'CREATE STATISTICS public.oob_stat ON id, (id + 1) FROM public.items', 'DROP STATISTICS public.oob_stat', 'detected-expected'],
      ['publication of the table', 'CREATE PUBLICATION oob_pub FOR TABLE public.items', 'DROP PUBLICATION oob_pub', 'detected-expected'],
      ['unlogged', 'ALTER TABLE public.items SET UNLOGGED', 'ALTER TABLE public.items SET LOGGED', 'detected-expected'],
      ['table in excluded schema', 'CREATE TABLE outside_scope.oob_x (id int)', 'DROP TABLE outside_scope.oob_x', 'invisible-expected'],
      ['row data insert', 'INSERT INTO public.items VALUES (42)', 'DELETE FROM public.items WHERE id = 42', 'invisible-expected'],
      ['ALTER DATABASE SET', 'ALTER DATABASE CURRENT_DATABASE_PLACEHOLDER SET work_mem = \'64MB\'', 'ALTER DATABASE CURRENT_DATABASE_PLACEHOLDER RESET work_mem', 'invisible-expected'],
      ['ALTER ROLE SET (execution role)', "ALTER ROLE tc_mig_owner SET statement_timeout = '5s'", 'ALTER ROLE tc_mig_owner RESET statement_timeout', 'invisible-expected'],
      ['event trigger (database level)', 'CREATE FUNCTION outside_scope.ev() RETURNS event_trigger LANGUAGE plpgsql AS $$ BEGIN NULL; END $$; CREATE EVENT TRIGGER oob_ev ON ddl_command_end EXECUTE FUNCTION outside_scope.ev()', 'DROP EVENT TRIGGER oob_ev; DROP FUNCTION outside_scope.ev()', 'invisible-expected'],
      ['extension pg_trgm', 'CREATE EXTENSION IF NOT EXISTS pg_trgm', 'DROP EXTENSION pg_trgm', 'detected-expected'],
    ]
    for (const [name, sql, undo, expectation] of cases) {
      const run = (s: string) => su(t, async (c) => {
        const d = (await c.query('SELECT current_database() AS d')).rows[0].d
        await c.query(s.replace(/CURRENT_DATABASE_PLACEHOLDER/g, `"${d}"`))
      })
      const applied = await attempt(() => run(sql))
      if (!applied.ok) { rec('c', `c1.oob.${name}`, 'SKIPPED', applied); continue }
      const r = await drift()
      const seen = r.check.status === 'drifted'
      await run(undo)
      const back = await drift()
      rec('c', `c1.oob.${name}`,
        (expectation === 'detected-expected') === seen ? (seen ? 'DETECTED' : 'INVISIBLE(as designed)') : (seen ? 'DETECTED(unexpected)' : 'INVISIBLE(unexpected)'),
        { expectation, ...summary(r), undoneAndClean: back.check.status === 'clean' ? true : summary(back) })
    }
  }, 300_000)

  it('E23: plan before out-of-band DDL is stale at acceptance; a plan after it is not', async () => {
    const before = await w.plan(t, { bundles: [w.bundle({ name: 'later-a', up: 'CREATE TABLE public.later_a (id int);\n', dependsOn: [base] })] })
    await su(t, (c) => c.query('ALTER TABLE public.items ADD COLUMN oob_stale int'))
    const stale = await attempt(() => w.accept(before))
    rec('c', 'c2.plan_before_oob_is_stale', !stale.ok && stale.code === 'PLAN_STALE' ? 'PASS' : 'FAIL', stale.ok ? { accepted: true } : stale)
    const d1 = await drift()
    rec('c', 'c2.drift_sees_it', d1.check.status === 'drifted' ? 'PASS' : 'FAIL', summary(d1))
    // plan made AFTER the out-of-band DDL
    const after = await attempt(() => w.plan(t, { bundles: [w.bundle({ name: 'later-b', up: 'CREATE TABLE public.later_b (id int);\n', dependsOn: [base] })] }))
    if (!after.ok) { rec('c', 'c2.plan_after_oob', 'info', after); return }
    rec('c', 'c2.plan_after_oob', 'info', {
      decision: after.value.decision,
      facts: planFacts(after.value),
      expectedFingerprintBound: (after.value.body['content'] as { expectedState: { schemaFingerprint: string } }).expectedState.schemaFingerprint,
      note: 'is there any signal in the plan that the schema has open drift findings?',
      openDrift: (await openFindings(w.h.worker, t.record.targetId, 'drift')).map((f) => `${f.code}:${f.severity}`),
    })
    const op = await w.apply(after.value)
    rec('c', 'c2.apply_on_top_of_oob', 'info', { state: op.state, ver: op.verificationOutcome })
    const d2 = await drift()
    const open = await openFindings(w.h.worker, t.record.targetId, 'drift')
    const bl = await currentBaseline(w.h.worker, await fresh())
    rec('c', 'c2.drift_after_next_migration', d2.check.status === 'clean' ? 'FAIL(OOB laundered into baseline)' : 'PASS', {
      ...summary(d2), openFindingsLeft: open.length, baselineReason: bl?.reason, baselineOperation: bl?.operationId === op.operationId,
      doc: 'drift-detection.md section 7: a migration baseline is adopted when the snapshot equals the migration fingerprint_after',
    })
    await su(t, (c) => c.query('ALTER TABLE public.items DROP COLUMN oob_stale'))
  }, 300_000)

  it('security-relevant out-of-band change (GRANT to PUBLIC) is absorbed by the next migration', async () => {
    await su(t, (c) => c.query('GRANT ALL ON public.items TO PUBLIC'))
    const d0 = await drift()
    rec('c', 'c3.grant_public_detected', d0.check.status === 'drifted' ? 'PASS' : 'FAIL', summary(d0))
    const p = await w.plan(t, { bundles: [w.bundle({ name: 'unrelated', up: 'CREATE TABLE public.unrelated (id int);\n', dependsOn: [base] })] })
    const op = await w.apply(p)
    const d1 = await drift()
    const bl = await currentBaseline(w.h.worker, await fresh())
    const live = await su(t, async (c) => (await c.query("SELECT has_table_privilege('public','public.items','SELECT') AS pub")).rows[0].pub)
    rec('c', 'c3.after_unrelated_migration', d1.check.status === 'clean' && live === true ? 'FAIL(PUBLIC grant adopted silently)' : 'PASS', {
      op: op.state, drift: summary(d1), publicStillHasSelect: live, baselineReason: bl?.reason,
    })
  }, 300_000)
})
