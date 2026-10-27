import { appendAuditEvent } from '@exponetdb/audit'
import {
  type AccessPolicyContext,
  type Admission,
  type AuditRequest,
  type AuthDeps,
  AuthError,
  type Authorization,
  type Authorizer,
  applyAccessPlan,
  approvalQueue,
  approve,
  auditRequest,
  cancelStepUp,
  confirmStepUp,
  coolingOperationOfPlan,
  createStepUp,
  deliveryStatus,
  disableIdentity,
  dispatchNotifications,
  enrollment,
  evaluateAccessPolicy,
  finishPasskeyLogin,
  finishPasskeyReauth,
  getIdentity,
  inviteIdentity,
  isStepUpAction,
  listIdentities,
  listRoleBindings,
  listRoles,
  loadSession,
  logout,
  matchingReceipt,
  me,
  type Outcome,
  oauth,
  ownCliGrant,
  type PlanActor,
  type Principal,
  passwordLogin,
  planIdentityChange,
  planPolicySettingsUpdate,
  planRoleBindingCreate,
  planRoleBindingDelete,
  policySettingsView,
  type RequestMeta,
  readStepUp,
  recoveryCodeLogin,
  redeemReceipt,
  refusal,
  reissueInvitation,
  reject,
  releaseAfterCooling,
  roleView,
  type SessionContext,
  type StepUpAction,
  type StepUpBinding,
  type SubjectRef,
  selfService,
  startPasskeyLogin,
  startPasskeyReauth,
  totpLogin,
  totpReauth,
  touchSession,
  unrestricted,
  withPolicy,
} from '@exponetdb/auth'
import { EXECUTION_DISABLED, type ExecutionSettings } from '@exponetdb/backups'
import {
  type ActionId,
  type ApiKeyView,
  type ApprovalQueueItem,
  type ApprovalView,
  type AuditChain,
  AuditEventSchema,
  type AuthenticationCredential,
  type AuthorizationServerMetadata,
  actionDefinition,
  type BindingScope,
  type BuiltInRoleId,
  type ClientRegistrationResponse,
  type ConsentView,
  type CreationOptions,
  type DeviceAuthorizationResponse,
  type EnrollmentComplete,
  type EnrollmentState,
  type FactorView,
  type Fleet,
  type GrantView,
  type IdentityView,
  type Installation,
  type InstallationHealth,
  type InvitationResponse,
  isActionId,
  isHighRiskAction,
  type Me,
  type OAuthClientView,
  type OAuthResource,
  OperationSchema,
  type PlanView,
  PlanViewSchema,
  type PolicySettingsView,
  type ProtectedResourceMetadata,
  type PublicJwk,
  REVIEW_SOURCE_MAX_CHARS,
  type ReauthResult,
  type RecoveryCodesView,
  type RegistrationCredential,
  type RequestOptions,
  type RoleBindingView,
  readPermissionOfKind,
  type Scope,
  type SecondFactorStep,
  type ServiceAccountView,
  type SessionView,
  type SignedIn,
  type SqlClassification,
  type SqlClassificationRequest,
  type StepUpView,
  type TargetRestriction,
  type Tier,
  type TokenResponse,
  type TotpSetup,
} from '@exponetdb/contracts'
import type { Queryable, Tx } from '@exponetdb/control-store'
import {
  type ApiKeyId,
  type AuthFactorId,
  type GrantId,
  type IdentityId,
  isId,
  isJsonObject,
  type JsonObject,
  type JsonValue,
  type OAuthClientId,
  type OperationId,
  type RequestId,
  type RoleBindingId,
  type SessionId,
  toJsonValue,
} from '@exponetdb/kernel'
import { type ReviewFile, reviewFiles } from '@exponetdb/migrations-engine'
import {
  beginIdempotent,
  completeIdempotent,
  type KindRegistry,
  OperationError,
  type PlanRecord,
  type PlanSubject,
  readPlan,
  releaseIdempotent,
  requestVerificationRetry,
  type StoredActionClass,
  transitionOperation,
  withdrawPlan,
} from '@exponetdb/operations'
import {
  applyRegistryPlan,
  type RegistryAcceptContext,
  type RegistryActor,
  RegistryError,
  operationActor as registryOperationActor,
} from '@exponetdb/registry'
import { AuditChainReader } from './audit-chain.ts'
import { type AuditExportQuery, auditExportNdjson, readAuditExport } from './audit-export.ts'
import { BackupUseCases } from './backups.ts'
import { BreakGlassUseCases } from './breakglass.ts'
import { type InstallationHealthSources, readInstallationHealth } from './installation-health.ts'
import { MigrationUseCases } from './migrations.ts'
import { NodeUseCases } from './nodes.ts'
import { PerformanceUseCases } from './performance.ts'
import { ProfileUseCases, profileView, readProfiles } from './profiles.ts'
import { QueryUseCases, type ReadParties } from './queries.ts'
import { RawStatementUseCases } from './raw-statements.ts'
import {
  type RegistryHost,
  type RegistryServices,
  RegistryUseCases,
  registryActor,
  type TargetVisibilityRestriction,
} from './registry.ts'
import { SavedQueryUseCases } from './saved-queries.ts'
import { classifySubmittedSql } from './sql-classification.ts'
import {
  type OperationRead,
  type OperationView,
  operationRead,
  operationsOfPlans,
  operationView,
  type PlanRead,
  planRead,
  planView,
  requirementsOf,
  verificationRetryable,
} from './views.ts'

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
  /**
   * Wave 4: the registry, schema, health and drift services as `serve`, and
   * the acceptance context of registry plans (their kinds bound to serve's
   * login, for acceptance checks only; the worker executes).
   */
  readonly registry?: RegistryServices & { readonly accept: RegistryAcceptContext }
  /**
   * Wave 8: what `GET /installation/health` needs from the serving process
   * (its readiness report and the keyring it loaded). Without it the read
   * answers `CONTROL_PLANE_DEGRADED`: nothing is invented.
   */
  readonly health?: InstallationHealthSources
  /**
   * Wave 9 Part B: whether backup and restore runs may execute
   * (`EXPONETDB_BACKUP_EXECUTION`, `EXPONETDB_RESTORE_EXECUTION`); read at
   * each plan. Absent: both disabled.
   */
  readonly backupExecution?: () => ExecutionSettings
  /** The running release (`GET /installation`). */
  readonly installation: {
    readonly version: string
    readonly features: readonly string[]
    /** This installation's id (public metadata, Wave 6). */
    readonly installationId?: string
    /** How new OAuth clients are admitted (OD-5; Wave 8, shown on the OAuth clients page). */
    readonly oauthClientRegistration?: 'open' | 'review'
  }
  /**
   * Authorization server extensions: the hardened network for client
   * metadata documents (CIMD), client assertions and further grants.
   */
  readonly oauth?: {
    readonly network?: oauth.FetchNetwork
    readonly fetch?: { readonly timeoutMs?: number; readonly maxBytes?: number }
    readonly assertions?: oauth.ClientAssertionVerifier
    readonly grants?: oauth.ExtraGrants
  }
  /** Reports a failed background write (a denial's audit event); never changes a decision. */
  readonly onBackgroundError?: (event: string, error: unknown) => void
}

/**
 * Denials of high-risk actions that are security signals (audit.md §2):
 * missing permission, scope, client kind, resource or restriction, a
 * human-only action by an agent, policy. A missing re-authentication, an
 * unknown subject or an unauthenticated request is an ordinary refusal.
 */
const AUDITED_DENIALS: ReadonlySet<string> = new Set([
  'client_kind',
  'resource',
  'delegated_scope',
  'restriction',
  'human_only',
  'recovery_session',
  'no_permission',
  'not_self',
  'scope',
  'scope_client',
  'tier_unknown',
  'policy',
])

/**
 * The bundle files a migration plan runs, as stored: `up.sql` and
 * `verify.sql` for an apply or a resume, `down.sql` for a rollback, and
 * `verify.sql` for a verification run again (it reads the target, so the
 * person sees what it asks). At most 64 files.
 */
const REVIEW_FILES: Readonly<Record<string, readonly ReviewFile[]>> = {
  'migration.apply': ['up.sql', 'verify.sql'],
  'migration.resume': ['up.sql', 'verify.sql'],
  'migration.rollback': ['down.sql'],
  'migration.verify': ['verify.sql'],
}

async function reviewSources(
  q: Queryable,
  plan: PlanRecord,
): Promise<NonNullable<ApprovalQueueItem['review']>['sources']> {
  const files = REVIEW_FILES[plan.kind]
  if (files === undefined) return []
  const content = plan.body['content']
  if (typeof content !== 'object' || content === null || Array.isArray(content)) return []
  const c = content as Record<string, unknown>
  const projectId = c['projectId']
  if (typeof projectId !== 'string') return []
  // A verification run names one migration; the other kinds list theirs.
  const listed = plan.kind === 'migration.verify' ? [c] : c['migrations']
  if (!Array.isArray(listed)) return []
  const items: { migrationId: string; revision: number }[] = []
  for (const item of listed.slice(0, 64)) {
    const migrationId = (item as Record<string, unknown> | null)?.['migrationId']
    const revision = (item as Record<string, unknown> | null)?.['revision']
    if (typeof migrationId !== 'string' || typeof revision !== 'number') continue
    items.push({ migrationId, revision })
  }
  const read = await reviewFiles(q, projectId, items, files)
  return read.slice(0, 64).map((f) => {
    const truncated = f.text.length > REVIEW_SOURCE_MAX_CHARS
    return {
      migrationId: f.migrationId as never,
      revision: f.revision,
      file: f.file,
      text: truncated ? f.text.slice(0, REVIEW_SOURCE_MAX_CHARS) : f.text,
      bytes: f.bytes,
      truncated,
    }
  })
}

/** The audit event of a denied high-risk action (an audit event name, not a contract action). */
const DENIAL_EVENT = 'authz.denied'

/** The audit's actor and client of a denied caller (no argument values). */
function denialParties(caller: Caller) {
  if (caller.kind === 'session') {
    return {
      actor: {
        kind: 'human' as const,
        identityId: caller.session.identityId,
        label: caller.session.label as never,
      },
      client: { clientId: null, kind: 'web' as const, sessionId: caller.session.sessionId },
    }
  }
  const { principal } = caller
  const credential = principal.delegation.credential
  return {
    actor: {
      kind: principal.identityKind,
      identityId: principal.identityId,
      label: principal.label as never,
    },
    client: {
      clientId: credential.type === 'access_token' ? credential.clientId : null,
      kind: principal.client,
      grantId: credential.type === 'access_token' ? credential.grantId : null,
    },
  }
}

/** Who reads rows, for the data-read audit and the lane's owner (Wave 7). */
function readParties(caller: Caller): ReadParties {
  const { actor, client } = denialParties(caller)
  const tool = caller.kind === 'bearer' ? caller.tool : undefined
  return {
    actor: { kind: actor.kind, identityId: actor.identityId, label: actor.label },
    client: {
      clientId: client.clientId,
      kind: client.kind,
      grantId: 'grantId' in client ? client.grantId : null,
      ...('sessionId' in client ? { sessionId: client.sessionId } : {}),
    },
    ...(tool === undefined ? {} : { tool }),
  }
}

