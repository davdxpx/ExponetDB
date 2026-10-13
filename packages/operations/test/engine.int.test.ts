import { verifyAuditChain } from '@exponetdb/audit'
import { type MigratedTestDatabase, migratedTestDatabase } from '@exponetdb/control-store/testing'
import { newId, systemClock } from '@exponetdb/kernel'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type AcceptDependencies,
  APPLY_OUTCOMES,
  acceptPlan,
  admits,
  canTransition,
  claimNextOperation,
  expirePlans,
  KindRegistry,
  MAX_PENDING_APPROVALS,
  OPERATION_STATES,
  type OperationRecord,
  readOperation,
  readPlan,
  readPolicySettings,
  renewLease,
  transitionOperation,
  VERIFICATION_OUTCOMES,
  WORKER_ACTOR,
  withdrawPlan,
} from '../src/index.ts'
import {
  decision,
  human,
  newPlan,
  otherHuman,
  serveActor,
  sleep,
  sqlstate,
  stores,
  syntheticKind,
} from './support.ts'

/**
 * The Operations Engine skeleton against PostgreSQL 17 with synthetic kinds:
 * the state machine in code and in the database agree, acceptance is
 * idempotent under concurrency, every transition is audited in its own
 * transaction, leases and takeovers never continue blindly.
 */
let db: MigratedTestDatabase
let as: ReturnType<typeof stores>
const synthetic = syntheticKind('synthetic.apply')
const registry = new KindRegistry([synthetic])
const deps = (overrides: Partial<AcceptDependencies> = {}): AcceptDependencies => ({
  kinds: registry,
  clock: systemClock,
  systemActor: serveActor,
  recheckPolicy: async () => ({ status: 'proceed', requirements: [] }),
  ...overrides,
})

const accept = (planId: string, actor = human, d = deps()) =>
  as('exdb_serve').transaction('test.accept', (tx) => acceptPlan(tx, { planId, actor }, d))

async function accepted(planId: string): Promise<OperationRecord> {
  const result = await accept(planId)
  if (result.status !== 'accepted') {
    throw result.error
  }
  return result.operation
}

beforeAll(async () => {
  db = await migratedTestDatabase('exdb_it_operations')
  as = stores(db)
})

afterAll(async () => {
  await db?.drop()
})

