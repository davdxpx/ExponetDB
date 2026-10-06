import {
  type AccessPolicyContext,
  type AuthDeps,
  AuthError,
  type Authorization,
  type Authorizer,
  applyAccessPlan,
  approvalQueue,
  approve,
  auditRequest,
  deliveryStatus,
  disableIdentity,
  dispatchNotifications,
  enrollment,
  evaluateAccessPolicy,
  finishPasskeyLogin,
  finishPasskeyReauth,
  getIdentity,
  inviteIdentity,
  listIdentities,
  listRoleBindings,
  listRoles,
  loadSession,
  logout,
  me,
  type Outcome,
  type Principal,
  passwordLogin,
  planIdentityChange,
  planPolicySettingsUpdate,
  planRoleBindingCreate,
  planRoleBindingDelete,
  policySettingsView,
  type RequestMeta,
  recoveryCodeLogin,
  refusal,
  reissueInvitation,
  reject,
  roleView,
  type SessionContext,
  type SubjectRef,
  selfService,
  startPasskeyLogin,
  startPasskeyReauth,
  totpLogin,
  totpReauth,
  touchSession,
  withPolicy,
} from '@exponetdb/auth'
import {
  type ApprovalQueueItem,
  type ApprovalView,
  type AuthenticationCredential,
  type BindingScope,
  type BuiltInRoleId,
  type CreationOptions,
  type EnrollmentComplete,
  type EnrollmentState,
  type FactorView,
  type IdentityView,
  type InvitationResponse,
  type Me,
  type PlanView,
  PlanViewSchema,
  type PolicySettingsView,
  type ReauthResult,
  type RecoveryCodesView,
  type RegistrationCredential,
  type RequestOptions,
  type RoleBindingView,
  type SecondFactorStep,
  type SessionView,
  type SignedIn,
  type TotpSetup,
} from '@exponetdb/contracts'
import type { Tx } from '@exponetdb/control-store'
import {
  type AuthFactorId,
  type IdentityId,
  isJsonObject,
  type JsonObject,
  type JsonValue,
  type OperationId,
  type RoleBindingId,
  type SessionId,
  toJsonValue,
} from '@exponetdb/kernel'
import {
  beginIdempotent,
  completeIdempotent,
  type KindRegistry,
  OperationError,
  type PlanRecord,
  type PlanSubject,
  readPlan,
  withdrawPlan,
} from '@exponetdb/operations'
import { type OperationView, operationView, planView } from './views.ts'

/**
 * The use cases of Wave 3A. Every interface (the `/auth` ceremonies and the
 * `/api/v1` resources of the Web App today; CLI, MCP and SDK later) calls
 * these and nothing else (C-9). Each one asks the central authorization
 * engine first (no handler decides access), then runs the auth or
 * operations service, and dispatches notifications only after the
 * transaction committed.
 *
 * Refusals are `AuthError` or `OperationError` with a catalog code, or an
 * `Outcome` refusal for ceremonies (whose failure accounting must commit).
 */
export interface ApplicationDeps {
  readonly auth: AuthDeps
  readonly authorizer: Authorizer
  readonly policy: AccessPolicyContext
  /** The access kinds bound to serve's login, for acceptance checks only; the worker executes. */
  readonly kinds: KindRegistry
  /** Rules shown in the policy settings view. */
  readonly ruleIds: readonly string[]
}

const INSTALLATION: SubjectRef = { kind: 'installation' }

function principalOf(session: SessionContext | undefined): Principal {
  return session === undefined
    ? { kind: 'anonymous', client: 'web' }
    : { kind: 'human', identityId: session.identityId, client: 'web', session }
}

function selfRef(session: SessionContext): SubjectRef {
  return { kind: 'self', identityId: session.identityId }
}

function json(value: unknown): JsonValue {
  const checked = toJsonValue(value)
  if (!checked.ok) {
    throw new AuthError('INTERNAL')
  }
  return checked.value
}

export class Application {
  readonly #d: ApplicationDeps

  constructor(deps: ApplicationDeps) {
    this.#d = deps
  }

  get publicOrigin(): string {
    return this.#d.auth.config.publicOrigin
  }

  // ----- authentication of a request -----

