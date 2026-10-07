import {
  type ActionDefinition,
  type ActionId,
  actionDefinition,
  type ClientKind,
  HUMAN_SESSION_CLIENT_KINDS,
  isActionId,
  isScope,
  isScopeGrantableTo,
  type OAuthResource,
  type Permission,
  RESOURCES_BY_CLIENT_KIND,
  type Scope,
  scopeDefinition,
} from '@exponetdb/contracts'
import type { Queryable } from '@exponetdb/control-store'
import type { IdentityId, JsonObject } from '@exponetdb/kernel'
import type { PlanSubject } from '@exponetdb/operations'
import type { PolicyDecision, Requirement } from '@exponetdb/policy'
import { AuthError } from '../errors.ts'
import type { SessionContext } from '../sessions.ts'
import { type Delegation, restrictionDenial } from './delegation.ts'
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
 *
 * Wave 3B adds delegated principals (an OAuth access token or an API key):
 * the same phases decide, and the delegation can only take away. Phase 1
 * also requires the resource the request arrived at to be the credential's
 * audience, and the action's fixed scope to be delegated; phase 2 requires
 * the subject's tiered scope to be delegated and the grant's restrictions
 * to cover the subject. A scope is named in a refusal only when the client
 * could obtain it: the client kind may hold it and the identity holds its
 * permission. A delegated principal never has a fresh re-authentication:
 * actions that need one are completed in a Web App session.
 */
export type Principal =
  | { readonly kind: 'anonymous'; readonly client: ClientKind }
  /** A Web App session: always client kind `web`. */
  | {
      readonly kind: 'human'
      readonly identityId: IdentityId
      readonly client: ClientKind
      readonly session: SessionContext
    }
  /**
   * A bearer credential: a person's OAuth grant (client `cli` or `mcp`), or a
   * service account's machine grant or API key (client `ci`). Any other
   * pairing of identity kind and client kind is refused.
   */
  | {
      readonly kind: 'delegated'
      readonly identityId: IdentityId
      readonly identityKind: 'human' | 'service'
      /** The pseudonymous label (`human #3`, `service #4`) for plans and audit. */
      readonly label: string
      readonly client: ClientKind
      readonly delegation: Delegation
    }

/** The identity behind a principal and whether it is a person. */
function isHumanIdentity(principal: Principal): boolean {
  return (
    principal.kind === 'human' ||
    (principal.kind === 'delegated' && principal.identityKind === 'human')
  )
}

/**
 * A person delegates to the CLI or an MCP client through a delegated grant;
 * a service account is always `ci`, with a machine grant or an API key. The
 * Control Store enforces the same pairing; the engine refuses anything else.
 */
function consistent(principal: Extract<Principal, { kind: 'delegated' }>): boolean {
  const service = principal.identityKind === 'service'
  if (service !== (principal.client === 'ci')) {
    return false
  }
  const credential = principal.delegation.credential
  return credential.type === 'api_key' ? service : (credential.grantKind === 'machine') === service
}

export type SubjectRef =
  | { readonly kind: 'installation' }
  | { readonly kind: 'self'; readonly identityId: IdentityId }
  | { readonly kind: 'plan'; readonly subject: PlanSubject }
  | { readonly kind: 'target'; readonly targetId: string }
  | { readonly kind: 'product'; readonly productId: string }
  | { readonly kind: 'project'; readonly projectId: string }
  | { readonly kind: 'environment'; readonly environmentId: string }
  | { readonly kind: 'cluster'; readonly clusterId: string }
  | { readonly kind: 'server'; readonly serverId: string }

/**
 * Where subject chains come from (Wave 4: the registry, `registryChains`).
 * Every method answers from server-side truth; `undefined` means the
 * subject does not exist.
 */
export interface SubjectChainSource {
  target(targetId: string): Promise<SubjectChain | undefined>
  /** A target path that is not registered yet (the subject of a `target.register` plan). */
  targetPath(path: string): Promise<SubjectChain | undefined>
  product(productId: string): Promise<SubjectChain | undefined>
  project(projectId: string): Promise<SubjectChain | undefined>
  environment(environmentId: string): Promise<SubjectChain | undefined>
  /** No product chain (a cluster can host several products); its tier is the derived tier. */
  cluster(clusterId: string): Promise<SubjectChain | undefined>
  server(serverId: string): Promise<SubjectChain | undefined>
}

/**
 * Resolves a subject reference to its scope chain from server-side truth
 * (registry, plan). `undefined` means it cannot be resolved: the decision
 * denies (fail closed).
 */
export interface AuthorizationSubjectResolver {
  resolve(ref: SubjectRef): Promise<SubjectChain | undefined>
}

