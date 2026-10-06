import {
  type ActionDefinition,
  type ActionId,
  actionDefinition,
  type ClientKind,
  HUMAN_SESSION_CLIENT_KINDS,
  isActionId,
  isScope,
  type Permission,
  scopeDefinition,
} from '@exponetdb/contracts'
import type { Queryable } from '@exponetdb/control-store'
import type { IdentityId } from '@exponetdb/kernel'
import type { PlanSubject } from '@exponetdb/operations'
import type { PolicyDecision, Requirement } from '@exponetdb/policy'
import { AuthError } from '../errors.ts'
import type { SessionContext } from '../sessions.ts'
import { type Grant, holds, INSTALLATION_SUBJECT, loadGrants, type SubjectChain } from './scope.ts'

/**
 * The central authorization engine (authorization.md §1). Every interface
 * calls it; no handler decides access itself. Two phases:
 *
 * 1. Before the input is parsed: the action exists, the client kind is
 *    allowed, the human-only rule holds, a recovery session is limited to
 *    setting up factors, and the identity holds the permission at some
 *    scope (its live grants, read fresh from the Control Store).
 * 2. After the server resolved the subject (never from the request): the
 *    permission holds at a scope that structurally covers the subject, the
 *    tier is known where it matters, the subject of a `self` action is the
 *    caller, and the re-authentication window of the action is met on the
 *    database clock with a passkey or TOTP proof.
 *
 * Policy (`packages/policy`) runs after both phases for consequential
 * actions; it can only refuse or add requirements, never allow what these
 * phases denied. There is no owner bypass: an owner passes because the
 * owner role lists every permission, and the policy rules still apply.
 * Anything unknown denies.
 */
export type Principal =
  | { readonly kind: 'anonymous'; readonly client: ClientKind }
  | {
      readonly kind: 'human'
      readonly identityId: IdentityId
      readonly client: ClientKind
      readonly session: SessionContext
    }
  /** Modeled for the matrix and Wave 3B; no credential authenticates one in Wave 3A. */
  | { readonly kind: 'service'; readonly identityId: IdentityId; readonly client: ClientKind }

export type SubjectRef =
  | { readonly kind: 'installation' }
  | { readonly kind: 'self'; readonly identityId: IdentityId }
  | { readonly kind: 'plan'; readonly subject: PlanSubject }
  | { readonly kind: 'target'; readonly targetId: string }

/**
 * Resolves a subject reference to its scope chain from server-side truth
 * (registry, plan). `undefined` means it cannot be resolved: the decision
 * denies (fail closed).
 */
export interface AuthorizationSubjectResolver {
  resolve(ref: SubjectRef): Promise<SubjectChain | undefined>
}

/**
 * Wave 3A resolver: installation-wide and self subjects are global; a plan
 * keeps the tier recorded at planning time; a target (and a plan on a
 * target) needs the registry, which arrives in Wave 4, so it is refused
 * until a target chain source is supplied.
 */
export class ControlPlaneSubjectResolver implements AuthorizationSubjectResolver {
  readonly #targets: ((targetId: string) => Promise<SubjectChain | undefined>) | undefined

  constructor(targets?: (targetId: string) => Promise<SubjectChain | undefined>) {
    this.#targets = targets
  }

  async resolve(ref: SubjectRef): Promise<SubjectChain | undefined> {
    switch (ref.kind) {
      case 'installation':
      case 'self':
        return INSTALLATION_SUBJECT
      case 'target':
        return this.#targets === undefined ? undefined : this.#targets(ref.targetId)
      case 'plan': {
        if (ref.subject.targetId === undefined) {
          return ref.subject.tier === undefined ? INSTALLATION_SUBJECT : { tier: ref.subject.tier }
        }
        if (this.#targets === undefined) {
          return undefined
        }
        const chain = await this.#targets(ref.subject.targetId)
        // The plan's recorded tier governs (authorization.md §5); a registry that disagrees refuses.
        if (
          chain === undefined ||
          (ref.subject.tier !== undefined && chain.tier !== ref.subject.tier)
        ) {
          return undefined
        }
        return chain
      }
    }
  }
}

/** What a recovery session (after a recovery code) may do: see itself, sign out, set up factors. */
export const RECOVERY_SESSION_ACTIONS: ReadonlySet<ActionId> = new Set<ActionId>([
  'me.get',
  'auth.session.list',
  'auth.factor.list',
  'auth.logout',
  'auth.reauth',
  'auth.session.revoke',
  'auth.passkey.add',
  'auth.password.change',
  'auth.totp.replace',
  'auth.recovery_codes.regenerate',
])

export type DenyReason =
  | 'unknown_action'
  | 'unauthenticated'
  | 'client_kind'
  | 'human_only'
  | 'recovery_session'
  | 'no_permission'
  | 'unsupported_rule'
  | 'subject_unresolved'
  | 'tier_unknown'
  | 'not_self'
  | 'scope'
  | 'scope_client'
  | 'reauth'
  | 'policy'