describe('the database enforces the same state machine', () => {
  it('transition_allowed and state_admits agree with the code for every input', async () => {
    const { rows } = await as('exdb_worker').query(
      'test.sm.transitions',
      `SELECT f, t, operations.transition_allowed(f, t) AS ok FROM unnest($1::text[]) f, unnest($1::text[]) t`,
      [OPERATION_STATES],
    )
    expect(rows).toHaveLength(OPERATION_STATES.length ** 2)
    for (const r of rows) {
      const from = OPERATION_STATES.find((s) => s === r.text('f'))
      const to = OPERATION_STATES.find((s) => s === r.text('t'))
      if (from === undefined || to === undefined) {
        throw new Error('unexpected state')
      }
      expect(r.bool('ok'), `${from}->${to}`).toBe(canTransition(from, to))
    }
    const admitted = await as('exdb_worker').query(
      'test.sm.admits',
      `SELECT s, a, v, operations.state_admits(s, a, v) AS ok
         FROM unnest($1::text[]) s, unnest($2::text[]) a, unnest($3::text[]) v`,
      [OPERATION_STATES, APPLY_OUTCOMES, VERIFICATION_OUTCOMES],
    )
    for (const r of admitted.rows) {
      const s = OPERATION_STATES.find((x) => x === r.text('s'))
      const a = APPLY_OUTCOMES.find((x) => x === r.text('a'))
      const v = VERIFICATION_OUTCOMES.find((x) => x === r.text('v'))
      if (s === undefined || a === undefined || v === undefined) {
        throw new Error('unexpected value')
      }
      expect(r.bool('ok'), `${s}/${a}/${v}`).toBe(admits(s, a, v))
    }
  })

  it('refuses invalid transitions, outcome mismatches and changes to finished operations by anyone', async () => {
    const op = await accepted((await newPlan(as('exdb_serve'))).planId)
    const worker = as('exdb_worker')
    const set = (sql: string) =>
      sqlstate(worker, `UPDATE operations.operations SET ${sql} WHERE operation_id = $1`, [
        op.operationId,
      ])
    expect(await set("state = 'succeeded'")).toBe('EXO01')
    expect(await set("state = 'running'")).toBe('EXO01')
    expect(await set("apply_outcome = 'applied'")).toBe('EXO01')
    expect(await set("kind = 'other.kind'")).toBe('42501')
    expect(
      await sqlstate(
        as('exdb_migrate'),
        "UPDATE operations.operations SET kind = 'other.kind' WHERE operation_id = $1",
        [op.operationId],
      ),
    ).toBe('EXO01')
    expect(
      await sqlstate(worker, 'DELETE FROM operations.operations WHERE operation_id = $1', [
        op.operationId,
      ]),
    ).toBe('42501')
    expect(await set("state = 'canceled', verification_outcome = 'not_applicable'")).toBeUndefined()
    expect(await set("state = 'queued', verification_outcome = 'pending'")).toBe('EXO01')
    expect(
      await sqlstate(
        as('exdb_migrate'),
        "UPDATE operations.operations SET state = 'queued' WHERE operation_id = $1",
        [op.operationId],
      ),
    ).toBe('EXO01')
  })

  it('serve may only approve or cancel before execution', async () => {
    const op = await accepted((await newPlan(as('exdb_serve'))).planId)
    const serve = as('exdb_serve')
    expect(
      await sqlstate(
        serve,
        "UPDATE operations.operations SET lease_owner = 'prc_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z' WHERE operation_id = $1",
        [op.operationId],
      ),
    ).toBe('42501')
    expect(
      await sqlstate(
        serve,
        "UPDATE operations.operations SET state = 'failed', verification_outcome = 'not_applicable' WHERE operation_id = $1",
        [op.operationId],
      ),
    ).toBe('EXO02')
    expect(
      await sqlstate(
        serve,
        "UPDATE operations.operations SET state = 'canceled', verification_outcome = 'not_applicable' WHERE operation_id = $1",
        [op.operationId],
      ),
    ).toBeUndefined()
  })

  it('plans: bindings immutable, one exit from active, bodies must hash to the plan hash', async () => {
    const plan = await newPlan(as('exdb_serve'))
    const serve = as('exdb_serve')
    expect(
      await sqlstate(
        as('exdb_migrate'),
        "UPDATE operations.plans SET kind = 'x.y' WHERE plan_id = $1",
        [plan.planId],
      ),
    ).toBe('EXO01')
    expect(
      await sqlstate(serve, "UPDATE operations.plans SET state = 'denied' WHERE plan_id = $1", [
        plan.planId,
      ]),
    ).toBe('EXO01')
    expect(
      await sqlstate(serve, "UPDATE operations.plans SET state = 'expired' WHERE plan_id = $1", [
        plan.planId,
      ]),
    ).toBe('EXO01')
    expect(
      await sqlstate(serve, "UPDATE operations.plans SET state = 'withdrawn' WHERE plan_id = $1", [
        plan.planId,
      ]),
    ).toBeUndefined()
    expect(
      await sqlstate(serve, "UPDATE operations.plans SET state = 'active' WHERE plan_id = $1", [
        plan.planId,
      ]),
    ).toBe('EXO01')
    const other = newId('pln', Date.now())
    await as('exdb_migrate').query(
      'test.plan.copy',
      `INSERT INTO operations.plans (plan_id, kind, kind_version, action_class, state, decision, plan_hash, content_checksum,
         policy_version, actor_kind, actor_id, client_kind, client_id, target_id, tier, created_at, expires_at)
       SELECT $2, kind, kind_version, action_class, 'active', decision, 'sha256:' || repeat('0', 64), content_checksum,
         policy_version, actor_kind, actor_id, client_kind, client_id, target_id, tier, created_at, expires_at
         FROM operations.plans WHERE plan_id = $1`,
      [plan.planId, other],
    )
    expect(
      await sqlstate(
        serve,
        `INSERT INTO operations.plan_bodies (plan_id, body) VALUES ($1, '{"forged":true}')`,
        [other],
      ),
    ).toBe('EXO03')
    expect(await sqlstate(serve, 'DELETE FROM operations.plans')).toBe('42501')
  })
})