/** Where a denied request pointed, for the audit's subject. */
function denialSubject(subject: SubjectRef) {
  const s: Record<string, string | undefined> =
    subject.kind === 'plan'
      ? {
          targetId: subject.subject.targetId,
          targetPath: subject.subject.targetPath,
          tier: subject.subject.tier,
          clusterId: subject.subject.clusterId,
          nodeId: subject.subject.nodeId,
          serverId: subject.subject.serverId,
        }
      : subject.kind === 'target'
        ? { targetId: subject.targetId }
        : subject.kind === 'cluster'
          ? { clusterId: subject.clusterId }
          : subject.kind === 'server'
            ? { serverId: subject.serverId }
            : {}
  return Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined))
}

/**
 * Who calls a use case: a Web App session, or a bearer credential (an
 * OAuth access token or an API key) at the resource it arrived at. Both go
 * to the same engine; a bearer caller never has a session and never a fresh
 * re-authentication.
 */
export type Caller =
  | {
      readonly kind: 'session'
      readonly session: SessionContext
      /** The request the call came through: recorded in a denial's audit, never decided on. */
      readonly requestId?: RequestId
    }
  | {
      readonly kind: 'bearer'
      readonly principal: oauth.DelegatedPrincipal
      readonly resource: OAuthResource
      /** The step-up receipt the request names (`ExponetDB-Step-Up`, ADR-0026); redeemed only by its bound use case. */
      readonly stepUpId?: string
      /** The MCP tool the request came through: recorded in a denial's audit, never decided on. */
      readonly tool?: string
      /** The request the call came through: recorded in a denial's audit, never decided on. */
      readonly requestId?: RequestId
    }

export function sessionCaller(session: SessionContext, requestId?: RequestId): Caller {
  return requestId === undefined
    ? { kind: 'session', session }
    : { kind: 'session', session, requestId }
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
    // Only a step-up receipt redeemed for this request proves presence (ADR-0026).
    reauthAt: principal.stepUp?.reauthAt ?? null,
    client: 'cli',
    clientId: credential.clientId,
  }
}

/**
 * The actor of an action that is not human-only (`node.inspect`, `node.plan`
 * and the plans they make, Wave 5 correction F9): the caller exactly as the
 * central engine authorized it, with its identity kind, client and client id,
 * for policy, the stored plan, acceptance and audit. Never a substitute for
 * the engine's decision, which comes first.
 */
function operationCaller(caller: Caller): RegistryActor {
  if (caller.kind === 'session') {
    return registryActor(caller.session)
  }
  const { principal } = caller
  const credential = principal.delegation.credential
  if (principal.client === 'web') {
    // A bearer credential never speaks for a Web App session.
    throw new AuthError('PERMISSION_DENIED')
  }
  return {
    kind: principal.identityKind,
    identityId: principal.identityId,
    label: principal.label,
    reauthAt: principal.stepUp?.reauthAt ?? null,
    client: principal.client,
    clientId: credential.type === 'access_token' ? credential.clientId : null,
    grantId: credential.type === 'access_token' ? credential.grantId : null,
  }
}

/**
 * The planning actor for an action: human-only actions keep `planActor` (a
 * Web App session or a person through the first-party CLI); the others carry
 * the authorized caller as it is (F9). A `critical` plan is human-only
 * whatever its kind says (G6 finding A2): pass the class the plan stored.
 */
function actorFor(caller: Caller, action: string, planClass?: StoredActionClass): RegistryActor {
  return isActionId(action) && !actionDefinition(action).humanOnly && planClass !== 'critical'
    ? operationCaller(caller)
    : registryActor(planActor(caller))
}

