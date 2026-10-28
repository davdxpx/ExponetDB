import { afterAll, beforeAll, describe, it } from 'vitest'
import { ingestBundles, planMigrationResume, planMigrationVerify } from '../src/index.ts'
import { attempt, planFacts, planRules, rec, server, su } from './tc-util.ts'
import { DEFAULTS, migrationWorld, type Target, type World } from './tc-world.ts'

let w: World
let s: Target
let p: Target

beforeAll(async () => {
  w = await migrationWorld('tc_mig_cs6', server)
  s = await w.registerTarget('tc6s', 'nonprod')
  p = await w.registerTarget('tc6p', 'prod', 'tc6s')
}, 300_000)

afterAll(async () => {
  await w?.close()
})

const ruleLine = (pl: { body: Record<string, unknown> }, ids: string[]) =>
  planRules(pl).filter((r) => ids.includes(r.id)).map((r) => `${r.id}=${r.result}`)

describe('(a)(b) on production: dependents of a failed verification, evidence bound to the verify digest', () => {
  it('prod dependents are blocked by migration.dependencies-verified', async () => {
    const base = w.ulid()
    const x = w.ulid()
    const baseB = w.bundle({ id: base, name: 'items', up: 'CREATE TABLE public.items (id int PRIMARY KEY);\n' })
    const xB = w.bundle({
      id: x, name: 'needs-rows', up: 'CREATE TABLE public.nr (id int);\n', dependsOn: [base],
      verify: '-- check: has a row\nSELECT count(*) > 0 AS ok FROM public.nr;\n',
    })
    w.setRules('registry-only')
    const pb = await w.apply(await w.plan(p, { bundles: [baseB] }))
    const px = await w.apply(await w.plan(p, { bundles: [xB] }))
    w.setRules('all')
    rec('a', 'a6.prod_setup', 'info', { base: pb.state, x: px.state, xVerification: px.verificationOutcome })
    const z = w.bundle({ name: 'on-top-of-failed', up: 'CREATE TABLE public.ontop (id int);\n', dependsOn: [x] })
    const pl = await attempt(() => w.plan(p, { bundles: [z] }))
    rec('a', 'a6.prod_dependent_plan', pl.ok && ruleLine(pl.value, ['migration.dependencies-verified']).some((l) => l.endsWith('fail')) ? 'PASS' : 'FAIL', pl.ok ? {
      decision: pl.value.decision, dependenciesVerified: planFacts(pl.value)['dependenciesVerified'],
      rules: ruleLine(pl.value, ['migration.dependencies-verified', 'migration.staging-evidence', 'migration.production-approval']),
    } : pl)
  }, 300_000)

  it('evidence follows the verify digest, not only the apply checksum', async () => {
    const base = w.ulid()
    const wId = w.ulid()
    const baseB = w.bundle({ id: base, name: 'items2', up: 'CREATE TABLE public.items2 (id int PRIMARY KEY);\n' })
    const spec = (verify: string) => ({
      id: wId, name: 'wide', up: 'CREATE TABLE public.wide (id int);\n', dependsOn: [base], verify,
    })
    const failing = '-- check: has a row\nSELECT count(*) > 0 AS ok FROM public.wide;\n'
    const fixed = '-- check: readable\nSELECT count(*) >= 0 AS ok FROM public.wide;\n'
    w.setRules('registry-only')
    await w.apply(await w.plan(p, { bundles: [baseB] }))
    w.setRules('all')
    await w.apply(await w.plan(s, { bundles: [baseB] }))
    const sa = await w.apply(await w.plan(s, { bundles: [w.bundle(spec(failing))] }))
    rec('b', 'b5.staging_verification', 'info', { state: sa.state, ver: sa.verificationOutcome })
    // production plan with the failing verify.sql: evidence unverified
    const prodFailing = await attempt(() => w.plan(p, { bundles: [w.bundle(spec(failing))] }))
    rec('b', 'b5.prod_plan_while_staging_failed', 'info', prodFailing.ok ? { evidence: planFacts(prodFailing.value)['evidence'], rules: ruleLine(prodFailing.value, ['migration.staging-evidence']) } : prodFailing)
    // fix: verify revision on staging, then migration.verify there
    const rev = await w.h.serve.transaction('tc.ingest', (tx) =>
      ingestBundles(tx, { projectId: s.record.projectId, bundles: [w.bundle(spec(fixed))], defaults: DEFAULTS, identityId: w.a.identityId }),
    )
    const verifyPlan = await w.h.serve.transaction('tc.vp', (tx) => planMigrationVerify(tx, w.ctx, w.a, s.record.targetId, wId, { revision: rev[0]?.revision.revision }))
    const vo = await w.apply(verifyPlan)
    rec('b', 'b5.staging_reverify_fixed', 'info', { state: vo.state, ver: vo.verificationOutcome, revision: rev[0]?.revision.revision })
    // production, by id: newest revision (fixed digest) -> evidence present
    const byId = await attempt(() => w.plan(p, { migrationIds: [wId as never] }))
    rec('b', 'b5.prod_plan_by_id_newest_revision', byId.ok && planFacts(byId.value)['evidence'] === 'present' ? 'PASS' : 'info', byId.ok ? { evidence: planFacts(byId.value)['evidence'], decision: byId.value.decision } : byId)
    // production, submitting the ORIGINAL verify.sql: stored revision 1 -> its digest differs from the one that passed
    const orig = await attempt(() => w.plan(p, { bundles: [w.bundle(spec(failing))] }))
    rec('b', 'b5.prod_plan_with_original_verify_digest', orig.ok && planFacts(orig.value)['evidence'] === 'other_verify_digest' ? 'PASS' : 'info', orig.ok ? {
      evidence: planFacts(orig.value)['evidence'], decision: orig.value.decision,
      content: JSON.stringify((orig.value.body['content'] as { migrations: { revision: number; verifyDigest: string }[] }).migrations.map((m) => ({ rev: m.revision, d: m.verifyDigest?.slice(-8) }))),
    } : orig)
    // staging re-verified with the OLD failing revision: latest run fails, evidence flips to unverified
    const oldPlan = await w.h.serve.transaction('tc.vp1', (tx) => planMigrationVerify(tx, w.ctx, w.a, s.record.targetId, wId, { revision: 1 }))
    const oo = await w.apply(oldPlan)
    const flipped = await attempt(() => w.plan(p, { migrationIds: [wId as never] }))
    rec('b', 'b5.evidence_after_old_revision_reverify', 'info', { staging: oo.verificationOutcome, evidence: flipped.ok ? planFacts(flipped.value)['evidence'] : flipped })
  }, 300_000)
})