describe('plans and acceptance', () => {
  it('creates an audited plan whose body hashes to its plan hash', async () => {
    const plan = await newPlan(as('exdb_serve'))
    expect(plan.state).toBe('active')
    const stored = await readPlan(as('exdb_serve'), plan.planId)
    expect(stored?.planHash).toBe(plan.planHash)
    expect(stored?.body['id']).toBe(plan.planId)
    const { rows } = await as('exdb_serve').query(
      'test.audit.plan',
      `SELECT count(*)::int AS n FROM audit.audit_events WHERE plan_id = $1 AND action = 'plan.created'`,
      [plan.planId],
    )
    expect(rows[0]?.int('n')).toBe(1)
  })

  it('a denied plan exists for explanation and can never be applied', async () => {
    const plan = await newPlan(as('exdb_serve'), { decision: await decision('deny') })
    expect(plan.state).toBe('denied')
    expect(await accept(plan.planId)).toMatchObject({
      status: 'refused',
      error: { code: 'PLAN_DENIED' },
    })
  })

  it('accepting is idempotent for the same caller and refused for anyone else', async () => {
    const plan = await newPlan(as('exdb_serve'))
    const first = await accept(plan.planId)
    expect(first).toMatchObject({
      status: 'accepted',
      alreadyAccepted: false,
      operation: { state: 'queued' },
    })
    const again = await accept(plan.planId)
    expect(again).toMatchObject({ status: 'accepted', alreadyAccepted: true })
    if (first.status === 'accepted' && again.status === 'accepted') {
      expect(again.operation.operationId).toBe(first.operation.operationId)
    }
    expect(await accept(plan.planId, otherHuman)).toMatchObject({
      status: 'refused',
      error: { code: 'PLAN_ALREADY_USED' },
    })
  })

  it('concurrent acceptances by the same caller create exactly one operation', async () => {
    const plan = await newPlan(as('exdb_serve'))
    const results = await Promise.all(Array.from({ length: 8 }, () => accept(plan.planId)))
    const ops = new Set(
      results.map((r) => (r.status === 'accepted' ? r.operation.operationId : 'refused')),
    )
    expect(ops.size).toBe(1)
    expect(results.filter((r) => r.status === 'accepted' && !r.alreadyAccepted)).toHaveLength(1)
    const { rows } = await as('exdb_serve').query(
      'test.ops.by_plan',
      'SELECT count(*)::int AS n FROM operations.operations WHERE plan_id = $1',
      [plan.planId],
    )
    expect(rows[0]?.int('n')).toBe(1)
  })

  it('another caller cannot apply a plan they did not create', async () => {
    const plan = await newPlan(as('exdb_serve'))
    expect(await accept(plan.planId, otherHuman)).toMatchObject({
      status: 'refused',
      error: { code: 'PLAN_BINDING_ACTOR' },
    })
    expect(await accept(plan.planId, { ...human, client: 'mcp' })).toMatchObject({
      status: 'refused',
      error: { code: 'PLAN_BINDING_ACTOR' },
    })
  })

  it('expired, withdrawn and unknown plans are refused', async () => {
    const short = await newPlan(as('exdb_serve'), { lifetimeMs: 50 })
    await sleep(80)
    expect(await accept(short.planId)).toMatchObject({
      status: 'refused',
      error: { code: 'PLAN_EXPIRED' },
    })
    expect(
      await as('exdb_worker').transaction('test.expire', (tx) =>
        expirePlans(tx, WORKER_ACTOR, { clock: systemClock }),
      ),
    ).toBeGreaterThanOrEqual(1)
    expect((await readPlan(as('exdb_serve'), short.planId))?.state).toBe('expired')
    const withdrawn = await newPlan(as('exdb_serve'))
    await as('exdb_serve').transaction('test.withdraw', (tx) =>
      withdrawPlan(tx, withdrawn.planId, human, { clock: systemClock }),
    )
    expect(await accept(withdrawn.planId)).toMatchObject({
      status: 'refused',
      error: { code: 'PLAN_STALE' },
    })
    expect(await accept(newId('pln', Date.now()))).toMatchObject({
      status: 'refused',
      error: { code: 'PLAN_NOT_FOUND' },
    })
  })

  it('a failing binding or a stricter policy invalidates the plan (persisted) and refuses', async () => {
    const stale = syntheticKind('synthetic.apply', {
      bindings: async () => [{ binding: 'schemaFingerprint' }],
    })
    const plan = await newPlan(as('exdb_serve'))
    const result = await accept(plan.planId, human, deps({ kinds: new KindRegistry([stale]) }))
    expect(result).toMatchObject({
      status: 'refused',
      error: { code: 'PLAN_STALE', changedBindings: [{ binding: 'schemaFingerprint' }] },
    })
    expect((await readPlan(as('exdb_serve'), plan.planId))?.state).toBe('invalidated')

    const plan2 = await newPlan(as('exdb_serve'))
    const stricter = await accept(
      plan2.planId,
      human,
      deps({ recheckPolicy: async () => ({ status: 'stale', reason: 'decision_stricter' }) }),
    )
    expect(stricter).toMatchObject({ status: 'refused', error: { code: 'PLAN_STALE' } })
    expect((await readPlan(as('exdb_serve'), plan2.planId))?.state).toBe('invalidated')
  })

  it('requirements: approvals wait; anything else unmet refuses (fail closed)', async () => {
    const approval = await newPlan(as('exdb_serve'), {
      decision: await decision('require', [
        { kind: 'approval', count: 1, permission: 'plans.approve' },
      ]),
    })
    expect(await accept(approval.planId)).toMatchObject({
      status: 'accepted',
      operation: { state: 'awaiting_approval' },
    })
    const reauth = await newPlan(as('exdb_serve'), {
      decision: await decision('require', [{ kind: 'reauth', withinSeconds: 300 }]),
    })
    expect(await accept(reauth.planId)).toMatchObject({
      status: 'refused',
      error: { code: 'REAUTH_REQUIRED' },
    })
    const met = await accept(reauth.planId, human, deps({ requirementMet: async () => true }))
    expect(met).toMatchObject({ status: 'accepted', operation: { state: 'queued' } })
  })

  it('at most 20 operations of one actor and client wait for an approval; the plan stays active', async () => {
    // A caller (an agent above all) cannot fill a person's approval queue.
    const busy = { ...human, identityId: otherHuman.identityId, client: 'cli' as const }
    const waits = async () =>
      newPlan(as('exdb_serve'), {
        actor: busy,
        decision: await decision('require', [
          { kind: 'approval', count: 1, permission: 'plans.approve' },
        ]),
      })
    const operations: string[] = []
    for (let i = 0; i < MAX_PENDING_APPROVALS; i++) {
      const result = await accept((await waits()).planId, busy)
      expect(result).toMatchObject({
        status: 'accepted',
        operation: { state: 'awaiting_approval' },
      })
      if (result.status === 'accepted') operations.push(result.operation.operationId)
    }
    const over = await waits()
    expect(await accept(over.planId, busy)).toMatchObject({
      status: 'refused',
      error: { code: 'APPROVALS_PENDING_LIMIT' },
    })
    const still = await as('exdb_serve').transaction('test.plan', (tx) => readPlan(tx, over.planId))
    expect(still?.state).toBe('active')
    // The bound is per client: the same person through the Web App is not affected.
    const web = { ...busy, client: 'web' as const }
    const elsewhere = await newPlan(as('exdb_serve'), {
      actor: web,
      decision: await decision('require', [
        { kind: 'approval', count: 1, permission: 'plans.approve' },
      ]),
    })
    expect(await accept(elsewhere.planId, web)).toMatchObject({ status: 'accepted' })
    // A plan that needs no approval is never counted against it.
    const plain = await newPlan(as('exdb_serve'), { actor: busy })
    expect(await accept(plain.planId, busy)).toMatchObject({
      status: 'accepted',
      operation: { state: 'queued' },
    })
    // Once one waiting operation is decided (here: canceled), the next is accepted.
    const first = operations[0] ?? ''
    await as('exdb_serve').transaction('test.cancel', (tx) =>
      transitionOperation(
        tx,
        {
          operationId: first as never,
          from: 'awaiting_approval',
          to: 'canceled',
          verificationOutcome: 'not_applicable',
          actor: busy,
        },
        { clock: systemClock },
      ),
    )
    expect(await accept(over.planId, busy)).toMatchObject({
      status: 'accepted',
      operation: { state: 'awaiting_approval' },
    })
  })
})