/** Who decides a client-registry change, for the audit. */
function deciderOf(caller: Caller): oauth.Decider {
  return caller.kind === 'session'
    ? oauth.sessionDecider(caller.session)
    : oauth.delegatedDecider(caller.principal)
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
  /** The Wave 4 use cases (registry, targets, schema, health, drift); same engine, same rules. */
  readonly registry: RegistryUseCases
  /** The Wave 5 node use cases (enrollment, revocation, decommissioning, reads). */
  readonly nodes: NodeUseCases
  /** Wave 9 Part B: backup repositories, policies, the catalog mirror, runs, restores and drills. */
  readonly backups: BackupUseCases
  /** The Wave 6 migration use cases (bundles, lint, plans, live reads). */
  readonly migrations: MigrationUseCases
  readonly breakGlass: BreakGlassUseCases
  /** The Wave 7 data reads (`sql_query`, `sql_explain`, `sql_cancel`; ADR-0028). */
  readonly queries: QueryUseCases
  /** The Wave 8 saved queries (order §9): owner-only changes, visibility decided on the scope. */
  readonly savedQueries: SavedQueryUseCases
  /** The raw statement view (Wave 8, owner decision S2): live, secrets removed, audited. */
  readonly rawStatements: RawStatementUseCases
  /** Wave 9 Part B: statement and table statistics, advisors, finding summary, cancel and terminate. */
  readonly performance: PerformanceUseCases
  /** The own profile, a display name and a picture (Wave 8, owner decision S10). */
  readonly profiles: ProfileUseCases
  /** The audit chain read with its bounded verification (Wave 8). */
  readonly #chain: AuditChainReader

  constructor(deps: ApplicationDeps) {
    this.#d = deps
    this.#chain = new AuditChainReader(deps.auth.store, deps.policy.clock)
    const host: RegistryHost = {
      store: deps.auth.store,
      keyring: deps.auth.keyring,
      clock: deps.policy.clock,
      services: deps.registry,
      authorize: (q, action, caller, subject) =>
        this.#authorize(q, action, caller as Caller, subject),
      admit: (q, action, caller) => this.#admit(q, action, caller as Caller),
      allowed: async (q, action, caller, subject) =>
        (
          await this.#d.authorizer.authorize(
            q,
            {
              action,
              principal: principalOf(caller as Caller),
              ...((caller as Caller).kind === 'bearer'
                ? { resource: (caller as Extract<Caller, { kind: 'bearer' }>).resource }
                : {}),
            },
            subject,
          )
        ).allowed,
      plan: (caller, action, idempotency, subject, create) =>
        this.#plan(
          caller as Caller,
          action,
          idempotency,
          (c) => actorFor(c, action),
          create,
          subject,
        ),
      inline: (caller, action, idempotency, subject, create) =>
        this.#inline(caller as Caller, action, idempotency, subject, create),
      identityOf: (caller) => identityOf(caller as Caller),
      planActor: (caller) => planActor(caller as Caller),
      restrictions: (caller) => restrictionsOf(caller as Caller),
      withStepUp: (tx, caller, bound) => this.#withStepUp(tx, caller as Caller, bound),
    }
    this.registry = new RegistryUseCases(host)
    this.nodes = new NodeUseCases(host)
    this.backups = new BackupUseCases(host, {
      execution: deps.backupExecution ?? (() => EXECUTION_DISABLED),
    })
    this.migrations = new MigrationUseCases(host)
    this.queries = new QueryUseCases({
      store: deps.auth.store,
      clock: deps.policy.clock,
      policy: () => deps.registry?.plans.policy,
      authorize: host.authorize,
      admit: host.admit,
      parties: (caller) => readParties(caller as Caller),
      denied: (action, caller, subject, error) => {
        if (isActionId(action) && isHighRiskAction(action)) {
          this.#auditDenial(action, caller as Caller, subject, 'policy', error)
        }
      },
    })
    this.savedQueries = new SavedQueryUseCases({
      store: deps.auth.store,
      clock: deps.policy.clock,
      authorize: host.authorize,
      admit: host.admit,
      allowed: host.allowed,
      parties: (caller) => readParties(caller as Caller),
    })
    this.profiles = new ProfileUseCases({
      store: deps.auth.store,
      clock: deps.policy.clock,
      authorize: host.authorize,
      allowed: host.allowed,
      parties: (caller) => readParties(caller as Caller),
    })
    this.rawStatements = new RawStatementUseCases({
      store: deps.auth.store,
      clock: deps.policy.clock,
      observation: () => deps.registry?.observation,
      authorize: host.authorize,
      admit: host.admit,
      parties: (caller) => readParties(caller as Caller),
    })
    this.performance = new PerformanceUseCases({
      ...host,
      parties: (caller) => readParties(caller as Caller),
    })
    this.breakGlass = new BreakGlassUseCases(host, {
      channel: deps.auth.channel,
      dispatch: (pending) => dispatchNotifications(deps.auth.store, deps.auth.channel, pending),
    })
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
    planClass?: StoredActionClass,
  ): Promise<Authorization> {
    const result = await this.#d.authorizer.authorize(
      q,
      {
        action,
        principal: principalOf(caller),
        ...(planKind === undefined ? {} : { planKind }),
        ...(planClass === undefined ? {} : { planClass }),
        ...(caller?.kind === 'bearer' ? { resource: caller.resource } : {}),
      },
      subject,
    )
    if (!result.allowed) {
      if (
        caller !== undefined &&
        isActionId(action) &&
        isHighRiskAction(action) &&
        AUDITED_DENIALS.has(result.reason)
      ) {
        this.#auditDenial(action, caller, subject, result.reason, result.error)
      }
      throw result.error
    }
    return result
  }

  /** Background writes still running: denial audits, grant uses (tests and shutdown wait). */
  readonly #background = new Set<Promise<void>>()

  #inBackground(event: string, work: Promise<unknown>): void {
    const write: Promise<void> = work
      .then(
        () => undefined,
        (failure: unknown) => this.#d.onBackgroundError?.(event, failure),
      )
      .finally(() => {
        this.#background.delete(write)
      })
    this.#background.add(write)
  }

  /**
   * A denied high-risk action, recorded as `authz.denied` (audit.md §2,
   * Wave 7 order §18) with the reason, the action, the tool, the client and
   * the grant, never an argument value. It is written in its own
   * transaction once the denying one has ended: the denial rolls the
   * request's transaction back, so the event cannot be part of it, and a
   * write that waited for it inside would deadlock on the audit chain lock.
   * The denial stands either way; a failed write is reported, never turned
   * into anything else.
   */
  #auditDenial(
    action: ActionId,
    caller: Caller,
    subject: SubjectRef,
    reason: string,
    error: { readonly code: string },
  ): void {
    const { actor, client } = denialParties(caller)
    const tool = caller.kind === 'bearer' ? caller.tool : undefined
    this.#inBackground(
      'authz.denial_audit_failed',
      this.#d.auth.store.transaction('application.authz.denied', (tx) =>
        appendAuditEvent(
          tx,
          {
            action: DENIAL_EVENT,
            phase: 'denied',
            actor,
            client,
            subject: denialSubject(subject),
            changes: { action, reason, ...(tool === undefined ? {} : { tool }) },
            result: { status: 'denied', errorCode: error.code },
            // The refusal's own request id: the audit event and the answer name the same call.
            ...(caller.requestId === undefined ? {} : { request: { requestId: caller.requestId } }),
          },
          { clock: this.#d.policy.clock },
        ),
      ),
    )
  }

  /** The minute each grant's use was last written by this process (a bounded throttle). */
  readonly #grantUses = new Map<string, number>()

  /**
   * Notes that a bearer caller's grant was used (Wave 7 order §16, decision
   * 10): the minute and the class only, at most one write a minute per
   * grant (the table's upsert holds that across processes, this throttle
   * spares the round trip). In the background: a failure is reported and
   * never fails the request. An API key has no grant: nothing is noted.
   * The last use is a data basis for the Web App, never a decision input.
   */
  noteGrantUse(caller: Caller, useClass: oauth.GrantUseClass): void {
    if (caller.kind !== 'bearer') return
    const credential = caller.principal.delegation.credential
    if (credential.type !== 'access_token') return
    const nowMs = this.#d.policy.clock.nowMs()
    const minute = Math.floor(nowMs / 60_000)
    if (this.#grantUses.get(credential.grantId) === minute) return
    if (this.#grantUses.size >= 10_000) this.#grantUses.clear()
    this.#grantUses.set(credential.grantId, minute)
    this.#inBackground(
      'oauth.grant_use_failed',
      oauth.recordGrantUse(this.#d.auth.store, credential.grantId, useClass, new Date(nowMs)),
    )
  }

  /** Resolves when every pending background write has ended. */
  async settled(): Promise<void> {
    while (this.#background.size > 0) {
      await Promise.all([...this.#background])
    }
  }

  /** Phase 1 only, for lists whose items are filtered by the caller's scopes. */
  async #admit(
    q: Parameters<Authorizer['admit']>[0],
    action: string,
    caller: Caller,
  ): Promise<Admission> {
    const result = await this.#d.authorizer.admit(q, {
      action,
      principal: principalOf(caller),
      ...(caller.kind === 'bearer' ? { resource: caller.resource } : {}),
    })
    if (!result.allowed) {
      // Admitted before any subject is resolved: the event names none.
      if (isActionId(action) && isHighRiskAction(action) && AUDITED_DENIALS.has(result.reason)) {
        this.#auditDenial(action, caller, INSTALLATION, result.reason, result.error)
      }
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

  /**
   * The fleet overview (`fleet.get`, Wave 8): targets by tier and health,
   * open findings by severity, and the operations that run, need attention
   * or await approval. `targets.read` admits the request; the findings part
   * is `unavailable` for a caller without `diagnostics.read`. The
   * operations part is exactly what `GET /operations` would list for the
   * caller (the read rule of the plan kind at the plan's subject, memoized
   * per kind and subject), counted: one query for the non-terminal
   * operations, at most `FLEET_OPERATION_SCAN` of them (newest first);
   * when more exist the counts say `lowerBound` with `scan_limit`.
   * A failed read is an error, never a zero.
   */
  async fleet(caller: Caller): Promise<Fleet> {
    // Admission first; the registry part applies the same permission's visibility to its counts.
    await this.#admit(this.#d.auth.store, 'fleet.get', caller)
    const parts = await this.registry.fleetParts(caller)
    const operations = await this.#fleetOperations(caller)
    return { ...parts, operations, asOf: new Date(this.#d.policy.clock.nowMs()).toISOString() }
  }

  async #fleetOperations(caller: Caller): Promise<Fleet['operations']> {
    const states = ['running', 'needs_attention', 'awaiting_approval'] as const
    const counts = { running: 0, needs_attention: 0, awaiting_approval: 0 }
    let capped = false
    await this.#d.auth.store.transaction('application.fleet.operations', async (tx) => {
      // An escaped NUL (`\u0000`, valid JSON that jsonb refuses) is read as U+FFFD, so no stored body can fail the read.
      const { rows } = await tx.query(
        'application.fleet.operations',
        `SELECT o.operation_id, o.kind, o.state, o.plan_id,
                replace(b.body, '\\u0000', '\\ufffd')::jsonb -> 'subject' AS subject
           FROM operations.operations o
           LEFT JOIN operations.plan_bodies b ON b.plan_id = o.plan_id
          WHERE o.state = ANY($1::text[])
          ORDER BY o.operation_id DESC
          LIMIT $2`,
        [[...states], FLEET_OPERATION_SCAN + 1],
      )
      capped = rows.length > FLEET_OPERATION_SCAN
      const decided = new Map<string, boolean>()
      for (const row of rows.slice(0, FLEET_OPERATION_SCAN)) {
        const kind = row.text('kind')
        const subject: SubjectRef =
          row.textOrNull('plan_id') === null
            ? INSTALLATION
            : {
                kind: 'plan',
                subject: subjectOfSubject(
                  (row.json('subject') ?? undefined) as JsonValue | undefined,
                ),
              }
        const memo = `${isActionId(kind) ? readPermissionOfKind(kind) : kind}|${JSON.stringify(subject)}`
        let allowed = decided.get(memo)
        if (allowed === undefined) {
          allowed = await this.#mayRead(tx, caller, 'operation.list', kind, subject)
          decided.set(memo, allowed)
        }
        const state = row.text('state')
        if (
          allowed &&
          (state === 'running' || state === 'needs_attention' || state === 'awaiting_approval')
        ) {
          counts[state]++
        }
      }
    })
    return {
      available: true,
      ...counts,
      source: 'live',
      observedAt: new Date(this.#d.policy.clock.nowMs()).toISOString(),
      lowerBound: capped,
      lowerBoundReason: capped ? 'scan_limit' : null,
    }
  }

  async installation(caller: Caller): Promise<Installation> {
    await this.#authorize(this.#d.auth.store, 'installation.get', caller, INSTALLATION)
    const id = this.#d.installation.installationId
    const registration = this.#d.installation.oauthClientRegistration
    return {
      ...(id === undefined ? {} : { installationId: id as Installation['installationId'] }),
      version: this.#d.installation.version,
      contracts: {
        restApi: 'v1',
        mcpCatalog: 'exponetdb.mcp/v1',
        nodeProtocol: 'exponetdb.node/v1',
        migrationManifest: 'exponetdb.migration/v1',
        projectConfig: 'exponetdb.project/v1',
      },
      features: [...this.#d.installation.features],
      ...(registration === undefined ? {} : { oauthClientRegistration: registration }),
    }
  }

  /**
   * Control Plane health (`installation.health.get`, Wave 8): the components
   * with their state, source and time, from the heartbeats, the maintenance
   * tasks, the data-read workers, the keyring and the audit chain. What this
   * release cannot observe is listed as such.
   */
  async installationHealth(caller: Caller): Promise<InstallationHealth> {
    await this.#authorize(this.#d.auth.store, 'installation.health.get', caller, INSTALLATION)
    const sources = this.#d.health
    if (sources === undefined) {
      throw new AuthError('CONTROL_PLANE_DEGRADED')
    }
    return readInstallationHealth(this.#d.auth.store, this.#d.policy.clock, sources)
  }

  /**
   * The audit chain (`audit.chain.get`, Wave 8): head, checkpoints, export
   * state per exporter and a verification computed on request from the
   * latest checkpoint. Installation-wide: a grant restricted to targets or
   * a tier is refused (`restricted_scope`) like the audit search without a
   * target.
   */
  async auditChain(caller: Caller): Promise<AuditChain> {
    await this.#authorize(this.#d.auth.store, 'audit.chain.get', caller, INSTALLATION)
    return this.#chain.read()
  }

  /**
   * The audit export (`audit.export`, owner decision 2026-10-13; audit.md
   * §5.1): the stored events verbatim as NDJSON, at most 10,000 per call,
   * for offline `ac1` verification. Owner and admin (`policy.manage`), a Web
   * App session re-authenticated within 300 seconds (the central engine
   * enforces both). The export is audited as `audit.export` in the same
   * transaction (range, count and position, never content); if that event
   * cannot be written, nothing is exported.
   */
  async exportAuditEvents(caller: Caller, query: AuditExportQuery): Promise<string> {
    await this.#authorize(this.#d.auth.store, 'audit.export', caller, INSTALLATION)
    return this.#d.auth.store.transaction('application.audit.export', async (tx) => {
      await this.#authorize(tx, 'audit.export', caller, INSTALLATION)
      const actor = actorFor(caller, 'audit.export')
      const page = await readAuditExport(
        tx,
        query,
        new Date(this.#d.policy.clock.nowMs()).toISOString(),
      )
      const h = page.header
      await appendAuditEvent(
        tx,
        {
          action: 'audit.export',
          phase: 'completed',
          actor: {
            kind: actor.kind ?? 'human',
            identityId: actor.identityId,
            label: actor.label as never,
            reauthAt: actor.reauthAt,
          },
          client: { clientId: actor.clientId ?? null, kind: actor.client ?? 'web' },
          changes: {
            from: h.from,
            to: h.to,
            firstSeq: h.firstSeq,
            lastSeq: h.lastSeq,
            count: h.count,
            more: h.more,
            paged: query.cursor !== undefined,
          },
          result: { status: 'succeeded' },
        },
        { clock: this.#d.policy.clock },
      )
      return auditExportNdjson(page)
    })
  }

  /**
   * Live statement classification (`sql.classify`, Wave 8): a pure parse of
   * submitted text with the migration analysis and the read-only admission.
   * Installation-level `migrations.read`; no target is touched, nothing is
   * stored, logged or audited, and the text is never echoed.
   */
  async classifySql(caller: Caller, request: SqlClassificationRequest): Promise<SqlClassification> {
    await this.#authorize(this.#d.auth.store, 'sql.classify', caller, INSTALLATION)
    return classifySubmittedSql(request, this.#d.policy.clock)
  }

  async me(caller: Caller): Promise<Me> {
    await this.#authorize(this.#d.auth.store, 'me.get', caller, selfRef(caller))
    const view = await me(this.#d.auth.store, sessionOf(caller))
    // The own profile (owner decision S10): the chosen name, the picture and the revision to change them at.
    const profile = profileView(
      view.identity.id,
      (await readProfiles(this.#d.auth.store, [view.identity.id])).get(view.identity.id),
    )
    return {
      ...view,
      displayName: profile.displayName,
      avatar: profile.avatar,
      profileRevision: profile.revision,
    }
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
    return { items: await this.#withProfiles(items.slice(0, query.limit)), nextCursor: null }
  }

  async identity(caller: Caller, identityId: IdentityId): Promise<IdentityView> {
    await this.#authorize(this.#d.auth.store, 'identity.get', caller, INSTALLATION)
    const [view] = await this.#withProfiles([await getIdentity(this.#d.auth.store, identityId)])
    if (view === undefined) throw new AuthError('NOT_FOUND')
    return view
  }

  /** The profile of each identity (owner decision S10): the chosen name and the picture, null when none. */
  async #withProfiles(items: readonly IdentityView[]): Promise<IdentityView[]> {
    const profiles = await readProfiles(
      this.#d.auth.store,
      items.map((i) => i.id),
    )
    return items.map((i) => {
      const profile = profileView(i.id, profiles.get(i.id))
      return { ...i, profileDisplayName: profile.displayName, avatar: profile.avatar }
    })
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
    // Only what the caller may decide on: the engine on each plan's recorded subject.
    const decidable: ApprovalQueueItem[] = []
    for (const item of items) {
      const plan = await readPlan(this.#d.auth.store, item.planId)
      if (plan === undefined) continue
      const decision = await this.#d.authorizer.authorize(
        this.#d.auth.store,
        { action: 'approval.approve', principal: principalOf(caller) },
        { kind: 'plan', subject: subjectOf(plan) },
      )
      // Re-authentication is checked last: a decision denied only for it is one the
      // person may take after re-authenticating, so the item belongs in the queue.
      if (decision.allowed || decision.reason === 'reauth') {
        decidable.push({ ...item, review: await this.#review(plan) })
      }
    }
    return { items: decidable }
  }

  /**
   * What the person reviews (Wave 7 order §24): the server's own plan view
   * (subject, creator, decision, rules, requirements, expiry, the change and
   * its analysis), the creating client's own name (never verified) and, for
   * migration plans, the files they run verbatim from the bundle store. No
   * number or word in it comes from an agent.
   */
  async #review(plan: PlanRecord): Promise<NonNullable<ApprovalQueueItem['review']>> {
    const store = this.#d.auth.store
    const client =
      plan.actor.clientId === null ? undefined : await oauth.readClient(store, plan.actor.clientId)
    return {
      plan: await planView(store, plan),
      clientName: client?.displayName ?? null,
      sources: await reviewSources(store, plan),
    }
  }

  // ----- plan and operation reads (OD-26 (c), resolved 2026-10-12) -----

  /**
   * Whether the caller may read a plan or operation of `kind` about
   * `subject`: the kind's domain read permission, or `plans.approve`
   * through a Web App session, at a scope covering the subject (the
   * central engine, `read_of_kind`). Anything else reads as not found:
   * an id grants nothing and reveals nothing.
   */
  async #mayRead(
    q: Queryable,
    caller: Caller,
    action: 'plan.get' | 'plan.list' | 'operation.get' | 'operation.list',
    kind: string,
    subject: SubjectRef,
  ): Promise<boolean> {
    const decision = await this.#d.authorizer.authorize(
      q,
      {
        action,
        principal: principalOf(caller),
        planKind: kind,
        ...(caller.kind === 'bearer' ? { resource: caller.resource } : {}),
      },
      subject,
    )
    return decision.allowed
  }

  async plan(caller: Caller, planId: string): Promise<PlanRead> {
    return this.#d.auth.store.transaction('application.plan.get', async (tx) => {
      const plan = isId('pln', planId) ? await readPlan(tx, planId) : undefined
      if (
        plan === undefined ||
        !(await this.#mayRead(tx, caller, 'plan.get', plan.kind, {
          kind: 'plan',
          subject: subjectOf(plan),
        }))
      ) {
        throw new OperationError('PLAN_NOT_FOUND')
      }
      // The operation that applied the plan, if any: readable under the same rule as the plan.
      const operations = await operationsOfPlans(tx, [plan.planId])
      return planRead(await planView(tx, plan), operations.get(plan.planId))
    })
  }

  async operation(caller: Caller, operationId: string): Promise<OperationRead> {
    const visible = await this.#d.auth.store.transaction(
      'application.operation.get',
      async (tx) => {
        if (!isId('op', operationId)) return false
        const { rows } = await tx.query(
          'application.operation.kind',
          'SELECT kind, plan_id FROM operations.operations WHERE operation_id = $1',
          [operationId],
        )
        const row = rows[0]
        if (row === undefined) return false
        const planId = row.textOrNull('plan_id')
        const plan = planId === null ? undefined : await readPlan(tx, planId)
        return this.#mayRead(
          tx,
          caller,
          'operation.get',
          row.text('kind'),
          plan === undefined ? INSTALLATION : { kind: 'plan', subject: subjectOf(plan) },
        )
      },
    )
    if (!visible) {
      throw new AuthError('OPERATION_NOT_FOUND')
    }
    return operationRead(await operationView(this.#d.auth.store, operationId, this.publicOrigin))
  }

  /**
   * Operations the caller may read, newest first. The filter by visibility
   * runs before the page is cut, so neither the items, the cursor nor a
   * count says anything about operations of other subjects. At most
   * `SCAN_LIMIT` candidates are examined per call; the cursor then
   * continues the scan.
   */
  async operations(
    caller: Caller,
    query: {
      readonly target?: string | undefined
      readonly kind?: string | undefined
      readonly state?: string | undefined
      readonly actor?: 'self' | 'any' | undefined
      readonly limit?: number | undefined
      readonly cursor?: string | undefined
    },
  ): Promise<{ items: OperationRead[]; nextCursor: string | null }> {
    const limit = query.limit ?? 50
    const SCAN_LIMIT = 2000
    let targetId: string | null = null
    if (query.target !== undefined) {
      targetId = (await this.registry.target(caller, query.target)).id
    }
    const after = decodeOperationCursor(query.cursor)
    const identity = identityOf(caller)
    const visible: string[] = []
    let next: string | null = null
    const decided = new Map<string, boolean>()
    await this.#d.auth.store.transaction('application.operation.list', async (tx) => {
      // Operation ids are ULIDs: descending id order is newest first, and the
      // last examined id is a stable keyset cursor.
      const { rows } = await tx.query(
        'application.operation.candidates',
        `SELECT o.operation_id, o.kind, o.plan_id
           FROM operations.operations o LEFT JOIN operations.plans p ON p.plan_id = o.plan_id
          WHERE ($1::text IS NULL OR p.target_id = $1)
            AND ($2::text IS NULL OR o.kind = $2)
            AND ($3::text IS NULL OR o.state = $3)
            AND ($4::text IS NULL OR o.actor_id = $4)
            AND ($5::text IS NULL OR o.operation_id < $5)
          ORDER BY o.operation_id DESC
          LIMIT $6`,
        [
          targetId,
          query.kind ?? null,
          query.state ?? null,
          query.actor === 'self' ? identity : null,
          after,
          SCAN_LIMIT + 1,
        ],
      )
      let scanned = 0
      for (const row of rows) {
        if (scanned === SCAN_LIMIT || visible.length === limit) {
          // More candidates remain: continue after the last one examined.
          break
        }
        scanned++
        const planId = row.textOrNull('plan_id')
        const plan = planId === null ? undefined : await readPlan(tx, planId)
        const subject: SubjectRef =
          plan === undefined ? INSTALLATION : { kind: 'plan', subject: subjectOf(plan) }
        const kind = row.text('kind')
        const memo = `${isActionId(kind) ? readPermissionOfKind(kind) : kind}|${JSON.stringify(subject)}`
        let allowed = decided.get(memo)
        if (allowed === undefined) {
          allowed = await this.#mayRead(tx, caller, 'operation.list', kind, subject)
          decided.set(memo, allowed)
        }
        const id = row.text('operation_id')
        if (allowed) visible.push(id)
        next = encodeOperationCursor(id)
      }
      if (scanned === rows.length) {
        next = null
      }
    })
    const items: OperationRead[] = []
    for (const id of visible) {
      items.push(operationRead(await operationView(this.#d.auth.store, id, this.publicOrigin)))
    }
    return { items, nextCursor: next }
  }

  // ----- audit search -----

  /**
   * Audit events, newest first (`audit.search`): `audit.read` at the
   * installation for everything, or covering one target for its events
   * only (`target`). Actors stay pseudonymous; a change description, the
   * request pseudonyms and the decision are not part of the read view.
   */
  async auditEvents(
    caller: Caller,
    query: {
      readonly from?: string | undefined
      readonly to?: string | undefined
      readonly target?: string | undefined
      readonly action?: string | undefined
      readonly actor?: 'self' | 'any' | undefined
      readonly result?: 'succeeded' | 'failed' | 'denied' | undefined
      /** The client and the grant the events were made through (runbook RB-11). */
      readonly client?: string | undefined
      readonly grant?: string | undefined
      /**
       * Only events whose actor is this identity (Wave 8 completion, REST only).
       * Combined with `actor: 'self'` both must hold: the caller's own events
       * when this is the caller, nothing otherwise.
       */
      readonly identity?: string | undefined
      readonly limit?: number | undefined
      readonly cursor?: string | undefined
    },
  ): Promise<{ items: AuditEventView[]; nextCursor: string | null }> {
    const limit = query.limit ?? 100
    const before = decodeAuditCursor(query.cursor)
    if (query.target === undefined && restricted(caller)) {
      return this.#auditEventsOfVisibleTargets(caller, query, limit, before)
    }
    return this.#d.auth.store.transaction('application.audit.search', async (tx) => {
      await this.#authorize(
        tx,
        'audit.search',
        caller,
        query.target === undefined ? INSTALLATION : { kind: 'target', targetId: query.target },
      )
      const { rows } = await tx.query(
        'application.audit.search',
        `SELECT seq, event FROM audit.audit_events
          WHERE ($1::timestamptz IS NULL OR occurred_at >= $1)
            AND ($2::timestamptz IS NULL OR occurred_at < $2)
            AND ($3::text IS NULL OR event::jsonb -> 'subject' ->> 'targetId' = $3)
            AND ($4::text IS NULL OR action = $4)
            AND ($5::text IS NULL OR actor_id = $5)
            AND ($6::text IS NULL OR event::jsonb -> 'result' ->> 'status' = $6)
            AND ($7::bigint IS NULL OR seq < $7)
            AND ($9::text IS NULL OR event::jsonb -> 'client' ->> 'clientId' = $9)
            AND ($10::text IS NULL OR event::jsonb -> 'client' ->> 'grantId' = $10)
            AND ($11::text IS NULL OR actor_id = $11)
          ORDER BY seq DESC
          LIMIT $8`,
        [
          query.from ?? null,
          query.to ?? null,
          query.target ?? null,
          query.action ?? null,
          query.actor === 'self' ? identityOf(caller) : null,
          query.result ?? null,
          before,
          limit + 1,
          query.client ?? null,
          query.grant ?? null,
          query.identity ?? null,
        ],
      )
      const page = rows.slice(0, limit)
      const items = page.map((r) =>
        auditView(JSON.parse(r.text('event')) as Record<string, unknown>),
      )
      const last = page.at(-1)
      return {
        items,
        nextCursor:
          rows.length > limit && last !== undefined ? encodeAuditCursor(last.text('seq')) : null,
      }
    })
  }

  /**
   * `audit.search` without a target for a grant restricted to tiers or
   * targets (authorization.md §1, Wave 7 decision): the events of the
   * targets the grant covers and the identity may read the audit of, never
   * an installation-wide event, never a refusal of the whole list. At most
   * `SCAN_LIMIT` events are examined per call; the cursor continues the scan.
   */
  async #auditEventsOfVisibleTargets(
    caller: Caller,
    query: Parameters<Application['auditEvents']>[1],
    limit: number,
    before: string | null,
  ): Promise<{ items: AuditEventView[]; nextCursor: string | null }> {
    const SCAN_LIMIT = 2000
    return this.#d.auth.store.transaction('application.audit.search', async (tx) => {
      await this.#admit(tx, 'audit.search', caller)
      const { rows } = await tx.query(
        'application.audit.search.targets',
        `SELECT seq, event, event::jsonb -> 'subject' ->> 'targetId' AS target_id
           FROM audit.audit_events
          WHERE event::jsonb -> 'subject' ->> 'targetId' IS NOT NULL
            AND ($1::timestamptz IS NULL OR occurred_at >= $1)
            AND ($2::timestamptz IS NULL OR occurred_at < $2)
            AND ($3::text IS NULL OR action = $3)
            AND ($4::text IS NULL OR actor_id = $4)
            AND ($5::text IS NULL OR event::jsonb -> 'result' ->> 'status' = $5)
            AND ($6::bigint IS NULL OR seq < $6)
            AND ($8::text IS NULL OR event::jsonb -> 'client' ->> 'clientId' = $8)
            AND ($9::text IS NULL OR event::jsonb -> 'client' ->> 'grantId' = $9)
            AND ($10::text IS NULL OR actor_id = $10)
          ORDER BY seq DESC
          LIMIT $7`,
        [
          query.from ?? null,
          query.to ?? null,
          query.action ?? null,
          query.actor === 'self' ? identityOf(caller) : null,
          query.result ?? null,
          before,
          SCAN_LIMIT + 1,
          query.client ?? null,
          query.grant ?? null,
          query.identity ?? null,
        ],
      )
      const decided = new Map<string, boolean>()
      const items: AuditEventView[] = []
      let next: string | null = null
      let scanned = 0
      for (const row of rows) {
        if (scanned === SCAN_LIMIT || items.length === limit) break
        scanned++
        const targetId = row.text('target_id')
        let allowed = decided.get(targetId)
        if (allowed === undefined) {
          allowed =
            isId('tgt', targetId) &&
            (
              await this.#d.authorizer.authorize(
                tx,
                {
                  action: 'audit.search',
                  principal: principalOf(caller),
                  ...(caller.kind === 'bearer' ? { resource: caller.resource } : {}),
                },
                { kind: 'target', targetId },
              )
            ).allowed
          decided.set(targetId, allowed)
        }
        if (allowed) {
          items.push(auditView(JSON.parse(row.text('event')) as Record<string, unknown>))
        }
        next = encodeAuditCursor(row.text('seq'))
      }
      if (scanned === rows.length) next = null
      return { items, nextCursor: next }
    })
  }

  // ----- CLI step-ups (ADR-0026) -----

  /**
   * Redeems the step-up receipt a bearer request names, for the binding the
   * use case recomputed from its own state: returns the caller with the
   * proof for this request and `redeem`, to be called once the bound action
   * succeeded (in the same transaction). A request without a receipt keeps
   * its caller; a receipt that does not match answers `REAUTH_REQUIRED`.
   */
  async #withStepUp(
    tx: Tx,
    caller: Caller,
    bound: {
      readonly action: StepUpAction
      readonly planId: string | null
      readonly planHash: string | null
      readonly tokenId: string | null
    },
  ): Promise<{ readonly caller: Caller; redeem(): Promise<void> }> {
    if (caller.kind !== 'bearer' || caller.stepUpId === undefined) {
      return { caller, redeem: async () => undefined }
    }
    const grant = ownCliGrant(caller.principal)
    const installationId = this.#d.installation.installationId
    if (grant === undefined || installationId === undefined) {
      throw new AuthError('REAUTH_REQUIRED')
    }
    const binding: StepUpBinding = { installationId, ...grant, ...bound }
    const receipt = await matchingReceipt(tx, caller.stepUpId, binding)
    if (receipt === undefined) {
      throw new AuthError('REAUTH_REQUIRED')
    }
    const principal = caller.principal
    return {
      caller: {
        ...caller,
        principal: {
          ...principal,
          stepUp: { reauthAt: receipt.reauthAt, reauthAgeSeconds: receipt.reauthAgeSeconds },
        },
      },
      redeem: () => redeemReceipt(tx, { clock: this.#d.policy.clock }, receipt, binding, principal),
    }
  }

  /**
   * A person's first-party CLI asks for a step-up for one action
   * (ADR-0026 §1). The binding is built from server state: the presenting
   * grant, the plan's stored hash (a plan of this person that is active and
   * needs a fresh proof to apply) or an enrollment token this person may
   * reveal now. Anything else answers like an unknown object.
   */
  async requestStepUp(
    caller: Caller,
    body: {
      readonly action: string
      readonly planId?: string | undefined
      readonly tokenId?: string | undefined
    },
  ): Promise<StepUpView> {
    return this.#d.auth.store.transaction('application.step_up.request', async (tx) => {
      await this.#admit(tx, 'step_up.request', caller)
      if (caller.kind !== 'bearer') throw new AuthError('PERMISSION_DENIED')
      const grant = ownCliGrant(caller.principal)
      const installationId = this.#d.installation.installationId
      if (grant === undefined) throw new AuthError('PERMISSION_DENIED')
      if (installationId === undefined) throw new AuthError('CONTROL_PLANE_DEGRADED')
      if (!isStepUpAction(body.action)) {
        throw new RegistryError('VALIDATION_FAILED', {
          errors: [
            { path: '/action', code: 'invalid', message: 'No step-up exists for this action.' },
          ],
        })
      }
      let bound: { planId: string | null; planHash: string | null; tokenId: string | null }
      if (body.action === 'plan.apply') {
        const plan = body.planId === undefined ? undefined : await readPlan(tx, body.planId)
        if (
          plan === undefined ||
          plan.state !== 'active' ||
          plan.actor.identityId !== grant.identityId ||
          plan.actor.client !== 'cli'
        ) {
          throw new AuthError('NOT_FOUND')
        }
        const definition = isActionId(plan.kind) ? actionDefinition(plan.kind) : undefined
        const needsProof =
          definition?.reauthentication === true ||
          requirementsOf(plan).some((r) => r.kind === 'reauth')
        if (!needsProof) throw new AuthError('CONFLICT')
        bound = { planId: plan.planId, planHash: plan.planHash, tokenId: null }
      } else {
        const tokenId = body.tokenId
        const { rows } =
          tokenId === undefined || !isId('ent', tokenId)
            ? { rows: [] }
            : await tx.query(
                'application.step_up.token',
                `SELECT 1 FROM nodes.enrollment_tokens
                  WHERE token_id = $1 AND state = 'created' AND reveal_by = $2 AND reveal_until > clock_timestamp()`,
                [tokenId, grant.identityId],
              )
        if (rows.length !== 1 || tokenId === undefined) throw new AuthError('NOT_FOUND')
        bound = { planId: null, planHash: null, tokenId }
      }
      return createStepUp(
        tx,
        { clock: this.#d.policy.clock },
        { installationId, ...grant, action: body.action, ...bound },
        caller.principal,
        this.publicOrigin,
      )
    })
  }

  async stepUp(caller: Caller, stepUpId: string): Promise<StepUpView> {
    await this.#admit(this.#d.auth.store, 'step_up.get', caller)
    return readStepUp(this.#d.auth.store, identityOf(caller), stepUpId, this.publicOrigin)
  }

  /**
   * Confirms a step-up in the Web App (ADR-0026 §2): the engine requires a
   * fresh passkey or TOTP proof of this session first. A wrong code counts
   * as an attempt (kept), then answers VALIDATION_FAILED; five end it.
   */
  async confirmStepUp(caller: Caller, stepUpId: string, userCode: string): Promise<StepUpView> {
    const outcome = await this.#d.auth.store.transaction(
      'application.step_up.confirm',
      async (tx) => {
        await this.#authorize(tx, 'step_up.confirm', caller, selfRef(caller))
        return confirmStepUp(
          tx,
          { clock: this.#d.policy.clock },
          sessionOf(caller),
          stepUpId,
          userCode,
          this.publicOrigin,
        )
      },
    )
    if (outcome.ok) return outcome.view
    if (outcome.reason === 'code_mismatch') {
      throw new RegistryError('VALIDATION_FAILED', {
        errors: [{ path: '/userCode', code: 'invalid', message: 'The code does not match.' }],
      })
    }
    throw new AuthError('CONFLICT')
  }

  async cancelStepUp(caller: Caller, stepUpId: string): Promise<StepUpView> {
    return this.#d.auth.store.transaction('application.step_up.cancel', async (tx) => {
      await this.#admit(tx, 'step_up.cancel', caller)
      return cancelStepUp(tx, identityOf(caller), stepUpId, this.publicOrigin)
    })
  }

  /**
   * Plans the caller may read, newest first (Wave 6), by the same rule and
   * with the same guarantees as `operations`: visibility is decided per
   * candidate before the page is cut, at most `SCAN_LIMIT` candidates per
   * call, and the cursor continues the scan.
   */
  async plans(
    caller: Caller,
    query: {
      readonly target?: string | undefined
      readonly kind?: string | undefined
      readonly state?: string | undefined
      readonly actor?: 'self' | 'any' | undefined
      readonly limit?: number | undefined
      readonly cursor?: string | undefined
    },
  ): Promise<{ items: PlanRead[]; nextCursor: string | null }> {
    const limit = query.limit ?? 50
    const SCAN_LIMIT = 2000
    let targetId: string | null = null
    if (query.target !== undefined) {
      targetId = (await this.registry.target(caller, query.target)).id
    }
    const after = decodePlanCursor(query.cursor)
    const identity = identityOf(caller)
    return this.#d.auth.store.transaction('application.plan.list', async (tx) => {
      const { rows } = await tx.query(
        'application.plan.candidates',
        `SELECT plan_id FROM operations.plans
          WHERE ($1::text IS NULL OR target_id = $1)
            AND ($2::text IS NULL OR kind = $2)
            AND ($3::text IS NULL OR state = $3)
            AND ($4::text IS NULL OR actor_id = $4)
            AND ($5::text IS NULL OR plan_id < $5)
          ORDER BY plan_id DESC
          LIMIT $6`,
        [
          targetId,
          query.kind ?? null,
          query.state ?? null,
          query.actor === 'self' ? identity : null,
          after,
          SCAN_LIMIT + 1,
        ],
      )
      const items: PlanView[] = []
      const decided = new Map<string, boolean>()
      let next: string | null = null
      let scanned = 0
      for (const row of rows) {
        if (scanned === SCAN_LIMIT || items.length === limit) break
        scanned++
        const id = row.text('plan_id')
        next = encodePlanCursor(id)
        const plan = await readPlan(tx, id)
        if (plan === undefined) continue
        const subject: SubjectRef = { kind: 'plan', subject: subjectOf(plan) }
        const memo = `${isActionId(plan.kind) ? readPermissionOfKind(plan.kind) : plan.kind}|${JSON.stringify(subject)}`
        let allowed = decided.get(memo)
        if (allowed === undefined) {
          allowed = await this.#mayRead(tx, caller, 'plan.list', plan.kind, subject)
          decided.set(memo, allowed)
        }
        if (allowed) items.push(await planView(tx, plan))
      }
      // The operation of each listed plan, one read for the page.
      const operations = await operationsOfPlans(
        tx,
        items.map((i) => i.id),
      )
      return {
        items: items.map((i) => planRead(i, operations.get(i.id))),
        nextCursor: scanned === rows.length ? null : next,
      }
    })
  }

  /**
   * Cancels an operation that has not started (awaiting approval or
   * queued; Wave 6). Only the actor that applied the plan may cancel it,
   * with the plan kind's permission; a caller who may not read the
   * operation gets `OPERATION_NOT_FOUND`. The database guard lets the
   * serve role cancel only an operation that has not started (EXO02).
   */
  async cancelOperation(caller: Caller, operationId: string): Promise<OperationView> {
    await this.#d.auth.store.transaction('application.operation.cancel', async (tx) => {
      const { rows } = isId('op', operationId)
        ? await tx.query(
            'application.operation.for_cancel',
            `SELECT kind, plan_id, state, actor_kind, actor_id, client_kind
               FROM operations.operations WHERE operation_id = $1 FOR UPDATE`,
            [operationId],
          )
        : { rows: [] }
      const row = rows[0]
      const planId = row?.textOrNull('plan_id') ?? null
      const plan = planId === null ? undefined : await readPlan(tx, planId)
      if (
        row === undefined ||
        plan === undefined ||
        !(await this.#mayRead(tx, caller, 'operation.get', row.text('kind'), {
          kind: 'plan',
          subject: subjectOf(plan),
        }))
      ) {
        throw new AuthError('OPERATION_NOT_FOUND')
      }
      await this.#authorize(
        tx,
        'operation.cancel',
        caller,
        { kind: 'plan', subject: subjectOf(plan) },
        plan.kind,
      )
      const actor = registryOperationActor(actorFor(caller, plan.kind, plan.actionClass))
      // The applying actor only, as apply and withdraw bind it: the identity, the client kind
      // and the registered client (another client of the same person cannot cancel).
      if (
        row.text('actor_kind') !== actor.kind ||
        row.textOrNull('actor_id') !== actor.identityId ||
        row.text('client_kind') !== actor.client ||
        plan.actor.clientId !== actor.clientId
      ) {
        throw new OperationError('PLAN_BINDING_ACTOR')
      }
      const state = row.text('state')
      if (state !== 'awaiting_approval' && state !== 'queued') {
        throw new RegistryError('OPERATION_NOT_CANCELABLE', { state })
      }
      await transitionOperation(
        tx,
        {
          operationId: operationId as OperationId,
          from: state,
          to: 'canceled',
          // Nothing ran: a canceled operation admits only these outcomes (§4.1).
          applyOutcome: 'not_started',
          verificationOutcome: 'not_applicable',
          actor,
          errorCode: 'OPERATION_CANCELLED',
          detail: { canceledBy: actor.identityId },
        },
        { clock: this.#d.policy.clock },
      )
    })
    return operationView(this.#d.auth.store, operationId, this.publicOrigin)
  }

  /**
   * Asks the worker to verify again an operation that needs attention after
   * an applied change whose verification errored or never finished (Wave 6,
   * failure case E10; operations-engine.md §4.1, needs_attention to
   * verifying). Anyone with the plan kind's permission on the plan's subject
   * may ask; a caller who may not read the operation gets
   * `OPERATION_NOT_FOUND`. serve records the request, audited; the worker
   * claims the operation and moves it under its lease. The change never runs
   * again: the kind re-runs its read-only verification.
   */
  async retryOperationVerification(caller: Caller, operationId: string): Promise<OperationView> {
    await this.#d.auth.store.transaction('application.operation.retry_verification', async (tx) => {
      const { rows } = isId('op', operationId)
        ? await tx.query(
            'application.operation.for_retry',
            `SELECT kind, plan_id, state, apply_outcome, verification_outcome
               FROM operations.operations WHERE operation_id = $1 FOR UPDATE`,
            [operationId],
          )
        : { rows: [] }
      const row = rows[0]
      const planId = row?.textOrNull('plan_id') ?? null
      const plan = planId === null ? undefined : await readPlan(tx, planId)
      if (
        row === undefined ||
        plan === undefined ||
        !(await this.#mayRead(tx, caller, 'operation.get', row.text('kind'), {
          kind: 'plan',
          subject: subjectOf(plan),
        }))
      ) {
        throw new AuthError('OPERATION_NOT_FOUND')
      }
      await this.#authorize(
        tx,
        'operation.retry_verification',
        caller,
        { kind: 'plan', subject: subjectOf(plan) },
        plan.kind,
      )
      const state = row.text('state')
      // The same rule the operation reads show as `retryable`.
      if (
        !verificationRetryable({
          kind: row.text('kind'),
          state,
          applyOutcome: row.text('apply_outcome'),
          verificationOutcome: row.text('verification_outcome'),
        })
      ) {
        throw new RegistryError('OPERATION_NOT_RETRYABLE', { state })
      }
      const actor = actorFor(caller, 'operation.retry_verification')
      await requestVerificationRetry(tx, operationId, actor.identityId)
      await appendAuditEvent(
        tx,
        {
          action: 'operation.retry_verification',
          phase: 'requested',
          actor: {
            kind: actor.kind ?? 'human',
            identityId: actor.identityId,
            label: actor.label as never,
            reauthAt: actor.reauthAt,
          },
          client: { clientId: actor.clientId ?? null, kind: actor.client ?? 'web' },
          refs: { operationId: operationId as OperationId, planId: plan.planId },
          changes: { from: state, to: 'verifying' },
          result: { status: 'succeeded' },
        },
        { clock: this.#d.policy.clock },
      )
    })
    return operationView(this.#d.auth.store, operationId, this.publicOrigin)
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

  async #plan<A>(
    caller: Caller,
    action: string,
    idempotency: { readonly key: string; readonly requestHash: string } | undefined,
    actorOf: (caller: Caller) => A,
    create: (tx: Tx, actor: A) => Promise<PlanRecord>,
    subject: (tx: Tx) => Promise<SubjectRef> = async () => INSTALLATION,
  ): Promise<PlanView> {
    return this.#d.auth.store.transaction('application.plan', async (tx) => {
      await this.#authorize(tx, action, caller, await subject(tx))
      const actor = actorOf(caller)
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

  /**
   * A low-class inline plan (operations-engine.md §1): authorized, planned
   * and accepted in one transaction, executed by the worker. A refusal at
   * acceptance commits nothing but the plan's invalidation.
   */
  async #inline(
    caller: Caller,
    action: string,
    idempotency: { readonly key: string; readonly requestHash: string } | undefined,
    subject: (tx: Tx) => Promise<SubjectRef>,
    create: (tx: Tx, actor: RegistryActor) => Promise<PlanRecord>,
  ): Promise<OperationView> {
    const registry = this.#d.registry
    if (registry === undefined) {
      throw new AuthError('CONTROL_PLANE_DEGRADED')
    }
    const done = await this.#d.auth.store.transaction('application.inline', async (tx) => {
      await this.#authorize(tx, action, caller, await subject(tx))
      if (idempotency !== undefined) {
        const started = await beginIdempotent(tx, {
          principal: idempotencyPrincipal(caller),
          key: idempotency.key,
          requestHash: idempotency.requestHash,
        })
        if (started.status === 'replay') {
          return { view: OperationSchema.parse(started.response) }
        }
      }
      const actor = actorFor(caller, action)
      const plan = await create(tx, actor)
      const result = await applyRegistryPlan(tx, registry.accept, actor, plan.planId)
      if (result.status === 'refused') {
        if (idempotency !== undefined) {
          await releaseIdempotent(tx, {
            principal: idempotencyPrincipal(caller),
            key: idempotency.key,
          })
        }
        // The plan an inline refusal invalidated: `PLAN_STALE` names it in its details.
        Object.defineProperty(result.error, 'planId', { value: plan.planId, enumerable: false })
        return { error: result.error }
      }
      const view = await operationView(tx, result.operation.operationId, this.publicOrigin)
      if (idempotency !== undefined) {
        await completeIdempotent(tx, {
          principal: idempotencyPrincipal(caller),
          key: idempotency.key,
          response: json(view),
        })
      }
      return { view }
    })
    if ('error' in done) {
      throw done.error
    }
    return done.view
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
    return this.#plan(
      caller,
      'access.role_binding.create.plan',
      idempotency,
      planActor,
      (tx, actor) => planRoleBindingCreate(tx, this.#d.policy, actor, body),
    )
  }

  planRoleBindingRemoval(
    caller: Caller,
    bindingId: RoleBindingId,
    idempotency?: { readonly key: string; readonly requestHash: string },
  ): Promise<PlanView> {
    return this.#plan(
      caller,
      'access.role_binding.delete.plan',
      idempotency,
      planActor,
      (tx, actor) => planRoleBindingDelete(tx, this.#d.policy, actor, bindingId),
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
    return this.#plan(
      caller,
      'access.policy_settings.update.plan',
      idempotency,
      planActor,
      (tx, actor) => planPolicySettingsUpdate(tx, this.#d.policy, actor, body),
    )
  }

  planIdentityChange(
    caller: Caller,
    kind: 'access.identity.enable' | 'access.identity.erase',
    identityId: IdentityId,
    idempotency?: { readonly key: string; readonly requestHash: string },
  ): Promise<PlanView> {
    return this.#plan(caller, `${kind}.plan`, idempotency, planActor, (tx, actor) =>
      planIdentityChange(tx, this.#d.policy, actor, kind, identityId),
    )
  }

  // ----- apply, withdraw, approvals -----

  /**
   * A refused apply of a `critical` plan says what to do (Wave 7 order §24):
   * only a person applies it. Given only when the engine would let this
   * caller apply the kind without the stored class, so it tells nothing the
   * caller could not do otherwise; any other refusal stays as it was.
   */
  async #humanApply(
    q: Queryable,
    caller: Caller,
    plan: { readonly planId: string; readonly kind: string; readonly actionClass: string },
    error: unknown,
  ): Promise<unknown> {
    if (
      plan.actionClass !== 'critical' ||
      caller.kind !== 'bearer' ||
      !(error instanceof AuthError) ||
      error.code !== 'PERMISSION_DENIED'
    ) {
      return error
    }
    const stored = await readPlan(q, plan.planId)
    if (stored === undefined) return error
    const asKind = await this.#d.authorizer.authorize(
      q,
      {
        action: 'plan.apply',
        principal: principalOf(caller),
        planKind: plan.kind,
        resource: caller.resource,
      },
      { kind: 'plan', subject: subjectOf(stored) },
    )
    return asKind.allowed
      ? new AuthError('HUMAN_APPLY_REQUIRED', { details: { planId: plan.planId } })
      : error
  }

  async apply(requested: Caller, planId: string): Promise<OperationView> {
    const operationId = await this.#d.auth.store.transaction('application.apply', async (tx) => {
      const plan = await readPlan(tx, planId)
      if (plan === undefined) {
        throw new OperationError('PLAN_NOT_FOUND')
      }
      // A step-up receipt counts only for this plan at its current hash (ADR-0026).
      const stepUp = await this.#withStepUp(tx, requested, {
        action: 'plan.apply',
        planId: plan.planId,
        planHash: plan.planHash,
        tokenId: null,
      })
      const caller = stepUp.caller as Caller
      try {
        await this.#authorize(
          tx,
          'plan.apply',
          caller,
          { kind: 'plan', subject: subjectOf(plan) },
          plan.kind,
          plan.actionClass,
        )
      } catch (error) {
        throw await this.#humanApply(tx, caller, plan, error)
      }
      if (this.#d.kinds.get(plan.kind) === undefined) {
        throw new OperationError('operation_kind_unknown')
      }
      const registry = this.#d.registry
      // A critical self-approval cools for 10 minutes and is released only
      // by the plan's own person with a fresh re-authentication in the Web
      // App (OD-9): for node and registry plans as for access plans, and
      // whether the plan was made in the Web App or through the CLI, which
      // cannot give that proof (correction review of F2, rounds 1 and 2).
      if (
        caller.kind === 'session' &&
        !plan.kind.startsWith('access.') &&
        registry !== undefined &&
        plan.actor.identityId === caller.session.identityId
      ) {
        const cooling = await coolingOperationOfPlan(tx, plan.planId)
        if (cooling !== undefined) {
          try {
            return (await releaseAfterCooling(tx, this.#d.policy, sessionOf(caller), cooling))
              .operationId
          } catch (error) {
            if (error instanceof AuthError || error instanceof OperationError) {
              return error
            }
            throw error
          }
        }
      }
      const result =
        plan.kind.startsWith('access.') || registry === undefined
          ? // Every access kind needs a fresh re-authentication: only a session reaches here.
            await applyAccessPlan(tx, this.#d.policy, this.#d.kinds, sessionOf(caller), planId)
          : await applyRegistryPlan(
              tx,
              registry.accept,
              caller.kind === 'session'
                ? registryActor(caller.session)
                : actorFor(caller, plan.kind, plan.actionClass),
              planId,
            )
      if (result.status === 'refused') {
        // Invalidations are persisted by acceptPlan before it refuses: commit them.
        // A refused apply leaves the receipt unredeemed.
        return result.error
      }
      await stepUp.redeem()
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
      await withdrawPlan(
        tx,
        planId,
        registryOperationActor(actorFor(caller, plan.kind, plan.actionClass)),
        {
          clock: this.#d.policy.clock,
        },
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
    const registry = this.#registry()
    return oauth.startAuthorization(
      this.#d.auth,
      meta,
      rawQuery,
      bindingCookie,
      registry === undefined ? undefined : oauth.cimdRefresher(registry),
    )
  }

  /** The client registry; undefined when no metadata network is configured (CIMD then refused). */
  #registry(): oauth.RegistryDeps | undefined {
    const network = this.#d.oauth?.network
    return network === undefined
      ? undefined
      : {
          auth: this.#d.auth,
          network,
          ...(this.#d.oauth?.fetch === undefined ? {} : { fetch: this.#d.oauth.fetch }),
        }
  }

  #requireRegistry(): oauth.RegistryDeps {
    const registry = this.#registry()
    if (registry === undefined) {
      throw new AuthError('CLIENT_METADATA_INVALID', { details: { reason: 'fetch_unavailable' } })
    }
    return registry
  }

  #tokenDeps(): oauth.TokenEndpointDeps {
    const issuer = this.publicOrigin
    return {
      auth: this.#d.auth,
      assertions: this.#d.oauth?.assertions ?? oauth.assertionVerifier(this.#d.auth),
      grants: {
        deviceCode: oauth.deviceCodeGrant,
        clientCredentials: (tx, client, params) =>
          oauth.clientCredentialsGrant(tx, client, params, issuer),
        ...this.#d.oauth?.grants,
      },
    }
  }

  /** POST /oauth/device_authorization (RFC 8628). */
  async deviceAuthorization(
    meta: RequestMeta,
    request: oauth.TokenRequest,
  ): Promise<DeviceAuthorizationResponse> {
    await this.#protocol('oauth.device_authorization')
    return oauth.startDeviceAuthorization(this.#tokenDeps(), meta, request)
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
    const view = await oauth.consentView(this.#d.auth, sessionOf(caller), handle, bindingCookie)
    return { ...view, targets: await this.#consentTargets(caller) }
  }

  /**
   * The targets a person can see, for the consent page's target choice
   * (Wave 7 order §16): the registry's list as this person, at most 200.
   * A person who may list none chooses among none (every target of the
   * tiers stays the default).
   */
  async #consentTargets(caller: Caller): Promise<ConsentView['targets']> {
    if (this.#d.registry === undefined) return []
    try {
      const page = await this.registry.targets(caller, {}, { limit: 200 })
      return page.items.map((t) => ({ id: t.id, path: t.path, tier: t.tier }))
    } catch (error) {
      if (error instanceof AuthError) return []
      throw error
    }
  }

  /**
   * A chosen target list: each one a target the person can read now
   * (`target.get`, the engine on the registry's subject) and of a chosen
   * tier. Checked before the grant is written; the engine still decides at
   * every use with the live role bindings.
   */
  async #checkTargetChoice(
    caller: Caller,
    body: { readonly tiers: readonly Tier[]; readonly targets?: TargetRestriction | undefined },
  ): Promise<void> {
    if (body.targets === undefined || body.targets.kind === 'all') return
    const refuse = (index: number, message: string): never => {
      throw new RegistryError('VALIDATION_FAILED', {
        errors: [{ path: `/targets/targetIds/${index}`, code: 'invalid', message }],
      })
    }
    if (this.#d.registry === undefined) refuse(0, 'No target can be chosen here.')
    for (const [index, id] of body.targets.targetIds.entries()) {
      let tier: Tier
      try {
        tier = (await this.registry.target(caller, id)).tier
      } catch (error) {
        if (error instanceof AuthError || error instanceof RegistryError) {
          return refuse(index, 'Not a target you can see.')
        }
        throw error
      }
      if (!body.tiers.includes(tier)) refuse(index, 'The target is outside the chosen tiers.')
    }
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
      readonly targets?: TargetRestriction | undefined
    },
    bindingCookie: string | undefined,
  ): Promise<{ readonly redirectTo: string }> {
    if (body.decision === 'allow') await this.#checkTargetChoice(caller, body)
    return this.#d.auth.store.transaction('application.oauth.consent', async (tx) => {
      await this.#authorize(tx, 'oauth.consent', caller, selfRef(caller))
      return oauth.decideConsent(tx, this.#d.auth, meta, sessionOf(caller), body, bindingCookie)
    })
  }

  async deviceView(caller: Caller, userCode: string): Promise<ConsentView> {
    await this.#authorize(this.#d.auth.store, 'oauth.consent.get', caller, selfRef(caller))
    const session = sessionOf(caller)
    await oauth.countDeviceAttempt(this.#d.auth, session)
    const view = await oauth.deviceView(this.#d.auth, session, userCode)
    return { ...view, targets: await this.#consentTargets(caller) }
  }

  async device(
    meta: RequestMeta,
    caller: Caller,
    body: {
      readonly userCode: string
      readonly decision: 'allow' | 'deny'
      readonly scopes: readonly Scope[]
      readonly tiers: readonly Tier[]
      readonly lifetimeDays: number
      readonly acknowledgeProduction?: true | undefined
      readonly targets?: TargetRestriction | undefined
    },
  ): Promise<{ readonly status: 'approved' | 'denied' }> {
    await this.#authorize(this.#d.auth.store, 'oauth.consent', caller, selfRef(caller))
    await oauth.countDeviceAttempt(this.#d.auth, sessionOf(caller))
    if (body.decision === 'allow') await this.#checkTargetChoice(caller, body)
    return this.#d.auth.store.transaction('application.oauth.device', async (tx) => {
      await this.#authorize(tx, 'oauth.consent', caller, selfRef(caller))
      return oauth.decideDevice(tx, this.#d.auth, meta, sessionOf(caller), body)
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
    const found = await oauth.readClientWithUse(this.#d.auth.store, clientId)
    if (found === undefined) {
      throw new AuthError('NOT_FOUND')
    }
    return oauth.clientView(found.client, found.use)
  }

  // ----- OAuth: client registry (OD-5) -----

  /** An administrator adds a CIMD client by its exact `client_id` URL; it starts pending. */
  async registerCimdClient(
    meta: RequestMeta,
    caller: Caller,
    clientId: string,
  ): Promise<OAuthClientView> {
    await this.#authorize(this.#d.auth.store, 'oauth.client.register_cimd', caller, INSTALLATION)
    const client = await oauth.registerCimdClient(
      this.#requireRegistry(),
      meta,
      deciderOf(caller),
      clientId,
    )
    return oauth.clientView(client)
  }

  async refreshOAuthClientMetadata(
    meta: RequestMeta,
    caller: Caller,
    clientId: OAuthClientId,
  ): Promise<OAuthClientView> {
    await this.#authorize(this.#d.auth.store, 'oauth.client.refresh_metadata', caller, INSTALLATION)
    const client = await oauth.refreshCimdClient(
      this.#requireRegistry(),
      clientId,
      deciderOf(caller),
      meta,
    )
    return oauth.clientView(client)
  }

  async #clientDecision(
    caller: Caller,
    action: 'oauth.client.approve' | 'oauth.client.reject' | 'oauth.client.disable',
    run: (tx: Tx, by: oauth.Decider) => Promise<oauth.OAuthClientRecord>,
  ): Promise<OAuthClientView> {
    return this.#d.auth.store.transaction(`application.${action}`, async (tx) => {
      await this.#authorize(tx, action, caller, INSTALLATION)
      // Inline security changes need a fresh re-authentication: only a session reaches here.
      return oauth.clientView(await run(tx, oauth.sessionDecider(sessionOf(caller))))
    })
  }

  approveOAuthClient(
    meta: RequestMeta,
    caller: Caller,
    clientId: OAuthClientId,
    fingerprint: string,
  ): Promise<OAuthClientView> {
    return this.#clientDecision(caller, 'oauth.client.approve', (tx, by) =>
      oauth.approveClient(tx, this.#d.auth, meta, by, clientId, fingerprint),
    )
  }

  rejectOAuthClient(
    meta: RequestMeta,
    caller: Caller,
    clientId: OAuthClientId,
    reason: string | undefined,
  ): Promise<OAuthClientView> {
    return this.#clientDecision(caller, 'oauth.client.reject', (tx, by) =>
      oauth.rejectClient(tx, this.#d.auth, meta, by, clientId, reason),
    )
  }

  disableOAuthClient(
    meta: RequestMeta,
    caller: Caller,
    clientId: OAuthClientId,
    reason: string | undefined,
  ): Promise<OAuthClientView> {
    return this.#clientDecision(caller, 'oauth.client.disable', (tx, by) =>
      oauth.disableClient(tx, this.#d.auth, meta, by, clientId, reason),
    )
  }

  // ----- service accounts and API keys (identity.md §5) -----

  async serviceAccounts(
    caller: Caller,
    query: { readonly limit: number },
  ): Promise<{ items: ServiceAccountView[]; nextCursor: null }> {
    await this.#authorize(this.#d.auth.store, 'service_account.list', caller, INSTALLATION)
    const items = await oauth.serviceAccountViews(this.#d.auth.store, this.publicOrigin, query)
    return { items, nextCursor: null }
  }

  async serviceAccount(caller: Caller, identityId: IdentityId): Promise<ServiceAccountView> {
    await this.#authorize(this.#d.auth.store, 'service_account.get', caller, INSTALLATION)
    const [view] = await oauth.serviceAccountViews(this.#d.auth.store, this.publicOrigin, {
      identityId,
      limit: 1,
    })
    if (view === undefined) {
      throw new AuthError('NOT_FOUND')
    }
    return view
  }

  /** An inline security change of the service-account surface: engine (with re-authentication), then `run`. */
  async #serviceChange<T>(
    meta: RequestMeta,
    caller: Caller,
    action: string,
    run: (tx: Tx, session: SessionContext, request: AuditRequest) => Promise<T>,
  ): Promise<T> {
    const request = await auditRequest(this.#d.auth.keys, meta)
    return this.#d.auth.store.transaction(`application.${action}`, async (tx) => {
      await this.#authorize(tx, action, caller, INSTALLATION)
      return run(tx, sessionOf(caller), request)
    })
  }

  async createServiceAccount(
    meta: RequestMeta,
    caller: Caller,
    body: { readonly displayName: string; readonly responsibleIdentityId?: IdentityId | undefined },
  ): Promise<ServiceAccountView> {
    const identityId = await this.#serviceChange(
      meta,
      caller,
      'service_account.create',
      (tx, session, request) =>
        oauth.createServiceAccount(tx, this.#d.auth, session, request, body),
    )
    const [view] = await oauth.serviceAccountViews(this.#d.auth.store, this.publicOrigin, {
      identityId,
      limit: 1,
    })
    if (view === undefined) {
      throw new AuthError('NOT_FOUND')
    }
    return view
  }

  async registerServiceAccountClient(
    meta: RequestMeta,
    caller: Caller,
    identityId: IdentityId,
    keys: readonly PublicJwk[],
  ): Promise<OAuthClientView> {
    const client = await this.#serviceChange(
      meta,
      caller,
      'service_account.client.register',
      (tx, session, request) =>
        oauth.registerServiceClient(tx, this.#d.auth, session, request, identityId, keys),
    )
    return oauth.clientView(client)
  }

  async replaceServiceAccountClientKeys(
    meta: RequestMeta,
    caller: Caller,
    identityId: IdentityId,
    keys: readonly PublicJwk[],
  ): Promise<OAuthClientView> {
    const client = await this.#serviceChange(
      meta,
      caller,
      'service_account.client.keys.replace',
      (tx, session, request) =>
        oauth.replaceServiceClientKeys(tx, this.#d.auth, session, request, identityId, keys),
    )
    return oauth.clientView(client)
  }

  async createMachineGrant(
    meta: RequestMeta,
    caller: Caller,
    identityId: IdentityId,
    body: oauth.MachineAuthority & { readonly lifetimeDays: number },
  ): Promise<GrantView> {
    const grantId = await this.#serviceChange(
      meta,
      caller,
      'service_account.grant.create',
      (tx, session, request) =>
        oauth.createMachineGrant(tx, this.#d.auth, session, request, identityId, body),
    )
    const [view] = await oauth.listGrantViews(this.#d.auth.store, this.publicOrigin, {
      grantId,
      limit: 1,
    })
    if (view === undefined) {
      throw new AuthError('NOT_FOUND')
    }
    return view
  }

  async apiKeys(
    caller: Caller,
    query: { readonly serviceAccount?: IdentityId | undefined; readonly limit: number },
  ): Promise<{ items: ApiKeyView[]; nextCursor: null }> {
    await this.#authorize(this.#d.auth.store, 'api_key.list', caller, INSTALLATION)
    const items = await oauth.listApiKeys(this.#d.auth.store, {
      ...(query.serviceAccount === undefined ? {} : { identityId: query.serviceAccount }),
      limit: query.limit,
    })
    return { items, nextCursor: null }
  }

  /** The only response that carries an API key: once, at creation. */
  async createApiKey(
    meta: RequestMeta,
    caller: Caller,
    identityId: IdentityId,
    body: oauth.MachineAuthority & {
      readonly lifetimeDays: number
      readonly label?: string | undefined
    },
  ): Promise<{ readonly apiKey: ApiKeyView; readonly secret: string }> {
    const created = await this.#serviceChange(
      meta,
      caller,
      'api_key.create',
      (tx, session, request) =>
        oauth.createApiKey(tx, this.#d.auth, session, request, identityId, body),
    )
    const views = await oauth.listApiKeys(this.#d.auth.store, { identityId, limit: 200 })
    const apiKey = views.find((k) => k.id === created.keyId)
    if (apiKey === undefined) {
      throw new AuthError('NOT_FOUND')
    }
    return { apiKey, secret: created.secret }
  }

  revokeApiKey(
    meta: RequestMeta,
    caller: Caller,
    keyId: ApiKeyId,
    reason: string | undefined,
  ): Promise<{ readonly revoked: boolean }> {
    return this.#serviceChange(meta, caller, 'api_key.revoke', async (tx, session, request) => ({
      revoked: await oauth.revokeApiKey(tx, this.#d.auth, session, request, keyId, reason),
    }))
  }

  /** POST /oauth/register (RFC 7591, approval-gated compatibility). */
  async registerClient(
    meta: RequestMeta,
    request: { readonly body: string | undefined; readonly contentType: string | undefined },
  ): Promise<ClientRegistrationResponse> {
    await this.#protocol('oauth.register')
    return oauth.registerDcrClient(this.#d.auth, meta, request)
  }
}

