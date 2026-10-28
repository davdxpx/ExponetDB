import { readLedgerRows, readMigrationEvents, readVerifications } from '@exponetdb/postgres'
import { serverFor, superuserClient } from '@exponetdb/testkit'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ingestBundles, planMigrationResume, planMigrationVerify } from '../src/index.ts'
import { DEFAULTS, migrationWorld, type Target, type World } from './world.ts'

/**
 * The recovery of an operation that needs attention (TC-005, MIG-01,
 * [failure-and-recovery.md §2](../../../exponetdb-docs/04-migrations/failure-and-recovery.md#2-non-transactional-migrations)):
 * `needs_attention` keeps the target's schema domain and is never claimed, so
 * the documented recovery (a verify revision, then `migration.verify`, or
 * `migration.resume`) must be able to take the domain from the operation it
 * recovers. Each case causes the failure for real on PostgreSQL 17.
 */
const pg17 = serverFor(17)
let w: World

beforeAll(async () => {
  w = await migrationWorld('exdb_it_mig_recovery', pg17)
}, 240_000)

afterAll(async () => {
  await w?.close()
})

const BASE_UP = 'CREATE TABLE public.items (id int PRIMARY KEY);\n'
const broken = '-- check: broken column\nSELECT count(no_such_column) >= 0 AS ok FROM public.bv;\n'
const fixed = '-- check: readable\nSELECT count(*) >= 0 AS ok FROM public.bv;\n'

async function targetWithBase(slug: string): Promise<{ t: Target; base: string }> {
  const t = await w.registerTarget(slug, 'nonprod')
  const base = w.ulid()
  const op = await w.apply(
    await w.plan(t, { bundles: [w.bundle({ id: base, name: 'items', up: BASE_UP })] }),
  )
  expect(op).toMatchObject({ state: 'succeeded' })
  return { t, base }
}

async function lockCount(operationId: string): Promise<number> {
  const r = await w.h.worker.query(
    'test.recovery.locks',
    'SELECT count(*)::int AS n FROM operations.operation_locks WHERE operation_id = $1',
    [operationId],
  )
  return r.rows[0]?.int('n') ?? -1
}

async function targetLocks(t: Target): Promise<number> {
  const r = await w.h.worker.query(
    'test.recovery.target_locks',
    'SELECT count(*)::int AS n FROM operations.operation_locks WHERE domain_key = $1',
    [`target:${t.record.targetId}:schema`],
  )
  return r.rows[0]?.int('n') ?? -1
}

async function observed<T>(
  t: Target,
  fn: (
    tx: Parameters<
      Parameters<
        Awaited<ReturnType<World['h']['workerConnector']['forTarget']>>['session']['readOnly']
      >[0]
    >[0],
  ) => Promise<T>,
): Promise<T> {
  const opened = await w.h.workerConnector.forTarget(t.record, 'observer', 'test')
  try {
    return await opened.session.readOnly(fn)
  } finally {
    await opened.session.close()
  }
}

const planContentOf = (p: { body: Record<string, unknown> }) =>
  p.body['content'] as Record<string, unknown>

describe('a verify.sql that errors (E10, second case)', () => {
  it('is recovered by a verify revision and migration.verify, which closes the stuck operation', async () => {
    const { t, base } = await targetWithBase('rec-a')
    const id = w.ulid()
    const spec = (verify: string) => ({
      id,
      name: 'broken-verify',
      up: 'CREATE TABLE public.bv (id int);\n',
      dependsOn: [base],
      verify,
    })
    const stuck = await w.apply(await w.plan(t, { bundles: [w.bundle(spec(broken))] }))
    expect(stuck).toMatchObject({
      state: 'needs_attention',
      applyOutcome: 'applied',
      verificationOutcome: 'error',
    })
    expect(await lockCount(stuck.operationId)).toBe(1)

    const revision = await w.h.serve.transaction('test.recovery.ingest', (tx) =>
      ingestBundles(tx, {
        projectId: t.record.projectId,
        bundles: [w.bundle(spec(fixed))],
        defaults: DEFAULTS,
        identityId: w.a.identityId,
      }),
    )
    const verifyPlan = await w.h.serve.transaction('test.recovery.plan', (tx) =>
      planMigrationVerify(tx, w.ctx, w.a, t.record.targetId, id, {
        revision: revision[0]?.revision.revision,
      }),
    )
    // The plan a person accepts says which operation it closes.
    expect(planContentOf(verifyPlan)['supersedes']).toBe(stuck.operationId)

    const recovery = await w.apply(verifyPlan)
    expect(recovery).toMatchObject({
      state: 'succeeded',
      applyOutcome: 'applied',
      verificationOutcome: 'passed',
    })
    expect(await w.operation(stuck.operationId)).toMatchObject({
      state: 'verification_failed',
      applyOutcome: 'applied',
      verificationOutcome: 'failed',
    })
    expect(await lockCount(stuck.operationId)).toBe(0)
    expect(await targetLocks(t)).toBe(0)
    const runs = await observed(t, (tx) => readVerifications(tx, id))
    expect(runs.map((r) => r.status)).toEqual(['error', 'passed'])

    // The next ordinary plan is admitted.
    const next = await w.apply(
      await w.plan(t, {
        bundles: [
          w.bundle({
            name: 'after',
            up: 'CREATE TABLE public.after_rec (id int);\n',
            dependsOn: [base],
          }),
        ],
      }),
    )
    expect(next).toMatchObject({ state: 'succeeded', verificationOutcome: 'passed' })
  })

  it('does not close an operation about another migration', async () => {
    const { t, base } = await targetWithBase('rec-c')
    const clean = w.ulid()
    expect(
      await w.apply(
        await w.plan(t, {
          bundles: [
            w.bundle({
              id: clean,
              name: 'clean',
              up: 'CREATE TABLE public.clean_one (id int);\n',
              dependsOn: [base],
              verify: '-- check: readable\nSELECT count(*) >= 0 AS ok FROM public.clean_one;\n',
            }),
          ],
        }),
      ),
    ).toMatchObject({ state: 'succeeded' })
    const other = w.ulid()
    const stuck = await w.apply(
      await w.plan(t, {
        bundles: [
          w.bundle({
            id: other,
            name: 'other-broken',
            up: 'CREATE TABLE public.other_bv (id int);\n',
            dependsOn: [base],
            verify: broken.replace('public.bv', 'public.other_bv'),
          }),
        ],
      }),
    )
    expect(stuck.state).toBe('needs_attention')
    const unrelated = await w.h.serve.transaction('test.recovery.unrelated', (tx) =>
      planMigrationVerify(tx, w.ctx, w.a, t.record.targetId, clean, {}),
    )
    expect(planContentOf(unrelated)['supersedes']).toBeUndefined()
    // It waits behind the stuck operation, which stays as it is.
    const waiting = await w.accept(unrelated)
    await w.drive({ polls: 5 })
    expect(await w.operation(waiting.operationId)).toMatchObject({ state: 'queued' })
    expect((await w.operation(stuck.operationId)).state).toBe('needs_attention')
    // Cancel the waiting plan (serve may cancel an operation that has not started): the shared
    // worker would answer `waiting` for it for ever and no later case could reach idle.
    await w.h.serve.transaction('test.recovery.cancel', (tx) =>
      tx.query(
        'test.recovery.cancel',
        `UPDATE operations.operations SET state = 'canceled', verification_outcome = 'not_applicable'
          WHERE operation_id = $1`,
        [waiting.operationId],
      ),
    )
  })
})

