import { verifyAuditChain } from '@exponetdb/audit'
import {
  expectOk,
  fixedClock,
  isJsonArray,
  isJsonObject,
  newId,
  type OperationId,
  parseId,
} from '@exponetdb/kernel'
import {
  acceptPlan,
  createPlan,
  KindRegistry,
  type OperationActor,
  type OperationKind,
  type PlanRecord,
  readOperation,
} from '@exponetdb/operations'
import { PolicyEngine, type Rule, RuleRegistry } from '@exponetdb/policy'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  Authorizer,
  approve,
  auditRequest,
  ControlPlaneSubjectResolver,
  checkRoleCatalog,
  disableIdentity,
  isAuthError,
  lockSession,
  me,
  planIdentityChange,
  planPolicySettingsUpdate,
  planRoleBindingCreate,
  planRoleBindingDelete,
  reject,
  releaseAfterCooling,
  SERVE_OPERATION_ACTOR,
  type SessionContext,
} from '../src/index.ts'
import {
  type AccessHarness,
  accessHarness,
  apply,
  bindRole,
  idn,
  invitePerson,
  signIn,
  work,
} from './support/access.ts'
import {
  age,
  type Enrolled,
  enrollFirstOwner,
  type Harness,
  harness,
  meta,
} from './support/flows.ts'

/**
 * Planned access changes and approvals against PostgreSQL 17 (G3A items
 * 21, 24, 25): role bindings, policy settings, enabling and erasing
 * identities through the Operations Engine with the worker; anti-escalation
 * and owner rules as policy; the last-owner race; OD-9 approvals.
 */
let h: Harness
let a: AccessHarness
let owner: Enrolled
let ownerSession: SessionContext
let admin: Enrolled
let dev: Enrolled

beforeAll(async () => {
  h = await harness('exdb_it_auth_access')
  a = accessHarness(h)
  owner = await enrollFirstOwner(h)
  ownerSession = await signIn(h, owner)
  admin = await invitePerson(h, ownerSession, 'admin@example.test')
  dev = await invitePerson(h, ownerSession, 'dev@example.test')
})

afterAll(async () => {
  await h?.db.drop()
})

async function caught(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise
    return undefined
  } catch (error) {
    return isAuthError(error)
      ? error.code
      : error instanceof Error && 'code' in error
        ? String(error.code)
        : String(error)
  }
}

const plan = <T>(
  fn: (tx: Parameters<Parameters<typeof h.deps.store.transaction>[1]>[0]) => Promise<T>,
) => h.deps.store.transaction('test.plan', fn)

function failedRules(p: PlanRecord): string[] {
  const policy = p.body['policy']
  const rules = isJsonObject(policy) ? policy['rules'] : undefined
  return isJsonArray(rules)
    ? rules
        .filter(isJsonObject)
        .filter((r) => r['result'] === 'fail' || r['result'] === 'unknown')
        .map((r) => String(r['id']))
    : []
}