export interface Denial {
  readonly allowed: false
  readonly reason: DenyReason
  readonly error: AuthError
}

export interface Admission {
  readonly allowed: true
  readonly action: ActionId
  /** The definition that governs: the plan kind's for `of_plan_kind` actions. */
  readonly definition: ActionDefinition
  readonly permission: Permission | 'self' | 'public'
  readonly grants: readonly Grant[]
}

export interface Authorization extends Omit<Admission, 'allowed'> {
  readonly allowed: true
  readonly subject: SubjectChain
  /** Grants that cover the subject (empty for `self` and `public`). */
  readonly covering: readonly Grant[]
}

export interface AuthorizationRequest {
  readonly action: string
  readonly principal: Principal
  /** For `of_plan_kind` actions (apply, withdraw): the plan's kind. */
  readonly planKind?: string
}

const deny = (reason: DenyReason, code: ConstructorParameters<typeof AuthError>[0]): Denial => ({
  allowed: false,
  reason,
  error: new AuthError(code),
})

function governing(request: AuthorizationRequest): ActionDefinition | Denial {
  if (!isActionId(request.action)) {
    return deny('unknown_action', 'PERMISSION_DENIED')
  }
  const own = actionDefinition(request.action)
  if (own.permission.kind !== 'of_plan_kind') {
    return own
  }
  if (request.planKind === undefined || !isActionId(request.planKind)) {
    return deny('unknown_action', 'PERMISSION_DENIED')
  }
  const kind = actionDefinition(request.planKind)
  if (!kind.operationKind || kind.permission.kind !== 'fixed') {
    return deny('unknown_action', 'PERMISSION_DENIED')
  }
  // The plan kind decides permission, clients, human-only and re-authentication;
  // the generic action can only narrow the clients.
  return {
    ...kind,
    clientKinds: kind.clientKinds.filter((c) => own.clientKinds.includes(c)),
    humanOnly: kind.humanOnly || own.humanOnly,
  }
}

/**
 * A passkey or TOTP proof of this session within `windowSeconds` (database
 * clock at lookup). A recovery-code proof counts only for setting up factors
 * in a recovery session. A service principal never has one.
 */
export function freshProof(
  principal: Principal,
  windowSeconds: number,
  action?: ActionId,
): boolean {
  if (principal.kind !== 'human') {
    return false
  }
  const session = principal.session
  const method =
    session.reauthMethod === 'passkey' ||
    session.reauthMethod === 'totp' ||
    (session.reauthMethod === 'recovery_code' &&
      session.assurance === 'recovery' &&
      action !== undefined &&
      RECOVERY_SESSION_ACTIONS.has(action))
  return method && session.reauthAgeSeconds !== null && session.reauthAgeSeconds <= windowSeconds
}

/** The structured result of authorization and policy together. */
export type AuthorizationDecision =
  | {
      readonly decision: 'allow'
      readonly authorization: Authorization
      readonly policyVersion?: string
    }
  | {
      readonly decision: 'require'
      readonly authorization: Authorization
      /** Requirements the request itself cannot meet (approval, backup, window, break-glass). */
      readonly requirements: readonly Requirement[]
      readonly policyVersion: string
    }
  | (Denial & { readonly decision: 'deny'; readonly rules?: readonly string[] })

/**
 * Combines an authorization with the policy decision for the same request:
 * `deny` (or an evaluation error) denies; a `reauth` requirement is met by a
 * fresh proof of this session; what remains is returned as `require`.
 * Policy can only take away, never add to what authorization allowed.
 */
export async function withPolicy(
  principal: Principal,
  authorization: Authorization | Denial,
  evaluate: () => Promise<PolicyDecision>,
): Promise<AuthorizationDecision> {
  if (!authorization.allowed) {
    return { ...authorization, decision: 'deny' }
  }
  let policy: PolicyDecision
  try {
    policy = await evaluate()
  } catch {
    // The policy could not be evaluated: unknown denies (C-11), as a degraded Control Plane.
    return { ...deny('policy', 'CONTROL_PLANE_DEGRADED'), decision: 'deny' }
  }
  if (policy.decision === 'deny') {
    const failed = policy.rules.filter((r) => r.result === 'fail' || r.result === 'unknown')
    return {
      allowed: false,
      reason: 'policy',
      error: new AuthError('POLICY_DENIED', {
        details: {
          rules: failed.slice(0, 64).map((r) => ({
            id: r.id,
            result: r.result,
            severity: r.severity,
            message: r.message,
            overridableByBreakGlass: r.overridableByBreakGlass,
          })),
        },
      }),
      decision: 'deny',
      rules: failed.map((r) => r.id),
    }
  }
  const remaining = policy.requirements.filter(
    (r) => !(r.kind === 'reauth' && freshProof(principal, r.withinSeconds, authorization.action)),
  )
  if (remaining.length === 0) {
    return { decision: 'allow', authorization, policyVersion: policy.policyVersion }
  }
  return {
    decision: 'require',
    authorization,
    requirements: remaining,
    policyVersion: policy.policyVersion,
  }
}

