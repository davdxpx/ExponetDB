import { serverFor } from '@exponetdb/testkit'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { appliedNotInSource, hotfixesWithoutEvidence, planMigrationRollback } from '../src/index.ts'
import { migrationWorld, type Target, type World } from './world.ts'

/**
 * G6 failure cases E16 and E18 (Wave 10 W10-3, OD-65 (a);
 * [failure-and-recovery.md §1](../../../exponetdb-docs/04-migrations/failure-and-recovery.md#1-edge-case-catalog)),
 * on PostgreSQL 17: what the detections report. Recording the findings is
 * the diagnostics package's (`diagnostics.int.test.ts`).
 */
const pg17 = serverFor(17)
let w: World

beforeAll(async () => {
  w = await migrationWorld('exdb_it_mig_hotfix', pg17)
}, 240_000)

afterAll(async () => {
  await w?.close()
})

const deps = () => ({
  store: w.h.worker,
  connector: w.h.workerConnector,
  installationId: w.h.db.installationId,
})

async function applied(t: Target, bundle: ReturnType<World['bundle']>) {
  const op = await w.apply(await w.plan(t, { bundles: [bundle] }))
  expect(op).toMatchObject({ state: 'succeeded' })
  return op
}

describe('E16: production has a hotfix that staging lacks (hotfix_without_evidence)', () => {
  it('reports the production migration staging lacks until staging has applied and verified it', async () => {
    const staging = await w.registerTarget('hf-stg', 'nonprod')
    const production = await w.registerTarget('hf-prd', 'prod', 'hf-stg')
    const base = w.ulid()
    const hot = w.ulid()
    const baseBundle = w.bundle({
      id: base,
      name: 'items',
      up: 'CREATE TABLE public.items (id int PRIMARY KEY);\n',
    })
    const hotBundle = w.bundle({
      id: hot,
      name: 'hotfix-col',
      up: 'ALTER TABLE public.items ADD COLUMN hot int;\n',
      dependsOn: [base],
    })
    await applied(staging, baseBundle)
    // The state after a break-glass hotfix: planned and accepted without the overridable
    // migration rules (the real flow needs a grant and a second person; http-migrations covers it).
    w.setRules('registry-only')
    try {
      await applied(production, baseBundle)
      await applied(production, hotBundle)
    } finally {
      w.setRules('all')
    }

    const seen = await hotfixesWithoutEvidence(deps(), production.record)
    expect(seen).toMatchObject({
      evidenceTargetId: staging.record.targetId,
      items: [{ migrationId: hot, name: 'hotfix-col', evidence: 'missing' }],
    })
    // Staging is not compared with anything: it has no evidence environment.
    expect(await hotfixesWithoutEvidence(deps(), staging.record)).toBeUndefined()

    // The documented resolution: the same migration (same id and checksum) applied and verified on staging.
    const back = await w.apply(await w.plan(staging, { migrationIds: [hot as never] }))
    expect(back).toMatchObject({ state: 'succeeded', verificationOutcome: 'passed' })
    expect(await hotfixesWithoutEvidence(deps(), production.record)).toMatchObject({
      evidenceTargetId: staging.record.targetId,
      items: [],
    })
  })

  it('counts a migration staging applied without a passed verification as no evidence', async () => {
    const staging = await w.registerTarget('hf-u-stg', 'nonprod')
    const production = await w.registerTarget('hf-u-prd', 'prod', 'hf-u-stg')
    const bundle = w.bundle({
      name: 'unverified',
      up: 'CREATE TABLE public.unverified (id int);\n',
      verify: '-- check: always fails\nSELECT false AS ok;\n',
    })
    const failed = await w.apply(await w.plan(staging, { bundles: [bundle] }))
    expect(failed).toMatchObject({ state: 'verification_failed' })
    w.setRules('registry-only')
    try {
      await w.apply(await w.plan(production, { bundles: [bundle] }))
    } finally {
      w.setRules('all')
    }
    const seen = await hotfixesWithoutEvidence(deps(), production.record)
    expect(seen?.items).toMatchObject([{ name: 'unverified', evidence: 'unverified' }])
  })
})

describe('E18: a migration removed from the source after it was applied (applied_not_in_source)', () => {
  it('names the applied migration a complete source omits, and nothing for the full set', async () => {
    const t = await w.registerTarget('src-a', 'nonprod')
    const x = w.ulid()
    const xBundle = w.bundle({ id: x, name: 'applied-x', up: 'CREATE TABLE public.x (id int);\n' })
    await applied(t, xBundle)
    const yBundle = w.bundle({
      name: 'later-y',
      up: 'CREATE TABLE public.y (id int);\n',
      dependsOn: [x],
    })
    expect(await appliedNotInSource(w.h.serve, t.record, [yBundle])).toEqual([
      { migrationId: x, name: 'applied-x' },
    ])
    expect(await appliedNotInSource(w.h.serve, t.record, [xBundle, yBundle])).toEqual([])
  })

  it('does not count a reverted migration: its row stays, the bundle may go', async () => {
    const t = await w.registerTarget('src-b', 'nonprod')
    const x = w.ulid()
    const xBundle = w.bundle({
      id: x,
      name: 'reverted-x',
      up: 'CREATE TABLE public.rx (id int);\n',
      down: 'DROP TABLE public.rx;\n',
    })
    await applied(t, xBundle)
    const rolled = await w.apply(
      await w.h.serve.transaction('test.hotfix.rollback', (tx) =>
        planMigrationRollback(tx, w.ctx, w.a, t.record.targetId, x),
      ),
    )
    expect(rolled).toMatchObject({ state: 'succeeded' })
    expect(await appliedNotInSource(w.h.serve, t.record, [])).toEqual([])
  })
})