describe('role bindings through the Operations Engine', () => {
  it('the startup check accepts the seeded role matrix', async () => {
    await expect(checkRoleCatalog(h.deps.store)).resolves.toBeUndefined()
  })

  it('an owner grants a role: planned, applied by the worker, verified, audited; serve never writes bindings', async () => {
    const op = await bindRole(h, a, ownerSession, admin.identityId, 'admin')
    expect(op).toMatchObject({
      state: 'succeeded',
      applyOutcome: 'applied',
      verificationOutcome: 'passed',
    })
    const rows = await h.db.asSuperuser(
      async (c) =>
        (
          await c.query(
            `SELECT role_id, scope_kind, origin, created_by_operation_id FROM auth.role_bindings WHERE identity_id = $1`,
            [admin.identityId],
          )
        ).rows,
    )
    expect(rows).toEqual([
      {
        role_id: 'admin',
        scope_kind: 'global',
        origin: 'operation',
        created_by_operation_id: op.operationId,
      },
    ])
    const denied = await h.db.asRole('exdb_serve', async (c) =>
      c
        .query(
          `INSERT INTO auth.role_bindings (binding_id, identity_id, role_id, scope_kind, state, origin, created_at)
           VALUES ($1, $2, 'owner', 'global', 'active', 'bootstrap', now())`,
          [newId('rlb', Date.now()), dev.identityId],
        )
        .then(
          () => 'inserted',
          (e: { code?: string }) => e.code,
        ),
    )
    expect(denied).toBe('42501')
    const audit = await h.db.asSuperuser(
      async (c) =>
        (
          await c.query(
            `SELECT event::jsonb->'actor'->>'label' AS label FROM audit.audit_events WHERE action = 'access.role_binding.create'`,
          )
        ).rows,
    )
    expect(audit).toEqual([{ label: 'system:worker' }])
    const view = await me(h.deps.store, await signIn(h, admin))
    expect(view.bindings.map((b) => b.roleId)).toEqual(['admin'])
    expect(view.effectivePermissions.map((p) => p.permission)).not.toContain('breakglass.activate')
  })

  it('an admin cannot make anyone an owner, bind itself, or remove an owner (policy, not a missing permission)', async () => {
    const adminSession = await signIn(h, admin)
    const ownerGrant = await plan((tx) =>
      planRoleBindingCreate(tx, a.context, adminSession, {
        identityId: idn(dev.identityId),
        roleId: 'owner',
        scope: { kind: 'global' },
      }),
    )
    expect(ownerGrant.state).toBe('denied')
    expect(failedRules(ownerGrant)).toEqual(['access.no-self-escalation', 'access.owner-only'])
    expect(await apply(h, a, adminSession, ownerGrant)).toMatchObject({ status: 'refused' })

    const selfGrant = await plan((tx) =>
      planRoleBindingCreate(tx, a.context, adminSession, {
        identityId: idn(admin.identityId),
        roleId: 'operator',
        scope: { kind: 'global' },
      }),
    )
    expect(failedRules(selfGrant)).toEqual(['access.no-self-escalation'])

    const ownerBinding = await h.db.asSuperuser(
      async (c) =>
        (
          await c.query(
            `SELECT binding_id FROM auth.role_bindings WHERE role_id = 'owner' AND state = 'active'`,
          )
        ).rows[0].binding_id,
    )
    const removal = await plan((tx) =>
      planRoleBindingDelete(tx, a.context, adminSession, ownerBinding),
    )
    expect(failedRules(removal)).toEqual(['access.last-owner', 'access.owner-only'])
  })

  it('a narrower binding cannot be widened by its holder (escalation by scope)', async () => {
    const product = newId('prd', Date.now())
    await bindRole(h, a, ownerSession, dev.identityId, 'admin', {
      kind: 'product',
      productId: product,
    })
    const devSession = await signIn(h, dev)
    const widened = await plan((tx) =>
      planRoleBindingCreate(tx, a.context, devSession, {
        identityId: idn(admin.identityId),
        roleId: 'viewer',
        scope: { kind: 'global' },
      }),
    )
    expect(failedRules(widened)).toEqual(['access.no-self-escalation'])
    // The product-scoped admin does not even pass the central engine for identity management.
    const engine = new Authorizer(new ControlPlaneSubjectResolver())
    const principal = {
      kind: 'human' as const,
      identityId: idn(dev.identityId),
      client: 'web' as const,
      session: devSession,
    }
    expect(
      await engine.authorize(
        h.deps.store,
        { action: 'access.role_binding.create', principal },
        { kind: 'installation' },
      ),
    ).toMatchObject({ allowed: false, reason: 'scope' })
  })

  it('the last owner cannot remove its own owner binding', async () => {
    const ownerBinding = await h.db.asSuperuser(
      async (c) =>
        (
          await c.query(
            `SELECT binding_id FROM auth.role_bindings WHERE role_id = 'owner' AND state = 'active'`,
          )
        ).rows[0].binding_id,
    )
    const removal = await plan((tx) =>
      planRoleBindingDelete(tx, a.context, ownerSession, ownerBinding),
    )
    expect(removal.state).toBe('denied')
    expect(failedRules(removal)).toEqual(['access.last-owner'])
  })

  it('two owners removing each other concurrently: the database lets exactly one succeed', async () => {
    const second = await invitePerson(h, ownerSession, 'owner2@example.test')
    expect(await bindRole(h, a, ownerSession, second.identityId, 'owner')).toMatchObject({
      state: 'succeeded',
    })
    const secondSession = await signIn(h, second)
    const bindings = await h.db.asSuperuser(
      async (c) =>
        (
          await c.query(
            `SELECT identity_id, binding_id FROM auth.role_bindings WHERE role_id = 'owner' AND state = 'active'`,
          )
        ).rows,
    )
    const of = (id: string) => bindings.find((b) => b.identity_id === id)?.binding_id
    const p1 = await plan((tx) =>
      planRoleBindingDelete(tx, a.context, ownerSession, of(second.identityId)),
    )
    const p2 = await plan((tx) =>
      planRoleBindingDelete(tx, a.context, secondSession, of(owner.identityId)),
    )
    expect([p1.state, p2.state]).toEqual(['active', 'active'])
    const o1 = await apply(h, a, ownerSession, p1)
    const o2 = await apply(h, a, secondSession, p2)
    if (o1.status !== 'accepted' || o2.status !== 'accepted') {
      throw new Error('apply refused')
    }
    const [r1, r2] = await Promise.all([
      work(h, a, o1.operation.operationId),
      work(h, a, o2.operation.operationId),
    ])
    const states = [r1.state, r2.state].sort()
    expect(states).toEqual(['failed', 'succeeded'])
    const owners = await h.db.asSuperuser(
      async (c) => (await c.query('SELECT auth.active_owner_count()::int AS n')).rows[0].n,
    )
    expect(owners).toBe(1)
    // Keep the original owner as the remaining owner for the rest of the suite.
    if (r1.state === 'succeeded') {
      return
    }
    ownerSession = await signIn(h, second)
    owner = second
  })

  it('a plan whose subject changed before apply is stale', async () => {
    const target = await invitePerson(h, ownerSession, 'stale@example.test')
    const p = await plan((tx) =>
      planRoleBindingCreate(tx, a.context, ownerSession, {
        identityId: idn(target.identityId),
        roleId: 'viewer',
        scope: { kind: 'global' },
      }),
    )
    const request = await auditRequest(h.deps.keys, meta())
    await h.deps.store.transaction('test.disable', (tx) =>
      disableIdentity(tx, h.deps, ownerSession, request, idn(target.identityId), undefined),
    )
    const result = await apply(h, a, ownerSession, p)
    expect(result).toMatchObject({ status: 'refused' })
    if (result.status === 'refused') {
      expect(result.error.code).toBe('PLAN_STALE')
    }
    // Enabling is a planned operation (a privilege increase).
    const enable = await plan((tx) =>
      planIdentityChange(
        tx,
        a.context,
        ownerSession,
        'access.identity.enable',
        idn(target.identityId),
      ),
    )
    const applied = await apply(h, a, ownerSession, enable)
    if (applied.status !== 'accepted') throw new Error('refused')
    expect(await work(h, a, applied.operation.operationId)).toMatchObject({
      state: 'succeeded',
      verificationOutcome: 'passed',
    })
  })
})

