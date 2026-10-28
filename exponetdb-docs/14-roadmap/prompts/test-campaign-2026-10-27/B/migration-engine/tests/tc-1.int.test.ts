import { randomBytes } from 'node:crypto'
import { type MigrationId, newId } from '@exponetdb/kernel'
import { requestVerificationRetry } from '@exponetdb/operations'
import { afterAll, beforeAll, describe, it } from 'vitest'
import {
  DEFERRED_TRIGGER_ROUNDS,
  ingestBundles,
  planMigrationApply,
  planMigrationResume,
  planMigrationRollback,
  planMigrationVerify,
  readProgress,
} from '../src/index.ts'
import {
  attempt,
  eventsOf,
  hasRelation,
  ledgerOf,
  opCode,
  opLocks,
  opSteps,
  planFacts,
  planRules,
  rec,
  server,
  sleep,
  su,
  tamper,
  verifsOf,
} from './tc-util.ts'
import { DEFAULTS, migrationWorld, type Target, type World } from './tc-world.ts'

let w: World
let tA: Target
let base = '' as MigrationId

const verifyPlan = (t: Target, id: string, revision?: number) =>
  w.h.serve.transaction('tc.verify.plan', (tx) =>
    planMigrationVerify(tx, w.ctx, w.a, t.record.targetId, id, { revision }),
  )
const rollbackPlan = (t: Target, id: string) =>
  w.h.serve.transaction('tc.rollback.plan', (tx) =>
    planMigrationRollback(tx, w.ctx, w.a, t.record.targetId, id),
  )
const resumePlan = (t: Target, id: string) =>
  w.h.serve.transaction('tc.resume.plan', (tx) =>
    planMigrationResume(tx, w.ctx, w.a, t.record.targetId, id, {}),
  )

async function baseOn(t: Target): Promise<MigrationId> {
  const id = w.ulid()
  const op = await w.apply(
    await w.plan(t, {
      bundles: [w.bundle({ id, name: 'items', up: 'CREATE TABLE public.items (id int PRIMARY KEY);\n' })],
    }),
  )
  if (op.state !== 'succeeded') throw new Error(`base not applied: ${op.state}`)
  return id
}

beforeAll(async () => {
  w = await migrationWorld('tc_mig_cs1', server)
  tA = await w.registerTarget('tc1a', 'nonprod')
  base = await baseOn(tA)
}, 300_000)

afterAll(async () => {
  await w?.close()
})

