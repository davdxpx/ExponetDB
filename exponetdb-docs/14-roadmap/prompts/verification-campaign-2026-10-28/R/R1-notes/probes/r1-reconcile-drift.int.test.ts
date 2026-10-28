// R1 probe TC-006 x TC-007: restore simulation, ledger.reconcile, re-apply, then what the drift check says.
// Lives beside reconcile.int.test.ts in a throwaway clone (packages/migrations-engine/test/).
import type { MigrationId } from '@exponetdb/kernel'
import { findTarget } from '@exponetdb/registry'
import { serverFor, superuserClient } from '@exponetdb/testkit'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { currentBaseline, openFindings, runDriftCheck } from '../../diagnostics/src/index.ts'
import { planLedgerReconcile } from '../src/index.ts'
import { migrationWorld, type Target, type World } from './tc-world.ts'

const pg17 = serverFor(17)
let w: World
beforeAll(async () => {
  w = await migrationWorld('exdb_r1_probe', pg17)
}, 240_000)
afterAll(async () => {
  await w?.close()
})
const deps = () => ({ store: w.h.worker, connector: w.h.workerConnector, installationId: w.h.db.installationId })
const drift = async (t: Target) => {
  const fresh = await findTarget(w.h.worker, t.record.targetId)
  if (fresh === undefined) throw new Error('target')
  const r = await runDriftCheck(deps(), fresh, 'schedule')
  return { status: r.check.status, drifted: r.check.drifted, items: r.items.map((i) => `${i.item.code}:${i.item.entry.class}:${JSON.stringify(i.item.entry.key)}`) }
}
const out = (label: string, v: unknown) => console.log(`[r1] ${label} ${JSON.stringify(v)}`)
async function applied(t: Target, name: string, dependsOn: string[], up: string): Promise<MigrationId> {
  const id = w.ulid()
  const op = await w.apply(await w.plan(t, { bundles: [w.bundle({ id, name, up, dependsOn })] }))
  expect(op).toMatchObject({ state: 'succeeded' })
  return id
}
async function su(t: Target, sql: string[]) {
  const c = await superuserClient(pg17, t.database)
  try {
    await c.query('BEGIN')
    await c.query('SET LOCAL session_replication_role = replica')
    for (const s of sql) await c.query(s)
    await c.query('COMMIT')
  } finally {
    await c.end()
  }
}

describe('R1: reconcile then drift', () => {
  it('after a restore + ledger.reconcile + re-apply, the drift state is', async () => {
    const t = await w.registerTarget('r1-a', 'nonprod')
    const base = await applied(t, 'items', [], 'CREATE TABLE public.items (id int PRIMARY KEY);\n')
    const m2 = await applied(t, 'second', [base], 'CREATE TABLE public.second (id int);\n')
    const m3 = await applied(t, 'third', [m2], 'CREATE TABLE public.third (id int);\n')
    out('clean-before', await drift(t))
    await su(t, [
      `DELETE FROM exponetdb.migration_verifications WHERE migration_id IN ('${m2}','${m3}')`,
      `DELETE FROM exponetdb.migration_events WHERE migration_id IN ('${m2}','${m3}')`,
      `DELETE FROM exponetdb.schema_migrations WHERE migration_id IN ('${m2}','${m3}')`,
      'DROP TABLE public.second', 'DROP TABLE public.third',
    ])
    out('after-restore-drift', await drift(t))
    const plan = await w.h.serve.transaction('r1.plan', (tx) => planLedgerReconcile(tx, w.ctx, w.a, t.record.targetId, { decision: 'adopt_target', note: 'r1 probe restore' }))
    out('reconcile-op', (await w.apply(plan)).state)
    out('after-reconcile-drift', await drift(t))
    out('after-reconcile-baseline', (await currentBaseline(w.h.worker, (await findTarget(w.h.worker, t.record.targetId))!))?.reason)
    const again = await w.apply(await w.plan(t, { migrationIds: [m2] }))
    out('reapply-m2', { state: again.state, ver: again.verificationOutcome })
    out('after-reapply-m2-drift', await drift(t))
    const again3 = await w.apply(await w.plan(t, { migrationIds: [m3] }))
    out('reapply-m3', { state: again3.state, ver: again3.verificationOutcome })
    out('after-reapply-m3-drift', await drift(t))
    out('open-findings', (await openFindings(w.h.worker, t.record.targetId, 'drift')).map((f) => `${f.code}:${f.severity}`))
  }, 300_000)
})
