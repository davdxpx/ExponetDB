import type { MigrationId } from '@exponetdb/kernel'
import type { OperationRecord, PlanRecord } from '@exponetdb/operations'
import { lockKey2, LOCK_NAMESPACE } from '@exponetdb/postgres'
import { superuserClient } from '@exponetdb/testkit'
import { afterAll, beforeAll, describe, it } from 'vitest'
import { newId } from '@exponetdb/kernel'
import { processNextOperation } from '@exponetdb/operations'
import { systemClock } from '@exponetdb/kernel'
import { planMigrationResume, readProgress } from '../src/index.ts'
import {
  attempt,
  eventsOf,
  exdbAdvisoryLocks,
  hasRelation,
  ledgerOf,
  opCode,
  opLocks,
  opSteps,
  rec,
  server,
  sleep,
  su,
} from './tc-util.ts'
import { DEFAULTS, migrationWorld, type Target, type World } from './tc-world.ts'

let w: World
let tD: Target
let base = '' as MigrationId

async function driveTrace(n: number) {
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

async function opsOf(t: Target) {
  const r = await w.h.worker.query(
    'tc.opsof',
    `SELECT o.operation_id, o.kind, o.state, o.apply_outcome, o.verification_outcome FROM operations.operations o
       JOIN operations.plans p ON p.plan_id = o.plan_id WHERE p.target_id = $1 ORDER BY o.operation_id`,
    [t.record.targetId],
  )
  const locks = await w.h.worker.query('tc.locks', 'SELECT operation_id, domain_key FROM operations.operation_locks', [])
  return {
    ops: r.rows.map((x) => `${x.text('operation_id').slice(-6)} ${x.text('kind')} ${x.text('state')} ${x.text('apply_outcome')} ${x.text('verification_outcome')}`),
    heldDomains: locks.rows.filter((x) => x.text('domain_key').includes(t.record.targetId)).map((x) => `${x.text('operation_id').slice(-6)} ${x.text('domain_key').slice(-12)}`),
  }
}

const timed = async <T>(fn: () => Promise<T>, capMs = 100_000) => {
  const t0 = Date.now()
  const r = await Promise.race([
    attempt(fn),
    sleep(capMs).then(() => ({ ok: false as const, code: 'TEST_CAP', details: capMs, message: 'cap reached', name: 'cap' })),
  ])
  return { ms: Date.now() - t0, r }
}

beforeAll(async () => {
  w = await migrationWorld('tc_mig_cs3', server)
  tD = await w.registerTarget('tc3d', 'nonprod')
  base = w.ulid()
  const op = await w.apply(await w.plan(tD, { bundles: [w.bundle({ id: base, name: 'items', up: 'CREATE TABLE public.items (id int PRIMARY KEY);\n' })] }))
  if (op.state !== 'succeeded') throw new Error('setup')
}, 300_000)

afterAll(async () => {
  await w?.close()
})

const alter = (name: string, extra: Partial<Parameters<World['bundle']>[0]> = {}) =>
  w.bundle({ name, up: `ALTER TABLE public.items ADD COLUMN ${name.replace(/-/g, '_')} int;\n`, dependsOn: [base], ...extra })

describe('(d) lock timeouts and concurrency', () => {
  it('ACCESS EXCLUSIVE held: at plan time', async () => {
    const holder = await superuserClient(server, tD.database)
    try {
      await holder.query('BEGIN')
      await holder.query('LOCK TABLE public.items IN ACCESS EXCLUSIVE MODE')
      const { ms, r } = await timed(() => w.plan(tD, { bundles: [alter('ax-plan')], defaults: { ...DEFAULTS, lockTimeout: '1s' } }))
      rec('d', 'd1.plan_under_access_exclusive', 'info', { ms, result: r.ok ? 'plan created' : r })
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined)
      await holder.end()
    }
  }, 200_000)

  it('ACCESS EXCLUSIVE held: between plan and acceptance', async () => {
    const p = await w.plan(tD, { bundles: [alter('ax-accept')], defaults: { ...DEFAULTS, lockTimeout: '1s' } })
    const holder = await superuserClient(server, tD.database)
    let acc: Awaited<ReturnType<typeof timed<unknown>>> | undefined
    try {
      await holder.query('BEGIN')
      await holder.query('LOCK TABLE public.items IN ACCESS EXCLUSIVE MODE')
      acc = await timed(() => w.accept(p))
      rec('d', 'd2.accept_under_access_exclusive', 'info', { ms: acc.ms, result: acc.r.ok ? 'accepted' : acc.r })
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined)
      await holder.end()
    }
    // whatever was accepted: let the worker finish it now that the lock is gone
    if (acc?.r.ok) {
      await w.drive()
      const op = await w.operation((acc.r.value as OperationRecord).operationId)
      rec('d', 'd2.after_release', 'info', { state: op.state, apply: op.applyOutcome, code: await opCode(w, op.operationId) })
    }
  }, 300_000)

  it('ACCESS EXCLUSIVE held: accepted, then the worker starts', async () => {
    const id = w.ulid()
    const p = await w.plan(tD, { bundles: [alter('ax-run', { id })], defaults: { ...DEFAULTS, lockTimeout: '1s' } })
    const accepted = await w.accept(p)
    const holder = await superuserClient(server, tD.database)
    try {
      await holder.query('BEGIN')
      await holder.query('LOCK TABLE public.items IN ACCESS EXCLUSIVE MODE')
      const { ms, r } = await timed(() => w.drive())
      const op = await w.operation(accepted.operationId)
      const prog = (await readProgress(w.h.worker, op.operationId))[0]
      rec('d', 'd3.worker_under_access_exclusive', 'info', {
        ms, driveResult: r.ok ? 'idle' : r, state: op.state, apply: op.applyOutcome,
        code: await opCode(w, op.operationId), progressCode: prog?.errorCode, sqlstate: prog?.sqlstate,
        ledgerHasIt: (await ledgerOf(w, tD)).some((x) => x.migrationId === id),
        exdbAdvisoryLocksHeld: await exdbAdvisoryLocks(tD),
        opLocks: await opLocks(w, op.operationId),
      })
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined)
      await holder.end()
    }
    const retry = await attempt(async () => w.apply(await w.plan(tD, { migrationIds: [id as never] })))
    rec('d', 'd3.replan_after_release', retry.ok && retry.value.state === 'succeeded' ? 'PASS' : 'info', retry.ok ? { state: retry.value.state } : retry)
  }, 300_000)

  it('(d) lockTimeout 1s against a conflicting lock the catalog reads do not wait for (ROW EXCLUSIVE)', async () => {
    const id = w.ulid()
    const p = await w.plan(tD, { bundles: [alter('rx-run', { id })], defaults: { ...DEFAULTS, lockTimeout: '1s' } })
    const before = (await ledgerOf(w, tD)).length
    const holder = await superuserClient(server, tD.database)
    let op: OperationRecord
    const t0 = Date.now()
    try {
      await holder.query('BEGIN')
      await holder.query('LOCK TABLE public.items IN ROW EXCLUSIVE MODE')
      op = await w.apply(p)
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined)
      await holder.end()
    }
    const ms = Date.now() - t0
    const prog = (await readProgress(w.h.worker, op.operationId))[0]
    const locksAfter = await exdbAdvisoryLocks(tD)
    const ok =
      op.state === 'failed' && op.applyOutcome === 'not_applied' &&
      (await opCode(w, op.operationId)) === 'MIGRATION_LOCK_TIMEOUT' &&
      (await ledgerOf(w, tD)).length === before && locksAfter.length === 0
    rec('d', 'd4.lock_timeout_1s', ok ? 'PASS' : 'FAIL', {
      ms, state: op.state, apply: op.applyOutcome, code: await opCode(w, op.operationId),
      progress: { code: prog?.errorCode, sqlstate: prog?.sqlstate, statementIndex: prog?.statementIndex },
      ledgerRowsBefore: before, ledgerRowsAfter: (await ledgerOf(w, tD)).length,
      columnAdded: await su(tD, async (c) => (await c.query("SELECT 1 FROM information_schema.columns WHERE table_name='items' AND column_name='rx_run'")).rowCount),
      exdbAdvisoryLocksAfter: locksAfter, opLocksAfter: await opLocks(w, op.operationId), steps: await opSteps(w, op.operationId),
    })
    const again = await w.apply(await w.plan(tD, { migrationIds: [id as never] }))
    rec('d', 'd4.same_bundle_applies_after_release', again.state === 'succeeded' ? 'PASS' : 'FAIL', { state: again.state })
  }, 300_000)

  it('(d) the schema advisory lock held by another session: typed timeout, then released', async () => {
    const id = w.ulid()
    const p = await w.plan(tD, { bundles: [alter('adv-run', { id })], lockWaitSeconds: 2 } as never)
    const key = lockKey2('schema', tD.record.targetId)
    const holder = await superuserClient(server, tD.database)
    try {
      const got = (await holder.query('SELECT pg_try_advisory_lock($1::int, $2::int) AS l', [LOCK_NAMESPACE, key])).rows[0].l
      const t0 = Date.now()
      const op = await w.apply(p)
      const waiting = (await opSteps(w, op.operationId)).filter((s) => s.includes('waiting_for_lock')).length
      rec('d', 'd5.advisory_lock_held_elsewhere', op.state === 'failed' && (await opCode(w, op.operationId)) === 'MIGRATION_LOCK_TIMEOUT' ? 'PASS' : 'FAIL', {
        gotLock: got, ms: Date.now() - t0, state: op.state, apply: op.applyOutcome, code: await opCode(w, op.operationId),
        waitingEvents: waiting, ledgerHasIt: (await ledgerOf(w, tD)).some((x) => x.migrationId === id),
        opLocks: await opLocks(w, op.operationId),
      })
    } finally {
      await holder.query('SELECT pg_advisory_unlock_all()').catch(() => undefined)
      await holder.end()
    }
    const again = await w.apply(await w.plan(tD, { migrationIds: [id as never] }))
    rec('d', 'd5.after_release', again.state === 'succeeded' ? 'PASS' : 'FAIL', { state: again.state, advisory: await exdbAdvisoryLocks(tD) })
  }, 300_000)

  it('(d) two concurrent applies on one target', async () => {
    const mk = (n: string) => w.bundle({ name: n.replace(/_/g, '-'), up: `CREATE TABLE public.${n} (id int);\n`, dependsOn: [base] })
    const b1 = mk('conc_one')
    const b2 = mk('conc_two')
    const p1: PlanRecord = await w.plan(tD, { bundles: [b1] })
    const p2: PlanRecord = await w.plan(tD, { bundles: [b2] })
    const [a1, a2] = [await w.accept(p1), await w.accept(p2)]
    const t0 = Date.now()
    await Promise.all([w.drive(), w.drive()])
    const [o1, o2] = [await w.operation(a1.operationId), await w.operation(a2.operationId)]
    const rows = (await ledgerOf(w, tD)).filter((r) => [o1.operationId, o2.operationId].includes(r.operationId))
    rec('d', 'd6.two_concurrent_applies', rows.length === 1 ? 'PASS' : 'FAIL', {
      ms: Date.now() - t0,
      first: { state: o1.state, apply: o1.applyOutcome, code: await opCode(w, o1.operationId) },
      second: { state: o2.state, apply: o2.applyOutcome, code: await opCode(w, o2.operationId) },
      ledgerRowsFromTheTwo: rows.length,
      tablesCreated: [await hasRelation(tD, 'public.conc_one'), await hasRelation(tD, 'public.conc_two')],
      advisoryAfter: await exdbAdvisoryLocks(tD),
      locksOp1: await opLocks(w, o1.operationId), locksOp2: await opLocks(w, o2.operationId),
    })
    // two plans from the same state, both applied one after the other: the second one is stale (re-plan works)
    const p3 = await w.plan(tD, { bundles: [mk('conc_three')] })
    const p4 = await w.plan(tD, { bundles: [mk('conc_four')] })
    const o3 = await w.apply(p3)
    const o4 = await attempt(() => w.accept(p4))
    rec('d', 'd6.sequential_stale', !o4.ok && o4.code === 'PLAN_STALE' && o3.state === 'succeeded' ? 'PASS' : 'FAIL', { first: o3.state, second: o4.ok ? 'accepted' : o4.code })
  }, 300_000)
})

