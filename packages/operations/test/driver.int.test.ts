import { verifyAuditChain } from '@exponetdb/audit'
import { type MigratedTestDatabase, migratedTestDatabase } from '@exponetdb/control-store/testing'
import { newId, type OperationId, systemClock } from '@exponetdb/kernel'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  acceptPlan,
  claimNextOperation,
  heldLocks,
  KindRegistry,
  type OperationKind,
  processNextOperation,
  readOperation,
  transitionOperation,
  WORKER_ACTOR,
} from '../src/index.ts'
import { human, newPlan, serveActor, sleep, stores, syntheticKind, target } from './support.ts'

/**
 * The worker loop with synthetic kinds against PostgreSQL 17: every path of
 * the state machine, with the outcome reported by the kind, never inferred;
 * a takeover reconciles instead of executing again.
 */
let db: MigratedTestDatabase
let as: ReturnType<typeof stores>

beforeAll(async () => {
  db = await migratedTestDatabase('exdb_it_driver')
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
  if (result.status !== 'accepted') {
    throw result.error
  }
  return result.operation.operationId
}

const run = (kind: OperationKind, workerId = newId('prc', Date.now())) =>
  processNextOperation(as('exdb_worker'), {
    workerId,
    kinds: new KindRegistry([kind]),
    clock: systemClock,
  })

async function events(operationId: string): Promise<string[]> {
  const { rows } = await as('exdb_worker').query(
    'test.events',
    `SELECT kind || coalesce(':' || to_state, '') || coalesce(':' || (detail ->> 'step'), '') AS e
       FROM operations.operation_events WHERE operation_id = $1 ORDER BY event_id`,
    [operationId],
  )
  return rows.map((r) => r.text('e'))
}

describe('the worker loop', () => {
  it('applies, verifies and succeeds; locks are held while working and released at the end', async () => {
    const tgt = target()
    let lockedDuringExecute: readonly string[] = []
    const kind = syntheticKind('synthetic.ok', {
      execute: async (ctx) => {
        lockedDuringExecute = await heldLocks(as('exdb_worker'), ctx.operationId)
        return 'applied'
      },
    })
    const id = await queue(kind, [`target:${tgt}:schema`])
    const result = await run(kind)
    expect(result).toMatchObject({
      status: 'done',
      operation: { state: 'succeeded', applyOutcome: 'applied', verificationOutcome: 'passed' },
    })
    expect(lockedDuringExecute).toEqual([`target:${tgt}:schema`])
    expect(await heldLocks(as('exdb_worker'), id)).toEqual([])
    expect(kind.calls).toEqual({ execute: 1, verify: 1, reconcile: 0 })
    expect(await events(id)).toEqual([
      'created:queued',
      'lease_acquired:queued',
      'locks_acquired',
      'transition:running',
      'step_started:execute',
      'step_finished:execute',
      'transition:verifying',
      'step_started:verify',
      'step_finished:verify',
      'transition:succeeded',
      'locks_released',
    ])
    expect(await run(kind)).toEqual({ status: 'idle' })
  })

  it('records each reported outcome truthfully', async () => {
    const cases: [string, Parameters<typeof syntheticKind>[1], object][] = [
      [
        'synthetic.notapplied',
        { execute: async () => 'not_applied' },
        { state: 'failed', applyOutcome: 'not_applied' },
      ],
      [
        'synthetic.verifyfail',
        { verify: async () => 'failed' },
        { state: 'verification_failed', applyOutcome: 'applied', verificationOutcome: 'failed' },
      ],
      [
        'synthetic.verifypartial',
        { execute: async () => 'partially_applied', verify: async () => 'partial' },
        {
          state: 'verification_failed',
          applyOutcome: 'partially_applied',
          verificationOutcome: 'partial',
        },
      ],
      [
        'synthetic.verifyerror',
        { verify: async () => 'error' },
        { state: 'needs_attention', applyOutcome: 'applied', verificationOutcome: 'error' },
      ],
      [
        'synthetic.noverify',
        { verifies: false },
        { state: 'succeeded', applyOutcome: 'applied', verificationOutcome: 'not_applicable' },
      ],
      [
        'synthetic.unknown',
        { execute: async () => 'unknown', reconcile: async () => 'applied' },
        { state: 'succeeded', applyOutcome: 'applied', verificationOutcome: 'passed' },
      ],
      [
        'synthetic.throws',
        {
          execute: async () => {
            throw new Error('connection lost after COMMIT')
          },
          reconcile: async () => 'not_applied',
        },
        { state: 'failed', applyOutcome: 'not_applied' },
      ],
      [
        'synthetic.inconclusive',
        { execute: async () => 'unknown' },
        { state: 'needs_attention', applyOutcome: 'unknown' },
      ],
    ]
    for (const [name, behavior, expected] of cases) {
      const kind = syntheticKind(name, behavior)
      await queue(kind)
      const result = await run(kind)
      expect(result, name).toMatchObject({ status: 'done', operation: expected })
      expect(kind.calls.execute, `${name} executes once`).toBe(1)
    }
  })

  it('a stale binding under the lock fails the operation before anything executes', async () => {
    let stale = false
    const kind = syntheticKind('synthetic.stale', {
      bindings: async () => (stale ? [{ binding: 'ledgerStateHash' }] : []),
    })
    const id = await queue(kind)
    stale = true
    expect(await run(kind)).toMatchObject({
      status: 'done',
      operation: { state: 'failed', applyOutcome: 'not_started' },
    })
    expect(kind.calls.execute).toBe(0)
    const { rows } = await as('exdb_worker').query(
      'test.audit.stale',
      `SELECT event::jsonb -> 'result' ->> 'errorCode' AS code FROM audit.audit_events
        WHERE operation_id = $1 AND action = 'operation.state_changed' ORDER BY seq DESC LIMIT 1`,
      [id],
    )
    expect(rows[0]?.text('code')).toBe('PLAN_STALE')
  })

  it('a refused execution fails with the catalog code and detail it reported', async () => {
    const kind = syntheticKind('synthetic.refused', {
      execute: async () => ({
        outcome: 'not_applied' as const,
        errorCode: 'TARGET_REGISTRATION_REFUSED',
        detail: { reason: 'control_store' },
      }),
    })
    const id = await queue(kind)
    expect(await run(kind)).toMatchObject({
      status: 'done',
      operation: { state: 'failed', applyOutcome: 'not_applied' },
    })
    const { rows } = await as('exdb_worker').query(
      'test.events.refused',
      `SELECT detail ->> 'errorCode' AS code, detail ->> 'reason' AS reason FROM operations.operation_events
        WHERE operation_id = $1 AND kind = 'transition' AND to_state = 'failed'`,
      [id],
    )
    expect(rows[0]?.text('code')).toBe('TARGET_REGISTRATION_REFUSED')
    expect(rows[0]?.text('reason')).toBe('control_store')
  })

  it('an operation waits for a held domain and runs once it is free', async () => {
    const tgt = target()
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const slow = syntheticKind('synthetic.slow', {
      execute: async () => {
        await gate
        return 'applied'
      },
    })
    const second = syntheticKind('synthetic.second')
    const first = await queue(slow, [`target:${tgt}:maintenance`])
    const waiting = await queue(second, [`target:${tgt}:schema`])
    const running = run(slow)
    await sleep(200)
    const blocked = await run(second)
    expect(blocked).toEqual({ status: 'waiting', operationId: waiting, blockingOperationId: first })
    expect((await readOperation(as('exdb_worker'), waiting))?.state).toBe('queued')
    release()
    expect(await running).toMatchObject({ operation: { state: 'succeeded' } })
    expect(await run(second)).toMatchObject({
      operation: { operationId: waiting, state: 'succeeded' },
    })
  })

  it('a takeover reconciles and never executes again', async () => {
    const kind = syntheticKind('synthetic.takeover', { reconcile: async () => 'applied' })
    const id = await queue(kind)
    const dead = newId('prc', Date.now())
    const claim = await claimNextOperation(as('exdb_worker'), {
      workerId: dead,
      kinds: [kind.kind],
      clock: systemClock,
      leaseMs: 200,
    })
    expect(claim?.operation.operationId).toBe(id)
    await as('exdb_worker').transaction('test.start', (tx) =>
      transitionOperation(
        tx,
        {
          operationId: id,
          from: 'queued',
          to: 'running',
          lease: { owner: dead },
          actor: WORKER_ACTOR,
        },
        { clock: systemClock },
      ),
    )
    // The worker dies while "executing": no outcome is recorded, the lease expires.
    await sleep(300)
    const result = await run(kind)
    expect(result).toMatchObject({
      status: 'done',
      takenOver: true,
      operation: { operationId: id, state: 'succeeded', applyOutcome: 'applied' },
    })
    expect(kind.calls).toEqual({ execute: 0, verify: 1, reconcile: 1 })
    expect(await events(id)).toContain('transition:needs_reconciliation')
  })
})

describe('the audit chain', () => {
  it('verifies after every path above', async () => {
    const verified = await verifyAuditChain(as('exdb_serve'))
    expect(verified).toMatchObject({ ok: true })
  })
})

describe('a recovery operation closes the needs_attention operation that holds its domain (TC-005, MIG-01)', () => {
  const stuck = async (
    name: string,
    behavior: Parameters<typeof syntheticKind>[1],
    tgt: string,
  ) => {
    const kind = syntheticKind(name, behavior)
    const id = await queue(kind, [`target:${tgt}:schema`])
    await run(kind)
    return { kind, id }
  }
  const recover = (name: string, tgt: string, ...named: string[]) => {
    const kind = syntheticKind(name)
    return queue(kind, [`target:${tgt}:schema`], named).then((id) => ({ kind, id }))
  }

  it('is blocked for ever without the plan naming it, and runs with it', async () => {
    const tgt = target()
    const first = await stuck('synthetic.stucka', { verify: async () => 'error' }, tgt)
    expect(await readOperation(as('exdb_worker'), first.id)).toMatchObject({
      state: 'needs_attention',
      applyOutcome: 'applied',
      verificationOutcome: 'error',
    })
    // An ordinary plan waits behind it: nothing releases the domain.
    const plain = await recover('synthetic.plaina', tgt)
    expect(await run(plain.kind)).toMatchObject({
      status: 'waiting',
      blockingOperationId: first.id,
    })
    // The recovery names it: the domain is taken in the same transaction, and the plan runs.
    const fix = await recover('synthetic.fixa', tgt, first.id)
    expect(await run(fix.kind)).toMatchObject({
      status: 'done',
      operation: { state: 'succeeded', applyOutcome: 'applied', verificationOutcome: 'passed' },
    })
    expect(await readOperation(as('exdb_worker'), first.id)).toMatchObject({
      state: 'verification_failed',
      applyOutcome: 'applied',
      verificationOutcome: 'failed',
      leaseOwner: null,
    })
    expect(await heldLocks(as('exdb_worker'), first.id)).toEqual([])
    expect(await heldLocks(as('exdb_worker'), fix.id)).toEqual([])
    expect(await events(first.id)).toEqual([
      'created:queued',
      'lease_acquired:queued',
      'locks_acquired',
      'transition:running',
      'step_started:execute',
      'step_finished:execute',
      'transition:verifying',
      'step_started:verify',
      'step_finished:verify',
      'transition:needs_attention',
      'transition:verification_failed',
      'locks_released',
    ])
    // The closing event names who superseded it and what the outcome was before.
    const { rows } = await as('exdb_worker').query(
      'test.superseded',
      `SELECT detail::text AS detail FROM operations.operation_events
        WHERE operation_id = $1 AND to_state = 'verification_failed'`,
      [first.id],
    )
    expect(rows[0]?.text('detail')).toContain(fix.id)
    // The next ordinary plan is admitted.
    expect(await run(plain.kind)).toMatchObject({
      status: 'done',
      operation: { state: 'succeeded' },
    })
  })

  it('closes an operation whose outcome is unknown as partially applied, and says so', async () => {
    const tgt = target()
    const first = await stuck('synthetic.stuckb', { execute: async () => 'unknown' }, tgt)
    expect(await readOperation(as('exdb_worker'), first.id)).toMatchObject({
      state: 'needs_attention',
      applyOutcome: 'unknown',
    })
    const fix = await recover('synthetic.fixb', tgt, first.id)
    await run(fix.kind)
    expect(await readOperation(as('exdb_worker'), first.id)).toMatchObject({
      state: 'verification_failed',
      applyOutcome: 'partially_applied',
      verificationOutcome: 'failed',
    })
    const { rows } = await as('exdb_worker').query(
      'test.superseded.detail',
      `SELECT detail->>'previousApplyOutcome' AS before, detail->>'supersededBy' AS by
         FROM operations.operation_events WHERE operation_id = $1 AND to_state = 'verification_failed'`,
      [first.id],
    )
    expect(rows[0]?.text('before')).toBe('unknown')
    expect(rows[0]?.text('by')).toBe(fix.id)
  })

  it('closes only an operation in needs_attention that holds a domain the recovery needs', async () => {
    const tgt = target()
    const other = target()
    const first = await stuck('synthetic.stuckc', { verify: async () => 'error' }, tgt)
    // Another target's plan naming it takes no part in it.
    const elsewhere = await recover('synthetic.fixc', other, first.id)
    expect(await run(elsewhere.kind)).toMatchObject({
      status: 'done',
      operation: { state: 'succeeded' },
    })
    expect(await readOperation(as('exdb_worker'), first.id)).toMatchObject({
      state: 'needs_attention',
    })
    expect(await heldLocks(as('exdb_worker'), first.id)).toEqual([`target:${tgt}:schema`])
    // An operation that is finished, or unknown, is left as it is and the plan simply runs.
    const done = await recover(
      'synthetic.fixd',
      other,
      first.id,
      'op_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z',
      'not an id',
    )
    expect(await run(done.kind)).toMatchObject({
      status: 'done',
      operation: { state: 'succeeded' },
    })
  })
})