describe('policy settings', () => {
  it('a non-owner may only tighten; ambiguous or lowering changes need an owner', async () => {
    const adminSession = await signIn(h, admin)
    const raise = await plan((tx) =>
      planPolicySettingsUpdate(tx, a.context, adminSession, {
        scopeKind: 'installation',
        scopeId: 'installation',
        ruleId: 'approval.self-approval',
        params: { criticalCoolingSeconds: 900 },
      }),
    )
    expect(raise.state).toBe('active')
    const applied = await apply(h, a, adminSession, raise)
    if (applied.status !== 'accepted') throw new Error('refused')
    expect(await work(h, a, applied.operation.operationId)).toMatchObject({ state: 'succeeded' })

    const lower = await plan((tx) =>
      planPolicySettingsUpdate(tx, a.context, adminSession, {
        scopeKind: 'installation',
        scopeId: 'installation',
        ruleId: 'approval.self-approval',
        params: { criticalCoolingSeconds: 60 },
      }),
    )
    expect(failedRules(lower)).toEqual(['access.policy-safety'])
    const unknown = await plan((tx) =>
      planPolicySettingsUpdate(tx, a.context, adminSession, {
        scopeKind: 'installation',
        scopeId: 'installation',
        ruleId: 'access.erase-approval',
        params: { approvals: 2 },
      }),
    )
    expect(failedRules(unknown)).toEqual(['access.policy-safety'])

    const ownerLower = await plan((tx) =>
      planPolicySettingsUpdate(tx, a.context, ownerSession, {
        scopeKind: 'installation',
        scopeId: 'installation',
        ruleId: 'approval.self-approval',
        params: { criticalCoolingSeconds: 600 },
      }),
    )
    expect(ownerLower.state).toBe('active')
    const back = await apply(h, a, ownerSession, ownerLower)
    if (back.status !== 'accepted') throw new Error('refused')
    expect(await work(h, a, back.operation.operationId)).toMatchObject({ state: 'succeeded' })
    await expect(
      caught(
        plan((tx) =>
          planPolicySettingsUpdate(tx, a.context, ownerSession, {
            scopeKind: 'installation',
            scopeId: 'installation',
            ruleId: 'approval.self-approval',
            params: { surprise: true },
          }),
        ),
      ),
    ).resolves.toBe('VALIDATION_FAILED')
  })
})