describe('(e) a non-transactional bundle killed mid-way', () => {
  let tE: Target
  let eBase = '' as MigrationId
  beforeAll(async () => {
    tE = await w.registerTarget('tc3e', 'nonprod')
    eBase = w.ulid()
    const op = await w.apply(await w.plan(tE, { bundles: [w.bundle({ id: eBase, name: 'items', up: 'CREATE TABLE public.items (id int PRIMARY KEY);\n' })] }))
    if (op.state !== 'succeeded') throw new Error('setup E')
  }, 300_000)

  async function killedRun(tE: Target, eBase: MigrationId, name: string, up: string) {
    const id = w.ulid()
    const p = await w.plan(tE, {
      bundles: [w.bundle({ id, name, up, transactional: false, dependsOn: [eBase] })],
      defaults: { ...DEFAULTS, lockTimeout: '60s' },
    })
    const holder = await superuserClient(server, tE.database)
    const watcher = await superuserClient(server, tE.database)
    let running: Promise<OperationRecord> | undefined
    let terminated = false
    try {
      await holder.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
      await holder.query('SELECT 1')
      running = w.apply(p)
      for (let i = 0; i < 300 && !terminated; i++) {
        const r = await watcher.query(
          `SELECT pg_terminate_backend(pid) AS done FROM pg_stat_activity
            WHERE datname = current_database() AND usename = 'exponetdb_migrator'
              AND wait_event_type = 'Lock' AND query ILIKE '%CONCURRENTLY%'`,
        )
        terminated = r.rows.some((row) => row.done === true)
        if (!terminated) await sleep(100)
      }
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined)
      await holder.end()
      await watcher.end()
    }
    const op = running === undefined ? undefined : await running.catch((e) => { throw e })
    return { id, op, terminated }
  }

  it('(e1) killed while statement 1 (CREATE INDEX CONCURRENTLY) waits', async () => {
    const { id, op, terminated } = await killedRun(tE, eBase,
      'nt-kill-one',
      'CREATE TABLE public.nt_side (id int);\nCREATE INDEX CONCURRENTLY nt_kill_one_idx ON public.items (id);\n',
    )
    if (op === undefined) { rec('e', 'e1.run', 'ERROR', { terminated }); return }
    const prog = (await readProgress(w.h.worker, op.operationId))[0]
    const events = (await eventsOf(w, tE, id)).map((e) => e.event)
    const idx = await su(tE, async (c) => (await c.query("SELECT i.indisvalid AS valid, i.indisready AS ready FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE c.relname='nt_kill_one_idx'")).rows)
    rec('e', 'e1.killed_state', 'info', {
      terminated, state: op.state, apply: op.applyOutcome, ver: op.verificationOutcome, code: await opCode(w, op.operationId),
      progress: { apply: prog?.applyOutcome, code: prog?.errorCode, idx: prog?.statementIndex, sqlstate: prog?.sqlstate },
      events, invalidIndex: idx, ledgerHas: (await ledgerOf(w, tE)).some((r) => r.migrationId === id),
      steps: await opSteps(w, op.operationId), opLocksHeld: await opLocks(w, op.operationId),
      advisory: await exdbAdvisoryLocks(tE),
    })
    // everything else is blocked
    const other = await attempt(() => w.plan(tE, { bundles: [w.bundle({ name: 'other', up: 'CREATE TABLE public.other_e (id int);\n', dependsOn: [eBase] })] }))
    rec('e', 'e2.other_plans_blocked', !other.ok && other.code === 'MIGRATION_INCOMPLETE' ? 'PASS' : 'FAIL', other.ok ? {} : other)
    const cleanup = await attempt(() => w.plan(tE, {
      bundles: [w.bundle({ name: 'cleanup-idx', up: 'DROP INDEX CONCURRENTLY IF EXISTS public.nt_kill_one_idx;\n', transactional: false, dependsOn: [eBase] })],
    }))
    rec('e', 'e3.cleanup_migration_alternative', !cleanup.ok && cleanup.code === 'MIGRATION_INCOMPLETE' ? 'DOC-ALTERNATIVE-UNREACHABLE' : 'reachable', cleanup.ok ? { planned: true } : cleanup)
    const again = await attempt(() => w.plan(tE, { migrationIds: [id as never] }))
    rec('e', 'e4.replan_original', !again.ok ? 'info' : 'info', again.ok ? { planned: true } : again)
    const resume = (cleanupFlag?: boolean) =>
      w.h.serve.transaction('tc.resume', (tx) =>
        planMigrationResume(tx, w.ctx, w.a, tE.record.targetId, id, cleanupFlag === undefined ? {} : { cleanup: cleanupFlag }),
      )
    const r0 = await resume()
    rec('e', 'e5.resume_without_cleanup', r0.decision === 'deny' ? 'PASS' : 'FAIL', { decision: r0.decision, analysis: r0.body['analysis'] })
    const r1 = await resume(true)
    rec('e', 'e5b.resume_plan_with_cleanup', 'info', { decision: r1.decision, cleanup: (r1.body['content'] as { resume?: { cleanup?: unknown } }).resume?.cleanup })
    const acc = await attempt(() => w.accept(r1))
    rec('e', 'e5c.accept_resume', 'info', acc.ok ? { operationId: acc.value.operationId.slice(-6), state: acc.value.state } : acc)
    const trace = await driveTrace(8)
    const resumeOp = acc.ok ? await w.operation(acc.value.operationId) : undefined
    rec('e', 'e5d.resume_cannot_start_while_domain_held', resumeOp?.state === 'succeeded' ? 'PASS' : 'FAIL', {
      trace, resumeState: resumeOp?.state, resumeApply: resumeOp?.applyOutcome, ...(await opsOf(tE)),
      steps: acc.ok ? await opSteps(w, acc.value.operationId) : [],
    })
    const ro = resumeOp ?? op
    const idxAfter = await su(tE, async (c) => (await c.query("SELECT i.indisvalid AS valid FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE c.relname='nt_kill_one_idx'")).rows)
    rec('e', 'e6.resume_with_cleanup', ro.state === 'succeeded' && idxAfter[0]?.valid === true ? 'PASS' : 'FAIL', {
      decision: r1.decision, state: ro.state, apply: ro.applyOutcome, ver: ro.verificationOutcome,
      events: (await eventsOf(w, tE, id)).map((e) => e.event), indexAfter: idxAfter,
    })
    const free = await attempt(() => w.plan(tE, { bundles: [w.bundle({ name: 'free-again', up: 'CREATE TABLE public.free_again (id int);\n', dependsOn: [eBase] })] }))
    rec('e', 'e7.target_unblocked', free.ok ? 'PASS' : 'FAIL', free.ok ? {} : free)
  }, 400_000)

  it('(e2) killed while statement 0 is a CONCURRENTLY statement', async () => {
    const tE2 = await w.registerTarget('tc3e2', 'nonprod')
    const eBase2 = w.ulid()
    await w.apply(await w.plan(tE2, { bundles: [w.bundle({ id: eBase2, name: 'items', up: 'CREATE TABLE public.items (id int PRIMARY KEY);\n' })] }))
    const { id, op, terminated } = await killedRun(tE2, eBase2,
      'nt-kill-zero',
      'CREATE INDEX CONCURRENTLY nt_kill_zero_idx ON public.items (id);\n',
    )
    if (op === undefined) { rec('e', 'e8.run', 'ERROR', { terminated }); return }
    const prog = (await readProgress(w.h.worker, op.operationId))[0]
    const idx = await su(tE2, async (c) => (await c.query("SELECT i.indisvalid AS valid FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE c.relname='nt_kill_zero_idx'")).rows)
    rec('e', 'e8.killed_stmt0_concurrently', 'info', {
      terminated, state: op.state, apply: op.applyOutcome, code: await opCode(w, op.operationId),
      progress: { apply: prog?.applyOutcome, code: prog?.errorCode, idx: prog?.statementIndex },
      events: (await eventsOf(w, tE2, id)).map((e) => e.event), invalidIndex: idx,
    })
    const other = await attempt(() => w.plan(tE2, { bundles: [w.bundle({ name: 'other2', up: 'CREATE TABLE public.other_e2 (id int);\n', dependsOn: [eBase2] })] }))
    rec('e', 'e9.blocked_after_stmt0_kill', !other.ok ? 'blocked' : 'NOT-blocked', other.ok ? {} : other)
    const r1 = await w.h.serve.transaction('tc.resume0', (tx) => planMigrationResume(tx, w.ctx, w.a, tE2.record.targetId, id, { cleanup: true }))
    const acc = await attempt(() => w.accept(r1))
    const trace = await driveTrace(6)
    const ro = acc.ok ? await w.operation(acc.value.operationId) : undefined
    rec('e', 'e10.resume_stmt0', ro?.state === 'succeeded' ? 'PASS' : 'FAIL', { decision: r1.decision, accepted: acc.ok, trace, state: ro?.state, ...(await opsOf(tE2)), events: (await eventsOf(w, tE2, id)).map((e) => e.event) })
  }, 400_000)
})