/** How many non-terminal operations the fleet overview examines; more reads as a lower bound. */
const FLEET_OPERATION_SCAN = 500

export function isGrantId(value: unknown): value is GrantId {
  return isId('grt', value)
}

/** The subject a plan recorded at planning time (every member the resolver uses). */
export function subjectOf(plan: PlanRecord): PlanSubject {
  return subjectOfSubject(plan.body['subject'])
}

/** The same, from the `subject` member of a plan body already read. */
function subjectOfSubject(subject: JsonValue | undefined): PlanSubject {
  if (!isJsonObject(subject)) {
    return {}
  }
  const out: { -readonly [K in keyof PlanSubject]: PlanSubject[K] } = {}
  for (const member of [
    'targetId',
    'targetPath',
    'clusterId',
    'nodeId',
    'productId',
    'projectId',
    'environmentId',
    'serverId',
  ] as const) {
    const value = subject[member]
    if (typeof value === 'string') {
      out[member] = value
    }
  }
  const tier = subject['tier']
  if (tier === 'prod' || tier === 'nonprod') {
    out.tier = tier
  }
  const generation = subject['generation']
  if (typeof generation === 'number' && Number.isSafeInteger(generation)) {
    out.generation = generation
  }
  return out
}

/** A bearer caller's grant restrictions (target list, tiers); a session has none. */
/** Whether a caller's grant is limited to some tiers or targets (a session never is). */
function restricted(caller: Caller): boolean {
  return caller.kind === 'bearer' && !unrestricted(caller.principal.delegation.restrictions)
}