// ----- OD-9 -----

const approvalRule: Rule = {
  id: 'test.needs-approval',
  version: 1,
  description: 'synthetic: every plan of the synthetic kinds needs one approval',
  appliesTo: ['test.*'],
  severity: 'require',
  overridableByBreakGlass: false,
  facts: [],
  defaults: {},
  requirements: () => [{ kind: 'approval', count: 1, permission: 'plans.approve' }],
  evaluate: () => ({ result: 'fail', message: 'needs approval' }),
}

const synthetic = (kind: string, actionClass: 'standard' | 'high' | 'critical'): OperationKind => ({
  kind,
  version: 1,
  actionClass,
  verifies: false,
  exclusivity: () => [],
  checkBindings: async () => [],
  execute: async () => 'applied',
  verify: async () => 'passed',
  reconcile: async () => 'applied',
})

const twoApprovalsRule: Rule = {
  ...approvalRule,
  id: 'test.needs-two-approvals',
  appliesTo: ['test.double'],
  requirements: () => [{ kind: 'approval', count: 2, permission: 'plans.approve' }],
}

const syntheticKinds = new KindRegistry([
  synthetic('test.standard', 'standard'),
  synthetic('test.critical', 'critical'),
  synthetic('test.double', 'high'),
])

const opId = (v: string): OperationId => expectOk(parseId('op', v), 'operation id')

