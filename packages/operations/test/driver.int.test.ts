import { verifyAuditChain } from '@exponetdb/audit'
import { type MigratedTestDatabase, migratedTestDatabase } from '@exponetdb/control-store/testing'
import { newId, type OperationId, systemClock } from '@exponetdb/kernel'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  acceptPlan,
  claimNextOperation,
  expireAwaitingApprovals,
  heldLocks,
  KindRegistry,
  type OperationKind,
  processNextOperation,
  readOperation,
  requestForceRelease,
  transitionOperation,
  WORKER_ACTOR,
} from '../src/index.ts'
import {
  decision,
  human,
  newPlan,
  serveActor,
  sleep,
  stores,
  syntheticKind,
  target,
} from './support.ts'

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

  // VC-008: the claim took the oldest waiter on every tick, so one blocked operation starved all others.
  it('a blocked operation does not starve a younger one, and is not claimed again while its blocker holds', async () => {
    const parkedTarget = target()
    const freeTarget = target()
    const parkedKind = syntheticKind('synthetic.parked', { verify: async () => 'error' })
    const parked = await queue(parkedKind, [`target:${parkedTarget}:schema`])
    await run(parkedKind)
    expect((await readOperation(as('exdb_worker'), parked))?.state).toBe('needs_attention')
    // One registry, as a worker has: the older operation waits, the younger one is free.
    const waiterKind = syntheticKind('synthetic.waiter')
    const youngKind = syntheticKind('synthetic.young')
    const older = await queue(waiterKind, [`target:${parkedTarget}:schema`])
    const younger = await queue(youngKind, [`target:${freeTarget}:schema`])
    const both = (workerId = newId('prc', Date.now())) =>
      processNextOperation(as('exdb_worker'), {
        workerId,
        kinds: new KindRegistry([parkedKind, waiterKind, youngKind]),
        clock: systemClock,
      })
    expect(await both()).toMatchObject({ status: 'waiting', operationId: older })
    expect(await both()).toMatchObject({
      status: 'done',
      operation: { operationId: younger, state: 'succeeded' },
    })
    // Sixty more ticks: nothing to do, and the waiter writes no event while its blocker holds.
    const before = (await events(older)).length
    for (let i = 0; i < 60; i++) expect(await both()).toEqual({ status: 'idle' })
    expect((await events(older)).length).toBe(before)
    expect(before).toBeLessThanOrEqual(3)
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

  // VC-044: the close ran before the recovery's own locks, bindings and admission, and committed.
  it('leaves the named operation needing attention, with its lock, when the recovery is refused or waits', async () => {
    const tgt = target()
    const other = target()
    const first = await stuck('synthetic.stucke', { verify: async () => 'error' }, tgt)
    const still = async () => {
      expect(await readOperation(as('exdb_worker'), first.id)).toMatchObject({
        state: 'needs_attention',
        leaseOwner: null,
      })
      expect(await heldLocks(as('exdb_worker'), first.id)).toEqual([`target:${tgt}:schema`])
    }
    // (a) The recovery's plan is stale at dispatch: it fails, and closes nothing.
    // The target changes after the plan was accepted: stale only at dispatch.
    let changed = false
    const staleKind = syntheticKind('synthetic.fixstale', {
      bindings: async () => (changed ? [{ binding: 'fingerprint' }] : []),
    })
    const stale = await queue(staleKind, [`target:${tgt}:schema`], [first.id])
    changed = true
    expect(await run(staleKind)).toMatchObject({
      status: 'done',
      operation: { operationId: stale, state: 'failed' },
    })
    await still()
    // (b) The recovery waits for another domain held by a running operation: it closes nothing.
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const holder = syntheticKind('synthetic.holder', {
      execute: async () => {
        await gate
        return 'applied'
      },
    })
    const holding = await queue(holder, [`target:${other}:schema`])
    const running = run(holder)
    await sleep(200)
    const waitKind = syntheticKind('synthetic.fixwait')
    const waiting = await queue(
      waitKind,
      [`target:${tgt}:schema`, `target:${other}:schema`],
      [first.id],
    )
    expect(await run(waitKind)).toMatchObject({ status: 'waiting', blockingOperationId: holding })
    await still()
    // The wait is still recorded (the views read waitingFor from it).
    expect(await events(waiting)).toContain('locks_waiting')
    release()
    await running
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

// VC-006, VC-055, VC-007: needs_attention had an exit for four migration kinds only and kept its
// domains for ever. A person's force release closes it for any kind, runs nothing again and frees
// the domains; the person states what the outcome was.
describe('a force release closes an operation that needs attention, of any kind', () => {
  const stuck = async (name: string, behavior: Parameters<typeof syntheticKind>[1]) => {
    const tgt = target()
    const kind = syntheticKind(name, behavior)
    const id = await queue(kind, [`target:${tgt}:schema`])
    await run(kind)
    expect((await readOperation(as('exdb_worker'), id))?.state).toBe('needs_attention')
    return { kind, id, tgt }
  }
  const release = async (id: string, outcome: 'applied' | 'not_applied' | 'unknown') => {
    await db.asSuperuser((c) =>
      c.query(
        `INSERT INTO auth.identities (identity_id, kind, state, display_name) VALUES ($1, 'service', 'invited', 'release test')
         ON CONFLICT (identity_id) DO NOTHING`,
        [human.identityId],
      ),
    )
    await as('exdb_serve').transaction('test.release', (tx) =>
      requestForceRelease(tx, id, human.identityId as string, {
        outcome,
        reason: 'The change was checked by hand on the target.',
      }),
    )
  }
  const closing = async (id: string) => {
    const { rows } = await as('exdb_worker').query(
      'test.release.detail',
      `SELECT detail::text AS d FROM operations.operation_events
        WHERE operation_id = $1 AND kind = 'transition' ORDER BY event_id DESC LIMIT 1`,
      [id],
    )
    return JSON.parse(rows[0]?.text('d') ?? '{}') as Record<string, unknown>
  }

  it('closes an applied change whose verification errored as unverified, frees the domain, runs nothing', async () => {
    const s1 = await stuck('synthetic.relverify', { verify: async () => 'error' })
    await release(s1.id, 'applied')
    expect(await run(s1.kind)).toMatchObject({ status: 'done' })
    expect(await readOperation(as('exdb_worker'), s1.id)).toMatchObject({
      state: 'verification_failed',
      applyOutcome: 'applied',
      leaseOwner: null,
    })
    expect(await heldLocks(as('exdb_worker'), s1.id)).toEqual([])
    // Nothing ran again: one execute, one verify, as before the release.
    expect(s1.kind.calls).toEqual({ execute: 1, verify: 1, reconcile: 0 })
    expect(await closing(s1.id)).toMatchObject({
      reason: 'force_release',
      releasedBy: human.identityId,
      assertedOutcome: 'applied',
      previousApplyOutcome: 'applied',
      previousVerificationOutcome: 'error',
    })
    // The domain is free: the next operation on the target runs.
    const next = syntheticKind('synthetic.relnext')
    await queue(next, [`target:${s1.tgt}:schema`])
    expect(await run(next)).toMatchObject({ status: 'done', operation: { state: 'succeeded' } })
  })

  it('closes an unknown outcome the person found not applied as failed, not applied', async () => {
    const s2 = await stuck('synthetic.relunknown', {
      execute: async () => 'unknown',
      reconcile: async () => 'unknown',
    })
    await release(s2.id, 'not_applied')
    await run(s2.kind)
    expect(await readOperation(as('exdb_worker'), s2.id)).toMatchObject({
      state: 'failed',
      applyOutcome: 'not_applied',
      verificationOutcome: 'not_applicable',
    })
    expect(await heldLocks(as('exdb_worker'), s2.id)).toEqual([])
    expect(await closing(s2.id)).toMatchObject({
      assertedOutcome: 'not_applied',
      previousApplyOutcome: 'unknown',
    })
  })

  it('records one open request per operation, and a finished operation is never touched', async () => {
    const s3 = await stuck('synthetic.reltwice', { verify: async () => 'error' })
    await release(s3.id, 'unknown')
    await release(s3.id, 'unknown')
    const { rows } = await as('exdb_worker').query(
      'test.release.count',
      'SELECT count(*)::int AS n FROM recovery.force_releases WHERE operation_id = $1',
      [s3.id],
    )
    expect(rows[0]?.int('n')).toBe(1)
    await run(s3.kind)
    expect((await readOperation(as('exdb_worker'), s3.id))?.state).toBe('verification_failed')
    // A request recorded later for the finished operation changes nothing.
    await release(s3.id, 'unknown')
    expect(await run(s3.kind)).toMatchObject({ status: 'idle' })
    expect((await readOperation(as('exdb_worker'), s3.id))?.state).toBe('verification_failed')
  })
})

// VC-057 / OD-64: nothing ended an operation awaiting approval.
describe('the approval window', () => {
  it('cancels an operation that awaited approval for more than four hours, and only that one', async () => {
    const kind = syntheticKind('synthetic.approval')
    const needsApproval = async () =>
      newPlan(as('exdb_serve'), {
        kind: kind.kind,
        domains: [`target:${target()}:schema`],
        decision: await decision('require', [
          { kind: 'approval', count: 1, permission: 'plans.approve' },
        ]),
      })
    const plan = await needsApproval()
    const accept = (planId: string) =>
      as('exdb_serve').transaction('test.accept.approval', (tx) =>
        acceptPlan(
          tx,
          { planId: planId as never, actor: human },
          {
            kinds: new KindRegistry([kind]),
            clock: systemClock,
            systemActor: serveActor,
            recheckPolicy: async () => ({
              status: 'proceed',
              requirements: [{ kind: 'approval', count: 1, permission: 'plans.approve' }],
            }),
          },
        ),
      )
    const old = await accept(plan.planId)
    const fresh = await accept((await needsApproval()).planId)
    if (old.status !== 'accepted' || fresh.status !== 'accepted') throw new Error('not accepted')
    expect([old.operation.state, fresh.operation.state]).toEqual([
      'awaiting_approval',
      'awaiting_approval',
    ])
    await db.asSuperuser(async (c) => {
      await c.query('BEGIN')
      await c.query('SET LOCAL session_replication_role = replica')
      await c.query(
        `UPDATE operations.operations SET created_at = clock_timestamp() - interval '4 hours 1 minute'
          WHERE operation_id = $1`,
        [old.operation.operationId],
      )
      await c.query('COMMIT')
    })
    const ended = await as('exdb_worker').transaction('test.approvals.expire', (tx) =>
      expireAwaitingApprovals(tx, WORKER_ACTOR, { clock: systemClock }),
    )
    expect(ended).toBe(1)
    expect((await readOperation(as('exdb_worker'), old.operation.operationId))?.state).toBe(
      'canceled',
    )
    expect((await readOperation(as('exdb_worker'), fresh.operation.operationId))?.state).toBe(
      'awaiting_approval',
    )
    const { rows } = await as('exdb_worker').query(
      'test.approvals.expired',
      `SELECT detail ->> 'errorCode' AS code FROM operations.operation_events
        WHERE operation_id = $1 AND to_state = 'canceled'`,
      [old.operation.operationId],
    )
    expect(rows[0]?.text('code')).toBe('APPROVAL_EXPIRED')
  })
})

// VC-058, VC-007: an unknown outcome parked in needs_attention after one reconcile and was never
// looked at again, even once the target answered; the change was committed (or not) all along.
describe('an unknown outcome is reconciled again later', () => {
  const age = (id: string) =>
    db.asSuperuser(async (c) => {
      await c.query('BEGIN')
      await c.query('SET LOCAL session_replication_role = replica')
      await c.query(
        `UPDATE operations.operations SET updated_at = clock_timestamp() - interval '6 minutes'
          WHERE operation_id = $1`,
        [id],
      )
      await c.query('COMMIT')
    })
  const parked = async (name: string, later: 'applied' | 'not_applied' | 'unknown') => {
    let answer: 'applied' | 'not_applied' | 'unknown' = 'unknown'
    const kind = syntheticKind(name, {
      execute: async () => 'unknown',
      reconcile: async () => answer,
    })
    const id = await queue(kind, [`target:${target()}:schema`])
    await run(kind)
    expect(await readOperation(as('exdb_worker'), id)).toMatchObject({
      state: 'needs_attention',
      applyOutcome: 'unknown',
    })
    // Not again at once: the next attempt waits five minutes.
    expect(await run(kind)).toEqual({ status: 'idle' })
    answer = later
    await age(id)
    return { kind, id }
  }

  it('verifies and succeeds once the ledger shows the change applied, running nothing again', async () => {
    const { kind, id } = await parked('synthetic.lateapplied', 'applied')
    expect(await run(kind)).toMatchObject({
      status: 'done',
      operation: { operationId: id, state: 'succeeded', applyOutcome: 'applied' },
    })
    expect(kind.calls).toEqual({ execute: 1, verify: 1, reconcile: 2 })
    expect(await heldLocks(as('exdb_worker'), id)).toEqual([])
  })

  it('fails as not applied once the target shows nothing was applied', async () => {
    const { kind, id } = await parked('synthetic.latenot', 'not_applied')
    expect(await run(kind)).toMatchObject({
      status: 'done',
      operation: { operationId: id, state: 'failed', applyOutcome: 'not_applied' },
    })
    expect(await heldLocks(as('exdb_worker'), id)).toEqual([])
  })

  it('keeps needing attention, unleased, while the outcome stays unknown', async () => {
    const { kind, id } = await parked('synthetic.lateunknown', 'unknown')
    await run(kind)
    expect(await readOperation(as('exdb_worker'), id)).toMatchObject({
      state: 'needs_attention',
      applyOutcome: 'unknown',
      leaseOwner: null,
    })
    expect(kind.calls.execute).toBe(1)
  })
})