describe('(i) which planners check the ledger against the mirror', () => {
  it('resume planner on a tampered ledger', async () => {
    const t = await w.registerTarget('tc6i', 'nonprod')
    const root = w.ulid()
    await w.apply(await w.plan(t, { bundles: [w.bundle({ id: root, name: 'root', up: 'CREATE TABLE public.root (id int);\n' })] }))
    await su(t, async (c) => {
      await c.query('BEGIN')
      await c.query('SET LOCAL session_replication_role = replica')
      await c.query("INSERT INTO exponetdb.migration_events (migration_id, operation_id, event) VALUES ($1, 'op_01M4R2T03VG6F43SEKX6F5ST5G', 'nontx_started')", ['01M4R2T03VG6F43SEKX6F5ST5X'])
      await c.query('COMMIT')
    }).catch((e) => rec('i', 'i.hand_event', 'ERROR', { m: String(e).slice(0, 200) }))
    const apply = await attempt(() => w.plan(t, { bundles: [w.bundle({ name: 'after-hand-event', up: 'CREATE TABLE public.hev (id int);\n', dependsOn: [root] })] }))
    rec('i', 'i.hand_written_nontx_started_event', apply.ok ? 'UNDETECTED-by-divergence' : 'blocked', apply.ok ? {} : apply)
    const r = await attempt(() => w.h.serve.transaction('tc.resume', (tx) => planMigrationResume(tx, w.ctx, w.a, t.record.targetId, '01M4R2T03VG6F43SEKX6F5ST5X', {})))
    rec('i', 'i.resume_planner_on_hand_event', 'info', r.ok ? { decision: r.value.decision } : r)
  }, 300_000)
})
