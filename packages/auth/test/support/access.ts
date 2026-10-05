import type { BindingScope, BuiltInRoleId } from '@exponetdb/contracts'
import type { ControlStore } from '@exponetdb/control-store'
import { expectOk, type IdentityId, newId, parseId } from '@exponetdb/kernel'
import {
  KindRegistry,
  type OperationRecord,
  type PlanRecord,
  processNextOperation,
  readOperation,
} from '@exponetdb/operations'
import { ACCESS_RULES, RuleRegistry } from '@exponetdb/policy'
import {
  type AccessPolicyContext,
  type ApplyResult,
  accessKinds,
  applyAccessPlan,
  auditRequest,
  finishPasskeyLogin,
  inviteIdentity,
  loadSession,
  planRoleBindingCreate,
  type SessionContext,
  startPasskeyLogin,
} from '../../src/index.ts'
import {
  ceremonyHandle,
  type Enrolled,
  enrollThroughLink,
  type Harness,
  meta,
  ORIGIN,
  RP_ID,
  sessionSecrets,
  UA,
  value,
} from './flows.ts'

export const idn = (v: string): IdentityId => expectOk(parseId('idn', v), 'identity id')

export interface AccessHarness {
  readonly context: AccessPolicyContext
  readonly kinds: KindRegistry
  readonly worker: ControlStore
}

export function accessHarness(h: Harness): AccessHarness {
  const worker = h.db.store('exdb_worker')
  return {
    context: {
      registry: new RuleRegistry(ACCESS_RULES),
      codeVersion: '0.1.0+test',
      clock: h.clock,
    },
    kinds: new KindRegistry(accessKinds(worker, h.clock)),
    worker,
  }
}

/** A passkey sign-in: a full session whose sign-in proof is a fresh re-authentication. */
export async function signIn(h: Harness, person: Enrolled): Promise<SessionContext> {
  const m = meta()
  const started = await startPasskeyLogin(h.deps, m)
  const assertion = person.authenticator.assert({
    challenge: value(started).challenge,
    origin: ORIGIN,
    rpId: RP_ID,
  })
  const finished = await finishPasskeyLogin(h.deps, m, ceremonyHandle(started), assertion)
  const loaded = await loadSession(h.deps.store, sessionSecrets(finished).token, { userAgent: UA })
  if (loaded === undefined) {
    throw new Error('sign-in failed')
  }
  return loaded
}

export async function invitePerson(
  h: Harness,
  inviter: SessionContext,
  email: string,
): Promise<Enrolled> {
  const request = await auditRequest(h.deps.keys, meta())
  const invited = await h.deps.store.transaction('test.invite', (tx) =>
    inviteIdentity(tx, h.deps, inviter, request, { email }),
  )
  return enrollThroughLink(h, invited.link, email)
}

export async function apply(
  h: Harness,
  a: AccessHarness,
  session: SessionContext,
  plan: PlanRecord,
): Promise<ApplyResult> {
  return h.deps.store.transaction('test.apply', (tx) =>
    applyAccessPlan(tx, a.context, a.kinds, session, plan.planId),
  )
}

/** Runs the worker until the operation finishes (execute, verify). */
export async function work(
  h: Harness,
  a: AccessHarness,
  operationId: string,
): Promise<OperationRecord> {
  const workerId = newId('prc', Date.now())
  for (let i = 0; i < 10; i++) {
    const result = await processNextOperation(a.worker, {
      workerId,
      kinds: a.kinds,
      clock: h.clock,
    })
    if (
      result.status === 'done' &&
      result.operation.operationId === operationId &&
      ['succeeded', 'failed', 'canceled'].includes(result.operation.state)
    ) {
      return result.operation
    }
    if (result.status === 'idle') {
      break
    }
  }
  const operation = await readOperation(a.worker, operationId)
  if (operation === undefined) {
    throw new Error('operation missing')
  }
  return operation
}

export async function bindRole(
  h: Harness,
  a: AccessHarness,
  actor: SessionContext,
  identityId: string,
  roleId: BuiltInRoleId,
  scope: BindingScope = { kind: 'global' },
): Promise<OperationRecord> {
  const plan = await h.deps.store.transaction('test.plan', (tx) =>
    planRoleBindingCreate(tx, a.context, actor, { identityId: idn(identityId), roleId, scope }),
  )
  const applied = await apply(h, a, actor, plan)
  if (applied.status !== 'accepted') {
    throw new Error(`apply refused: ${applied.error.code}`)
  }
  return work(h, a, applied.operation.operationId)
}
