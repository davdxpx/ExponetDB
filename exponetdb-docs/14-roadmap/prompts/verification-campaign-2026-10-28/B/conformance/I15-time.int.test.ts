// I15 time limits: statement timeout, lock timeout and the lock wait are enforced, each with its named error and
// the documented default (planning-and-apply.md §5, §6).  Real PostgreSQL 17 through the engine.
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { superuserClient, serverFor } from '@exponetdb/testkit'
import { readProgress } from '@exponetdb/migrations-engine'
import { DEFAULTS, migrationWorld, operationError, type Target, type World } from './lib/world.ts'
import { ENGINE_DEFAULT_LOCK_TIMEOUT_MS, ENGINE_DEFAULT_STATEMENT_TIMEOUT_MS } from '../../packages/migrations/src/format/projection.ts'

let w: World
let t: Target
beforeAll(async () => {
  w = await migrationWorld('b2_i15t', serverFor(17))
  t = await w.registerTarget('time', 'nonprod')
}, 300_000)
afterAll(async () => {
  await w?.close()
})

describe('I15 time limits', () => {
  test('documented engine defaults: lock_timeout 5 s, statement_timeout 15 min', () => {
    expect(ENGINE_DEFAULT_LOCK_TIMEOUT_MS).toBe(5_000)
    expect(ENGINE_DEFAULT_STATEMENT_TIMEOUT_MS).toBe(15 * 60_000)
  })

  test('statementTimeout: a statement past its limit fails with MIGRATION_EXECUTION_FAILED / SQLSTATE 57014, nothing applied', async () => {
    const id = w.ulid()
    const p = await w.plan(t, {
      bundles: [w.bundle({ id, name: 'slow', up: 'CREATE TABLE public.slow_t (i int);\nSELECT pg_sleep(30);\n' })],
      defaults: { ...DEFAULTS, statementTimeout: '1s' },
    })
    const t0 = Date.now()
    const op = await w.apply(p)
    expect(Date.now() - t0).toBeLessThan(20_000)
    expect(op).toMatchObject({ state: 'failed', applyOutcome: 'not_applied' })
    const progress = await readProgress(w.h.worker, op.operationId)
    // named: the statement timeout has no code of its own; it is MIGRATION_EXECUTION_FAILED plus sqlstate 57014
    expect({ code: (await operationError(w.h, op.operationId)).code, sqlstate: progress[0]?.sqlstate }).toEqual({ code: 'MIGRATION_EXECUTION_FAILED', sqlstate: '57014' })
  })

  test('lockTimeout: a statement that waits for a lock fails with MIGRATION_LOCK_TIMEOUT / 55P03 within the limit', async () => {
    const base = w.ulid()
    await w.apply(await w.plan(t, { bundles: [w.bundle({ id: base, name: 'lockt', up: 'CREATE TABLE public.lock_t (i int);\n' })] }))
    const id = w.ulid()
    const p = await w.plan(t, {
      bundles: [w.bundle({ id, name: 'blocked', up: 'ALTER TABLE public.lock_t ADD COLUMN c int;\n', dependsOn: [base] })],
      defaults: { ...DEFAULTS, lockTimeout: '1s' },
    })
    const holder = await superuserClient(serverFor(17), t.database)
    try {
      await holder.query('BEGIN')
      await holder.query('LOCK TABLE public.lock_t IN ROW EXCLUSIVE MODE')
      const t0 = Date.now()
      const op = await w.apply(p)
      const took = Date.now() - t0
      expect(op).toMatchObject({ state: 'failed', applyOutcome: 'not_applied' })
      expect((await operationError(w.h, op.operationId)).code).toBe('MIGRATION_LOCK_TIMEOUT')
      expect(took, `took ${took} ms for lock_timeout 1 s`).toBeLessThan(15_000)
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined)
      await holder.end()
    }
  })
})