describe('a non-transactional bundle killed mid-way (E4)', () => {
  it('is completed by migration.resume with cleanup, which closes the stuck operation', async () => {
    const { t, base } = await targetWithBase('rec-b')
    const id = w.ulid()
    const plan = await w.plan(t, {
      bundles: [
        w.bundle({
          id,
          name: 'nt-kill',
          up: 'CREATE TABLE public.nt_side (id int);\nCREATE INDEX CONCURRENTLY nt_kill_idx ON public.items (id);\n',
          transactional: false,
          dependsOn: [base],
        }),
      ],
      defaults: { ...DEFAULTS, lockTimeout: '60s' },
    })
    // An older snapshot holds the concurrent index build waiting; its backend is then terminated.
    const holder = await superuserClient(pg17, t.database)
    const watcher = await superuserClient(pg17, t.database)
    let running: Promise<Awaited<ReturnType<World['apply']>>> | undefined
    try {
      await holder.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
      await holder.query('SELECT 1')
      running = w.apply(plan)
      for (let i = 0; i < 300; i++) {
        const r = await watcher.query(
          `SELECT pg_terminate_backend(pid) AS done FROM pg_stat_activity
            WHERE datname = current_database() AND usename = 'exponetdb_migrator'
              AND wait_event_type = 'Lock' AND query ILIKE '%CONCURRENTLY%'`,
        )
        if (r.rows.some((x) => x.done === true)) break
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined)
      await holder.end()
      await watcher.end()
    }
    const stuck = await (running as Promise<Awaited<ReturnType<World['apply']>>>)
    expect(stuck).toMatchObject({ state: 'needs_attention', applyOutcome: 'unknown' })
    expect(await lockCount(stuck.operationId)).toBe(1)

    const resumePlan = await w.h.serve.transaction('test.recovery.resume', (tx) =>
      planMigrationResume(tx, w.ctx, w.a, t.record.targetId, id, { cleanup: true }),
    )
    const resumed = await w.apply(resumePlan)
    expect(resumed).toMatchObject({ state: 'succeeded', applyOutcome: 'applied' })
    expect(await w.operation(stuck.operationId)).toMatchObject({
      state: 'verification_failed',
      applyOutcome: 'partially_applied',
      verificationOutcome: 'failed',
    })
    expect(await lockCount(stuck.operationId)).toBe(0)
    expect(await targetLocks(t)).toBe(0)

    // The index is valid, the applied event and the ledger row are there.
    const index = await superuserClient(pg17, t.database)
    try {
      const r = await index.query(
        `SELECT indisvalid FROM pg_index WHERE indexrelid = 'public.nt_kill_idx'::regclass`,
      )
      expect(r.rows.map((x) => x.indisvalid)).toEqual([true])
    } finally {
      await index.end()
    }
    expect((await observed(t, (tx) => readLedgerRows(tx))).map((r) => r.migrationId)).toContain(id)
    expect(
      (await observed(t, (tx) => readMigrationEvents(tx, { migrationId: id }))).filter(
        (e) => e.event === 'applied',
      ),
    ).toHaveLength(1)

    const next = await w.apply(
      await w.plan(t, {
        bundles: [
          w.bundle({
            name: 'after',
            up: 'CREATE TABLE public.after_nt (id int);\n',
            dependsOn: [base],
          }),
        ],
      }),
    )
    expect(next).toMatchObject({ state: 'succeeded' })
  })
})
