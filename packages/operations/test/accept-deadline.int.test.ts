import { type MigratedTestDatabase, migratedTestDatabase } from '@exponetdb/control-store/testing'
import { systemClock } from '@exponetdb/kernel'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { acceptPlan, KindRegistry } from '../src/index.ts'
import { human, newPlan, serveActor, stores, syntheticKind } from './support.ts'

/**
 * VC-123: accepting a plan reads the managed target while the plan's row lock and a Control Store
 * connection are held, on a pool shared with everything `serve` does. A target that never answers
 * ended in a wait as long as the TCP timeout, ten at a time. The live check has a deadline now.
 */
let db: MigratedTestDatabase
let as: ReturnType<typeof stores>
let silent = true
const kind = syntheticKind('synthetic.deadline', {
  bindings: () => (silent ? new Promise(() => undefined) : Promise.resolve([])),
})

beforeAll(async () => {
  db = await migratedTestDatabase('exdb_it_accept_deadline')
  as = stores(db)
})

afterAll(async () => {
  await db?.drop()
})

describe('the live binding check of an accept (VC-123)', () => {
  it('is refused TARGET_UNAVAILABLE within the deadline, releases the plan and leaves it active', async () => {
    const plan = await newPlan(as('exdb_serve'), { kind: kind.kind })
    const accept = (bindingDeadlineMs: number) =>
      as('exdb_serve').transaction('test.accept.deadline', (tx) =>
        acceptPlan(
          tx,
          { planId: plan.planId, actor: human },
          {
            kinds: new KindRegistry([kind]),
            clock: systemClock,
            systemActor: serveActor,
            recheckPolicy: async () => ({ status: 'proceed', requirements: [] }),
            bindingDeadlineMs,
          },
        ),
      )
    silent = true
    const started = performance.now()
    const refused = await accept(200)
    expect(performance.now() - started).toBeLessThan(5000)
    expect(refused).toMatchObject({ status: 'refused', error: { code: 'TARGET_UNAVAILABLE' } })
    // The row lock went with the transaction and the plan was not spent: the next accept goes through.
    silent = false
    expect(await accept(200)).toMatchObject({ status: 'accepted' })
  })
})