function restrictionsOf(caller: Caller): TargetVisibilityRestriction | undefined {
  if (caller.kind !== 'bearer') {
    return undefined
  }
  const r = caller.principal.delegation.restrictions
  return {
    ...(r.targets.kind === 'list' ? { targetIds: [...r.targets.targetIds] } : {}),
    tiers: [...r.tiers],
  }
}

/** Opaque audit cursor: a version prefix and the base64url of the last sequence number shown. */
const AUDIT_CURSOR_PREFIX = 'a1_'

function encodeAuditCursor(seq: string): string {
  return AUDIT_CURSOR_PREFIX + Buffer.from(seq, 'utf8').toString('base64url')
}

function decodeAuditCursor(cursor: string | undefined): string | null {
  if (cursor === undefined) return null
  const seq = cursor.startsWith(AUDIT_CURSOR_PREFIX)
    ? Buffer.from(cursor.slice(AUDIT_CURSOR_PREFIX.length), 'base64url').toString('utf8')
    : ''
  if (!/^[1-9][0-9]{0,18}$/.test(seq)) {
    throw new RegistryError('VALIDATION_FAILED', {
      errors: [{ path: '/cursor', code: 'invalid', message: 'Unknown cursor.' }],
    })
  }
  return seq
}

type AuditEventView = ReturnType<typeof AuditEventSchema.parse>