describe('(a)+(b) a failing verify.sql after a successful apply, and its revision', () => {
  const id = () => idA
  let idA = '' as MigrationId
  const verify0 = '-- check: the table has a row\nSELECT count(*) > 0 AS ok FROM public.vf_t;\n'
  const spec = (verify: string, up = 'CREATE TABLE public.vf_t (id int);\n') => ({
    id: idA,
    name: 'needs-rows',
    up,
    verify,
    down: 'DROP TABLE public.vf_t;\n',
    dependsOn: [base],
  })

  it('(a) applied+verification_failed, no retry, no rollback, ledger stays, second plan', async () => {
    idA = w.ulid()
    const op = await w.apply(await w.plan(tA, { bundles: [w.bundle(spec(verify0))] }))
    const progress = await readProgress(w.h.worker, op.operationId)
    rec('a', 'a1.outcome', 'info', {
      state: op.state,
      applyOutcome: op.applyOutcome,
      verificationOutcome: op.verificationOutcome,
      progress: progress.map((p) => ({
        id: p.migrationId,
        apply: p.applyOutcome,
        ver: p.verificationOutcome,
        code: p.errorCode,
      })),
    })
    const snap = async () => ({
      op: (await w.operation(op.operationId)).state,
      steps: await opSteps(w, op.operationId),
      ledger: (await ledgerOf(w, tA)).filter((r) => r.migrationId === id()).map((r) => ({
        reverted: r.revertedAt,
        op: r.operationId,
        seq: String(r.appliedSeq),
      })),
      events: (await eventsOf(w, tA, id())).map((e) => e.event),
      verifs: (await verifsOf(w, tA, id())).map((v) => [v.status, v.verifyDigest]),
      table: await hasRelation(tA, 'public.vf_t'),
      progress: (await readProgress(w.h.worker, op.operationId)).map((p) => [p.applyOutcome, p.verificationOutcome]),
    })
    const before = await snap()
    await w.drive()
    await sleep(4000)
    await w.drive()
    const after = await snap()
    rec('a', 'a2.no_retry_no_rollback', JSON.stringify(before) === JSON.stringify(after) ? 'PASS' : 'FAIL', {
      before,
      after,
      expected: 'identical: one applied event, one failed verification, table present, no reverted event',
      downNeverRan: after.table === true && !after.events.includes('reverted'),
      orderedLocksHeldByOp: await opLocks(w, op.operationId),
    })
    // The documented state: applied + failed; domain held? (verification_failed is final)
    rec('a', 'a2.operation_state', op.state === 'verification_failed' && op.applyOutcome === 'applied' ? 'PASS' : 'FAIL', {
      state: op.state,
      apply: op.applyOutcome,
      verification: op.verificationOutcome,
    })

    // a second plan for the same migration
    const byId = await attempt(() => w.plan(tA, { migrationIds: [id() as never] }))
    rec('a', 'a3.second_plan_by_id', byId.ok ? 'FAIL' : byId.code === 'MIGRATION_ALREADY_APPLIED' ? 'PASS' : 'FAIL', byId)
    const byBundle = await attempt(() => w.plan(tA, { bundles: [w.bundle(spec(verify0))] }))
    rec('a', 'a3.second_plan_same_bundle', byBundle.ok ? 'FAIL' : byBundle.code === 'MIGRATION_ALREADY_APPLIED' ? 'PASS' : 'FAIL', byBundle)

    // a dependent on top of a failed verification: nonprod
    const dep = w.ulid()
    const depPlan = await attempt(() =>
      w.plan(tA, {
        bundles: [w.bundle({ id: dep, name: 'on-top', up: 'CREATE TABLE public.on_top (id int);\n', dependsOn: [id()] })],
      }),
    )
    if (depPlan.ok) {
      rec('a', 'a4.dependent_plan_nonprod', 'info', {
        decision: depPlan.value.decision,
        rules: planRules(depPlan.value).filter((r) => r.result !== 'pass' && r.result !== 'not_applicable'),
        dependenciesVerified: planFacts(depPlan.value)['dependenciesVerified'],
      })
      const depOp = await w.apply(depPlan.value)
      rec('a', 'a4.dependent_apply_nonprod', 'info', { state: depOp.state, apply: depOp.applyOutcome })
    } else rec('a', 'a4.dependent_plan_nonprod', 'info', depPlan)

    // retry-verification on a final verification_failed operation
    const ver = (await import('../../application/src/views.ts')) as { verificationRetryable: (o: unknown) => boolean }
    const row = await w.operation(op.operationId)
    rec('a', 'a5.retry_verification_rule', ver.verificationRetryable({
      kind: row.kind, state: row.state, applyOutcome: row.applyOutcome, verificationOutcome: row.verificationOutcome,
    }) ? 'FAIL' : 'PASS', { kind: row.kind, state: row.state, note: 'application.ts:2046-2056 raises OPERATION_NOT_RETRYABLE' })
    // a raw request (bypassing the use case) must not make the worker re-run anything
    const operator = newId('idn', Date.now())
    await w.h.db.asSuperuser(async (c) => {
      await c.query(
        `INSERT INTO auth.identities (identity_id, kind, state, email, email_normalized, webauthn_user_handle)
         VALUES ($1, 'human', 'invited', 'op-tc1@example.test', 'op-tc1@example.test', $2)`,
        [operator, randomBytes(32)],
      )
    })
    await w.h.serve.transaction('tc.retry', (tx) => requestVerificationRetry(tx, op.operationId, operator))
    await w.drive()
    const afterRaw = await snap()
    rec('a', 'a5.raw_retry_request_ignored', JSON.stringify(afterRaw) === JSON.stringify(before) ? 'PASS' : 'INFO-CHANGED', { afterRaw })
  }, 300_000)

  it('(b) verify revision: comment-only vs executable, checksum binding', async () => {
    const proj = tA.record.projectId
    const ingest = (b: ReturnType<World['bundle']>) =>
      w.h.serve.transaction('tc.ingest', (tx) =>
        ingestBundles(tx, { projectId: proj, bundles: [b], defaults: DEFAULTS, identityId: w.a.identityId }),
      )
    const baseline = await ingest(w.bundle(spec(verify0)))
    const d0 = baseline[0]?.revision.verifyDigest
    const checksum = baseline[0]?.revision.checksum
    rec('b', 'b0.original', 'info', { status: baseline[0]?.status, revision: baseline[0]?.revision.revision, d0, checksum })

    // 1. comment-only verify.sql edit
    const comment = await ingest(w.bundle(spec(`${verify0}-- reviewed again\n`)))
    const d1 = comment[0]?.revision.verifyDigest
    rec('b', 'b1.comment_only_verify_edit', comment[0]?.status === 'verify_revision' && d1 !== d0 ? 'PASS' : 'FAIL', {
      status: comment[0]?.status, revision: comment[0]?.revision.revision, d0, d1,
      sameApplyChecksum: comment[0]?.revision.checksum === checksum,
      doc: 'verification.md: the verify digest changes with any edit, comment or directive included',
    })
    const p1 = await attempt(() => verifyPlan(tA, id()))
    let ran1: unknown = null
    if (p1.ok) {
      const content = p1.value.body['content'] as { revision: number; verifyDigest: string }
      const o = await w.apply(p1.value)
      ran1 = { usedRevision: content.revision, usedDigest: content.verifyDigest, state: o.state, ver: o.verificationOutcome }
    }
    rec('b', 'b1.reverify_with_comment_revision', 'info', { plan: p1.ok ? 'ok' : p1, ran1 })

    // 2. executable fix of verify.sql
    const fixed = await ingest(w.bundle(spec('-- check: the table is readable\nSELECT count(*) >= 0 AS ok FROM public.vf_t;\n')))
    const d2 = fixed[0]?.revision.verifyDigest
    const rev2 = fixed[0]?.revision.revision
    rec('b', 'b2.executable_verify_fix', fixed[0]?.status === 'verify_revision' ? 'PASS' : 'FAIL', { status: fixed[0]?.status, rev2, d2 })
    const p2 = await attempt(() => verifyPlan(tA, id(), rev2))
    let ran2: unknown = null
    if (p2.ok) {
      const o = await w.apply(p2.value)
      ran2 = { state: o.state, apply: o.applyOutcome, ver: o.verificationOutcome, kind: o.kind }
    }
    const runs = (await verifsOf(w, tA, id())).map((v) => ({ status: v.status, digest: v.verifyDigest, op: v.operationId }))
    const origOp = (await ledgerOf(w, tA)).find((r) => r.migrationId === id())
    rec('b', 'b2.reverify_after_fix', ran2 !== null ? 'PASS' : 'FAIL', {
      ran2, runs, ledgerChecksumUnchanged: origOp?.checksum === checksum,
      originalOperationState: (await w.operation(origOp?.operationId ?? '')).state,
    })

    // 3. up.sql: executable change -> refused; comment-only change -> ?
    const execUp = await attempt(() => ingest(w.bundle(spec(verify0, 'CREATE TABLE public.vf_t (id int, more int);\n'))))
    rec('b', 'b3.executable_up_change', !execUp.ok && execUp.code === 'MIGRATION_CHECKSUM_MISMATCH' ? 'PASS' : 'FAIL', execUp.ok ? { status: execUp.value[0]?.status } : execUp)
    const commentUp = await attempt(() => ingest(w.bundle(spec(verify0, '-- a comment added later\nCREATE TABLE public.vf_t (id int);\n'))))
    rec('b', 'b3.comment_only_up_change', 'info', commentUp.ok
      ? { status: commentUp.value[0]?.status, sameChecksum: commentUp.value[0]?.revision.checksum === checksum,
          newBundleDigest: commentUp.value[0]?.revision.bundleDigest, sourceDigest: commentUp.value[0]?.revision.sourceDigest }
      : commentUp)

    // 4. a revision number that does not exist / re-verify with the OLD failing revision after the fix
    const oldRev = await attempt(() => verifyPlan(tA, id(), 1))
    rec('b', 'b4.reverify_with_older_failing_revision', 'info', oldRev.ok ? { allowed: true, note: 'any stored revision of the applied checksum may be chosen' } : oldRev)
    const ghost = await attempt(() => verifyPlan(tA, id(), 99))
    rec('b', 'b4.reverify_nonexistent_revision', !ghost.ok && ghost.code === 'NOT_FOUND' ? 'PASS' : 'FAIL', ghost.ok ? {} : ghost)
  }, 300_000)
})

