import { systemClock } from '@exponetdb/kernel'
import { createLogger } from '@exponetdb/observability'
import { planTargetStateChange } from '@exponetdb/registry'
import { runAsSuperuser, serverFor } from '@exponetdb/testkit'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  migrationWorld,
  type Target,
  type World,
} from '../../../packages/migrations-engine/test/world.ts'
import { run } from '../../../packages/registry/test/harness.ts'
import { type ObservationTasks, observationTasks } from '../src/composition/registry.ts'

/**
 * G6 failure case E16 through the worker's composition (review of W10-3, M2): the task
 * `ledger.watch` against a production target and its staging target on PostgreSQL 17. The finding
 * opens, follows what staging gets, clears, stays as it is while staging cannot be read (without
 * failing the task), resolves `superseded` when staging is gone, and an observed production target
 * is not compared.
 */
const pg17 = serverFor(17)
let w: World
let tasks: ObservationTasks
let staging: Target
let production: Target
let observed: Target

beforeAll(async () => {
  w = await migrationWorld('exdb_it_hotfix_watch', pg17)
  tasks = observationTasks(
    {
      store: w.h.worker,
      keyring: w.h.keyring,
      clock: systemClock,
      installationId: w.h.db.installationId,
    },
    // Only the health sample suspends targets; the watch never uses the acceptance context.
    {} as never,
    createLogger({ role: 'worker', level: 'error', write: () => undefined }),
  )
  staging = await w.registerTarget('hw-stg', 'nonprod')
  production = await w.registerTarget('hw-prd', 'prod', 'hw-stg')
  observed = await w.registerTarget('hw-obs', 'prod', 'hw-stg', 'observed')
}, 300_000)

afterAll(async () => {
  await w?.close()
})

const finding = async (t: Target) => {
  const r = await w.h.worker.query(
    'test.hotfix_watch.finding',
    `SELECT state, resolution, details FROM observation.findings
      WHERE target_id = $1 AND code = 'hotfix_without_evidence' ORDER BY finding_id DESC LIMIT 1`,
    [t.record.targetId],
  )
  const row = r.rows[0]
  return row === undefined
    ? undefined
    : {
        state: row.text('state'),
        resolution: row.textOrNull('resolution'),
        details: row.json('details') as { count: number; migrations: { migrationId: string }[] },
      }
}

/** Applies a bundle to production without the migration rules: the state a break-glass hotfix leaves. */
async function hotfix(bundle: ReturnType<World['bundle']>) {
  w.setRules('registry-only')
  try {
    expect(await w.apply(await w.plan(production, { bundles: [bundle] }))).toMatchObject({
      state: 'succeeded',
    })
  } finally {
    w.setRules('all')
  }
}

const toStaging = async (id: string) =>
  expect(await w.apply(await w.plan(staging, { migrationIds: [id as never] }))).toMatchObject({
    state: 'succeeded',
  })

/** The staging marker names another generation: its evidence cannot be trusted or read. */
const shiftMarker = (by: number) =>
  runAsSuperuser(pg17, staging.database, [
    `BEGIN; SET LOCAL session_replication_role = replica; UPDATE exponetdb.target_identity SET generation = generation + (${by}); COMMIT`,
  ])

describe('the ledger watch compares production with its evidence target (E16)', () => {
  it('opens, follows staging, clears, survives an unreadable staging or production and resolves when staging is gone', async () => {
    const base = w.bundle({
      name: 'items',
      up: 'CREATE TABLE public.items (id int PRIMARY KEY);\n',
    })
    const baseId = base.directory.slice(0, 26)
    expect(await w.apply(await w.plan(staging, { bundles: [base] }))).toMatchObject({
      state: 'succeeded',
    })
    await hotfix(base)
    const one = w.bundle({
      name: 'hot-one',
      up: 'ALTER TABLE public.items ADD COLUMN one int;\n',
      dependsOn: [baseId],
    })
    const oneId = one.directory.slice(0, 26)
    const two = w.bundle({
      name: 'hot-two',
      up: 'ALTER TABLE public.items ADD COLUMN two int;\n',
      dependsOn: [oneId],
    })
    const twoId = two.directory.slice(0, 26)
    await hotfix(one)
    await hotfix(two)

    await expect(tasks.watchLedgers()).resolves.toBeUndefined()
    expect(await finding(production)).toMatchObject({
      state: 'open',
      details: { count: 2, migrations: [{ migrationId: twoId }, { migrationId: oneId }] },
    })
    // The observed production target has no ExponetDB ledger: it is not compared.
    expect(await finding(observed)).toBeUndefined()

    await toStaging(oneId)
    await tasks.watchLedgers()
    expect(await finding(production)).toMatchObject({
      state: 'open',
      details: { count: 1, migrations: [{ migrationId: twoId }] },
    })

    // Staging unreadable as evidence: the finding stays as it is and the task does not fail.
    await shiftMarker(100)
    try {
      await expect(tasks.watchLedgers()).resolves.toBeUndefined()
      expect(await finding(production)).toMatchObject({ state: 'open', details: { count: 1 } })
    } finally {
      await shiftMarker(-100)
    }

    await toStaging(twoId)
    await tasks.watchLedgers()
    expect(await finding(production)).toMatchObject({ state: 'resolved', resolution: 'cleared' })

    // Staging is decommissioned: nothing can be compared, the finding is resolved superseded.
    await hotfix(
      w.bundle({
        name: 'hot-three',
        up: 'ALTER TABLE public.items ADD COLUMN three int;\n',
        dependsOn: [twoId],
      }),
    )
    // Production itself unreadable: its own ledger comparison fails the task, the E16 check still runs.
    const connections = (allow: boolean) =>
      runAsSuperuser(pg17, 'postgres', [
        `ALTER DATABASE ${production.database} ALLOW_CONNECTIONS ${allow}`,
      ])
    await connections(false)
    try {
      await expect(tasks.watchLedgers()).rejects.toMatchObject({
        message: expect.stringMatching(/ledger_watch_incomplete/),
      })
    } finally {
      await connections(true)
    }
    expect(await finding(production)).toMatchObject({ state: 'open', details: { count: 1 } })
    const gone = await run(w.h, w.a, (tx) =>
      planTargetStateChange(tx, w.h.context, w.a, 'target.decommission', staging.record.targetId, {
        reason: 'wrong_database',
      }),
    )
    expect(gone.operation.state).toBe('succeeded')
    await tasks.watchLedgers()
    expect(await finding(production)).toMatchObject({
      state: 'resolved',
      resolution: 'superseded',
    })
  }, 400_000)
})
