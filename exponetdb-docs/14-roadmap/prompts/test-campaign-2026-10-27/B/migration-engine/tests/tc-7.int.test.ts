import { newId, systemClock } from '@exponetdb/kernel'
import { processNextOperation } from '@exponetdb/operations'
import { superuserClient } from '@exponetdb/testkit'
import { afterAll, beforeAll, describe, it } from 'vitest'
import { planMigrationResume } from '../src/index.ts'
import { attempt, rec, server, sleep } from './tc-util.ts'
import { DEFAULTS, migrationWorld, type Target, type World } from './tc-world.ts'

let w: World
let t: Target
let base = ''

beforeAll(async () => {
  w = await migrationWorld('tc_mig_cs7', server)
  t = await w.registerTarget('tc7', 'nonprod')
  base = w.ulid()
  await w.apply(await w.plan(t, { bundles: [w.bundle({ id: base, name: 'items', up: 'CREATE TABLE public.items (id int PRIMARY KEY);\n' })] }))
}, 300_000)
afterAll(async () => { await w?.close() })

describe('details', () => {
  it('ACCESS EXCLUSIVE: which error detail does the operation carry', async () => {
    const id = w.ulid()
    const p = await w.plan(t, { bundles: [w.bundle({ id, name: 'ax-detail', up: 'ALTER TABLE public.items ADD COLUMN ax int;\n', dependsOn: [base] })], defaults: { ...DEFAULTS, lockTimeout: '1s' } })
    const acc = await w.accept(p)
    const holder = await superuserClient(server, t.database)
    try {
      await holder.query('BEGIN')
      await holder.query('LOCK TABLE public.items IN ACCESS EXCLUSIVE MODE')
      await w.drive()
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined)
      await holder.end()
    }
    const ev = await w.h.worker.query('tc.ev', `SELECT kind, detail FROM operations.operation_events WHERE operation_id = $1 AND detail::text LIKE '%PLAN_STALE%' OR (operation_id = $1 AND detail ? 'changedBindings') ORDER BY event_id`, [acc.operationId])
    rec('d', 'd3b.access_exclusive_error_detail', 'info', { events: ev.rows.map((r) => [r.text('kind'), r.json('detail')]) })
  }, 200_000)

  it('stuck resume: events written per worker poll, and the retry rule for apply outcome unknown', async () => {
    const mid = w.ulid()
    const p = await w.plan(t, {
      bundles: [w.bundle({ id: mid, name: 'nt-kill', up: 'CREATE TABLE public.nt_side (id int);\nCREATE INDEX CONCURRENTLY nt_kill_idx ON public.items (id);\n', transactional: false, dependsOn: [base] })],
      defaults: { ...DEFAULTS, lockTimeout: '60s' },
    })
    const holder = await superuserClient(server, t.database)
    const watcher = await superuserClient(server, t.database)
    let running
    try {
      await holder.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
      await holder.query('SELECT 1')
      running = w.apply(p)
      for (let i = 0; i < 300; i++) {
        const r = await watcher.query(`SELECT pg_terminate_backend(pid) AS done FROM pg_stat_activity WHERE datname = current_database() AND usename = 'exponetdb_migrator' AND wait_event_type = 'Lock' AND query ILIKE '%CONCURRENTLY%'`)
        if (r.rows.some((x) => x.done === true)) break
        await sleep(100)
      }
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined)
      await holder.end()
      await watcher.end()
    }
    const op = await running
    const ver = (await import('../../application/src/views.ts')) as { verificationRetryable: (o: unknown) => boolean }
    rec('e', 'e11.retry_rule_for_unknown_outcome', ver.verificationRetryable({ kind: op.kind, state: op.state, applyOutcome: op.applyOutcome, verificationOutcome: op.verificationOutcome }) ? 'retryable' : 'NOT-RETRYABLE', { state: op.state, apply: op.applyOutcome, ver: op.verificationOutcome })
    const resume = await w.h.serve.transaction('tc.r', (tx) => planMigrationResume(tx, w.ctx, w.a, t.record.targetId, mid, { cleanup: true }))
    const acc = await w.accept(resume)
    const kinds = w.kindsFor(w.h.workerConnector)
    const count = async () => (await w.h.worker.query('tc.cnt', 'SELECT count(*)::int AS n FROM operations.operation_events WHERE operation_id = $1', [acc.operationId])).rows[0]?.int('n')
    const before = await count()
    const workerId = newId('prc', Date.now())
    for (let i = 0; i < 10; i++) await processNextOperation(w.h.worker, { workerId, kinds, clock: systemClock })
    const after = await count()
    const cancel = await w.h.worker.query('tc.cancel', 'SELECT state FROM operations.operations WHERE operation_id = $1', [acc.operationId])
    rec('e', 'e12.events_per_poll_of_blocked_resume', 'info', { eventsBefore: before, eventsAfter10Polls: after, perPoll: ((after ?? 0) - (before ?? 0)) / 10, resumeState: cancel.rows[0]?.text('state') })
  }, 300_000)
})