describe('transitions are audited atomically', () => {
  it('when the audit append fails, the transition does not happen', async () => {
    const op = await accepted((await newPlan(as('exdb_serve'))).planId)
    await db.asSuperuser((c) => c.query('REVOKE INSERT ON audit.audit_events FROM exdb_serve'))
    try {
      await expect(
        as('exdb_serve').transaction('test.cancel', (tx) =>
          transitionOperation(
            tx,
            {
              operationId: op.operationId,
              from: 'queued',
              to: 'canceled',
              verificationOutcome: 'not_applicable',
              actor: serveActor,
            },
            { clock: systemClock },
          ),
        ),
      ).rejects.toMatchObject({ code: 'audit_append_failed' })
    } finally {
      await db.asSuperuser((c) => c.query('GRANT INSERT ON audit.audit_events TO exdb_serve'))
    }
    expect((await readOperation(as('exdb_serve'), op.operationId))?.state).toBe('queued')
    const events = await as('exdb_serve').query(
      'test.events',
      `SELECT count(*)::int AS n FROM operations.operation_events WHERE operation_id = $1 AND kind = 'transition'`,
      [op.operationId],
    )
    expect(events.rows[0]?.int('n')).toBe(0)
  })

  it('the API refuses what the state machine forbids before touching the database', async () => {
    const op = await accepted((await newPlan(as('exdb_serve'))).planId)
    await expect(
      as('exdb_worker').transaction('test.bad', (tx) =>
        transitionOperation(
          tx,
          { operationId: op.operationId, from: 'queued', to: 'succeeded', actor: WORKER_ACTOR },
          { clock: systemClock },
        ),
      ),
    ).rejects.toMatchObject({ code: 'operation_transition_invalid' })
    await expect(
      as('exdb_worker').transaction('test.bad2', (tx) =>
        transitionOperation(
          tx,
          {
            operationId: op.operationId,
            from: 'running',
            to: 'verifying',
            applyOutcome: 'applied',
            actor: WORKER_ACTOR,
          },
          { clock: systemClock },
        ),
      ),
    ).rejects.toMatchObject({ code: 'operation_state_changed' })
  })
})

