import { runAsSuperuser, serverFor } from '@exponetdb/testkit'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  compareSource,
  hotfixesWithoutEvidence,
  planMigrationApply,
  planMigrationRollback,
} from '../src/index.ts'
import { DEFAULTS, migrationWorld, type Target, type World } from './world.ts'

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
      kind: 'compared',
      evidenceTargetId: staging.record.targetId,
      evidenceDivergent: false,
      items: [{ migrationId: hot, name: 'hotfix-col', evidence: 'missing' }],
    })
    // Staging is not compared with anything: it has no evidence environment.
    expect(await hotfixesWithoutEvidence(deps(), staging.record)).toBeUndefined()

    // The documented resolution: the same migration (same id and checksum) applied and verified on staging.
    const back = await w.apply(await w.plan(staging, { migrationIds: [hot as never] }))
    expect(back).toMatchObject({ state: 'succeeded', verificationOutcome: 'passed' })
    expect(await hotfixesWithoutEvidence(deps(), production.record)).toMatchObject({
      kind: 'compared',
      evidenceTargetId: staging.record.targetId,
      items: [],
    })
    // A production target without an evidence environment cannot be compared, which is said.
    const alone = await w.registerTarget('hf-alone', 'prod')
    expect(await hotfixesWithoutEvidence(deps(), alone.record)).toEqual({
      kind: 'not_comparable',
      reason: 'no_evidence_environment',
    })
  })

  it('says that the evidence target diverges instead of calling every migration missing', async () => {
    const staging = await w.registerTarget('hf-d-stg', 'nonprod')
    const production = await w.registerTarget('hf-d-prd', 'prod', 'hf-d-stg')
    const bundle = w.bundle({ name: 'shared', up: 'CREATE TABLE public.shared (id int);\n' })
    await applied(staging, bundle)
    w.setRules('registry-only')
    try {
      await applied(production, bundle)
    } finally {
      w.setRules('all')
    }
    expect(await hotfixesWithoutEvidence(deps(), production.record)).toMatchObject({
      evidenceDivergent: false,
      items: [],
    })
    // A ledger row written by hand on staging: its mirror disagrees, no row there is evidence.
    await runAsSuperuser(pg17, staging.database, [
      `BEGIN; SET LOCAL session_replication_role = replica;
       CREATE TEMP TABLE hand ON COMMIT DROP AS SELECT * FROM exponetdb.schema_migrations;
       UPDATE hand SET migration_id = '${w.ulid()}', applied_seq = 99999;
       INSERT INTO exponetdb.schema_migrations OVERRIDING SYSTEM VALUE SELECT * FROM hand; COMMIT`,
    ])
    expect(await hotfixesWithoutEvidence(deps(), production.record)).toMatchObject({
      kind: 'compared',
      evidenceDivergent: true,
      items: [{ name: 'shared', evidence: 'missing' }],
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
    expect(await hotfixesWithoutEvidence(deps(), production.record)).toMatchObject({
      items: [{ name: 'unverified', evidence: 'unverified' }],
    })
  })
})

describe('E18: a migration removed from the source after it was applied (applied_not_in_source)', () => {
  it('splits the applied migrations a source lacks into older and newer than its newest bundle', async () => {
    const t = await w.registerTarget('src-a', 'nonprod')
    const x = w.ulid()
    const xBundle = w.bundle({ id: x, name: 'applied-x', up: 'CREATE TABLE public.x (id int);\n' })
    await applied(t, xBundle)
    const y = w.ulid()
    const yBundle = w.bundle({
      id: y,
      name: 'later-y',
      up: 'CREATE TABLE public.y (id int);\n',
      dependsOn: [x],
    })
    await applied(t, yBundle)
    const z = w.ulid()
    // A source of y and a new z lacks x, older than its newest bundle: x is missing from it.
    expect(await compareSource(w.h.serve, t.record, [y, z])).toEqual({
      newestId: z,
      older: [{ migrationId: x, name: 'applied-x' }],
      newer: [],
    })
    // A source whose newest bundle is x lacks y, which is newer: the clone is behind, not missing it.
    expect(await compareSource(w.h.serve, t.record, [x])).toEqual({
      newestId: x,
      older: [],
      newer: [{ migrationId: y, name: 'later-y' }],
    })
    expect(await compareSource(w.h.serve, t.record, [x, y])).toMatchObject({ older: [], newer: [] })
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
    expect(await compareSource(w.h.serve, t.record, [w.ulid()])).toMatchObject({
      older: [],
      newer: [],
    })
  })

  const planWith = (t: Target, request: Record<string, unknown>, seen: string[][]) =>
    w.h.serve.transaction('test.source.plan', (tx) =>
      planMigrationApply(
        tx,
        {
          ...w.ctx,
          onSourceValidated: (ids: readonly string[]) => {
            seen.push([...ids])
          },
        },
        w.a,
        t.record.targetId,
        { defaults: DEFAULTS, lintProfile: 'standard', sourceComplete: true, ...request } as never,
      ),
    )

  it('hands over the ids of a whole source only after ingest validated it, and shows a source that is behind in the plan', async () => {
    const t = await w.registerTarget('src-c', 'nonprod')
    const early = w.ulid()
    const x = w.ulid()
    const xBundle = w.bundle({ id: x, name: 'applied-x', up: 'CREATE TABLE public.cx (id int);\n' })
    await applied(t, xBundle)
    const seen: string[][] = []
    // A directory that does not name its manifest's id is refused before anything is handed over.
    const forged = { ...xBundle, directory: `${w.ulid()}_applied-x` }
    await expect(planWith(t, { bundles: [forged] }, seen)).rejects.toMatchObject({
      code: 'MIGRATION_BUNDLE_INVALID',
    })
    expect(seen).toEqual([])
    // An older pending bundle without x: the source is behind x, the plan says so.
    const pending = w.bundle({
      id: early,
      name: 'early',
      up: 'CREATE TABLE public.early (id int);\n',
    })
    const plan = await planWith(t, { bundles: [pending] }, seen)
    expect(seen).toEqual([[early]])
    expect(plan.body['analysis']).toMatchObject({
      sourceCheck: { newestId: early, appliedNotInSource: [], behind: [x] },
    })
  })
})