/**
 * The resolver of the engine: installation-wide and self subjects are
 * global; everything else comes from the chain source (Wave 4: the
 * registry). Without a source (Wave 3A), a target and every registry
 * subject is refused (fail closed). A plan keeps the tier recorded at
 * planning time (authorization.md §5): a registry that now disagrees
 * refuses.
 */
export class ControlPlaneSubjectResolver implements AuthorizationSubjectResolver {
  readonly #source: SubjectChainSource | undefined
  readonly #targets: ((targetId: string) => Promise<SubjectChain | undefined>) | undefined

  constructor(
    source?: SubjectChainSource | ((targetId: string) => Promise<SubjectChain | undefined>),
  ) {
    if (typeof source === 'function') {
      this.#targets = source
      this.#source = undefined
    } else {
      this.#source = source
      this.#targets = source === undefined ? undefined : (id) => source.target(id)
    }
  }

  async resolve(ref: SubjectRef): Promise<SubjectChain | undefined> {
    switch (ref.kind) {
      case 'installation':
      case 'self':
        return INSTALLATION_SUBJECT
      case 'target':
        return this.#targets === undefined ? undefined : this.#targets(ref.targetId)
      case 'product':
        return this.#source?.product(ref.productId)
      case 'project':
        return this.#source?.project(ref.projectId)
      case 'environment':
        return this.#source?.environment(ref.environmentId)
      case 'cluster':
        return this.#source?.cluster(ref.clusterId)
      case 'server':
        return this.#source?.server(ref.serverId)
      case 'plan':
        return this.#plan(ref.subject)
    }
  }