/**
 * The REST read projection of a stored audit event (pseudonymous actor; no
 * changes, request or decision, except a denial's action, reason and tool).
 */
function auditView(e: Record<string, unknown>): AuditEventView {
  const o = (v: unknown) =>
    typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {}
  const str = (v: unknown) => (typeof v === 'string' ? v : null)
  const actor = o(e['actor'])
  const client = e['client'] === undefined ? null : o(e['client'])
  const subject = o(e['subject'])
  const refs = o(e['refs'])
  const resultOf = o(e['result'])
  const changes = o(e['changes'])
  const status = str(resultOf['status'])
  const errorCode = str(resultOf['errorCode'])
  const view = {
    id: str(e['id']),
    occurredAt: str(e['occurredAt']),
    action: str(e['action']),
    phase: str(e['phase']),
    actor: {
      identityId: str(actor['identityId']),
      kind: str(actor['kind']),
      label: str(actor['label']) ?? 'unknown',
    },
    client:
      client === null
        ? null
        : {
            clientId: str(client['clientId']),
            kind: str(client['kind']),
            grantId: str(client['grantId']),
            sessionId: str(client['sessionId']),
          },
    subject: {
      targetId: str(subject['targetId']),
      targetPath: str(subject['targetPath']),
      clusterId: str(subject['clusterId']),
      nodeId: str(subject['nodeId']),
      tier: str(subject['tier']),
    },
    refs: {
      planId: str(refs['planId']),
      planHash: str(refs['planHash']),
      operationId: str(refs['operationId']),
      jobId: str(refs['jobId']),
    },
    reason: str(e['reason']),
    denial:
      e['action'] === DENIAL_EVENT
        ? {
            action: str(changes['action']),
            reason: str(changes['reason']),
            tool: str(changes['tool']),
          }
        : null,
    result: {
      // An event without a result records a request; it read as succeeded so far.
      status: status ?? 'succeeded',
      errorCode: errorCode !== null && /^[A-Z][A-Z0-9_]{1,63}$/.test(errorCode) ? errorCode : null,
    },
  }
  const checked = AuditEventSchema.safeParse(view)
  if (!checked.success) {
    // A stored event the read view cannot vouch for: a degraded read, never an invented one.
    throw new AuthError('CONTROL_PLANE_DEGRADED')
  }
  return checked.data
}

