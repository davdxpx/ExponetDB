// R1 probe TC-005 (lead's check): closeSuperseded runs inside the start transaction BEFORE acquireLocks,
// checkBindings and admit; does the close survive a recovery that is then refused, stale or revoked?
// Lives beside driver.int.test.ts in a throwaway clone (packages/operations/test/).
import { type MigratedTestDatabase, migratedTestDatabase } from '@exponetdb/control-store/testing'
import { newId, type OperationId, systemClock } from '@exponetdb/kernel'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  acceptPlan,
  heldLocks,
  KindRegistry,
  type OperationKind,
  processNextOperation,
  readOperation,
} from '../src/index.ts'
import { human, newPlan, serveActor, stores, syntheticKind, target } from './support.ts'

let db: MigratedTestDatabase
let as: ReturnType<typeof stores>
beforeAll(async () => {
  db = await migratedTestDatabase('exdb_r1_supersede')
  as = stores(db)
})
afterAll(async () => {
  await db?.drop()
})

async function queue(kind: OperationKind, domains: readonly string[] = [], supersedes?: readonly string[]): Promise<OperationId> {
  const plan = await newPlan(as('exdb_serve'), { kind: kind.kind, domains, ...(supersedes === undefined ? {} : { supersedes }) })
  const result = await as('exdb_serve').transaction('test.accept', (tx) =>
    acceptPlan(tx, { planId: plan.planId, actor: human }, {
      kinds: new KindRegistry([kind]), clock: systemClock, systemActor: serveActor,
      recheckPolicy: async () => ({ status: 'proceed', requirements: [] }),
    }),
  )
  if (result.status !== 'accepted') throw result.error
  return result.operation.operationId
}
const run = (kind: OperationKind, admit?: Parameters<typeof processNextOperation>[1]['admit']) =>
  processNextOperation(as('exdb_worker'), {
    workerId: newId('prc', Date.now()), kinds: new KindRegistry([kind]), clock: systemClock,
    ...(admit === undefined ? {} : { admit }),
  })
const state = async (id: OperationId) => {
  const o = await readOperation(as('exdb_worker'), id)
  return { state: o?.state, apply: o?.applyOutcome, ver: o?.verificationOutcome, locks: await heldLocks(as('exdb_worker'), id) }
}
const out = (label: string, v: unknown) => console.log(`[r1] ${label} ${JSON.stringify(v)}`)

async function stuck(tgt: string, tag: string) {
  const k = syntheticKind(`synthetic.stuck${tag}`, { verify: async () => 'error' })
  const id = await queue(k, [`target:${tgt}:schema`])
  await run(k)
  return id
}

describe('R1: order of closeSuperseded in the start transaction', () => {
  it('control: an unobstructed recovery closes the stuck operation', async () => {
    const tgt = target()
    const first = await stuck(tgt, 'c')
    const fix = syntheticKind('synthetic.fixc')
    await queue(fix, [`target:${tgt}:schema`], [first])
    out('control run', (await run(fix)).status)
    out('control stuck op', await state(first))
  })
  it('stale: checkBindings refuses the recovery (PLAN_STALE)', async () => {
    const tgt = target()
    const first = await stuck(tgt, 's')
    let stale = false
    const fix = syntheticKind('synthetic.fixs', { bindings: async () => (stale ? [{ binding: 'target' }] : []) })
    const fixId = await queue(fix, [`target:${tgt}:schema`], [first])
    stale = true // the target changed between acceptance and start
    const r = await run(fix)
    out('stale run', { status: r.status, recoveryState: (await state(fixId)).state })
    out('stale stuck op', await state(first))
    expect((await state(first)).state).toBeDefined()
  })
  it('revoked: admit() refuses the recovery (GRANT_REVOKED, E27)', async () => {
    const tgt = target()
    const first = await stuck(tgt, 'r')
    const fix = syntheticKind('synthetic.fixr')
    const fixId = await queue(fix, [`target:${tgt}:schema`], [first])
    const r = await run(fix, async () => [{ binding: 'authorization' } as never])
    out('revoked run', { status: r.status, recoveryState: (await state(fixId)).state })
    out('revoked stuck op', await state(first))
  })
  it('blocked: a second domain of the recovery is held by another operation', async () => {
    const tgt = target()
    const cluster = `cluster:${newId('cls', Date.now())}:config`
    const holder = await (async () => {
      const k = syntheticKind('synthetic.holder', { verify: async () => 'error' })
      const id = await queue(k, [cluster]); await run(k); return id
    })()
    const first = await stuck(tgt, 'b')
    const fix = syntheticKind('synthetic.fixb')
    const fixId = await queue(fix, [`target:${tgt}:schema`, cluster], [first])
    const r = await run(fix)
    out('blocked run', { status: r.status, recoveryState: (await state(fixId)).state })
    out('blocked stuck op', await state(first))
    out('blocked holder', await state(holder))
  })
})
