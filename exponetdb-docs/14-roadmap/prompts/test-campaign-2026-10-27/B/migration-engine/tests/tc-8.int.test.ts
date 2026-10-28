import { randomBytes } from 'node:crypto'
import { newId, systemClock } from '@exponetdb/kernel'
import { processNextOperation, requestVerificationRetry } from '@exponetdb/operations'
import { afterAll, beforeAll, describe, it } from 'vitest'
import { ingestBundles, planMigrationVerify, readProgress } from '../src/index.ts'
import { attempt, opCode, opSteps, rec, server } from './tc-util.ts'
import { DEFAULTS, migrationWorld, type Target, type World } from './tc-world.ts'

let w: World
let t: Target
let base = ''

beforeAll(async () => {
  w = await migrationWorld('tc_mig_cs8', server)
  t = await w.registerTarget('tc8', 'nonprod')
  base = w.ulid()
  await w.apply(await w.plan(t, { bundles: [w.bundle({ id: base, name: 'items', up: 'CREATE TABLE public.items (id int PRIMARY KEY);\n' })] }))
}, 300_000)
afterAll(async () => { await w?.close() })

async function trace(n: number) {
  const kinds = w.kindsFor(w.h.workerConnector)
  const workerId = newId('prc', Date.now())
  const out: string[] = []
  for (let i = 0; i < n; i++) {
    const r = await processNextOperation(w.h.worker, { workerId, kinds, clock: systemClock })
    out.push(r.status)
    if (r.status === 'idle') break
  }
  return out
}

describe('(b) E10 with a broken verify.sql: retry-verification and migration.verify', () => {
  it('the documented recovery of a verify.sql that errors', async () => {
    const id = w.ulid()
    const spec = (verify: string) => ({ id, name: 'broken-verify', up: 'CREATE TABLE public.bv (id int);\n', dependsOn: [base], verify })
    const broken = '-- check: broken column\nSELECT count(no_such_column) >= 0 AS ok FROM public.bv;\n'
    const fixed = '-- check: readable\nSELECT count(*) >= 0 AS ok FROM public.bv;\n'
    const pl = await attempt(() => w.plan(t, { bundles: [w.bundle(spec(broken))] }))
    if (!pl.ok) { rec('b', 'b6.plan', 'info', pl); return }
    const op = await w.apply(pl.value)
    const prog = (await readProgress(w.h.worker, op.operationId))[0]
    rec('b', 'b6.apply_with_erroring_verify', 'info', { state: op.state, apply: op.applyOutcome, ver: op.verificationOutcome, code: await opCode(w, op.operationId), progress: prog?.errorCode })
    // 1. retry-verification re-runs the operation's OWN digest
    const operator = newId('idn', Date.now())
    await w.h.db.asSuperuser(async (c) => {
      await c.query(`INSERT INTO auth.identities (identity_id, kind, state, email, email_normalized, webauthn_user_handle) VALUES ($1, 'human', 'invited', 'op-tc8@example.test', 'op-tc8@example.test', $2)`, [operator, randomBytes(32)])
    })
    await w.h.serve.transaction('tc.retry', (tx) => requestVerificationRetry(tx, op.operationId, operator))
    await w.drive()
    const afterRetry = await w.operation(op.operationId)
    rec('b', 'b6.retry_verification_reuses_the_broken_digest', afterRetry.state === 'needs_attention' ? 'STILL-STUCK' : 'info', { state: afterRetry.state, ver: afterRetry.verificationOutcome })
    // 2. the documented fix: a verify revision, then migration.verify
    const rev = await w.h.serve.transaction('tc.ingest', (tx) =>
      ingestBundles(tx, { projectId: t.record.projectId, bundles: [w.bundle(spec(fixed))], defaults: DEFAULTS, identityId: w.a.identityId }),
    )
    const vp = await attempt(() => w.h.serve.transaction('tc.vp', (tx) => planMigrationVerify(tx, w.ctx, w.a, t.record.targetId, id, { revision: rev[0]?.revision.revision })))
    if (!vp.ok) { rec('b', 'b6.verify_plan', 'info', vp); return }
    const acc = await attempt(() => w.accept(vp.value))
    const tr = await trace(6)
    const vop = acc.ok ? await w.operation(acc.value.operationId) : undefined
    rec('b', 'b6.migration_verify_while_needs_attention', vop?.state === 'succeeded' ? 'PASS' : 'FAIL(DEADLOCK)', {
      plan: 'created', accepted: acc.ok ? true : acc, trace: tr, verifyOpState: vop?.state, steps: acc.ok ? (await opSteps(w, acc.value.operationId)).slice(0, 8) : [],
      originalOpState: (await w.operation(op.operationId)).state,
    })
  }, 300_000)
})