/** Opaque plan cursor: a version prefix and the base64url of the last examined id. */
const PLAN_CURSOR_PREFIX = 'p1_'

function encodePlanCursor(id: string): string {
  return PLAN_CURSOR_PREFIX + Buffer.from(id, 'utf8').toString('base64url')
}

function decodePlanCursor(cursor: string | undefined): string | null {
  if (cursor === undefined) return null
  const id = cursor.startsWith(PLAN_CURSOR_PREFIX)
    ? Buffer.from(cursor.slice(PLAN_CURSOR_PREFIX.length), 'base64url').toString('utf8')
    : ''
  if (!isId('pln', id)) {
    throw new RegistryError('VALIDATION_FAILED', {
      errors: [{ path: '/cursor', code: 'invalid', message: 'Unknown cursor.' }],
    })
  }
  return id
}

/** Opaque operation cursor: a version prefix and the base64url of the last examined id. */
const OPERATION_CURSOR_PREFIX = 'o1_'

function encodeOperationCursor(id: string): string {
  return OPERATION_CURSOR_PREFIX + Buffer.from(id, 'utf8').toString('base64url')
}

function decodeOperationCursor(cursor: string | undefined): string | null {
  if (cursor === undefined) return null
  const id = cursor.startsWith(OPERATION_CURSOR_PREFIX)
    ? Buffer.from(cursor.slice(OPERATION_CURSOR_PREFIX.length), 'base64url').toString('utf8')
    : ''
  if (!isId('op', id)) {
    throw new RegistryError('VALIDATION_FAILED', {
      errors: [{ path: '/cursor', code: 'invalid', message: 'Unknown cursor.' }],
    })
  }
  return id
}