describe('leases', () => {
  it('two workers never claim the same operation; a lost lease stops the old worker; takeover reconciles', async () => {
    const kind = syntheticKind('synthetic.lease')
    const plans = [
      await newPlan(as('exdb_serve'), { kind: 'synthetic.lease' }),
      await newPlan(as('exdb_serve'), { kind: 'synthetic.lease' }),
    ]
    for (const p of plans) {
      await as('exdb_serve').transaction('test.accept', (tx) =>
        acceptPlan(
          tx,
          { planId: p.planId, actor: human },
          deps({ kinds: new KindRegistry([kind]) }),
        ),
      )
    }
    const a = newId('prc', Date.now())
    const b = newId('prc', Date.now() + 1)
    const workerA = db.store('exdb_worker')
    const workerB = db.store('exdb_worker')
    const [ca, cb] = await Promise.all([
      claimNextOperation(workerA, {
        workerId: a,
        kinds: ['synthetic.lease'],
        clock: systemClock,
        leaseMs: 400,
      }),
      claimNextOperation(workerB, {
        workerId: b,
        kinds: ['synthetic.lease'],
        clock: systemClock,
        leaseMs: 60_000,
      }),
    ])
    expect(ca?.operation.operationId).toBeDefined()
    expect(cb?.operation.operationId).toBeDefined()
    expect(ca?.operation.operationId).not.toBe(cb?.operation.operationId)
    if (ca === undefined) {
      throw new Error('no claim')
    }
    const id = ca.operation.operationId
    await workerA.transaction('test.run', (tx) =>
      transitionOperation(
        tx,
        {
          operationId: id,
          from: 'queued',
          to: 'running',
          lease: { owner: a },
          actor: WORKER_ACTOR,
        },
        { clock: systemClock },
      ),
    )
    expect(await renewLease(workerA, id, a, 400)).toBe(true)
    // Worker A "dies": no renewal. B cannot take a live lease, then takes the expired one.
    await sleep(500)
    const takeover = await claimNextOperation(workerB, {
      workerId: b,
      kinds: ['synthetic.lease'],
      clock: systemClock,
    })
    expect(takeover).toMatchObject({
      takenOver: true,
      next: 'reconcile',
      operation: { operationId: id, state: 'needs_reconciliation', applyOutcome: 'unknown' },
    })
    expect(await renewLease(workerA, id, a)).toBe(false)
    await expect(
      workerA.transaction('test.zombie', (tx) =>
        transitionOperation(
          tx,
          {
            operationId: id,
            from: 'running',
            to: 'verifying',
            applyOutcome: 'applied',
            lease: { owner: a },
            actor: WORKER_ACTOR,
          },
          { clock: systemClock },
        ),
      ),
    ).rejects.toMatchObject({ code: 'operation_state_changed' })
    await expect(
      workerA.transaction('test.zombie2', (tx) =>
        transitionOperation(
          tx,
          {
            operationId: id,
            from: 'needs_reconciliation',
            to: 'failed',
            applyOutcome: 'not_applied',
            verificationOutcome: 'not_applicable',
            lease: { owner: a },
            actor: WORKER_ACTOR,
          },
          { clock: systemClock },
        ),
      ),
    ).rejects.toMatchObject({ code: 'operation_lease_lost' })
    const events = await as('exdb_worker').query(
      'test.lease.events',
      'SELECT kind FROM operations.operation_events WHERE operation_id = $1 ORDER BY event_id',
      [id],
    )
    expect(events.rows.map((r) => r.text('kind'))).toEqual([
      'created',
      'lease_acquired',
      'transition',
      'lease_taken_over',
      'transition',
    ])
  })
})

describe('policy settings', () => {
  it('reads the rows of the subject’s scope chain only', async () => {
    const tgt = newId('tgt', Date.now())
    const worker = as('exdb_worker')
    await worker.query(
      'test.settings',
      `INSERT INTO policy.rule_settings (scope_kind, scope_id, rule_id, revision, params, created_by)
       VALUES ('installation', 'installation', 'synthetic.rule', 1, '{"hours": 24}', 'x'),
              ('target', $1, 'synthetic.rule', 1, '{"hours": 1}', 'x'),
              ('target', $2, 'synthetic.rule', 1, '{"hours": 99}', 'x')`,
      [tgt, newId('tgt', Date.now() + 5)],
    )
    const rows = await readPolicySettings(as('exdb_serve'), { targetId: tgt })
    expect(rows.map((r) => [r.scopeKind, r.params['hours']])).toEqual([
      ['installation', 24],
      ['target', 1],
    ])
  })
})

describe('the audit chain', () => {
  it('verifies after everything above', async () => {
    expect(await verifyAuditChain(as('exdb_serve'))).toMatchObject({ ok: true })
  })
})