describe('(f) rollback plans', () => {
  let tF: Target
  let b0 = '' as MigrationId
  it('latest only, never automatic, unverified, no down.sql', async () => {
    tF = await w.registerTarget('tc1f', 'nonprod')
    b0 = await baseOn(tF)
    const mk = (name: string, down: boolean, verify?: string) => {
      const id = w.ulid()
      return {
        id,
        bundle: w.bundle({
          id, name, up: `CREATE TABLE public.${name.replace(/-/g, '_')} (id int);\n`,
          ...(down ? { down: `DROP TABLE public.${name.replace(/-/g, '_')};\n` } : {}),
          ...(verify === undefined ? {} : { verify }),
          dependsOn: [b0],
        }),
      }
    }
    const m1 = mk('rb-one', true)
    const m2 = mk('rb-two', true)
    const m3 = mk('rb-three-nodown', false)
    for (const m of [m1, m2, m3]) {
      const o = await w.apply(await w.plan(tF, { bundles: [m.bundle] }))
      if (o.state !== 'succeeded') throw new Error(`setup ${m.id}`)
    }
    const r1 = await attempt(() => rollbackPlan(tF, m1.id))
    rec('f', 'f1.non_latest', !r1.ok && r1.code === 'MIGRATION_ROLLBACK_BLOCKED' && (r1.details as { reason?: string })?.reason === 'not_latest' ? 'PASS' : 'FAIL', r1.ok ? {} : r1)
    const r3 = await attempt(() => rollbackPlan(tF, m3.id))
    rec('f', 'f2.no_down_sql', !r3.ok && (r3.details as { reason?: string })?.reason === 'no_down_sql' ? 'PASS' : 'FAIL', r3.ok ? {} : r3)
    const rb = await attempt(() => rollbackPlan(tF, b0))
    rec('f', 'f3.dependents_applied', !rb.ok && (rb.details as { reason?: string })?.reason === 'dependents_applied' ? 'PASS' : 'FAIL', rb.ok ? {} : rb)

    // an unverified (verification failed) latest migration may be rolled back, only by an explicit plan
    const m4 = mk('rb-four-unverified', true, '-- check: has a row\nSELECT count(*) > 0 AS ok FROM public.rb_four_unverified;\n')
    const o4 = await w.apply(await w.plan(tF, { bundles: [m4.bundle] }))
    const tableAfterApply = await hasRelation(tF, 'public.rb_four_unverified')
    await w.drive()
    await sleep(2000)
    await w.drive()
    const stillThere = await hasRelation(tF, 'public.rb_four_unverified')
    rec('f', 'f4.failed_verification_is_not_rolled_back', o4.state === 'verification_failed' && tableAfterApply && stillThere ? 'PASS' : 'FAIL', { state: o4.state, tableAfterApply, stillThere })
    const p4 = await attempt(() => rollbackPlan(tF, m4.id))
    if (p4.ok) {
      rec('f', 'f4.rollback_plan_of_unverified', 'info', { kind: p4.value.kind, decision: p4.value.decision, failing: planRules(p4.value).filter((r) => r.result === 'fail') })
      // a stale second plan: plan twice, apply the first, accept the second
      const pDup = await rollbackPlan(tF, m4.id)
      const ro = await w.apply(p4.value)
      const dup = await attempt(() => w.accept(pDup))
      rec('f', 'f4.rollback_applied', ro.state === 'succeeded' ? 'PASS' : 'FAIL', {
        state: ro.state, apply: ro.applyOutcome, ver: ro.verificationOutcome, table: await hasRelation(tF, 'public.rb_four_unverified'),
        events: (await eventsOf(w, tF, m4.id)).map((e) => e.event),
        secondPlanAccept: dup.ok ? 'accepted' : dup.code,
      })
      const again = await attempt(() => w.plan(tF, { migrationIds: [m4.id as never] }))
      rec('f', 'f4.reapply_reverted', !again.ok && again.code === 'MIGRATION_REVERTED' ? 'PASS' : 'FAIL', again.ok ? {} : again)
    } else rec('f', 'f4.rollback_plan_of_unverified', 'FAIL', p4)

    // out-of-band DDL then rollback plan
    const m5 = mk('rb-five', true)
    await w.apply(await w.plan(tF, { bundles: [m5.bundle] }))
    await su(tF, (c) => c.query('CREATE TABLE public.oob_after_m5 (id int)'))
    const p5 = await attempt(() => rollbackPlan(tF, m5.id))
    rec('f', 'f5.rollback_after_oob_ddl', !p5.ok && p5.code === 'SCHEMA_FINGERPRINT_MISMATCH' ? 'PASS' : 'FAIL', p5.ok ? {} : p5)
    await su(tF, (c) => c.query('DROP TABLE public.oob_after_m5'))
  }, 400_000)
})

