/**
 * Block R, tester R3, TC-061 (MIG-10): the events a waiting operation writes per worker poll.
 * Copy to packages/operations/test/r3-locks.int.test.ts (it reuses the helpers of driver.int.test.ts) and run
 * `bunx vitest run --config vitest.integration.config.ts test/r3-locks.int.test.ts` with EXDB_TEST_PG_URL set.
 */
import { type MigratedTestDatabase, migratedTestDatabase } from '@exponetdb/control-store/testing'
import { type OperationId, systemClock } from '@exponetdb/kernel'
import { afterAll, beforeAll, describe, it } from 'vitest'
import {
  acceptPlan,
  KindRegistry,
  type OperationKind,
  processNextOperation,
  WORKER_ACTOR,
} from '../src/index.ts'
import { human, newPlan, serveActor, sleep, stores, syntheticKind, target } from './support.ts'

let db: MigratedTestDatabase
let as: ReturnType<typeof stores>

beforeAll(async () => {
  db = await migratedTestDatabase('exdb_it_r3_locks')
  as = stores(db)
})
afterAll(async () => {
  await db?.drop()
})

async function queue(kind: OperationKind, domains: readonly string[]): Promise<OperationId> {
  const plan = await newPlan(as('exdb_serve'), { kind: kind.kind, domains })
  const result = await as('exdb_serve').transaction('test.accept', (tx) =>
    acceptPlan(tx, { planId: plan.planId, actor: human }, {
      kinds: new KindRegistry([kind]),
      clock: systemClock,
      systemActor: serveActor,
      recheckPolicy: async () => ({ status: 'proceed', requirements: [] }),
    }),
  )
  if (result.status !== 'accepted') throw result.error
  return result.operation.operationId
}

describe('TC-061: a waiting operation and its events', () => {
  it('counts the events of an operation that waits for ten polls', async () => {
    const tgt = target()
    let release: () => void = () => undefined
    const gate = new Promise<void>((r) => {
      release = r
    })
    const slow = syntheticKind('synthetic.slow', { execute: async () => { await gate; return 'applied' } })
    const second = syntheticKind('synthetic.second')
    const first = await queue(slow, [`target:${tgt}:maintenance`])
    const waiting = await queue(second, [`target:${tgt}:schema`])
    const run = (kind: OperationKind) =>
      processNextOperation(as('exdb_worker'), { workerId: WORKER_ID, kinds: new KindRegistry([kind]), clock: systemClock })
    const running = run(slow)
    await sleep(200)
    const count = async () => {
      const { rows } = await as('exdb_worker').query(
        'r3.count',
        `SELECT kind, count(*)::int AS n FROM operations.operation_events WHERE operation_id = $1 GROUP BY kind ORDER BY kind`,
        [waiting],
      )
      return Object.fromEntries(rows.map((r) => [r.text('kind'), r.int('n')]))
    }
    const before = await count()
    for (let i = 0; i < 10; i++) await run(second)
    const after = await count()
    process.stdout.write(`R3PROBE tc061.events ${JSON.stringify({ first, waiting, before, after })}\n`)
    release()
    await running
  })
})

const WORKER_ID = 'prc_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z' as never
