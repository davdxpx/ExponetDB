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
  oauth,
  type PlanActor,
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
  type AuthorizationServerMetadata,
  type BindingScope,
  type BuiltInRoleId,
  type ConsentView,
  type CreationOptions,
  type EnrollmentComplete,
  type EnrollmentState,
  type FactorView,
  type GrantView,
  type IdentityView,
  type Installation,
  type InvitationResponse,
  type Me,
  type OAuthClientView,
  type OAuthResource,
  type PlanView,
  PlanViewSchema,
  type PolicySettingsView,
  type ProtectedResourceMetadata,
  type ReauthResult,
  type RecoveryCodesView,
  type RegistrationCredential,
  type RequestOptions,
  type RoleBindingView,
  type Scope,
  type SecondFactorStep,
  type SessionView,
  type SignedIn,
  type Tier,
  type TokenResponse,
  type TotpSetup,
} from '@exponetdb/contracts'
import type { Tx } from '@exponetdb/control-store'
import {
  type AuthFactorId,
  type GrantId,
  type IdentityId,
  isId,
  isJsonObject,
  type JsonObject,
  type JsonValue,
  type OAuthClientId,
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
  /** The running release (`GET /installation`). */
  readonly installation: { readonly version: string; readonly features: readonly string[] }
  /** Authorization server extensions: client assertions, further grants, CIMD refresh. */
  readonly oauth?: {
    readonly assertions?: oauth.ClientAssertionVerifier
    readonly grants?: oauth.ExtraGrants
    readonly refresher?: oauth.ClientMetadataRefresher
  }
}

/**
 * Who calls a use case: a Web App session, or a bearer credential (an
 * OAuth access token or an API key) at the resource it arrived at. Both go
 * to the same engine; a bearer caller never has a session and never a fresh
 * re-authentication.
 */
export type Caller =
  | { readonly kind: 'session'; readonly session: SessionContext }
  | {
      readonly kind: 'bearer'
      readonly principal: oauth.DelegatedPrincipal
      readonly resource: OAuthResource
    }

export function sessionCaller(session: SessionContext): Caller {
  return { kind: 'session', session }
}

const INSTALLATION: SubjectRef = { kind: 'installation' }

function principalOf(caller: Caller | undefined): Principal {
  if (caller === undefined) {
    return { kind: 'anonymous', client: 'web' }
  }
  return caller.kind === 'session'
    ? {
        kind: 'human',
        identityId: caller.session.identityId,
        client: 'web',
        session: caller.session,
      }
    : caller.principal
}

function identityOf(caller: Caller): IdentityId {
  return caller.kind === 'session' ? caller.session.identityId : caller.principal.identityId
}

function selfRef(caller: Caller): SubjectRef {
  return { kind: 'self', identityId: identityOf(caller) }
}

/**
 * The session behind an authorized action that only a Web App session may
 * reach (own credentials, approvals, inline changes with re-authentication).
 * The engine already refused anything else; this only narrows the type.
 */
function sessionOf(caller: Caller): SessionContext {
  if (caller.kind !== 'session') {
    throw new AuthError('PERMISSION_DENIED')
  }
  return caller.session
}

/** The planner of an access change: a session, or a person through the first-party CLI. */
function planActor(caller: Caller): PlanActor {
  if (caller.kind === 'session') {
    return caller.session
  }
  const { principal } = caller
  const credential = principal.delegation.credential
  if (
    principal.identityKind !== 'human' ||
    principal.client !== 'cli' ||
    credential.type !== 'access_token'
  ) {
    throw new AuthError('PERMISSION_DENIED')
  }
  return {
    identityId: principal.identityId,
    label: principal.label,
    reauthAt: null,
    client: 'cli',
    clientId: credential.clientId,
  }
}