describe('(j) dependsOn an unknown id', () => {
  it('returns MIGRATION_DEPENDENCY_UNKNOWN with which details', async () => {
    const ghost = w.ulid()
    const r = await attempt(() =>
      w.plan(tA, { bundles: [w.bundle({ name: 'orphan-dep', up: 'CREATE TABLE public.orphan_dep (id int);\n', dependsOn: [ghost] })] }),
    )
    rec('j', 'j1.unknown_dependency', !r.ok && r.code === 'MIGRATION_DEPENDENCY_UNKNOWN' && r.details === undefined ? 'CONFIRMED-NO-ID' : 'OTHER', { ghost, result: r.ok ? 'plan created' : r })
    const two = [w.ulid(), w.ulid()]
    const r2 = await attempt(() =>
      w.plan(tA, { bundles: [w.bundle({ name: 'orphan-dep2', up: 'CREATE TABLE public.orphan_dep2 (id int);\n', dependsOn: two })] }),
    )
    rec('j', 'j2.two_unknown_dependencies', 'info', { ghosts: two, result: r2.ok ? 'plan created' : r2 })
  }, 120_000)
})

describe('(i) ledger integrity', () => {
  let tI: Target
  let root = '' as MigrationId
  let dependentSpec: () => ReturnType<World['bundle']>
  it('tamper and delete: which planner notices', async () => {
    tI = await w.registerTarget('tc1i', 'nonprod')
    root = w.ulid()
    const op = await w.apply(await w.plan(tI, {
      bundles: [w.bundle({ id: root, name: 'root', up: 'CREATE TABLE public.root (id int);\n', down: 'DROP TABLE public.root;\n', verify: '-- check: readable\nSELECT count(*) >= 0 AS ok FROM public.root;\n' })],
    }))
    if (op.state !== 'succeeded') throw new Error('setup root')
    dependentSpec = () => w.bundle({ id: w.ulid(), name: 'dependent', up: 'CREATE TABLE public.dependent (id int);\n', dependsOn: [root] })
    const row0 = (await ledgerOf(w, tI)).find((r) => r.migrationId === root)
    const planners = async (label: string) => {
      const out: Record<string, unknown> = {}
      const a = await attempt(() => w.plan(tI, { bundles: [dependentSpec()] }))
      out['apply'] = a.ok ? 'PLAN CREATED' : a.code
      const v = await attempt(() => verifyPlan(tI, root))
      out['verify'] = v.ok ? 'PLAN CREATED' : v.code
      const r = await attempt(() => rollbackPlan(tI, root))
      out['rollback'] = r.ok ? 'PLAN CREATED' : `${r.code}${r.details ? JSON.stringify(r.details) : ''}`
      rec('i', `i.${label}`, 'info', out)
      return out
    }
    await planners('baseline_no_tamper')
    // 1. checksum changed
    await tamper(tI, 'UPDATE exponetdb.schema_migrations SET checksum = $2 WHERE migration_id = $1', [root, `sha256:c1:${'0'.repeat(64)}`])
    await planners('checksum_tampered')
    await tamper(tI, 'UPDATE exponetdb.schema_migrations SET checksum = $2 WHERE migration_id = $1', [root, row0?.checksum])
    // 2. reverted_at set by hand (not compared by compareLedger)
    await tamper(tI, "UPDATE exponetdb.schema_migrations SET reverted_at = now(), reverted_by_op = $2 WHERE migration_id = $1", [root, row0?.operationId])
    const o2 = await planners('reverted_at_set_by_hand')
    await tamper(tI, 'UPDATE exponetdb.schema_migrations SET reverted_at = NULL, reverted_by_op = NULL WHERE migration_id = $1', [root])
    rec('i', 'i.reverted_at_detection', o2['apply'] === 'LEDGER_DIVERGENCE' ? 'PASS' : 'FAIL', { applyPlannerCode: o2['apply'], expected: 'LEDGER_DIVERGENCE (a row changed by hand)', ledger: 'divergence.ts:35-46 compares only checksum and operation_id' })
    // 3. fingerprint_after changed
    await tamper(tI, "UPDATE exponetdb.schema_migrations SET fingerprint_after = 'fp1:18:' || repeat('0', 64) WHERE migration_id = $1", [root])
    const o3 = await planners('fingerprint_after_tampered')
    await tamper(tI, 'UPDATE exponetdb.schema_migrations SET fingerprint_after = $2 WHERE migration_id = $1', [root, row0?.fingerprintAfter])
    rec('i', 'i.fingerprint_after_detection', o3['apply'] === 'LEDGER_DIVERGENCE' ? 'PASS' : 'FAIL', { applyPlannerCode: o3['apply'] })
    // 4. row deleted
    await su(tI, async (c) => {
      await c.query('BEGIN')
      await c.query('SET LOCAL session_replication_role = replica')
      await c.query('CREATE TEMP TABLE kept AS SELECT * FROM exponetdb.schema_migrations WHERE migration_id = $1', [root])
      await c.query('DELETE FROM exponetdb.schema_migrations WHERE migration_id = $1', [root])
      await c.query('COMMIT')
      await planners('row_deleted')
      await c.query('BEGIN')
      await c.query('SET LOCAL session_replication_role = replica')
      await c.query('INSERT INTO exponetdb.schema_migrations OVERRIDING SYSTEM VALUE SELECT * FROM kept')
      await c.query('COMMIT')
    })
    await planners('restored')
  }, 300_000)

  it('E-1: a forged ledger row through a chain of deferred triggers as the migrator', async () => {
    const chain = (last: number, table: string) =>
      [
        `CREATE TABLE public.${table} (id int);`,
        `CREATE FUNCTION public.${table}_chain() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id < ${last} THEN
    SET CONSTRAINTS ALL DEFERRED;
    INSERT INTO public.${table} VALUES (NEW.id + 1);
  ELSE
    EXECUTE 'RESET ROLE';
    INSERT INTO exponetdb.schema_migrations
      (migration_id, origin, name, checksum, checksum_provenance, applied_at, operation_id, engine_version, pg_version_num)
      VALUES ('01M4R2T03VG6F43SEKX6F5ST5X', 'exponetdb', 'forged', 'sha256:c1:${'3'.repeat(64)}', 'computed_at_apply', now(), 'op_01M4R2T03VG6F43SEKX6F5ST5G', 'forged', 180000);
    EXECUTE 'SET ROLE tc_mig_owner';
  END IF;
  RETURN NULL;
END $$;`,
        `CREATE CONSTRAINT TRIGGER ${table}_trg AFTER INSERT ON public.${table} DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.${table}_chain();`,
        `INSERT INTO public.${table} VALUES (1);`,
        '',
      ].join('\n')
    const ledgerCount = async () => su(tI, async (c) => (await c.query("SELECT count(*)::int AS n FROM exponetdb.schema_migrations WHERE name = 'forged'")).rows[0].n)
    for (const [label, last, table] of [
      ['chain_4', 4, 'tc_chain4'],
      ['chain_at_bound', DEFERRED_TRIGGER_ROUNDS, 'tc_chainb'],
      ['chain_past_bound', DEFERRED_TRIGGER_ROUNDS + 4, 'tc_chainx'],
    ] as const) {
      const id = w.ulid()
      const p = await attempt(() => w.plan(tI, { bundles: [w.bundle({ id, name: label.replace(/_/g, '-'), up: chain(last, table), dependsOn: [root], declared: 'potentially_breaking' })] }))
      if (!p.ok) { rec('i', `e1.${label}`, 'ERROR', p); continue }
      const op = await w.apply(p.value)
      const prog = (await readProgress(w.h.worker, op.operationId))[0]
      rec('i', `e1.${label}`, (await ledgerCount()) === 0 && op.state === 'failed' ? 'PASS' : 'FAIL', {
        state: op.state, apply: op.applyOutcome, code: await opCode(w, op.operationId),
        gate: prog?.gate, forgedRowsInLedger: await ledgerCount(), tableCreated: await hasRelation(tI, `public.${table}`),
      })
    }
  }, 300_000)
})