async function syntheticOperation(
  actor: OperationActor,
  kind: 'test.standard' | 'test.critical' | 'test.double',
): Promise<{ plan: PlanRecord; operationId: string }> {
  const engine = new PolicyEngine({
    registry: new RuleRegistry([approvalRule, twoApprovalsRule]),
    providers: [],
    codeVersion: '0.1.0+test',
    clock: fixedClock(Date.now()),
  })
  const decision = await engine.evaluate({
    request: {
      kind,
      principal: { kind: actor.kind, identityId: actor.identityId, client: actor.client },
      subject: {},
    },
    settings: [],
  })
  return h.deps.store.transaction('test.synthetic', async (tx) => {
    const created = await createPlan(
      tx,
      {
        kind,
        kindVersion: 1,
        actionClass: kind === 'test.critical' ? 'critical' : 'high',
        actor,
        subject: {},
        content: { synthetic: true, at: Date.now() },
        policy: decision,
      },
      { clock: h.clock },
    )
    const accepted = await acceptPlan(
      tx,
      { planId: created.planId, actor },
      {
        kinds: syntheticKinds,
        clock: h.clock,
        systemActor: SERVE_OPERATION_ACTOR,
        recheckPolicy: async () => ({ status: 'proceed', requirements: decision.requirements }),
      },
    )
    if (accepted.status !== 'accepted') throw accepted.error
    expect(accepted.operation.state).toBe('awaiting_approval')
    return { plan: created, operationId: accepted.operation.operationId }
  })
}

const humanActor = (
  s: SessionContext,
  client: OperationActor['client'] = 'web',
): OperationActor => ({
  kind: 'human',
  identityId: s.identityId,
  label: s.label,
  client,
  clientId: null,
})

const decide = (session: SessionContext, operationId: string, planHash: string, ack = false) =>
  h.deps.store.transaction('test.approve', (tx) =>
    approve(tx, a.context, session, opId(operationId), {
      planHash,
      ...(ack ? { acknowledgeSelfApproval: true as const } : {}),
    }),
  )

async function state(operationId: string) {
  return (await readOperation(h.deps.store, operationId))?.state
}