function idempotencyPrincipal(caller: Caller): string {
  return `idn:${identityOf(caller)}`
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
    caller: Caller | undefined,
    subject: SubjectRef,
    planKind?: string,
  ): Promise<Authorization> {
    const result = await this.#d.authorizer.authorize(
      q,
      {
        action,
        principal: principalOf(caller),
        ...(planKind === undefined ? {} : { planKind }),
        ...(caller?.kind === 'bearer' ? { resource: caller.resource } : {}),
      },
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
      const caller = session === undefined ? undefined : sessionCaller(session)
      await this.#authorize(
        this.#d.auth.store,
        action,
        caller,
        caller === undefined ? INSTALLATION : selfRef(caller),
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

  /** A self ceremony reached through `/api/v1`: the engine decides for any caller, only a session passes. */
  async #selfCeremony<T>(
    action: string,
    caller: Caller,
    run: (session: SessionContext) => Promise<Outcome<T>>,
  ): Promise<Outcome<T>> {
    try {
      await this.#authorize(this.#d.auth.store, action, caller, selfRef(caller))
    } catch (error) {
      if (error instanceof AuthError) {
        return refusal(error)
      }
      throw error
    }
    const outcome = await run(sessionOf(caller))
    await dispatchNotifications(this.#d.auth.store, this.#d.auth.channel, outcome.deliveries)
    return outcome
  }

  revokeSession(meta: RequestMeta, caller: Caller, target: SessionId) {
    return this.#selfCeremony('auth.session.revoke', caller, (session) =>
      selfService.revokeOwnSession(this.#d.auth, meta, session, target),
    )
  }

  revokeOtherSessions(meta: RequestMeta, caller: Caller) {
    return this.#selfCeremony('auth.session.revoke', caller, (session) =>
      selfService.revokeOtherSessions(this.#d.auth, meta, session),
    )
  }

  // ----- reads -----

  async installation(caller: Caller): Promise<Installation> {
    await this.#authorize(this.#d.auth.store, 'installation.get', caller, INSTALLATION)
    return {
      version: this.#d.installation.version,
      contracts: {
        restApi: 'v1',
        mcpCatalog: 'exponetdb.mcp/v1',
        nodeProtocol: 'exponetdb.node/v1',
        migrationManifest: 'exponetdb.migration/v1',
        projectConfig: 'exponetdb.project/v1',
      },
      features: [...this.#d.installation.features],
    }
  }

  async me(caller: Caller): Promise<Me> {
    await this.#authorize(this.#d.auth.store, 'me.get', caller, selfRef(caller))
    return me(this.#d.auth.store, sessionOf(caller))
  }

  async sessions(caller: Caller): Promise<SessionView[]> {
    await this.#authorize(this.#d.auth.store, 'auth.session.list', caller, selfRef(caller))
    return selfService.ownSessions(this.#d.auth, sessionOf(caller))
  }

  async factors(caller: Caller): Promise<FactorView[]> {
    await this.#authorize(this.#d.auth.store, 'auth.factor.list', caller, selfRef(caller))
    return selfService.ownFactors(this.#d.auth, sessionOf(caller))
  }

  async identities(
    caller: Caller,
    query: { readonly state?: IdentityView['state'] | undefined; readonly limit: number },
  ): Promise<{ items: IdentityView[]; nextCursor: null }> {
    await this.#authorize(this.#d.auth.store, 'identity.list', caller, INSTALLATION)
    const all = await listIdentities(this.#d.auth.store)
    const items = all.filter((i) => query.state === undefined || i.state === query.state)
    return { items: items.slice(0, query.limit), nextCursor: null }
  }

  async identity(caller: Caller, identityId: IdentityId): Promise<IdentityView> {
    await this.#authorize(this.#d.auth.store, 'identity.get', caller, INSTALLATION)
    return getIdentity(this.#d.auth.store, identityId)
  }

  async roles(caller: Caller) {
    await this.#authorize(this.#d.auth.store, 'role.list', caller, INSTALLATION)
    return { items: listRoles() }
  }

  async role(caller: Caller, roleId: BuiltInRoleId) {
    await this.#authorize(this.#d.auth.store, 'role.get', caller, INSTALLATION)
    return roleView(roleId)
  }

  async roleBindings(
    caller: Caller,
    query: {
      readonly identity?: IdentityId | undefined
      readonly state?: 'active' | 'revoked' | undefined
      readonly limit: number
    },
  ): Promise<{ items: RoleBindingView[]; nextCursor: null }> {
    await this.#authorize(this.#d.auth.store, 'role_binding.list', caller, INSTALLATION)
    const all = await listRoleBindings(this.#d.auth.store, {
      ...(query.identity === undefined ? {} : { identityId: query.identity }),
      includeRevoked: query.state === 'revoked',
    })
    const items = all.filter((b) => query.state === undefined || b.state === query.state)
    return { items: items.slice(0, query.limit), nextCursor: null }
  }

  async policySettings(caller: Caller): Promise<PolicySettingsView> {
    await this.#authorize(this.#d.auth.store, 'policy_settings.get', caller, INSTALLATION)
    return policySettingsView(this.#d.auth.store, this.#d.policy.registry, this.#d.ruleIds)
  }

  async approvals(caller: Caller): Promise<{ items: ApprovalQueueItem[] }> {
    await this.#authorize(this.#d.auth.store, 'approval.list', caller, INSTALLATION)
    const items = await approvalQueue(this.#d.auth.store, sessionOf(caller))
    // Wave 3A resolves installation-wide plans only; target plans wait for the registry.
    return { items: items.filter((i) => i.tier === null) }
  }

  // ----- inline access changes (C-6: precondition, re-authentication, mutation, audit) -----

  async invite(
    meta: RequestMeta,
    caller: Caller,
    body: { readonly email: string; readonly displayName?: string | undefined },
  ): Promise<InvitationResponse> {
    const request = await auditRequest(this.#d.auth.keys, meta)
    const result = await this.#d.auth.store.transaction('application.invite', async (tx) => {
      await this.#authorize(tx, 'access.identity.invite', caller, INSTALLATION)
      return inviteIdentity(tx, this.#d.auth, sessionOf(caller), request, body)
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
    caller: Caller,
    identityId: IdentityId,
  ): Promise<InvitationResponse> {
    const request = await auditRequest(this.#d.auth.keys, meta)
    const result = await this.#d.auth.store.transaction('application.reissue', async (tx) => {
      await this.#authorize(tx, 'access.invitation.reissue', caller, INSTALLATION)
      return reissueInvitation(tx, this.#d.auth, sessionOf(caller), request, identityId)
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
    caller: Caller,
    identityId: IdentityId,
    reason: string | undefined,
  ): Promise<IdentityView> {
    const request = await auditRequest(this.#d.auth.keys, meta)
    const result = await this.#d.auth.store.transaction('application.disable', async (tx) => {
      const authorization = await this.#d.authorizer.authorize(
        tx,
        {
          action: 'access.identity.disable',
          principal: principalOf(caller),
          ...(caller.kind === 'bearer' ? { resource: caller.resource } : {}),
        },
        INSTALLATION,
      )
      const session = authorization.allowed ? sessionOf(caller) : undefined
      const decision = await withPolicy(principalOf(caller), authorization, () =>
        evaluateAccessPolicy(tx, this.#d.policy, {
          kind: 'access.identity.disable',
          actor: { identityId: identityOf(caller), reauthAt: session?.reauthAt ?? null },
          change: { kind: 'identity.disable', identityId },
          content: { identityId },
        }),
      )
      if (decision.decision !== 'allow' || session === undefined) {
        throw decision.decision === 'deny' ? decision.error : new AuthError('APPROVAL_REQUIRED')
      }
      return disableIdentity(tx, this.#d.auth, session, request, identityId, reason)
    })
    await dispatchNotifications(this.#d.auth.store, this.#d.auth.channel, [result.delivery])
    return result.identity
  }

  // ----- planned access changes -----

  async #plan(
    caller: Caller,
    action: string,
    idempotency: { readonly key: string; readonly requestHash: string } | undefined,
    create: (tx: Tx, actor: PlanActor) => Promise<PlanRecord>,
  ): Promise<PlanView> {
    return this.#d.auth.store.transaction('application.plan', async (tx) => {
      await this.#authorize(tx, action, caller, INSTALLATION)
      const actor = planActor(caller)
      if (idempotency !== undefined) {
        const started = await beginIdempotent(tx, {
          principal: idempotencyPrincipal(caller),
          key: idempotency.key,
          requestHash: idempotency.requestHash,
        })
        if (started.status === 'replay') {
          return PlanViewSchema.parse(started.response)
        }
      }
      const view = await planView(tx, await create(tx, actor))
      if (idempotency !== undefined) {
        await completeIdempotent(tx, {
          principal: idempotencyPrincipal(caller),
          key: idempotency.key,
          response: json(view),
        })
      }
      return view
    })
  }

  planRoleBinding(
    caller: Caller,
    body: {
      readonly identityId: IdentityId
      readonly roleId: BuiltInRoleId
      readonly scope: BindingScope
    },
    idempotency?: { readonly key: string; readonly requestHash: string },
  ): Promise<PlanView> {
    return this.#plan(caller, 'access.role_binding.create.plan', idempotency, (tx, actor) =>
      planRoleBindingCreate(tx, this.#d.policy, actor, body),
    )
  }

  planRoleBindingRemoval(
    caller: Caller,
    bindingId: RoleBindingId,
    idempotency?: { readonly key: string; readonly requestHash: string },
  ): Promise<PlanView> {
    return this.#plan(caller, 'access.role_binding.delete.plan', idempotency, (tx, actor) =>
      planRoleBindingDelete(tx, this.#d.policy, actor, bindingId),
    )
  }

  planPolicySettings(
    caller: Caller,
    body: {
      readonly scopeKind: string
      readonly scopeId: string
      readonly ruleId: string
      readonly params: JsonObject
    },
    idempotency?: { readonly key: string; readonly requestHash: string },
  ): Promise<PlanView> {
    return this.#plan(caller, 'access.policy_settings.update.plan', idempotency, (tx, actor) =>
      planPolicySettingsUpdate(tx, this.#d.policy, actor, body),
    )
  }

  planIdentityChange(
    caller: Caller,
    kind: 'access.identity.enable' | 'access.identity.erase',
    identityId: IdentityId,
    idempotency?: { readonly key: string; readonly requestHash: string },
  ): Promise<PlanView> {
    return this.#plan(caller, `${kind}.plan`, idempotency, (tx, actor) =>
      planIdentityChange(tx, this.#d.policy, actor, kind, identityId),
    )
  }

  // ----- apply, withdraw, approvals -----

  async apply(caller: Caller, planId: string): Promise<OperationView> {
    const operationId = await this.#d.auth.store.transaction('application.apply', async (tx) => {
      const plan = await readPlan(tx, planId)
      if (plan === undefined) {
        throw new OperationError('PLAN_NOT_FOUND')
      }
      await this.#authorize(
        tx,
        'plan.apply',
        caller,
        { kind: 'plan', subject: subjectOf(plan) },
        plan.kind,
      )
      if (this.#d.kinds.get(plan.kind) === undefined) {
        throw new OperationError('operation_kind_unknown')
      }
      // Every access kind needs a fresh re-authentication: only a session reaches here.
      const result = await applyAccessPlan(
        tx,
        this.#d.policy,
        this.#d.kinds,
        sessionOf(caller),
        planId,
      )
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

  async withdraw(caller: Caller, planId: string): Promise<PlanView> {
    return this.#d.auth.store.transaction('application.withdraw', async (tx) => {
      const plan = await readPlan(tx, planId)
      if (plan === undefined) {
        throw new OperationError('PLAN_NOT_FOUND')
      }
      await this.#authorize(
        tx,
        'plan.withdraw',
        caller,
        { kind: 'plan', subject: subjectOf(plan) },
        plan.kind,
      )
      const actor = planActor(caller)
      await withdrawPlan(
        tx,
        planId,
        {
          kind: 'human',
          identityId: actor.identityId,
          label: actor.label,
          client: actor.client ?? 'web',
          clientId: actor.clientId ?? null,
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
    caller: Caller,
    operationId: OperationId,
    action: 'approval.approve' | 'approval.reject',
    run: (tx: Tx, session: SessionContext) => Promise<{ readonly approval: ApprovalView }>,
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
      await this.#authorize(tx, action, caller, { kind: 'plan', subject: subjectOf(plan) })
      return (await run(tx, sessionOf(caller))).approval
    })
  }

  approve(
    caller: Caller,
    operationId: OperationId,
    body: { readonly planHash: string; readonly acknowledgeSelfApproval?: true | undefined },
  ): Promise<ApprovalView> {
    return this.#decide(caller, operationId, 'approval.approve', (tx, session) =>
      approve(tx, this.#d.policy, session, operationId, body),
    )
  }

  reject(
    caller: Caller,
    operationId: OperationId,
    body: { readonly planHash: string },
  ): Promise<ApprovalView> {
    return this.#decide(caller, operationId, 'approval.reject', (tx, session) =>
      reject(tx, this.#d.policy, session, operationId, body),
    )
  }

  // ----- OAuth: discovery and protocol endpoints (oauth.md §2, §4, §5) -----

  /** Bearer authentication of a request at `resource`; undefined when the credential is not valid there. */
  async authenticateBearer(
    token: string,
    resource: OAuthResource,
  ): Promise<oauth.DelegatedPrincipal | undefined> {
    const result = await oauth.authenticateBearer(this.#d.auth.store, token, resource)
    return result.ok ? result.principal : undefined
  }

  async #protocol(action: string): Promise<void> {
    await this.#authorize(this.#d.auth.store, action, undefined, INSTALLATION)
  }

  async authorizationServerMetadata(): Promise<AuthorizationServerMetadata> {
    await this.#protocol('oauth.metadata.get')
    return oauth.authorizationServerMetadata(this.publicOrigin)
  }

  async protectedResourceMetadata(resource: OAuthResource): Promise<ProtectedResourceMetadata> {
    await this.#protocol('oauth.metadata.get')
    return oauth.protectedResourceMetadata(this.publicOrigin, resource)
  }

  async authorize(
    meta: RequestMeta,
    rawQuery: string,
    bindingCookie: string | undefined,
  ): Promise<oauth.AuthorizeOutcome> {
    await this.#protocol('oauth.authorize')
    return oauth.startAuthorization(
      this.#d.auth,
      meta,
      rawQuery,
      bindingCookie,
      this.#d.oauth?.refresher,
    )
  }

  #tokenDeps(): oauth.TokenEndpointDeps {
    return {
      auth: this.#d.auth,
      ...(this.#d.oauth?.assertions === undefined ? {} : { assertions: this.#d.oauth.assertions }),
      ...(this.#d.oauth?.grants === undefined ? {} : { grants: this.#d.oauth.grants }),
    }
  }

  async token(meta: RequestMeta, request: oauth.TokenRequest): Promise<TokenResponse> {
    await this.#protocol('oauth.token')
    return oauth.tokenEndpoint(this.#tokenDeps(), meta, request)
  }

  async revokeToken(meta: RequestMeta, request: oauth.TokenRequest): Promise<void> {
    await this.#protocol('oauth.revoke')
    await oauth.revocationEndpoint(this.#tokenDeps(), meta, request)
  }

  // ----- OAuth: consent (Web App ceremonies) -----

  async consentView(
    caller: Caller,
    handle: string,
    bindingCookie: string | undefined,
  ): Promise<ConsentView> {
    await this.#authorize(this.#d.auth.store, 'oauth.consent.get', caller, selfRef(caller))
    return oauth.consentView(this.#d.auth, sessionOf(caller), handle, bindingCookie)
  }

  async consent(
    meta: RequestMeta,
    caller: Caller,
    body: {
      readonly request: string
      readonly decision: 'allow' | 'deny'
      readonly scopes: readonly Scope[]
      readonly tiers: readonly Tier[]
      readonly lifetimeDays: number
      readonly acknowledgeProduction?: true | undefined
    },
    bindingCookie: string | undefined,
  ): Promise<{ readonly redirectTo: string }> {
    return this.#d.auth.store.transaction('application.oauth.consent', async (tx) => {
      await this.#authorize(tx, 'oauth.consent', caller, selfRef(caller))
      return oauth.decideConsent(tx, this.#d.auth, meta, sessionOf(caller), body, bindingCookie)
    })
  }

  // ----- OAuth: connected applications and administration -----

  async myGrants(caller: Caller): Promise<GrantView[]> {
    await this.#authorize(this.#d.auth.store, 'oauth.grant.list_own', caller, selfRef(caller))
    return oauth.listGrantViews(this.#d.auth.store, this.publicOrigin, {
      identityId: identityOf(caller),
      limit: 200,
    })
  }

  async revokeMyGrant(
    meta: RequestMeta,
    caller: Caller,
    grantId: GrantId,
  ): Promise<{ readonly revoked: boolean }> {
    const request = await auditRequest(this.#d.auth.keys, meta)
    return this.#d.auth.store.transaction('application.oauth.revoke_own', async (tx) => {
      await this.#authorize(tx, 'oauth.grant.revoke_own', caller, selfRef(caller))
      const session = sessionOf(caller)
      const grant = await oauth.readGrant(tx, grantId, { forUpdate: true })
      // Another identity's grant is "not found" for the caller.
      if (grant === undefined || grant.identityId !== session.identityId) {
        throw new AuthError('NOT_FOUND')
      }
      const revoked = await oauth.revokeGrant(tx, grantId, 'owner', session.identityId)
      if (revoked) {
        await oauth.auditGrantRevoked(tx, this.#d.auth, session, request, grant, 'owner')
      }
      return { revoked }
    })
  }

  async grants(
    caller: Caller,
    query: {
      readonly identity?: IdentityId | undefined
      readonly state?: 'active' | 'revoked' | 'expired' | undefined
      readonly limit: number
    },
  ): Promise<{ items: GrantView[]; nextCursor: null }> {
    await this.#authorize(this.#d.auth.store, 'oauth.grant.list', caller, INSTALLATION)
    const items = await oauth.listGrantViews(this.#d.auth.store, this.publicOrigin, {
      ...(query.identity === undefined ? {} : { identityId: query.identity }),
      ...(query.state === undefined ? {} : { state: query.state }),
      limit: query.limit,
    })
    return { items, nextCursor: null }
  }

  async revokeGrant(
    meta: RequestMeta,
    caller: Caller,
    grantId: GrantId,
  ): Promise<{ readonly revoked: boolean }> {
    const request = await auditRequest(this.#d.auth.keys, meta)
    return this.#d.auth.store.transaction('application.oauth.revoke', async (tx) => {
      await this.#authorize(tx, 'oauth.grant.revoke', caller, INSTALLATION)
      const session = sessionOf(caller)
      const grant = await oauth.readGrant(tx, grantId, { forUpdate: true })
      if (grant === undefined) {
        throw new AuthError('NOT_FOUND')
      }
      const revoked = await oauth.revokeGrant(tx, grantId, 'administrator', session.identityId)
      if (revoked) {
        await oauth.auditGrantRevoked(tx, this.#d.auth, session, request, grant, 'administrator')
      }
      return { revoked }
    })
  }

  async oauthClients(
    caller: Caller,
    query: { readonly state?: OAuthClientView['state'] | undefined; readonly limit: number },
  ): Promise<{ items: OAuthClientView[]; nextCursor: null }> {
    await this.#authorize(this.#d.auth.store, 'oauth.client.list', caller, INSTALLATION)
    const items = await oauth.listClientViews(this.#d.auth.store, query)
    return { items, nextCursor: null }
  }

  async oauthClient(caller: Caller, clientId: OAuthClientId): Promise<OAuthClientView> {
    await this.#authorize(this.#d.auth.store, 'oauth.client.get', caller, INSTALLATION)
    const client = await oauth.readClient(this.#d.auth.store, clientId)
    if (client === undefined) {
      throw new AuthError('NOT_FOUND')
    }
    return oauth.clientView(client)
  }
}

export function isGrantId(value: unknown): value is GrantId {
  return isId('grt', value)
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