export class Authorizer {
  readonly #resolver: AuthorizationSubjectResolver

  constructor(resolver: AuthorizationSubjectResolver) {
    this.#resolver = resolver
  }

  /** Phase 1: before input parsing. */
  async admit(q: Queryable, request: AuthorizationRequest): Promise<Admission | Denial> {
    const definition = governing(request)
    if ('allowed' in definition) {
      return definition
    }
    const action = request.action
    if (!isActionId(action)) {
      return deny('unknown_action', 'PERMISSION_DENIED')
    }
    const { principal } = request
    if (!definition.clientKinds.includes(principal.client)) {
      return deny('client_kind', 'PERMISSION_DENIED')
    }
    const rule = definition.permission
    if (rule.kind === 'public') {
      return { allowed: true, action, definition, permission: 'public', grants: [] }
    }
    if (principal.kind === 'anonymous') {
      return deny('unauthenticated', 'UNAUTHENTICATED')
    }
    if (
      definition.humanOnly &&
      (principal.kind !== 'human' || !HUMAN_SESSION_CLIENT_KINDS.includes(principal.client))
    ) {
      return deny('human_only', 'PERMISSION_DENIED')
    }
    // The action's scope must be usable by this client kind: a session scope
    // (`api`) is never a wildcard, it only admits the Web App to actions whose
    // permission is checked separately below.
    const scope = definition.scope
    if (scope.kind === 'fixed') {
      const scopeDef = isScope(scope.scope) ? scopeDefinition(scope.scope) : undefined
      if (
        scopeDef === undefined ||
        !scopeDef.clientKinds.includes(principal.client) ||
        (scopeDef.humanOnly && principal.kind !== 'human')
      ) {
        return deny('scope_client', 'PERMISSION_DENIED')
      }
    }
    if (
      principal.kind === 'human' &&
      principal.session.assurance === 'recovery' &&
      !RECOVERY_SESSION_ACTIONS.has(action)
    ) {
      return deny('recovery_session', 'RECOVERY_REQUIRED')
    }
    if (principal.kind === 'service' && rule.kind === 'self') {
      return deny('human_only', 'PERMISSION_DENIED')
    }
    if (rule.kind === 'self') {
      return { allowed: true, action, definition, permission: 'self', grants: [] }
    }
    if (rule.kind !== 'fixed') {
      return deny('unsupported_rule', 'PERMISSION_DENIED')
    }
    const grants = await loadGrants(q, principal.identityId)
    if (!holds(grants, rule.permission)) {
      return deny('no_permission', 'PERMISSION_DENIED')
    }
    return { allowed: true, action, definition, permission: rule.permission, grants }
  }

  /** Phase 2: after the subject is resolved on the server. */
  async decide(
    request: AuthorizationRequest,
    admission: Admission,
    subject: SubjectRef,
  ): Promise<Authorization | Denial> {
    const { principal } = request
    const { definition } = admission
    if (admission.permission === 'public') {
      return { ...admission, subject: INSTALLATION_SUBJECT, covering: [] }
    }
    if (principal.kind === 'anonymous') {
      return deny('unauthenticated', 'UNAUTHENTICATED')
    }
    const chain = await this.#resolver.resolve(subject)
    if (chain === undefined) {
      return deny('subject_unresolved', 'NOT_FOUND')
    }
    if (
      definition.tierSemantics !== 'none' &&
      chain.targetId !== undefined &&
      chain.tier === undefined
    ) {
      return deny('tier_unknown', 'PERMISSION_DENIED')
    }
    if (definition.scope.kind === 'tiered') {
      const name =
        chain.tier === undefined ? undefined : `${definition.scope.permission}:${chain.tier}`
      const scopeDef = name !== undefined && isScope(name) ? scopeDefinition(name) : undefined
      if (scopeDef === undefined || !scopeDef.clientKinds.includes(principal.client)) {
        return deny(chain.tier === undefined ? 'tier_unknown' : 'scope_client', 'PERMISSION_DENIED')
      }
    }
    let covering: readonly Grant[] = []
    if (admission.permission === 'self') {
      if (subject.kind !== 'self' || subject.identityId !== principal.identityId) {
        return deny('not_self', 'PERMISSION_DENIED')
      }
    } else {
      const permission = admission.permission
      covering = admission.grants.filter(
        (g) => g.permission === permission && holds([g], permission, chain),
      )
      if (covering.length === 0) {
        return deny('scope', 'PERMISSION_DENIED')
      }
    }
    if (
      definition.reauthentication &&
      !freshProof(principal, definition.reauthWithinSeconds ?? 0, admission.action)
    ) {
      return deny('reauth', 'REAUTH_REQUIRED')
    }
    return { ...admission, subject: chain, covering }
  }

  /** Both phases (for actions whose subject is known before parsing). */
  async authorize(
    q: Queryable,
    request: AuthorizationRequest,
    subject: SubjectRef,
  ): Promise<Authorization | Denial> {
    const admission = await this.admit(q, request)
    return admission.allowed ? this.decide(request, admission, subject) : admission
  }
}