  /** The live session of a request, or undefined. Touches `last_seen_at` at most once a minute. */
  async authenticate(cookie: string | undefined, userAgent: string | undefined) {
    const session = await loadSession(this.#d.auth.store, cookie, { userAgent })
    if (session?.touchDue === true) {
      await touchSession(this.#d.auth.store, session.sessionId)
    }
    return session
  }

  async #authorize(
    q: Parameters<Authorizer['authorize']>[0],
    action: string,
    session: SessionContext | undefined,
    subject: SubjectRef,
    planKind?: string,
  ): Promise<Authorization> {
    const result = await this.#d.authorizer.authorize(
      q,
      { action, principal: principalOf(session), ...(planKind === undefined ? {} : { planKind }) },
      subject,
    )
    if (!result.allowed) {
      throw result.error
    }
    return result
  }

  async #ceremony<T>(
    action: string,
    session: SessionContext | undefined,
    run: () => Promise<Outcome<T>>,
  ): Promise<Outcome<T>> {
    try {
      await this.#authorize(
        this.#d.auth.store,
        action,
        session,
        session === undefined ? INSTALLATION : selfRef(session),
      )
    } catch (error) {
      if (error instanceof AuthError) {
        return refusal(error)
      }
      throw error
    }
    const outcome = await run()
    await dispatchNotifications(this.#d.auth.store, this.#d.auth.channel, outcome.deliveries)
    return outcome
  }

  // ----- sign-in and enrollment ceremonies (public) -----

  loginPasskeyOptions(meta: RequestMeta): Promise<Outcome<RequestOptions>> {
    return this.#ceremony('auth.login', undefined, () => startPasskeyLogin(this.#d.auth, meta))
  }

  loginPasskey(
    meta: RequestMeta,
    handle: string | undefined,
    credential: AuthenticationCredential,
  ) {
    return this.#ceremony<SignedIn>('auth.login', undefined, () =>
      finishPasskeyLogin(this.#d.auth, meta, handle, credential),
    )
  }

  loginPassword(
    meta: RequestMeta,
    email: string,
    password: string,
  ): Promise<Outcome<SecondFactorStep>> {
    return this.#ceremony('auth.login', undefined, () =>
      passwordLogin(this.#d.auth, meta, email, password),
    )
  }

  loginTotp(
    meta: RequestMeta,
    handle: string | undefined,
    code: string,
  ): Promise<Outcome<SignedIn>> {
    return this.#ceremony('auth.login', undefined, () =>
      totpLogin(this.#d.auth, meta, handle, code),
    )
  }

  loginRecoveryCode(
    meta: RequestMeta,
    handle: string | undefined,
    code: string,
  ): Promise<Outcome<SignedIn>> {
    return this.#ceremony('auth.login', undefined, () =>
      recoveryCodeLogin(this.#d.auth, meta, handle, code),
    )
  }

  enrollmentRedeem(meta: RequestMeta, token: string): Promise<Outcome<EnrollmentState>> {
    return this.#ceremony('auth.enrollment', undefined, () =>
      enrollment.redeem(this.#d.auth, meta, token),
    )
  }

  enrollmentPasskeyOptions(handle: string | undefined): Promise<Outcome<CreationOptions>> {
    return this.#ceremony('auth.enrollment', undefined, () =>
      enrollment.passkeyOptions(this.#d.auth, handle),
    )
  }

  enrollmentPasskey(
    handle: string | undefined,
    credential: RegistrationCredential,
    label: string | undefined,
  ): Promise<Outcome<EnrollmentState>> {
    return this.#ceremony('auth.enrollment', undefined, () =>
      enrollment.passkey(this.#d.auth, handle, credential, label),
    )
  }

  enrollmentPassword(
    handle: string | undefined,
    password: string,
  ): Promise<Outcome<EnrollmentState>> {
    return this.#ceremony('auth.enrollment', undefined, () =>
      enrollment.password(this.#d.auth, handle, password),
    )
  }

  enrollmentTotpOptions(handle: string | undefined): Promise<Outcome<TotpSetup>> {
    return this.#ceremony('auth.enrollment', undefined, () =>
      enrollment.totpOptions(this.#d.auth, handle),
    )
  }

  enrollmentTotp(
    meta: RequestMeta,
    handle: string | undefined,
    code: string,
  ): Promise<Outcome<EnrollmentState>> {
    return this.#ceremony('auth.enrollment', undefined, () =>
      enrollment.totp(this.#d.auth, meta, handle, code),
    )
  }

  enrollmentComplete(
    meta: RequestMeta,
    handle: string | undefined,
  ): Promise<Outcome<EnrollmentComplete>> {
    return this.#ceremony('auth.enrollment', undefined, () =>
      enrollment.complete(this.#d.auth, meta, handle),
    )
  }

  // ----- session-bound ceremonies (self) -----

  logout(
    meta: RequestMeta,
    session: SessionContext,
  ): Promise<Outcome<{ readonly signedOut: true }>> {
    return this.#ceremony('auth.logout', session, () => logout(this.#d.auth, meta, session))
  }

  reauthPasskeyOptions(session: SessionContext): Promise<Outcome<RequestOptions>> {
    return this.#ceremony('auth.reauth', session, () => startPasskeyReauth(this.#d.auth, session))
  }

  reauthPasskey(
    meta: RequestMeta,
    session: SessionContext,
    credential: AuthenticationCredential,
  ): Promise<Outcome<ReauthResult>> {
    return this.#ceremony('auth.reauth', session, () =>
      finishPasskeyReauth(this.#d.auth, meta, session, credential),
    )
  }

  reauthTotp(
    meta: RequestMeta,
    session: SessionContext,
    code: string,
  ): Promise<Outcome<ReauthResult>> {
    return this.#ceremony('auth.reauth', session, () =>
      totpReauth(this.#d.auth, meta, session, code),
    )
  }

  passkeyOptions(session: SessionContext): Promise<Outcome<CreationOptions>> {
    return this.#ceremony('auth.passkey.add', session, () =>
      selfService.passkeyOptions(this.#d.auth, session),
    )
  }

  addPasskey(
    meta: RequestMeta,
    session: SessionContext,
    credential: RegistrationCredential,
    label: string | undefined,
  ): Promise<Outcome<FactorView>> {
    return this.#ceremony('auth.passkey.add', session, () =>
      selfService.addPasskey(this.#d.auth, meta, session, credential, label),
    )
  }

  removePasskey(meta: RequestMeta, session: SessionContext, factorId: AuthFactorId) {
    return this.#ceremony('auth.passkey.remove', session, () =>
      selfService.removePasskey(this.#d.auth, meta, session, factorId),
    )
  }

  changePassword(
    meta: RequestMeta,
    session: SessionContext,
    password: string,
  ): Promise<Outcome<FactorView>> {
    return this.#ceremony('auth.password.change', session, () =>
      selfService.changePassword(this.#d.auth, meta, session, password),
    )
  }

  totpOptions(session: SessionContext): Promise<Outcome<TotpSetup>> {
    return this.#ceremony('auth.totp.replace', session, () =>
      selfService.totpOptions(this.#d.auth, session),
    )
  }

  replaceTotp(
    meta: RequestMeta,
    session: SessionContext,
    code: string,
  ): Promise<Outcome<FactorView>> {
    return this.#ceremony('auth.totp.replace', session, () =>
      selfService.replaceTotp(this.#d.auth, meta, session, code),
    )
  }

  regenerateRecoveryCodes(
    meta: RequestMeta,
    session: SessionContext,
  ): Promise<Outcome<RecoveryCodesView>> {
    return this.#ceremony('auth.recovery_codes.regenerate', session, () =>
      selfService.regenerateRecoveryCodes(this.#d.auth, meta, session),
    )
  }

  revokeSession(meta: RequestMeta, session: SessionContext, target: SessionId) {
    return this.#ceremony('auth.session.revoke', session, () =>
      selfService.revokeOwnSession(this.#d.auth, meta, session, target),
    )
  }

  revokeOtherSessions(meta: RequestMeta, session: SessionContext) {
    return this.#ceremony('auth.session.revoke', session, () =>
      selfService.revokeOtherSessions(this.#d.auth, meta, session),
    )
  }

  // ----- reads -----

  async me(session: SessionContext): Promise<Me> {
    await this.#authorize(this.#d.auth.store, 'me.get', session, selfRef(session))
    return me(this.#d.auth.store, session)
  }

  async sessions(session: SessionContext): Promise<SessionView[]> {
    await this.#authorize(this.#d.auth.store, 'auth.session.list', session, selfRef(session))
    return selfService.ownSessions(this.#d.auth, session)
  }

  async factors(session: SessionContext): Promise<FactorView[]> {
    await this.#authorize(this.#d.auth.store, 'auth.factor.list', session, selfRef(session))
    return selfService.ownFactors(this.#d.auth, session)
  }

  async identities(
    session: SessionContext,
    query: { readonly state?: IdentityView['state'] | undefined; readonly limit: number },
  ): Promise<{ items: IdentityView[]; nextCursor: null }> {
    await this.#authorize(this.#d.auth.store, 'identity.list', session, INSTALLATION)
    const all = await listIdentities(this.#d.auth.store)
    const items = all.filter((i) => query.state === undefined || i.state === query.state)
    return { items: items.slice(0, query.limit), nextCursor: null }
  }

  async identity(session: SessionContext, identityId: IdentityId): Promise<IdentityView> {
    await this.#authorize(this.#d.auth.store, 'identity.get', session, INSTALLATION)
    return getIdentity(this.#d.auth.store, identityId)
  }

  async roles(session: SessionContext) {
    await this.#authorize(this.#d.auth.store, 'role.list', session, INSTALLATION)
    return { items: listRoles() }
  }

  async role(session: SessionContext, roleId: BuiltInRoleId) {
    await this.#authorize(this.#d.auth.store, 'role.get', session, INSTALLATION)
    return roleView(roleId)
  }

  async roleBindings(
    session: SessionContext,
    query: {
      readonly identity?: IdentityId | undefined
      readonly state?: 'active' | 'revoked' | undefined
      readonly limit: number
    },
  ): Promise<{ items: RoleBindingView[]; nextCursor: null }> {
    await this.#authorize(this.#d.auth.store, 'role_binding.list', session, INSTALLATION)
    const all = await listRoleBindings(this.#d.auth.store, {
      ...(query.identity === undefined ? {} : { identityId: query.identity }),
      includeRevoked: query.state === 'revoked',
    })
    const items = all.filter((b) => query.state === undefined || b.state === query.state)
    return { items: items.slice(0, query.limit), nextCursor: null }
  }

  async policySettings(session: SessionContext): Promise<PolicySettingsView> {
    await this.#authorize(this.#d.auth.store, 'policy_settings.get', session, INSTALLATION)
    return policySettingsView(this.#d.auth.store, this.#d.policy.registry, this.#d.ruleIds)
  }

  async approvals(session: SessionContext): Promise<{ items: ApprovalQueueItem[] }> {
    await this.#authorize(this.#d.auth.store, 'approval.list', session, INSTALLATION)
    const items = await approvalQueue(this.#d.auth.store, session)
    // Wave 3A resolves installation-wide plans only; target plans wait for the registry.
    return { items: items.filter((i) => i.tier === null) }
  }

  // ----- inline access changes (C-6: precondition, re-authentication, mutation, audit) -----

  async invite(
    meta: RequestMeta,
    session: SessionContext,
    body: { readonly email: string; readonly displayName?: string | undefined },
  ): Promise<InvitationResponse> {
    const request = await auditRequest(this.#d.auth.keys, meta)
    const result = await this.#d.auth.store.transaction('application.invite', async (tx) => {
      await this.#authorize(tx, 'access.identity.invite', session, INSTALLATION)
      return inviteIdentity(tx, this.#d.auth, session, request, body)
    })
    const outcomes = await dispatchNotifications(this.#d.auth.store, this.#d.auth.channel, [
      result.delivery,
    ])
    const outcome =
      result.delivery === undefined ? undefined : outcomes.get(result.delivery.notificationId)
    return {
      identity: result.identity,
      invitation: {
        link: result.link,
        expiresAt: result.expiresAt,
        delivery: deliveryStatus(this.#d.auth, outcome),
      },
    }
  }

  async reissueInvitation(
    meta: RequestMeta,
    session: SessionContext,
    identityId: IdentityId,
  ): Promise<InvitationResponse> {
    const request = await auditRequest(this.#d.auth.keys, meta)
    const result = await this.#d.auth.store.transaction('application.reissue', async (tx) => {
      await this.#authorize(tx, 'access.invitation.reissue', session, INSTALLATION)
      return reissueInvitation(tx, this.#d.auth, session, request, identityId)
    })
    const outcomes = await dispatchNotifications(this.#d.auth.store, this.#d.auth.channel, [
      result.delivery,
    ])
    const outcome =
      result.delivery === undefined ? undefined : outcomes.get(result.delivery.notificationId)
    return {
      identity: result.identity,
      invitation: {
        link: result.link,
        expiresAt: result.expiresAt,
        delivery: deliveryStatus(this.#d.auth, outcome),
      },
    }
  }

  async disable(
    meta: RequestMeta,
    session: SessionContext,
    identityId: IdentityId,
    reason: string | undefined,
  ): Promise<IdentityView> {
    const request = await auditRequest(this.#d.auth.keys, meta)
    const result = await this.#d.auth.store.transaction('application.disable', async (tx) => {
      const authorization = await this.#d.authorizer.authorize(
        tx,
        { action: 'access.identity.disable', principal: principalOf(session) },
        INSTALLATION,
      )
      const decision = await withPolicy(principalOf(session), authorization, () =>
        evaluateAccessPolicy(tx, this.#d.policy, {
          kind: 'access.identity.disable',
          actor: { identityId: session.identityId, reauthAt: session.reauthAt },
          change: { kind: 'identity.disable', identityId },
          content: { identityId },
        }),
      )
      if (decision.decision !== 'allow') {
        throw decision.decision === 'deny' ? decision.error : new AuthError('APPROVAL_REQUIRED')
      }
      return disableIdentity(tx, this.#d.auth, session, request, identityId, reason)
    })
    await dispatchNotifications(this.#d.auth.store, this.#d.auth.channel, [result.delivery])
    return result.identity
  }

  // ----- planned access changes -----

  async #plan(
    session: SessionContext,
    action: string,
    idempotency: { readonly key: string; readonly requestHash: string } | undefined,
    create: (tx: Tx) => Promise<PlanRecord>,
  ): Promise<PlanView> {
    return this.#d.auth.store.transaction('application.plan', async (tx) => {
      await this.#authorize(tx, action, session, INSTALLATION)
      if (idempotency !== undefined) {
        const started = await beginIdempotent(tx, {
          principal: `idn:${session.identityId}`,
          key: idempotency.key,
          requestHash: idempotency.requestHash,
        })
        if (started.status === 'replay') {
          return PlanViewSchema.parse(started.response)
        }
      }
      const view = await planView(tx, await create(tx))
      if (idempotency !== undefined) {
        await completeIdempotent(tx, {
          principal: `idn:${session.identityId}`,
          key: idempotency.key,
          response: json(view),
        })
      }
      return view
    })
  }

  planRoleBinding(
    session: SessionContext,
    body: {
      readonly identityId: IdentityId
      readonly roleId: BuiltInRoleId
      readonly scope: BindingScope
    },
    idempotency?: { readonly key: string; readonly requestHash: string },
  ): Promise<PlanView> {
    return this.#plan(session, 'access.role_binding.create.plan', idempotency, (tx) =>
      planRoleBindingCreate(tx, this.#d.policy, session, body),
    )
  }

  planRoleBindingRemoval(
    session: SessionContext,
    bindingId: RoleBindingId,
    idempotency?: { readonly key: string; readonly requestHash: string },
  ): Promise<PlanView> {
    return this.#plan(session, 'access.role_binding.delete.plan', idempotency, (tx) =>
      planRoleBindingDelete(tx, this.#d.policy, session, bindingId),
    )
  }

  planPolicySettings(
    session: SessionContext,
    body: {
      readonly scopeKind: string
      readonly scopeId: string
      readonly ruleId: string
      readonly params: JsonObject
    },
    idempotency?: { readonly key: string; readonly requestHash: string },
  ): Promise<PlanView> {
    return this.#plan(session, 'access.policy_settings.update.plan', idempotency, (tx) =>
      planPolicySettingsUpdate(tx, this.#d.policy, session, body),
    )
  }

  planIdentityChange(
    session: SessionContext,
    kind: 'access.identity.enable' | 'access.identity.erase',
    identityId: IdentityId,
    idempotency?: { readonly key: string; readonly requestHash: string },
  ): Promise<PlanView> {
    return this.#plan(session, `${kind}.plan`, idempotency, (tx) =>
      planIdentityChange(tx, this.#d.policy, session, kind, identityId),
    )
  }

  // ----- apply, withdraw, approvals -----

  async apply(session: SessionContext, planId: string): Promise<OperationView> {
    const operationId = await this.#d.auth.store.transaction('application.apply', async (tx) => {
      const plan = await readPlan(tx, planId)
      if (plan === undefined) {
        throw new OperationError('PLAN_NOT_FOUND')
      }
      await this.#authorize(
        tx,
        'plan.apply',
        session,
        { kind: 'plan', subject: subjectOf(plan) },
        plan.kind,
      )
      if (this.#d.kinds.get(plan.kind) === undefined) {
        throw new OperationError('operation_kind_unknown')
      }
      const result = await applyAccessPlan(tx, this.#d.policy, this.#d.kinds, session, planId)
      if (result.status === 'refused') {
        // Invalidations are persisted by acceptPlan before it refuses: commit them.
        return result.error
      }
      return result.operation.operationId
    })
    if (typeof operationId !== 'string') {
      throw operationId
    }
    return operationView(this.#d.auth.store, operationId, this.publicOrigin)
  }

  async withdraw(session: SessionContext, planId: string): Promise<PlanView> {
    return this.#d.auth.store.transaction('application.withdraw', async (tx) => {
      const plan = await readPlan(tx, planId)
      if (plan === undefined) {
        throw new OperationError('PLAN_NOT_FOUND')
      }
      await this.#authorize(
        tx,
        'plan.withdraw',
        session,
        { kind: 'plan', subject: subjectOf(plan) },
        plan.kind,
      )
      await withdrawPlan(
        tx,
        planId,
        {
          kind: 'human',
          identityId: session.identityId,
          label: session.label,
          client: 'web',
          clientId: null,
        },
        { clock: this.#d.policy.clock },
      )
      const after = await readPlan(tx, planId)
      if (after === undefined) {
        throw new OperationError('PLAN_NOT_FOUND')
      }
      return planView(tx, after)
    })
  }

  async #decide(
    session: SessionContext,
    operationId: OperationId,
    action: 'approval.approve' | 'approval.reject',
    run: (tx: Tx) => Promise<{ readonly approval: ApprovalView }>,
  ): Promise<ApprovalView> {
    return this.#d.auth.store.transaction(`application.${action}`, async (tx) => {
      const { rows } = await tx.query(
        'application.approval.plan',
        'SELECT plan_id FROM operations.operations WHERE operation_id = $1',
        [operationId],
      )
      const planId = rows[0]?.textOrNull('plan_id')
      const plan = planId === undefined || planId === null ? undefined : await readPlan(tx, planId)
      if (plan === undefined) {
        throw new AuthError('OPERATION_NOT_FOUND')
      }
      await this.#authorize(tx, action, session, { kind: 'plan', subject: subjectOf(plan) })
      return (await run(tx)).approval
    })
  }

  approve(
    session: SessionContext,
    operationId: OperationId,
    body: { readonly planHash: string; readonly acknowledgeSelfApproval?: true | undefined },
  ): Promise<ApprovalView> {
    return this.#decide(session, operationId, 'approval.approve', (tx) =>
      approve(tx, this.#d.policy, session, operationId, body),
    )
  }

  reject(
    session: SessionContext,
    operationId: OperationId,
    body: { readonly planHash: string },
  ): Promise<ApprovalView> {
    return this.#decide(session, operationId, 'approval.reject', (tx) =>
      reject(tx, this.#d.policy, session, operationId, body),
    )
  }
}

function subjectOf(plan: PlanRecord): PlanSubject {
  const subject = plan.body['subject']
  if (!isJsonObject(subject)) {
    return {}
  }
  const targetId = subject['targetId']
  const tier = subject['tier']
  const out: { targetId?: string; tier?: 'prod' | 'nonprod' } = {}
  if (typeof targetId === 'string') {
    out.targetId = targetId
  }
  if (tier === 'prod' || tier === 'nonprod') {
    out.tier = tier
  }
  return out
}