describe('OD-9 approvals', () => {
  it('1. an agent-proposed plan is approved by the same person through the Web App: not a self-approval', async () => {
    const s = await signIn(h, owner)
    const { plan: p, operationId } = await syntheticOperation(humanActor(s, 'mcp'), 'test.critical')
    const outcome = await decide(s, operationId, p.planHash)
    expect(outcome.approval.selfApproval).toBe(false)
    expect(outcome.notBefore).toBeNull()
    expect(await state(operationId)).toBe('queued')
  })

  it('2. an agent client can never approve (engine and Control Store)', async () => {
    const s = await signIn(h, owner)
    const engine = new Authorizer(new ControlPlaneSubjectResolver())
    const agent = {
      kind: 'human' as const,
      identityId: s.identityId,
      client: 'mcp' as const,
      session: s,
    }
    expect(
      await engine.admit(h.deps.store, { action: 'approval.approve', principal: agent }),
    ).toMatchObject({
      allowed: false,
      reason: 'client_kind',
    })
    const { plan: p, operationId } = await syntheticOperation(humanActor(s), 'test.standard')
    const viaMcp = await h.db.asRole('exdb_serve', (c) =>
      c
        .query(
          `INSERT INTO approvals.plan_approvals (approval_id, operation_id, plan_id, plan_hash, approver_identity_id,
             approver_session_id, approver_client, decision, self_approval, reauth_event_id, cooling_seconds,
             policy_version, decided_at, not_before)
           VALUES ($1, $2, $3, $4, $5, $6, 'mcp', 'approved', false, $7, 0, $8, now(), now())`,
          [
            newId('apr', Date.now()),
            operationId,
            p.planId,
            p.planHash,
            s.identityId,
            s.sessionId,
            s.reauthEventId,
            p.policyVersion,
          ],
        )
        .then(
          () => 'inserted',
          (e: { code?: string }) => e.code,
        ),
    )
    expect(viaMcp).toBe('23514')
  })

  it('3. a human self-approves a non-critical plan with acknowledgement and a fresh proof: queued at once', async () => {
    const s = await signIn(h, owner)
    const { plan: p, operationId } = await syntheticOperation(humanActor(s), 'test.standard')
    expect(await caught(decide(s, operationId, p.planHash))).toBe('SELF_APPROVAL_UNACKNOWLEDGED')
    const outcome = await decide(s, operationId, p.planHash, true)
    expect(outcome.approval.selfApproval).toBe(true)
    expect(outcome.notBefore).toBeNull()
    expect(await state(operationId)).toBe('queued')
    const audit = await h.db.asSuperuser(
      async (c) =>
        (
          await c.query(
            `SELECT count(*)::int AS n FROM audit.audit_events WHERE action = 'approval.self_approval'`,
          )
        ).rows[0].n,
    )
    expect(audit).toBeGreaterThanOrEqual(1)
  })

  it('4. the same without a fresh proof is refused (engine and Control Store)', async () => {
    const s = await signIn(h, owner)
    const { plan: p, operationId } = await syntheticOperation(humanActor(s), 'test.standard')
    await age(
      h,
      `UPDATE auth.reauth_events SET occurred_at = occurred_at - interval '10 minutes' WHERE reauth_event_id = $1`,
      [s.reauthEventId],
    )
    await age(
      h,
      `UPDATE auth.web_sessions SET reauth_at = reauth_at - interval '10 minutes' WHERE session_id = $1`,
      [s.sessionId],
    )
    const engine = new Authorizer(new ControlPlaneSubjectResolver())
    const reloaded = await h.deps.store.transaction('test.reload', (tx) =>
      lockSession(tx, s.sessionId),
    )
    if (reloaded === undefined) throw new Error('session')
    expect(reloaded.reauthAgeSeconds).toBeGreaterThan(300)
    expect(
      await engine.authorize(
        h.deps.store,
        {
          action: 'approval.approve',
          principal: {
            kind: 'human',
            identityId: reloaded.identityId,
            client: 'web',
            session: reloaded,
          },
        },
        { kind: 'plan', subject: {} },
      ),
    ).toMatchObject({ allowed: false, reason: 'reauth' })
    expect(await caught(decide(reloaded, operationId, p.planHash, true))).toBe('REAUTH_REQUIRED')
    expect(await state(operationId)).toBe('awaiting_approval')
  })

  it('5 to 8. a critical self-approval cools for 10 minutes, then needs a fresh proof at apply', async () => {
    const victim = await invitePerson(h, ownerSession, 'erase-me@example.test')
    let s = await signIn(h, owner)
    const erase = await plan((tx) =>
      planIdentityChange(tx, a.context, s, 'access.identity.erase', idn(victim.identityId)),
    )
    expect(erase.state).toBe('active')
    expect(erase.actionClass).toBe('critical')
    const first = await apply(h, a, s, erase)
    if (first.status !== 'accepted') throw new Error('refused')
    const operationId = first.operation.operationId
    expect(first.operation.state).toBe('awaiting_approval')

    // 5. recorded, cooling for 600 s on the database clock
    const outcome = await decide(s, operationId, erase.planHash, true)
    expect(outcome.approval.selfApproval).toBe(true)
    const cooling = await h.db.asSuperuser(
      async (c) =>
        (
          await c.query(
            `SELECT cooling_seconds, not_before - decided_at = interval '600 seconds' AS exact
             FROM approvals.plan_approvals WHERE approval_id = $1`,
            [outcome.approval.id],
          )
        ).rows[0],
    )
    expect(cooling).toEqual({ cooling_seconds: 600, exact: true })
    expect(await state(operationId)).toBe('awaiting_approval')

    // 6. at +9m59s: refused
    await age(
      h,
      `UPDATE approvals.plan_approvals SET decided_at = decided_at - interval '599 seconds',
              not_before = not_before - interval '599 seconds' WHERE approval_id = $1`,
      [outcome.approval.id],
    )
    s = await signIn(h, owner)
    const early = await apply(h, a, s, erase)
    expect(early.status === 'refused' && early.error.code).toBe('APPROVAL_COOLING_PERIOD')

    // 7. after 10 minutes without a fresh proof: refused
    await age(
      h,
      `UPDATE approvals.plan_approvals SET decided_at = decided_at - interval '2 seconds',
              not_before = not_before - interval '2 seconds' WHERE approval_id = $1`,
      [outcome.approval.id],
    )
    await age(
      h,
      `UPDATE auth.reauth_events SET occurred_at = occurred_at - interval '6 minutes' WHERE reauth_event_id = $1`,
      [s.reauthEventId],
    )
    await age(
      h,
      `UPDATE auth.web_sessions SET reauth_at = reauth_at - interval '6 minutes' WHERE session_id = $1`,
      [s.sessionId],
    )
    const staleSession = await h.deps.store.transaction('test.reload', (tx) =>
      lockSession(tx, s.sessionId),
    )
    if (staleSession === undefined) throw new Error('session')
    expect(
      await caught(
        h.deps.store.transaction('test.release', (tx) =>
          releaseAfterCooling(tx, a.context, staleSession, opId(operationId)),
        ),
      ),
    ).toBe('REAUTH_REQUIRED')
    expect(await state(operationId)).toBe('awaiting_approval')

    // 8. after 10 minutes with a fresh proof: queued, executed, verified
    s = await signIn(h, owner)
    const released = await apply(h, a, s, erase)
    expect(released).toMatchObject({ status: 'accepted', alreadyAccepted: true })
    expect(await state(operationId)).toBe('queued')
    expect(await work(h, a, operationId)).toMatchObject({
      state: 'succeeded',
      verificationOutcome: 'passed',
    })
    const erased = await h.db.asSuperuser(
      async (c) =>
        (
          await c.query(
            `SELECT state, email, display_name, webauthn_user_handle,
                  (SELECT count(*)::int FROM auth.factors f WHERE f.identity_id = i.identity_id) AS factors
             FROM auth.identities i WHERE identity_id = $1`,
            [victim.identityId],
          )
        ).rows[0],
    )
    expect(erased).toEqual({
      state: 'erased',
      email: null,
      display_name: null,
      webauthn_user_handle: null,
      factors: 0,
    })
  })

  it('the proof given for a self-approval never serves the apply, even with a short cooling period', async () => {
    let s = await signIn(h, owner)
    const { plan: p, operationId } = await syntheticOperation(humanActor(s), 'test.critical')
    const outcome = await decide(s, operationId, p.planHash, true)
    // As if the owner had shortened the cooling period to 60 s: it has ended,
    // while the approval's own proof is still within the 5-minute window.
    await age(
      h,
      `UPDATE approvals.plan_approvals SET cooling_seconds = 60,
              decided_at = decided_at - interval '61 seconds',
              not_before = decided_at - interval '1 second' WHERE approval_id = $1`,
      [outcome.approval.id],
    )
    await age(
      h,
      `UPDATE auth.reauth_events SET occurred_at = occurred_at - interval '61 seconds' WHERE reauth_event_id = $1`,
      [s.reauthEventId],
    )
    await age(
      h,
      `UPDATE auth.web_sessions SET reauth_at = reauth_at - interval '61 seconds' WHERE session_id = $1`,
      [s.sessionId],
    )
    const reloaded = await h.deps.store.transaction('test.reload', (tx) =>
      lockSession(tx, s.sessionId),
    )
    if (reloaded === undefined) throw new Error('session')
    expect(
      await caught(
        h.deps.store.transaction('test.release', (tx) =>
          releaseAfterCooling(tx, a.context, reloaded, opId(operationId)),
        ),
      ),
    ).toBe('REAUTH_REQUIRED')
    // A proof after the end of the cooling period releases it.
    s = await signIn(h, owner)
    const released = await h.deps.store.transaction('test.release', (tx) =>
      releaseAfterCooling(tx, a.context, s, opId(operationId)),
    )
    expect(released.state).toBe('queued')
  })

  it('9. another plan hash is another plan: no approval or cooling carries over', async () => {
    const s = await signIn(h, owner)
    const one = await syntheticOperation(humanActor(s), 'test.critical')
    const two = await syntheticOperation(humanActor(s), 'test.critical')
    expect(one.plan.planHash).not.toBe(two.plan.planHash)
    expect(await caught(decide(s, one.operationId, two.plan.planHash, true))).toBe('PLAN_STALE')
    await decide(s, one.operationId, one.plan.planHash, true)
    const count = await h.db.asSuperuser(
      async (c) =>
        (
          await c.query(
            'SELECT count(*)::int AS n FROM approvals.plan_approvals WHERE operation_id = $1',
            [two.operationId],
          )
        ).rows[0].n,
    )
    expect(count).toBe(0)
    expect(await state(two.operationId)).toBe('awaiting_approval')
  })

  it('10. a distinct human approves a critical plan: no cooling', async () => {
    const adminSession = await signIn(h, admin)
    const s = await signIn(h, owner)
    const { plan: p, operationId } = await syntheticOperation(humanActor(s), 'test.critical')
    const outcome = await decide(adminSession, operationId, p.planHash)
    expect(outcome.approval.selfApproval).toBe(false)
    expect(outcome.notBefore).toBeNull()
    expect(await state(operationId)).toBe('queued')
  })

  it('a rejection cancels; a second decision by the same person is refused', async () => {
    const s = await signIn(h, owner)
    const { plan: p, operationId } = await syntheticOperation(humanActor(s), 'test.standard')
    await h.deps.store.transaction('test.reject', (tx) =>
      reject(tx, a.context, s, opId(operationId), { planHash: p.planHash }),
    )
    expect(await state(operationId)).toBe('canceled')
    expect(await caught(decide(s, operationId, p.planHash, true))).toBe('APPROVAL_NOT_PENDING')
  })

  it('a self-approval the policy forbids is denied', async () => {
    const s = await signIn(h, owner)
    const forbid = await plan((tx) =>
      planPolicySettingsUpdate(tx, a.context, s, {
        scopeKind: 'installation',
        scopeId: 'installation',
        ruleId: 'approval.self-approval',
        params: { allowed: false },
      }),
    )
    const applied = await apply(h, a, s, forbid)
    if (applied.status !== 'accepted') throw new Error('refused')
    await work(h, a, applied.operation.operationId)
    const { plan: p, operationId } = await syntheticOperation(humanActor(s), 'test.standard')
    expect(await caught(decide(s, operationId, p.planHash, true))).toBe('POLICY_DENIED')
  })

  it('a stale approval does not count once the approver lost plans.approve', async () => {
    const s = await signIn(h, owner)
    const { plan: p, operationId } = await syntheticOperation(humanActor(s, 'mcp'), 'test.double')
    const adminSession = await signIn(h, admin)
    expect((await decide(adminSession, operationId, p.planHash)).operation.state).toBe(
      'awaiting_approval',
    )
    const adminBinding = await h.db.asSuperuser(
      async (c) =>
        (
          await c.query(
            `SELECT binding_id FROM auth.role_bindings WHERE identity_id = $1 AND state = 'active'`,
            [admin.identityId],
          )
        ).rows[0].binding_id,
    )
    const removal = await plan((tx) => planRoleBindingDelete(tx, a.context, s, adminBinding))
    const applied = await apply(h, a, s, removal)
    if (applied.status !== 'accepted') throw new Error('refused')
    expect(await work(h, a, applied.operation.operationId)).toMatchObject({ state: 'succeeded' })
    // Two approvals are recorded, but only one approver still holds plans.approve.
    const second = await decide(await signIn(h, owner), operationId, p.planHash)
    expect(second.operation.state).toBe('awaiting_approval')
    const operator = await invitePerson(h, s, 'operator@example.test')
    await bindRole(h, a, s, operator.identityId, 'operator')
    const third = await decide(await signIn(h, operator), operationId, p.planHash)
    expect(third.operation.state).toBe('queued')
  })

  it('keeps an intact audit chain', async () => {
    expect((await verifyAuditChain(h.deps.store)).ok).toBe(true)
  })
})
