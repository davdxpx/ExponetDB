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

/**
 * D0 exploratory test (verification campaign 2026-10-28, security review of the TC-005 bundle):
 * `closeSuperseded` (packages/operations/src/supersede.ts) runs in the same transaction as the start of the
 * recovery operation, but BEFORE `acquireLocks`, `kind.checkBindings` and `options.admit`
 * (driver.ts:178-183). When the recovery is refused afterwards (PLAN_STALE, GRANT_REVOKED, or a lock
 * conflict on another domain), the transaction still commits and the operation in needs_attention stays closed.
 *
 * Copy this file to packages/operations/test/ of a work copy and run it with the integration config.
 */
let db: MigratedTestDatabase
let as: ReturnType<typeof stores>

beforeAll(async () => {
  db = await migratedTestDatabase('exdb_it_d0_supersede')
  as = stores(db)
})

afterAll(async () => {
  await db?.drop()
})

async function queue(
  kind: OperationKind,
  domains: readonly string[] = [],
  supersedes?: readonly string[],
): Promise<OperationId> {
  const plan = await newPlan(as('exdb_serve'), {
    kind: kind.kind,
    domains,
    ...(supersedes === undefined ? {} : { supersedes }),
  })
  const result = await as('exdb_serve').transaction('test.accept', (tx) =>
    acceptPlan(
      tx,
      { planId: plan.planId, actor: human },
      {
        kinds: new KindRegistry([kind]),
        clock: systemClock,
        systemActor: serveActor,
        recheckPolicy: async () => ({ status: 'proceed', requirements: [] }),
      },
    ),
  )
  if (result.status !== 'accepted') throw result.error
  return result.operation.operationId
}

const run = (kind: OperationKind, admit?: Parameters<typeof processNextOperation>[1]['admit']) =>
  processNextOperation(as('exdb_worker'), {
    workerId: newId('prc', Date.now()),
    kinds: new KindRegistry([kind]),
    clock: systemClock,
    ...(admit === undefined ? {} : { admit }),
  })

async function stuck(name: string, tgt: string) {
  const kind = syntheticKind(name, { verify: async () => 'error' })
  const id = await queue(kind, [`target:${tgt}:schema`])
  await run(kind)
  expect(await readOperation(as('exdb_worker'), id)).toMatchObject({ state: 'needs_attention' })
  return id
}

describe('the operation in needs_attention is closed before the recovery is checked (D0)', () => {
  it('a recovery refused as PLAN_STALE (bindings changed) has already closed it and released its domain', async () => {
    const tgt = target()
    const first = await stuck('synthetic.d0stucka', tgt)
    // Fresh at acceptance (first call), changed at dispatch (every later call): the ledger moved in between.
    let checks = 0
    const recovery = syntheticKind('synthetic.d0fixa', {
      bindings: async () => (checks++ === 0 ? [] : [{ binding: 'ledger' }]),
    })
    const id = await queue(recovery, [`target:${tgt}:schema`], [first])
    const result = await run(recovery)
    expect(result).toMatchObject({ status: 'done', operation: { state: 'failed' } })
    expect(recovery.calls.execute).toBe(0) // the recovery did nothing ...
    // ... yet the operation it was meant to recover is closed, and the target's schema domain is free.
    expect(await readOperation(as('exdb_worker'), first)).toMatchObject({
      state: 'verification_failed',
    })
    expect(await heldLocks(as('exdb_worker'), first)).toEqual([])
    expect(await readOperation(as('exdb_worker'), id)).toMatchObject({ state: 'failed' })
  })

  it('a recovery whose identity lost its authority (admit: GRANT_REVOKED) has closed it too', async () => {
    const tgt = target()
    const first = await stuck('synthetic.d0stuckb', tgt)
    const recovery = syntheticKind('synthetic.d0fixb')
    await queue(recovery, [`target:${tgt}:schema`], [first])
    const result = await run(recovery, async () => [{ binding: 'authorization', actual: 'revoked' }])
    expect(result).toMatchObject({ status: 'done', operation: { state: 'failed' } })
    expect(recovery.calls.execute).toBe(0)
    expect(await readOperation(as('exdb_worker'), first)).toMatchObject({
      state: 'verification_failed',
    })
    expect(await heldLocks(as('exdb_worker'), first)).toEqual([])
  })

  it('a recovery that then waits for another domain has closed it and stays queued', async () => {
    const tgt = target()
    const other = target()
    const first = await stuck('synthetic.d0stuckc', tgt)
    const holder = await stuck('synthetic.d0stuckd', other) // holds target:<other>:schema in needs_attention
    const recovery = syntheticKind('synthetic.d0fixc')
    await queue(recovery, [`target:${tgt}:schema`, `target:${other}:schema`], [first])
    const result = await run(recovery)
    expect(result).toMatchObject({ status: 'waiting', blockingOperationId: holder })
    expect(await readOperation(as('exdb_worker'), first)).toMatchObject({
      state: 'verification_failed',
    })
  })
})