  async #plan(subject: PlanSubject): Promise<SubjectChain | undefined> {
    const recorded = subject.tier
    const agrees = (chain: SubjectChain | undefined) =>
      chain !== undefined && (recorded === undefined || chain.tier === recorded) ? chain : undefined
    if (subject.targetId !== undefined) {
      if (this.#targets === undefined) {
        return undefined
      }
      const chain = await this.#targets(subject.targetId)
      if (chain !== undefined) {
        return agrees(chain)
      }
      // A target the plan creates (target.register): the chain of its path, with its new id.
      if (subject.targetPath === undefined || this.#source === undefined) {
        return undefined
      }
      const path = agrees(await this.#source.targetPath(subject.targetPath))
      return path === undefined ? undefined : { ...path, targetId: subject.targetId }
    }
    const source = this.#source
    if (subject.targetPath !== undefined) {
      // Planning a target that does not exist yet: the chain of its path.
      return source === undefined ? undefined : agrees(await source.targetPath(subject.targetPath))
    }
    if (subject.environmentId !== undefined) {
      return source === undefined
        ? undefined
        : agrees(await source.environment(subject.environmentId))
    }
    if (subject.projectId !== undefined) {
      const chain = source === undefined ? undefined : await source.project(subject.projectId)
      return chain === undefined
        ? undefined
        : recorded === undefined
          ? chain
          : { ...chain, tier: recorded }
    }
    if (subject.productId !== undefined) {
      // A new environment's plan records the tier it creates; the product chain carries none.
      const chain = source === undefined ? undefined : await source.product(subject.productId)
      return chain === undefined
        ? undefined
        : recorded === undefined
          ? chain
          : { ...chain, tier: recorded }
    }
    if (subject.clusterId !== undefined) {
      if (source === undefined) return undefined
      // A cluster the plan registers does not exist yet: the empty chain (only
      // global bindings cover it), the strictest there is.
      const chain = (await source.cluster(subject.clusterId)) ?? {}
      // A cluster's derived tier may rise after planning; the stricter of the two governs.
      return chain.tier === 'prod' || recorded === 'prod'
        ? { ...chain, tier: 'prod' }
        : recorded === undefined
          ? chain
          : { ...chain, tier: recorded }
    }
    if (subject.serverId !== undefined) {
      return source === undefined ? undefined : source.server(subject.serverId)
    }
    return recorded === undefined ? INSTALLATION_SUBJECT : { tier: recorded }
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
  | 'resource'
  | 'delegated_scope'
  | 'restriction'
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
  /**
   * The protected resource the request arrived at (`api` for `/api/v1`,
   * `mcp` for `/mcp`); required for a delegated principal, whose credential
   * is valid for exactly one resource.
   */
  readonly resource?: OAuthResource
}

const deny = (
  reason: DenyReason,
  code: ConstructorParameters<typeof AuthError>[0],
  details?: JsonObject,
): Denial => ({
  allowed: false,
  reason,
  error: new AuthError(code, details === undefined ? {} : { details }),
})

/** A missing delegated scope: named, because the client could obtain it. */
const missingScope = (scope: Scope): Denial =>
  deny('delegated_scope', 'INSUFFICIENT_SCOPE', { requiredScope: scope })

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
 * in a recovery session. A delegated principal never has one.
 */
export function freshProof(
  principal: Principal,
  windowSeconds: number,
  action?: ActionId,
): boolean {
  // Only a Web App session carries a proof of presence; a bearer credential never does.
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
    if (rule.kind === 'public' || rule.kind === 'protocol') {
      // A ceremony or an OAuth protocol endpoint: its own proof authorizes it.
      return { allowed: true, action, definition, permission: 'public', grants: [] }
    }
    if (principal.kind === 'anonymous') {
      return deny('unauthenticated', 'UNAUTHENTICATED')
    }
    // A Web App session is the client kind `web` and nothing else.
    if (principal.kind === 'human' && principal.client !== 'web') {
      return deny('client_kind', 'PERMISSION_DENIED')
    }
    if (principal.kind === 'delegated' && !consistent(principal)) {
      return deny('client_kind', 'PERMISSION_DENIED')
    }
    const human = isHumanIdentity(principal)
    if (
      definition.humanOnly &&
      (!human || !HUMAN_SESSION_CLIENT_KINDS.includes(principal.client))
    ) {
      return deny('human_only', 'PERMISSION_DENIED')
    }
    if (principal.kind === 'delegated') {
      const { delegation } = principal
      const resources = RESOURCES_BY_CLIENT_KIND[principal.client]
      if (
        request.resource === undefined ||
        request.resource !== delegation.resource ||
        !resources.includes(delegation.resource) ||
        (delegation.credential.type === 'api_key' && delegation.resource !== 'api')
      ) {
        return deny('resource', 'PERMISSION_DENIED')
      }
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
        (scopeDef.humanOnly && !human) ||
        (principal.kind === 'delegated' && !isScopeGrantableTo(scope.scope, principal.client))
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
    if (rule.kind === 'self') {
      // Own credentials and sessions: a Web App session only, never a delegated credential.
      if (principal.kind !== 'human') {
        return deny('human_only', 'PERMISSION_DENIED')
      }
      return { allowed: true, action, definition, permission: 'self', grants: [] }
    }
    if (rule.kind !== 'fixed') {
      return deny('unsupported_rule', 'PERMISSION_DENIED')
    }
    const grants = await loadGrants(q, principal.identityId)
    if (!holds(grants, rule.permission)) {
      return deny('no_permission', 'PERMISSION_DENIED')
    }
    // The identity could use the action: a missing fixed scope is named (step-up).
    if (
      principal.kind === 'delegated' &&
      scope.kind === 'fixed' &&
      isScope(scope.scope) &&
      !principal.delegation.scopes.has(scope.scope)
    ) {
      return missingScope(scope.scope)
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
    let tieredName: Scope | undefined
    const chain = await this.#resolver.resolve(subject)
    if (chain === undefined) {
      return deny('subject_unresolved', 'NOT_FOUND')
    }
    // A restricted delegation sees only its targets (error-model.md §4; owner decision
    // R2, 2026-10-07): a target outside its target list or tier answers exactly like
    // an unknown target, before any check that could name a tier or a scope.
    if (principal.kind === 'delegated' && subject.kind === 'target') {
      const outside = restrictionDenial(principal.delegation.restrictions, definition, chain)
      if (outside === 'target' || outside === 'tier') {
        return {
          allowed: false,
          reason: 'restriction',
          error: new AuthError('TARGET_NOT_FOUND', {
            concealed: outside === 'target' ? 'target_restriction' : 'tier_restriction',
          }),
        }
      }
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
      if (
        scopeDef === undefined ||
        name === undefined ||
        !isScope(name) ||
        !scopeDef.clientKinds.includes(principal.client) ||
        (principal.kind === 'delegated' && !isScopeGrantableTo(name, principal.client))
      ) {
        return deny(chain.tier === undefined ? 'tier_unknown' : 'scope_client', 'PERMISSION_DENIED')
      }
      tieredName = name
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
    if (principal.kind === 'delegated') {
      // The live bindings allow it; the delegation can only take away.
      if (tieredName !== undefined && !principal.delegation.scopes.has(tieredName)) {
        return missingScope(tieredName)
      }
      const refused = restrictionDenial(principal.delegation.restrictions, definition, chain)
      if (refused !== undefined) {
        return deny(
          'restriction',
          refused === 'target'
            ? 'TARGET_NOT_IN_GRANT'
            : refused === 'tier'
              ? 'TIER_NOT_PERMITTED'
              : 'PERMISSION_DENIED',
        )
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
