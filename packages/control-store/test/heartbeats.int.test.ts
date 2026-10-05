import { newId } from '@exponetdb/kernel'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  beat,
  claimDueTask,
  finishTask,
  liveProcesses,
  markStopped,
  pruneHeartbeats,
  registerProcess,
  registerTasks,
  releaseTasks,
  taskStates,
} from '../src/index.ts'
import { type MigratedTestDatabase, migratedTestDatabase } from '../src/testing/index.ts'

let db: MigratedTestDatabase
const prc = () => newId('prc', Date.now())

beforeAll(async () => {
  db = await migratedTestDatabase('exdb_it_heartbeats')
})

afterAll(async () => {
  await db?.drop()
})

describe('process heartbeats', () => {
  it('registers, beats, lists live processes and stops', async () => {
    const worker = db.store('exdb_worker')
    const id = prc()
    await registerProcess(worker, {
      processId: id,
      role: 'worker',
      buildVersion: '0.1.0',
      buildCommit: 'abcdef1',
    })
    expect(await beat(worker, id)).toBe(true)
    const live = await liveProcesses(db.store('exdb_serve'))
    expect(live.find((p) => p.processId === id)).toMatchObject({
      role: 'worker',
      buildVersion: '0.1.0',
    })
    await markStopped(worker, id)
    expect(await beat(worker, id)).toBe(false)
    expect(
      (await liveProcesses(db.store('exdb_serve'))).find((p) => p.processId === id),
    ).toBeUndefined()
  })

  it('row-level security: a login cannot write heartbeats of another role', async () => {
    const serve = db.store('exdb_serve')
    await expect(
      registerProcess(serve, {
        processId: prc(),
        role: 'worker',
        buildVersion: '0.1.0',
        buildCommit: 'abcdef1',
      }),
    ).rejects.toMatchObject({ sqlstate: '42501' })
    const workerId = prc()
    await registerProcess(db.store('exdb_worker'), {
      processId: workerId,
      role: 'worker',
      buildVersion: '0.1.0',
      buildCommit: 'unknown',
    })
    expect(await beat(serve, workerId)).toBe(false)
    expect(await beat(db.store('exdb_gateway'), workerId)).toBe(false)
    await expect(
      db.store('exdb_serve').query('test.delete', 'DELETE FROM control.process_heartbeats'),
    ).rejects.toMatchObject({
      sqlstate: '42501',
    })
  })

  it('pruning removes only stale rows (enforced by the database policy too)', async () => {
    const worker = db.store('exdb_worker')
    const fresh = prc()
    const old = prc()
    await registerProcess(worker, {
      processId: fresh,
      role: 'worker',
      buildVersion: '0.1.0',
      buildCommit: 'unknown',
    })
    await registerProcess(worker, {
      processId: old,
      role: 'worker',
      buildVersion: '0.1.0',
      buildCommit: 'unknown',
    })
    await db.asSuperuser((c) =>
      c.query(
        "UPDATE control.process_heartbeats SET heartbeat_at = now() - interval '8 days' WHERE process_id = $1",
        [old],
      ),
    )
    // Even an unbounded DELETE by the worker removes only what the policy allows.
    await worker.query('test.delete_all', 'DELETE FROM control.process_heartbeats')
    const ids = (await liveProcesses(worker, 3600)).map((p) => p.processId)
    expect(ids).toContain(fresh)
    expect(await pruneHeartbeats(worker)).toBe(0)
    const remaining = await db.asSuperuser(async (c) =>
      (await c.query('SELECT process_id FROM control.process_heartbeats')).rows.map(
        (r) => r.process_id,
      ),
    )
    expect(remaining).not.toContain(old)
    expect(remaining).toContain(fresh)
  })
})

describe('maintenance task leases', () => {
  it('a due task is claimed by exactly one of two concurrent workers', async () => {
    const worker = db.store('exdb_worker')
    await registerTasks(worker, ['test.alpha'])
    const [a, b] = [prc(), prc()]
    const claims = await Promise.all([
      claimDueTask(db.store('exdb_worker'), a, ['test.alpha'], 30),
      claimDueTask(db.store('exdb_worker'), b, ['test.alpha'], 30),
    ])
    expect(claims.filter((c) => c === 'test.alpha')).toHaveLength(1)
    const owner = claims[0] === 'test.alpha' ? a : b
    const other = owner === a ? b : a
    expect(await finishTask(worker, 'test.alpha', other, 'succeeded', null, 60)).toBe(false)
    expect(await finishTask(worker, 'test.alpha', owner, 'succeeded', null, 60)).toBe(true)
    expect(await claimDueTask(worker, other, ['test.alpha'], 30)).toBeUndefined()
  })

  it('an expired lease can be taken over; failures are counted', async () => {
    const worker = db.store('exdb_worker')
    await registerTasks(worker, ['test.beta'])
    const crashed = prc()
    expect(await claimDueTask(worker, crashed, ['test.beta'], 1)).toBe('test.beta')
    await new Promise((r) => setTimeout(r, 1200))
    const successor = prc()
    expect(await claimDueTask(worker, successor, ['test.beta'], 30)).toBe('test.beta')
    expect(await finishTask(worker, 'test.beta', crashed, 'succeeded', null, 60)).toBe(false)
    expect(await finishTask(worker, 'test.beta', successor, 'failed', 'export_failed', 0)).toBe(
      true,
    )
    const state = (await taskStates(worker)).find((t) => t.task === 'test.beta')
    expect(state).toMatchObject({
      lastOutcome: 'failed',
      lastReason: 'export_failed',
      consecutiveFailures: 1,
    })
  })

  it('a graceful shutdown releases leases without recording a run', async () => {
    const worker = db.store('exdb_worker')
    await registerTasks(worker, ['test.gamma'])
    const owner = prc()
    expect(await claimDueTask(worker, owner, ['test.gamma'], 300)).toBe('test.gamma')
    expect(await releaseTasks(worker, owner)).toBe(1)
    expect(await claimDueTask(worker, prc(), ['test.gamma'], 30)).toBe('test.gamma')
    await expect(
      db
        .store('exdb_serve')
        .query('test.claim', 'UPDATE control.maintenance_tasks SET lease_owner = NULL'),
    ).rejects.toMatchObject({
      sqlstate: '42501',
    })
  })
})
