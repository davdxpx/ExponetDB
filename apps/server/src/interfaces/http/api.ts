import {
  type Application,
  type Caller,
  idempotencyRequestHash,
  isIdempotencyKey,
  sessionCaller,
} from '@exponetdb/application'
import {
  AuthError,
  CEREMONY_COOKIE,
  CSRF_COOKIE,
  CSRF_HEADER,
  type Outcome,
  oauth,
  SESSION_ABSOLUTE_SECONDS,
  SESSION_COOKIE,
  type SessionContext,
  verifyCsrf,
} from '@exponetdb/auth'
import {
  AccessRoleSchema,
  ApiKeyCreateRequestSchema,
  ApiKeyIdSchema,
  ApprovalDecisionRequestSchema,
  AUTH_BASE_PATH,
  AUTH_ROUTES,
  AuditExportQuerySchema,
  AuthenticationCredentialSchema,
  AuthFactorIdSchema,
  AuthorizationRequestHandleSchema,
  actionDefinition,
  BaselinePlanRequestSchema,
  BreakGlassActivateRequestSchema,
  BreakGlassGrantIdSchema,
  BreakGlassGrantListQuerySchema,
  BreakGlassReviewRequestSchema,
  BundleIngestRequestSchema,
  CimdClientRequestSchema,
  CLIENT_STATES,
  ClientApprovalRequestSchema,
  ClientDecisionReasonSchema,
  ClusterBootstrapSqlQuerySchema,
  ClusterConfirmRequestSchema,
  ClusterDeclaredTierRequestSchema,
  ClusterIdSchema,
  ClusterRegisterRequestSchema,
  ConsentDecisionRequestSchema,
  CredentialSubmissionSchema,
  DatabaseIdSchema,
  DatabaseRegisterRequestSchema,
  DEFAULT_BODY_LIMIT_BYTES,
  DeviceDecisionRequestSchema,
  DisableIdentityRequestSchema,
  DriftAcceptRequestSchema,
  decodeQuery,
  EmailSchema,
  EndpointIdSchema,
  EndpointRequestSchema,
  EnrollmentTokenIdSchema,
  EnvironmentChangeRequestSchema,
  EnvironmentCreateRequestSchema,
  EnvironmentIdSchema,
  ExecutionRoleBindingsRequestSchema,
  ExecutionRoleExceptionDeclareRequestSchema,
  ExecutionRoleExceptionIdSchema,
  ExecutionRoleExceptionRevokeRequestSchema,
  type ExplainRequest,
  FindingIdSchema,
  GrantIdSchema,
  GrantStateSchema,
  IdentityIdSchema,
  IdentityStateSchema,
  ImportAnalysisRequestSchema,
  ImportDecisionRequestSchema,
  ImportReportIdSchema,
  InviteIdentityRequestSchema,
  isScope,
  LinkTokenSchema,
  MachineGrantRequestSchema,
  MigrationIdSchema,
  MigrationLintRequestSchema,
  MigrationPlanRequestSchema,
  MigrationResumeRequestSchema,
  MigrationRollbackRequestSchema,
  MigrationVerifyRequestSchema,
  NodeConfigUpdateRequestSchema,
  NodeIdSchema,
  NodeInspectionRequestSchema,
  NodeObservationQuerySchema,
  NodePlanRequestSchema,
  OAuthClientIdSchema,
  OperationIdSchema,
  OperationStateSchema,
  PasswordInputSchema,
  PlanIdSchema,
  PlanStateSchema,
  PolicySettingsPlanRequestSchema,
  ProductCreateRequestSchema,
  ProductIdSchema,
  type ProfileUpdateRequest,
  ProjectChangeRequestSchema,
  ProjectCreateRequestSchema,
  ProjectIdSchema,
  type QueryRequest,
  REST_API_BASE_PATH,
  RecoveryCodeInputSchema,
  RegistrationCredentialSchema,
  RevokeRequestSchema,
  ROUTE_LIST,
  RoleBindingIdSchema,
  RoleBindingPlanRequestSchema,
  RoleIdSchema,
  RoleVerifierSubmissionSchema,
  type RouteContract,
  type SavedQueryCreateRequest,
  SavedQueryIdSchema,
  type SavedQueryUpdateRequest,
  SchemaDiffRequestSchema,
  SchemaObjectKindSchema,
  type Scope,
  ServerCreateRequestSchema,
  ServerIdSchema,
  ServiceAccountCreateRequestSchema,
  ServiceClientKeysRequestSchema,
  SessionIdSchema,
  Sha256DigestSchema,
  SlugSchema,
  SqlClassificationRequestSchema,
  StepUpIdSchema,
  TargetRefSchema,
  TargetRegisterRequestSchema,
  TargetStateChangeRequestSchema,
  TargetStateSchema,
  TierSchema,
  TotpCodeSchema,
  UserCodeSchema,
} from '@exponetdb/contracts'
import { isJsonObject, type RequestId, toJsonValue } from '@exponetdb/kernel'
import { describeError, type Logger } from '@exponetdb/observability'
import type { Context, Hono } from 'hono'
import { existenceFloor } from '../existence.ts'
import { authenticateBearer, authorizationHeaders } from './bearer.ts'
import type { HttpEnv } from './env.ts'
import {
  clearCookie,
  clientAddress,
  HttpRefusal,
  parseCookies,
  problemResponse,
  readLimitedBytes,
  readLimitedText,
  setCookie,
} from './request.ts'

/**
 * The authenticated HTTP interfaces of Wave 3A: the Web App ceremonies under
 * `/auth` and the access resources under `/api/v1`. Every route comes from
 * the contracts (path, method, action, body, response); every handler calls
 * `@exponetdb/application` and nothing else (C-9).
 *
 * Per request, before any handler:
 * - credential mode, exactly one per request (Wave 3B): the session cookie,
 *   or one `Authorization: Bearer` header carrying an OAuth access token or
 *   an API key for the REST API. Both together are `AMBIGUOUS_CREDENTIALS`;
 *   a bearer credential is never accepted under `/auth` (the Web App
 *   ceremonies) and is checked live for this resource (`api`) on every
 *   request; a 401 or an `INSUFFICIENT_SCOPE` 403 carries the
 *   `WWW-Authenticate` challenge with the protected resource metadata;
 * - cookie-authenticated state changes need `Origin` equal to the configured
 *   public origin (and `Sec-Fetch-Site: same-origin` when the browser sends
 *   it) and the CSRF header, equal to the CSRF cookie and to the session's
 *   stored hash (a bearer credential is no ambient authority: no CSRF);
 * - bodies are JSON of at most 64 KiB, validated against the contract;
 * - responses are validated against the contract before they are sent.
 */
export interface ApiDeps {
  readonly application: Application
  readonly publicOrigin: string
  readonly trustedProxies: readonly string[]
  readonly logger: Logger
  /** False until the stored role matrix is verified: nothing is authorized before (fail closed). */
  readonly available: () => boolean
}

type Env = HttpEnv

interface Call {
  readonly c: Context<Env>
  readonly meta: {
    readonly requestId: RequestId
    readonly clientIp: string | undefined
    readonly userAgent: string | undefined
  }
  readonly body: unknown
  /** The raw body of a `rawBody` route (a picture): the bytes and the declared media type. */
  readonly raw?: { readonly bytes: Uint8Array; readonly mediaType: string }
  readonly params: unknown
  readonly query: unknown
  readonly session: SessionContext | undefined
  /** The authenticated caller of an `/api/v1` route (session or bearer). */
  readonly caller: Caller | undefined
  readonly ceremony: string | undefined
  /** The OAuth browser-binding cookie (consent of an authorization request). */
  readonly oauthBinding: string | undefined
}

/** A plain result, or a ceremony outcome (which carries cookie instructions). */
type Result =
  | { readonly kind: 'value'; readonly value: unknown }
  /** A body the use case already serialized (`mediaType` routes: NDJSON). */
  | { readonly kind: 'text'; readonly body: string }
  /** Raw bytes of a `rawResponse` route (a picture) with its media type and caching key. */
  | {
      readonly kind: 'bytes'
      readonly body: Uint8Array
      readonly mediaType: string
      readonly headers: Readonly<Record<string, string>>
      /**
       * The strong entity tag of exactly these bytes. A request whose `If-None-Match`
       * names it is answered `304 Not Modified` without the bytes, but only after the
       * handler ran: the caller was authorized for the current bytes first.
       */
      readonly etag?: string
    }
  | { readonly kind: 'outcome'; readonly outcome: Outcome<unknown> }

type Handler = (app: Application, call: Call) => Promise<Result>

/**
 * Whether an `If-None-Match` header names the entity tag (RFC 9110 §13.1.2:
 * weak comparison, a list of tags or `*`). An absent or malformed header never
 * matches, so the full answer is sent.
 */
function matchesEtag(header: string | undefined, etag: string): boolean {
  if (header === undefined || header.length > 2048) return false
  const opaque = etag.replace(/^W\//, '')
  return header.split(',').some((part) => {
    const tag = part.trim()
    return tag === '*' || tag.replace(/^W\//, '') === opaque
  })
}

const value = (v: unknown): Result => ({ kind: 'value', value: v })
const outcome = (o: Outcome<unknown>): Result => ({ kind: 'outcome', outcome: o })

function session(call: Call): SessionContext {
  if (call.session === undefined) {
    throw new HttpRefusal('SESSION_EXPIRED')
  }
  return call.session
}

function caller(call: Call): Caller {
  if (call.caller === undefined) {
    throw new HttpRefusal('UNAUTHENTICATED')
  }
  return call.caller
}

function field(source: unknown, key: string): unknown {
  return typeof source === 'object' && source !== null && !Array.isArray(source)
    ? Object.getOwnPropertyDescriptor(source, key)?.value
    : undefined
}

function optionalText(source: unknown, key: string): string | undefined {
  const v = field(source, key)
  return typeof v === 'string' ? v : undefined
}

function idempotency(call: Call): { key: string; requestHash: string } | undefined {
  const key = call.c.req.header('idempotency-key')
  if (key === undefined) {
    return undefined
  }
  if (!isIdempotencyKey(key)) {
    throw new HttpRefusal('VALIDATION_FAILED')
  }
  const body = toJsonValue(call.body ?? null)
  if (!body.ok) {
    throw new HttpRefusal('VALIDATION_FAILED')
  }
  return {
    key,
    requestHash: idempotencyRequestHash(call.c.req.method, call.c.req.path, body.value),
  }
}

/** A page request from the (already validated) query: limit and the opaque cursor. */
function pageOf(query: unknown): { limit: number; cursor?: string } {
  const cursor = optionalText(query, 'cursor')
  return { limit: limitOf(query), ...(cursor === undefined ? {} : { cursor }) }
}

const target = (call: Call) => TargetRefSchema.parse(field(call.params, 'target'))
const clusterId = (call: Call) => ClusterIdSchema.parse(field(call.params, 'clusterId'))
const savedQueryId = (call: Call) => SavedQueryIdSchema.parse(field(call.params, 'savedQueryId'))

function optional<T>(source: unknown, key: string, parse: (v: unknown) => T): T | undefined {
  const v = field(source, key)
  return v === undefined ? undefined : parse(v)
}

function limitOf(query: unknown): number {
  const raw = field(query, 'limit')
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : 50
  return Number.isInteger(n) && n >= 1 && n <= 200 ? n : 50
}

/** The handlers, by contract operation id. A route without a handler is not served (test: all Wave 3A routes have one). */
function revisionOf(raw: unknown): number {
  const n = typeof raw === 'string' && /^[1-9][0-9]{0,8}$/.test(raw) ? Number(raw) : raw
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 1) {
    throw new HttpRefusal('VALIDATION_FAILED')
  }
  return n
}

const BUNDLE_FILES = ['migration.yaml', 'up.sql', 'verify.sql', 'down.sql'] as const

function bundleFileOf(raw: unknown): (typeof BUNDLE_FILES)[number] {
  const file = BUNDLE_FILES.find((f) => f === raw)
  if (file === undefined) {
    throw new HttpRefusal('VALIDATION_FAILED')
  }
  return file
}

/** The request header that names a CLI step-up receipt (ADR-0026). */
export const STEP_UP_HEADER = 'exponetdb-step-up'

export const HANDLERS: Readonly<Record<string, Handler>> = {
  // ----- /auth: sign-in and enrollment (public ceremonies) -----
  loginPasskeyOptions: async (app, call) => outcome(await app.loginPasskeyOptions(call.meta)),
  loginPasskey: async (app, call) =>
    outcome(
      await app.loginPasskey(
        call.meta,
        call.ceremony,
        AuthenticationCredentialSchema.parse(field(call.body, 'credential')),
      ),
    ),
  loginPassword: async (app, call) =>
    outcome(
      await app.loginPassword(
        call.meta,
        EmailSchema.parse(field(call.body, 'email')),
        PasswordInputSchema.parse(field(call.body, 'password')),
      ),
    ),
  loginTotp: async (app, call) =>
    outcome(
      await app.loginTotp(call.meta, call.ceremony, TotpCodeSchema.parse(field(call.body, 'code'))),
    ),
  loginRecoveryCode: async (app, call) =>
    outcome(
      await app.loginRecoveryCode(
        call.meta,
        call.ceremony,
        RecoveryCodeInputSchema.parse(field(call.body, 'code')),
      ),
    ),
  enrollmentRedeem: async (app, call) =>
    outcome(
      await app.enrollmentRedeem(call.meta, LinkTokenSchema.parse(field(call.body, 'token'))),
    ),
  enrollmentPasskeyOptions: async (app, call) =>
    outcome(await app.enrollmentPasskeyOptions(call.ceremony)),
  enrollmentPasskey: async (app, call) =>
    outcome(
      await app.enrollmentPasskey(
        call.ceremony,
        RegistrationCredentialSchema.parse(field(call.body, 'credential')),
        optionalText(call.body, 'label'),
      ),
    ),
  enrollmentPassword: async (app, call) =>
    outcome(
      await app.enrollmentPassword(
        call.ceremony,
        PasswordInputSchema.parse(field(call.body, 'password')),
      ),
    ),
  enrollmentTotpOptions: async (app, call) =>
    outcome(await app.enrollmentTotpOptions(call.ceremony)),
  enrollmentTotp: async (app, call) =>
    outcome(
      await app.enrollmentTotp(
        call.meta,
        call.ceremony,
        TotpCodeSchema.parse(field(call.body, 'code')),
      ),
    ),
  enrollmentComplete: async (app, call) =>
    outcome(await app.enrollmentComplete(call.meta, call.ceremony)),

  // ----- /auth: session-bound ceremonies -----
  logout: async (app, call) => outcome(await app.logout(call.meta, session(call))),
  reauthPasskeyOptions: async (app, call) => outcome(await app.reauthPasskeyOptions(session(call))),
  reauthPasskey: async (app, call) =>
    outcome(
      await app.reauthPasskey(
        call.meta,
        session(call),
        AuthenticationCredentialSchema.parse(field(call.body, 'credential')),
      ),
    ),
  reauthTotp: async (app, call) =>
    outcome(
      await app.reauthTotp(
        call.meta,
        session(call),
        TotpCodeSchema.parse(field(call.body, 'code')),
      ),
    ),
  passkeyOptions: async (app, call) => outcome(await app.passkeyOptions(session(call))),
  addPasskey: async (app, call) =>
    outcome(
      await app.addPasskey(
        call.meta,
        session(call),
        RegistrationCredentialSchema.parse(field(call.body, 'credential')),
        optionalText(call.body, 'label'),
      ),
    ),
  removePasskey: async (app, call) =>
    outcome(
      await app.removePasskey(
        call.meta,
        session(call),
        AuthFactorIdSchema.parse(field(call.params, 'factorId')),
      ),
    ),
  changePassword: async (app, call) =>
    outcome(
      await app.changePassword(
        call.meta,
        session(call),
        PasswordInputSchema.parse(field(call.body, 'password')),
      ),
    ),
  totpOptions: async (app, call) => outcome(await app.totpOptions(session(call))),
  replaceTotp: async (app, call) =>
    outcome(
      await app.replaceTotp(
        call.meta,
        session(call),
        TotpCodeSchema.parse(field(call.body, 'code')),
      ),
    ),
  regenerateRecoveryCodes: async (app, call) =>
    outcome(await app.regenerateRecoveryCodes(call.meta, session(call))),

  // ----- /api/v1: the current identity -----
  getMe: async (app, call) => value(await app.me(caller(call))),
  // Wave 8 (owner decision S10): the own profile.
  updateMyProfile: async (app, call) =>
    value(
      await app.profiles.updateProfile(caller(call), call.body as ProfileUpdateRequest, {
        requestId: call.meta.requestId,
      }),
    ),
  setMyAvatar: async (app, call) => {
    if (call.raw === undefined) {
      throw new HttpRefusal('VALIDATION_FAILED')
    }
    return value(
      await app.profiles.setAvatar(caller(call), call.raw, { requestId: call.meta.requestId }),
    )
  },
  deleteMyAvatar: async (app, call) =>
    value(await app.profiles.deleteAvatar(caller(call), { requestId: call.meta.requestId })),
  listMySessions: async (app, call) => value({ items: await app.sessions(caller(call)) }),
  revokeMySession: async (app, call) =>
    outcome(
      await app.revokeSession(
        call.meta,
        caller(call),
        SessionIdSchema.parse(field(call.params, 'sessionId')),
      ),
    ),
  revokeMyOtherSessions: async (app, call) =>
    outcome(await app.revokeOtherSessions(call.meta, caller(call))),
  listMyFactors: async (app, call) => value({ items: await app.factors(caller(call)) }),

  // ----- /api/v1: identities -----
  listIdentities: async (app, call) => {
    const state = field(call.query, 'state')
    return value(
      await app.identities(caller(call), {
        state: state === undefined ? undefined : IdentityStateSchema.parse(state),
        limit: limitOf(call.query),
      }),
    )
  },
  getIdentityAvatar: async (app, call) => {
    const picture = await app.profiles.avatar(
      caller(call),
      IdentityIdSchema.parse(field(call.params, 'identityId')),
      Sha256DigestSchema.parse(field(call.query, 'v')),
    )
    return {
      kind: 'bytes',
      body: picture.bytes,
      mediaType: picture.mediaType,
      // The entity tag is the stored hash of the bytes (an image without its metadata).
      etag: `"${picture.sha256.slice('sha256:'.length)}"`,
      // An image only, whatever the bytes might look like to a sniffer (threat-model.md, Wave 8):
      // never sniffed, never a document. Kept privately but revalidated on every use
      // (`no-cache`), so a person who loses access, or a removed picture, stops being
      // shown at once; an unchanged picture is a `304` without the bytes.
      headers: {
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox",
        'cache-control': 'private, no-cache',
        'content-disposition': 'inline',
        'cross-origin-resource-policy': 'same-origin',
      },
    }
  },
  getIdentity: async (app, call) =>
    value(
      await app.identity(caller(call), IdentityIdSchema.parse(field(call.params, 'identityId'))),
    ),
  inviteIdentity: async (app, call) =>
    value(await app.invite(call.meta, caller(call), InviteIdentityRequestSchema.parse(call.body))),
  reissueInvitation: async (app, call) =>
    value(
      await app.reissueInvitation(
        call.meta,
        caller(call),
        IdentityIdSchema.parse(field(call.params, 'identityId')),
      ),
    ),
  disableIdentity: async (app, call) =>
    value(
      await app.disable(
        call.meta,
        caller(call),
        IdentityIdSchema.parse(field(call.params, 'identityId')),
        DisableIdentityRequestSchema.parse(call.body).reason,
      ),
    ),
  planIdentityEnable: async (app, call) =>
    value(
      await app.planIdentityChange(
        caller(call),
        'access.identity.enable',
        IdentityIdSchema.parse(field(call.params, 'identityId')),
        idempotency(call),
      ),
    ),
  planIdentityErasure: async (app, call) =>
    value(
      await app.planIdentityChange(
        caller(call),
        'access.identity.erase',
        IdentityIdSchema.parse(field(call.params, 'identityId')),
        idempotency(call),
      ),
    ),

  // ----- /api/v1: roles, bindings, policy -----
  listRoles: async (app, call) => value(await app.roles(caller(call))),
  getRole: async (app, call) =>
    value(await app.role(caller(call), RoleIdSchema.parse(field(call.params, 'roleId')))),
  listRoleBindings: async (app, call) => {
    const identity = field(call.query, 'identity')
    const state = field(call.query, 'state')
    return value(
      await app.roleBindings(caller(call), {
        identity: identity === undefined ? undefined : IdentityIdSchema.parse(identity),
        state: state === 'active' || state === 'revoked' ? state : undefined,
        limit: limitOf(call.query),
      }),
    )
  },
  planRoleBinding: async (app, call) =>
    value(
      await app.planRoleBinding(
        caller(call),
        RoleBindingPlanRequestSchema.parse(call.body),
        idempotency(call),
      ),
    ),
  planRoleBindingRemoval: async (app, call) =>
    value(
      await app.planRoleBindingRemoval(
        caller(call),
        RoleBindingIdSchema.parse(field(call.params, 'bindingId')),
        idempotency(call),
      ),
    ),
  getPolicySettings: async (app, call) => value(await app.policySettings(caller(call))),
  planPolicySettings: async (app, call) => {
    const body = PolicySettingsPlanRequestSchema.parse(call.body)
    const params = toJsonValue(body.params)
    if (!params.ok || !isJsonObject(params.value)) {
      throw new HttpRefusal('VALIDATION_FAILED')
    }
    return value(
      await app.planPolicySettings(
        caller(call),
        { ...body, params: params.value },
        idempotency(call),
      ),
    )
  },

  // ----- /api/v1: approvals and plans -----
  listApprovals: async (app, call) => value(await app.approvals(caller(call))),
  approveOperation: async (app, call) =>
    value(
      await app.approve(
        caller(call),
        OperationIdSchema.parse(field(call.params, 'operationId')),
        ApprovalDecisionRequestSchema.parse(call.body),
      ),
    ),
  rejectOperation: async (app, call) =>
    value(
      await app.reject(
        caller(call),
        OperationIdSchema.parse(field(call.params, 'operationId')),
        ApprovalDecisionRequestSchema.parse(call.body),
      ),
    ),
  applyPlan: async (app, call) =>
    value(await app.apply(caller(call), PlanIdSchema.parse(field(call.params, 'planId')))),
  withdrawPlan: async (app, call) =>
    value(await app.withdraw(caller(call), PlanIdSchema.parse(field(call.params, 'planId')))),

  // ----- /api/v1: installation -----
  getPlan: async (app, call) =>
    value(await app.plan(caller(call), PlanIdSchema.parse(field(call.params, 'planId')))),
  getOperation: async (app, call) =>
    value(
      await app.operation(caller(call), OperationIdSchema.parse(field(call.params, 'operationId'))),
    ),
  listOperations: async (app, call) => {
    const actor = field(call.query, 'actor')
    return value(
      await app.operations(caller(call), {
        target: optional(call.query, 'target', (v) => TargetRefSchema.parse(v)),
        kind: optionalText(call.query, 'kind'),
        state: optional(call.query, 'state', (v) => OperationStateSchema.parse(v)),
        actor: actor === 'self' || actor === 'any' ? actor : undefined,
        ...pageOf(call.query),
      }),
    )
  },
  searchAuditEvents: async (app, call) => {
    const actor = field(call.query, 'actor')
    const status = field(call.query, 'result')
    return value(
      await app.auditEvents(caller(call), {
        from: optionalText(call.query, 'from'),
        to: optionalText(call.query, 'to'),
        target: optionalText(call.query, 'target'),
        action: optionalText(call.query, 'action'),
        actor: actor === 'self' || actor === 'any' ? actor : undefined,
        result:
          status === 'succeeded' || status === 'failed' || status === 'denied' ? status : undefined,
        client: optionalText(call.query, 'client'),
        grant: optionalText(call.query, 'grant'),
        identity: optionalText(call.query, 'identity'),
        ...pageOf(call.query),
      }),
    )
  },
  listPlans: async (app, call) => {
    const actor = field(call.query, 'actor')
    return value(
      await app.plans(caller(call), {
        target: optional(call.query, 'target', (v) => TargetRefSchema.parse(v)),
        kind: optionalText(call.query, 'kind'),
        state: optional(call.query, 'state', (v) => PlanStateSchema.parse(v)),
        actor: actor === 'self' || actor === 'any' ? actor : undefined,
        ...pageOf(call.query),
      }),
    )
  },
  requestStepUp: async (app, call) => {
    const body = call.body as { action: string; planId?: string; tokenId?: string }
    return value(
      await app.requestStepUp(caller(call), {
        action: body.action,
        planId: body.planId,
        tokenId: body.tokenId,
      }),
    )
  },
  getStepUp: async (app, call) =>
    value(await app.stepUp(caller(call), StepUpIdSchema.parse(field(call.params, 'stepUpId')))),
  confirmStepUp: async (app, call) =>
    value(
      await app.confirmStepUp(
        caller(call),
        StepUpIdSchema.parse(field(call.params, 'stepUpId')),
        String((call.body as { userCode: string }).userCode),
      ),
    ),
  cancelStepUp: async (app, call) =>
    value(
      await app.cancelStepUp(caller(call), StepUpIdSchema.parse(field(call.params, 'stepUpId'))),
    ),
  cancelOperation: async (app, call) =>
    value(
      await app.cancelOperation(
        caller(call),
        OperationIdSchema.parse(field(call.params, 'operationId')),
      ),
    ),
  retryOperationVerification: async (app, call) =>
    value(
      await app.retryOperationVerification(
        caller(call),
        OperationIdSchema.parse(field(call.params, 'operationId')),
      ),
    ),
  getInstallation: async (app, call) => value(await app.installation(caller(call))),
  // ----- /api/v1: the Wave 8 reads (order §9) -----
  getInstallationHealth: async (app, call) => value(await app.installationHealth(caller(call))),
  getAuditChain: async (app, call) => value(await app.auditChain(caller(call))),
  exportAuditEvents: async (app, call) => {
    const query = AuditExportQuerySchema.parse(call.query)
    return { kind: 'text', body: await app.exportAuditEvents(caller(call), query) }
  },
  classifySql: async (app, call) =>
    value(await app.classifySql(caller(call), SqlClassificationRequestSchema.parse(call.body))),
  getTargetHealthHistory: async (app, call) =>
    value(
      await app.registry.targetHealthHistory(caller(call), target(call), {
        from: optionalText(call.query, 'from'),
        to: optionalText(call.query, 'to'),
      }),
    ),
  listNodeJobs: async (app, call) =>
    value(
      await app.nodes.jobs(
        caller(call),
        NodeIdSchema.parse(field(call.params, 'nodeId')),
        pageOf(call.query),
      ),
    ),
  listNodeCertificates: async (app, call) => value(await app.nodes.certificates(caller(call))),
  getMigrationStream: async (app, call) =>
    value(
      await app.migrations.stream(
        caller(call),
        ProjectIdSchema.parse(field(call.params, 'projectId')),
      ),
    ),

  // ----- /auth: OAuth consent (Wave 3B) -----
  oauthConsentView: async (app, call) =>
    value(
      await app.consentView(
        sessionCaller(session(call)),
        AuthorizationRequestHandleSchema.parse(field(call.body, 'request')),
        call.oauthBinding,
      ),
    ),
  oauthConsent: async (app, call) => {
    const body = ConsentDecisionRequestSchema.parse(call.body)
    return value(
      await app.consent(
        call.meta,
        sessionCaller(session(call)),
        {
          request: body.request,
          decision: body.decision,
          scopes: body.scopes,
          tiers: body.tiers,
          lifetimeDays: body.lifetimeDays,
          acknowledgeProduction: body.acknowledgeProduction,
          targets: body.targets,
        },
        call.oauthBinding,
      ),
    )
  },

  oauthDeviceView: async (app, call) =>
    value(
      await app.deviceView(
        sessionCaller(session(call)),
        UserCodeSchema.parse(field(call.body, 'userCode')),
      ),
    ),
  oauthDevice: async (app, call) => {
    const body = DeviceDecisionRequestSchema.parse(call.body)
    return value(
      await app.device(call.meta, sessionCaller(session(call)), {
        userCode: body.userCode,
        decision: body.decision,
        scopes: body.scopes,
        tiers: body.tiers,
        lifetimeDays: body.lifetimeDays,
        acknowledgeProduction: body.acknowledgeProduction,
        targets: body.targets,
      }),
    )
  },

  // ----- /api/v1: connected applications and OAuth administration (Wave 3B) -----
  listMyGrants: async (app, call) => value({ items: await app.myGrants(caller(call)) }),
  revokeMyGrant: async (app, call) =>
    value(
      await app.revokeMyGrant(
        call.meta,
        caller(call),
        GrantIdSchema.parse(field(call.params, 'grantId')),
      ),
    ),
  listGrants: async (app, call) => {
    const identity = field(call.query, 'identity')
    const state = field(call.query, 'state')
    return value(
      await app.grants(caller(call), {
        identity: identity === undefined ? undefined : IdentityIdSchema.parse(identity),
        state: state === undefined ? undefined : GrantStateSchema.parse(state),
        limit: limitOf(call.query),
      }),
    )
  },
  revokeGrant: async (app, call) =>
    value(
      await app.revokeGrant(
        call.meta,
        caller(call),
        GrantIdSchema.parse(field(call.params, 'grantId')),
      ),
    ),
  listOAuthClients: async (app, call) => {
    const state = field(call.query, 'state')
    const parsed = CLIENT_STATES.find((s) => s === state)
    if (state !== undefined && parsed === undefined) {
      throw new HttpRefusal('VALIDATION_FAILED')
    }
    return value(
      await app.oauthClients(caller(call), { state: parsed, limit: limitOf(call.query) }),
    )
  },
  getOAuthClient: async (app, call) =>
    value(
      await app.oauthClient(
        caller(call),
        OAuthClientIdSchema.parse(field(call.params, 'oauthClientId')),
      ),
    ),
  registerCimdClient: async (app, call) =>
    value(
      await app.registerCimdClient(
        call.meta,
        caller(call),
        CimdClientRequestSchema.parse(call.body).clientId,
      ),
    ),
  refreshOAuthClientMetadata: async (app, call) =>
    value(
      await app.refreshOAuthClientMetadata(
        call.meta,
        caller(call),
        OAuthClientIdSchema.parse(field(call.params, 'oauthClientId')),
      ),
    ),
  approveOAuthClient: async (app, call) =>
    value(
      await app.approveOAuthClient(
        call.meta,
        caller(call),
        OAuthClientIdSchema.parse(field(call.params, 'oauthClientId')),
        ClientApprovalRequestSchema.parse(call.body).fingerprint,
      ),
    ),
  rejectOAuthClient: async (app, call) =>
    value(
      await app.rejectOAuthClient(
        call.meta,
        caller(call),
        OAuthClientIdSchema.parse(field(call.params, 'oauthClientId')),
        ClientDecisionReasonSchema.parse(call.body).reason,
      ),
    ),
  // ----- /api/v1: service accounts and API keys (Wave 3B) -----
  listServiceAccounts: async (app, call) =>
    value(await app.serviceAccounts(caller(call), { limit: limitOf(call.query) })),
  getServiceAccount: async (app, call) =>
    value(
      await app.serviceAccount(
        caller(call),
        IdentityIdSchema.parse(field(call.params, 'identityId')),
      ),
    ),
  createServiceAccount: async (app, call) => {
    const body = ServiceAccountCreateRequestSchema.parse(call.body)
    return value(
      await app.createServiceAccount(call.meta, caller(call), {
        displayName: body.displayName,
        responsibleIdentityId: body.responsibleIdentityId,
      }),
    )
  },
  registerServiceAccountClient: async (app, call) =>
    value(
      await app.registerServiceAccountClient(
        call.meta,
        caller(call),
        IdentityIdSchema.parse(field(call.params, 'identityId')),
        ServiceClientKeysRequestSchema.parse(call.body).jwks.keys,
      ),
    ),
  replaceServiceAccountClientKeys: async (app, call) =>
    value(
      await app.replaceServiceAccountClientKeys(
        call.meta,
        caller(call),
        IdentityIdSchema.parse(field(call.params, 'identityId')),
        ServiceClientKeysRequestSchema.parse(call.body).jwks.keys,
      ),
    ),
  createMachineGrant: async (app, call) => {
    const body = MachineGrantRequestSchema.parse(call.body)
    return value(
      await app.createMachineGrant(
        call.meta,
        caller(call),
        IdentityIdSchema.parse(field(call.params, 'identityId')),
        {
          scopes: body.scopes,
          restrictions: body.restrictions,
          acknowledgeProductionWrite: body.acknowledgeProductionWrite,
          lifetimeDays: body.lifetimeDays,
        },
      ),
    )
  },
  listApiKeys: async (app, call) => {
    const serviceAccount = field(call.query, 'serviceAccount')
    return value(
      await app.apiKeys(caller(call), {
        serviceAccount:
          serviceAccount === undefined ? undefined : IdentityIdSchema.parse(serviceAccount),
        limit: limitOf(call.query),
      }),
    )
  },
  createApiKey: async (app, call) => {
    const body = ApiKeyCreateRequestSchema.parse(call.body)
    return value(
      await app.createApiKey(
        call.meta,
        caller(call),
        IdentityIdSchema.parse(field(call.params, 'identityId')),
        {
          scopes: body.scopes,
          restrictions: body.restrictions,
          acknowledgeProductionWrite: body.acknowledgeProductionWrite,
          lifetimeDays: body.lifetimeDays,
          label: body.label,
        },
      ),
    )
  },
  revokeApiKey: async (app, call) =>
    value(
      await app.revokeApiKey(
        call.meta,
        caller(call),
        ApiKeyIdSchema.parse(field(call.params, 'keyId')),
        RevokeRequestSchema.parse(call.body).reason,
      ),
    ),
  // ----- /api/v1: registry reads (Wave 4) -----
  listProducts: async (app, call) =>
    value(await app.registry.products(caller(call), pageOf(call.query))),
  getProduct: async (app, call) =>
    value(
      await app.registry.product(
        caller(call),
        ProductIdSchema.parse(field(call.params, 'productId')),
      ),
    ),
  listProductEnvironments: async (app, call) =>
    value(
      await app.registry.environments(
        caller(call),
        ProductIdSchema.parse(field(call.params, 'productId')),
        pageOf(call.query),
      ),
    ),
  listProjects: async (app, call) =>
    value(
      await app.registry.projects(
        caller(call),
        { product: optional(call.query, 'product', (v) => SlugSchema.parse(v)) },
        pageOf(call.query),
      ),
    ),
  getProject: async (app, call) =>
    value(
      await app.registry.project(
        caller(call),
        ProjectIdSchema.parse(field(call.params, 'projectId')),
      ),
    ),
  listTargets: async (app, call) =>
    value(
      await app.registry.targets(
        caller(call),
        {
          product: optional(call.query, 'product', (v) => SlugSchema.parse(v)),
          project: optional(call.query, 'project', (v) => SlugSchema.parse(v)),
          environment: optional(call.query, 'environment', (v) => SlugSchema.parse(v)),
          tier: optional(call.query, 'tier', (v) => TierSchema.parse(v)),
          state: optional(call.query, 'state', (v) => TargetStateSchema.parse(v)),
        },
        pageOf(call.query),
      ),
    ),
  getTarget: async (app, call) => value(await app.registry.target(caller(call), target(call))),
  getTargetHealth: async (app, call) =>
    value(await app.registry.targetHealth(caller(call), target(call))),
  listTargetFindings: async (app, call) => {
    const kind = field(call.query, 'kind')
    const severity = field(call.query, 'severity')
    return value(
      await app.registry.targetFindings(
        caller(call),
        target(call),
        {
          includeResolved: field(call.query, 'includeResolved') === true,
          ...(kind === 'drift' || kind === 'health' ? { kind } : {}),
          ...(severity === 'info' || severity === 'warning' || severity === 'critical'
            ? { severity }
            : {}),
        },
        pageOf(call.query),
      ),
    )
  },
  // ----- /api/v1: the fleet overview and the findings across targets (Wave 8, order §9) -----
  getFleet: async (app, call) => value(await app.fleet(caller(call))),
  listFindings: async (app, call) => {
    const severity = field(call.query, 'severity')
    const state = field(call.query, 'state')
    const kind = field(call.query, 'kind')
    return value(
      await app.registry.findings(
        caller(call),
        {
          target: optional(call.query, 'target', (v) => TargetRefSchema.parse(v)),
          ...(severity === 'info' || severity === 'warning' || severity === 'critical'
            ? { severity }
            : {}),
          ...(state === 'open' || state === 'resolved' || state === 'all' ? { state } : {}),
          ...(kind === 'drift' || kind === 'health' ? { kind } : {}),
        },
        pageOf(call.query),
      ),
    )
  },
  listServers: async (app, call) =>
    value(await app.registry.servers(caller(call), pageOf(call.query))),
  getServer: async (app, call) =>
    value(
      await app.registry.server(caller(call), ServerIdSchema.parse(field(call.params, 'serverId'))),
    ),
  listClusters: async (app, call) =>
    value(await app.registry.clusters(caller(call), pageOf(call.query))),
  getCluster: async (app, call) => value(await app.registry.cluster(caller(call), clusterId(call))),
  getClusterBootstrapSql: async (app, call) => {
    const q = ClusterBootstrapSqlQuerySchema.parse(call.query ?? {})
    return value(
      await app.registry.bootstrapSql(caller(call), clusterId(call), {
        ...(q.database === undefined ? {} : { databases: q.database }),
        ...(q.project === undefined ? {} : { projectId: q.project }),
        ...(q.environment === undefined ? {} : { environmentId: q.environment }),
        ...(q.ledgers === undefined ? {} : { ledgers: q.ledgers }),
      }),
    )
  },
  listClusterEndpoints: async (app, call) => {
    const state = field(call.query, 'state')
    return value(
      await app.registry.endpoints(
        caller(call),
        clusterId(call),
        state === 'active' || state === 'retired' ? state : undefined,
      ),
    )
  },
  listClusterDatabases: async (app, call) =>
    value(await app.registry.databases(caller(call), clusterId(call))),
  listClusterCredentials: async (app, call) =>
    value(await app.registry.credentials(caller(call), clusterId(call))),

  // ----- /api/v1: registry plans and the write-only credential (Wave 4) -----
  planProduct: async (app, call) =>
    value(
      await app.registry.planProduct(
        caller(call),
        ProductCreateRequestSchema.parse(call.body),
        idempotency(call),
      ),
    ),
  planEnvironment: async (app, call) =>
    value(
      await app.registry.planEnvironment(
        caller(call),
        ProductIdSchema.parse(field(call.params, 'productId')),
        EnvironmentCreateRequestSchema.parse(call.body),
        idempotency(call),
      ),
    ),
  planEnvironmentChange: async (app, call) =>
    value(
      await app.registry.planEnvironmentChange(
        caller(call),
        ProductIdSchema.parse(field(call.params, 'productId')),
        EnvironmentIdSchema.parse(field(call.params, 'environmentId')),
        EnvironmentChangeRequestSchema.parse(call.body),
        idempotency(call),
      ),
    ),
  planProject: async (app, call) =>
    value(
      await app.registry.planProject(
        caller(call),
        ProjectCreateRequestSchema.parse(call.body),
        idempotency(call),
      ),
    ),
  planProjectChange: async (app, call) =>
    value(
      await app.registry.planProjectChange(
        caller(call),
        ProjectIdSchema.parse(field(call.params, 'projectId')),
        ProjectChangeRequestSchema.parse(call.body),
        idempotency(call),
      ),
    ),
  getProjectExecutionRoles: async (app, call) =>
    value(
      await app.registry.projectExecutionRoles(
        caller(call),
        ProjectIdSchema.parse(field(call.params, 'projectId')),
      ),
    ),
  planExecutionRoleBindings: async (app, call) =>
    value(
      await app.registry.planExecutionRoleBindings(
        caller(call),
        ProjectIdSchema.parse(field(call.params, 'projectId')),
        EnvironmentIdSchema.parse(field(call.params, 'environmentId')),
        ExecutionRoleBindingsRequestSchema.parse(call.body),
        idempotency(call),
      ),
    ),
  planExecutionRoleException: async (app, call) =>
    value(
      await app.registry.planExecutionRoleException(
        caller(call),
        ProjectIdSchema.parse(field(call.params, 'projectId')),
        EnvironmentIdSchema.parse(field(call.params, 'environmentId')),
        ExecutionRoleExceptionDeclareRequestSchema.parse(call.body),
        idempotency(call),
      ),
    ),
  planExecutionRoleExceptionRevocation: async (app, call) =>
    value(
      await app.registry.planExecutionRoleExceptionRevocation(
        caller(call),
        ProjectIdSchema.parse(field(call.params, 'projectId')),
        ExecutionRoleExceptionIdSchema.parse(field(call.params, 'exceptionId')),
        ExecutionRoleExceptionRevokeRequestSchema.parse(call.body),
        idempotency(call),
      ),
    ),
  planServer: async (app, call) =>
    value(
      await app.registry.planServer(
        caller(call),
        ServerCreateRequestSchema.parse(call.body),
        idempotency(call),
      ),
    ),
  planClusterRegistration: async (app, call) =>
    value(
      await app.registry.planClusterRegistration(
        caller(call),
        ClusterRegisterRequestSchema.parse(call.body),
        idempotency(call),
      ),
    ),
  planClusterConfirmation: async (app, call) =>
    value(
      await app.registry.planClusterConfirmation(
        caller(call),
        clusterId(call),
        ClusterConfirmRequestSchema.parse(call.body),
        idempotency(call),
      ),
    ),
  planClusterDeclaredTier: async (app, call) =>
    value(
      await app.registry.planClusterDeclaredTier(
        caller(call),
        clusterId(call),
        ClusterDeclaredTierRequestSchema.parse(call.body),
        idempotency(call),
      ),
    ),
  planEndpoint: async (app, call) =>
    value(
      await app.registry.planEndpoint(
        caller(call),
        clusterId(call),
        EndpointRequestSchema.parse(call.body),
        idempotency(call),
      ),
    ),
  planDatabaseRetirement: async (app, call) =>
    value(
      await app.registry.planDatabaseRetirement(
        caller(call),
        clusterId(call),
        DatabaseIdSchema.parse(field(call.params, 'databaseId')),
        idempotency(call),
      ),
    ),
  planEndpointRetirement: async (app, call) =>
    value(
      await app.registry.planEndpointRetirement(
        caller(call),
        clusterId(call),
        EndpointIdSchema.parse(field(call.params, 'endpointId')),
        idempotency(call),
      ),
    ),
  planDatabaseRegistration: async (app, call) =>
    value(
      await app.registry.planDatabaseRegistration(
        caller(call),
        clusterId(call),
        DatabaseRegisterRequestSchema.parse(call.body),
        idempotency(call),
      ),
    ),
  planTargetRegistration: async (app, call) =>
    value(
      await app.registry.planTargetRegistration(
        caller(call),
        TargetRegisterRequestSchema.parse(call.body),
        idempotency(call),
      ),
    ),
  planTargetSuspension: async (app, call) =>
    value(
      await app.registry.planTargetStateChange(
        caller(call),
        'target.suspend',
        target(call),
        TargetStateChangeRequestSchema.parse(call.body),
        idempotency(call),
      ),
    ),
  planTargetResumption: async (app, call) =>
    value(
      await app.registry.planTargetStateChange(
        caller(call),
        'target.resume',
        target(call),
        TargetStateChangeRequestSchema.parse(call.body),
        idempotency(call),
      ),
    ),
  planTargetDecommission: async (app, call) =>
    value(
      await app.registry.planTargetStateChange(
        caller(call),
        'target.decommission',
        target(call),
        TargetStateChangeRequestSchema.parse(call.body),
        idempotency(call),
      ),
    ),
  planDriftAcceptance: async (app, call) =>
    value(
      await app.registry.planDriftAccept(
        caller(call),
        FindingIdSchema.parse(field(call.params, 'finding')),
        DriftAcceptRequestSchema.parse(call.body ?? {}),
        idempotency(call),
      ),
    ),
  submitClusterCredential: async (app, call) =>
    value(
      await app.registry.submitCredential(
        call.meta.requestId,
        caller(call),
        clusterId(call),
        AccessRoleSchema.parse(field(call.params, 'role')),
        CredentialSubmissionSchema.parse(call.body).password,
      ),
    ),

  // ----- /api/v1: migrations (Wave 6, planning-and-apply.md §1) -----
  ingestBundles: async (app, call) =>
    value(
      await app.migrations.ingest(
        caller(call),
        ProjectIdSchema.parse(field(call.params, 'projectId')),
        BundleIngestRequestSchema.parse(call.body),
      ),
    ),
  lintMigrations: async (app, call) =>
    value(
      await app.migrations.lint(
        caller(call),
        ProjectIdSchema.parse(field(call.params, 'projectId')),
        MigrationLintRequestSchema.parse(call.body),
      ),
    ),
  getBundle: async (app, call) =>
    value(
      await app.migrations.bundle(
        caller(call),
        ProjectIdSchema.parse(field(call.params, 'projectId')),
        MigrationIdSchema.parse(field(call.params, 'migrationId')),
      ),
    ),
  getBundleFile: async (app, call) =>
    value(
      await app.migrations.bundleFile(
        caller(call),
        ProjectIdSchema.parse(field(call.params, 'projectId')),
        MigrationIdSchema.parse(field(call.params, 'migrationId')),
        revisionOf(field(call.params, 'revision')),
        bundleFileOf(field(call.params, 'file')),
      ),
    ),
  getTargetMigrations: async (app, call) =>
    value(await app.migrations.status(caller(call), target(call))),
  getTargetMigration: async (app, call) =>
    value(
      await app.migrations.detail(
        caller(call),
        target(call),
        MigrationIdSchema.parse(field(call.params, 'migrationId')),
      ),
    ),
  verifyMigration: async (app, call) =>
    value(
      await app.migrations.verify(
        caller(call),
        target(call),
        MigrationIdSchema.parse(field(call.params, 'migrationId')),
        MigrationVerifyRequestSchema.parse(call.body ?? {}),
        idempotency(call),
      ),
    ),
  planMigrationRollback: async (app, call) => {
    MigrationRollbackRequestSchema.parse(call.body ?? {})
    return value(
      await app.migrations.planRollback(
        caller(call),
        target(call),
        MigrationIdSchema.parse(field(call.params, 'migrationId')),
        idempotency(call),
      ),
    )
  },
  activateBreakGlass: async (app, call) =>
    value(
      await app.breakGlass.activate(
        caller(call),
        target(call),
        BreakGlassActivateRequestSchema.parse(call.body),
      ),
    ),
  // Wave 8 (order §9): the grants and their post-incident review; nothing here activates one.
  listBreakGlassGrants: async (app, call) => {
    const query = BreakGlassGrantListQuerySchema.parse(call.query)
    return value(
      await app.breakGlass.list(caller(call), {
        state: query.state,
        review: query.review,
        target: query.target,
        ...pageOf(call.query),
      }),
    )
  },
  reviewBreakGlassGrant: async (app, call) =>
    value(
      await app.breakGlass.review(
        caller(call),
        BreakGlassGrantIdSchema.parse(field(call.params, 'grant')),
        BreakGlassReviewRequestSchema.parse(call.body),
      ),
    ),
  planImportAnalysis: async (app, call) =>
    value(
      await app.migrations.planImportAnalysis(
        caller(call),
        target(call),
        ImportAnalysisRequestSchema.parse(call.body),
        idempotency(call),
      ),
    ),
  checkScratchTarget: async (app, call) =>
    value(
      await app.migrations.scratchCheck(
        caller(call),
        target(call),
        String(field(call.query, 'scratchTarget')),
      ),
    ),
  getImportReport: async (app, call) =>
    value(
      await app.migrations.importReport(
        caller(call),
        target(call),
        ImportReportIdSchema.parse(field(call.params, 'importReportId')),
      ),
    ),
  decideImportItem: async (app, call) =>
    value(
      await app.migrations.decideImportItem(
        caller(call),
        target(call),
        ImportReportIdSchema.parse(field(call.params, 'importReportId')),
        Number.parseInt(String(field(call.params, 'itemId')), 10),
        ImportDecisionRequestSchema.parse(call.body),
      ),
    ),
  planBaseline: async (app, call) =>
    value(
      await app.migrations.planBaseline(
        caller(call),
        target(call),
        BaselinePlanRequestSchema.parse(call.body),
        idempotency(call),
      ),
    ),
  planMigrationResume: async (app, call) =>
    value(
      await app.migrations.planResume(
        caller(call),
        target(call),
        MigrationIdSchema.parse(field(call.params, 'migrationId')),
        MigrationResumeRequestSchema.parse(call.body ?? {}),
        idempotency(call),
      ),
    ),
  planMigrations: async (app, call) =>
    value(
      await app.migrations.plan(
        caller(call),
        target(call),
        MigrationPlanRequestSchema.parse(call.body),
        idempotency(call),
      ),
    ),

  // ----- /api/v1: nodes (Wave 5, control-plane.md §7) -----
  listNodes: async (app, call) => value(await app.nodes.nodes(caller(call), pageOf(call.query))),
  getNode: async (app, call) =>
    value(await app.nodes.node(caller(call), NodeIdSchema.parse(field(call.params, 'nodeId')))),
  planNodeEnrollment: async (app, call) =>
    value(
      await app.nodes.planEnrollment(
        caller(call),
        ServerIdSchema.parse(field(call.params, 'serverId')),
        idempotency(call),
      ),
    ),
  revealEnrollmentToken: async (app, call) =>
    value(
      await app.nodes.revealToken(
        call.meta.requestId,
        caller(call),
        EnrollmentTokenIdSchema.parse(field(call.params, 'tokenId')),
      ),
    ),
  planNodeRevocation: async (app, call) =>
    value(
      await app.nodes.planRevocation(
        caller(call),
        NodeIdSchema.parse(field(call.params, 'nodeId')),
        idempotency(call),
      ),
    ),
  planNodeConfigUpdate: async (app, call) =>
    value(
      await app.nodes.planConfigUpdate(
        caller(call),
        NodeIdSchema.parse(field(call.params, 'nodeId')),
        NodeConfigUpdateRequestSchema.parse(call.body),
        idempotency(call),
      ),
    ),
  planNodeDecommissioning: async (app, call) =>
    value(
      await app.nodes.planDecommissioning(
        caller(call),
        NodeIdSchema.parse(field(call.params, 'nodeId')),
        idempotency(call),
      ),
    ),
  inspectNode: async (app, call) =>
    value(
      await app.nodes.inspect(
        caller(call),
        NodeIdSchema.parse(field(call.params, 'nodeId')),
        NodeInspectionRequestSchema.parse(call.body),
        idempotency(call),
      ),
    ),
  listNodeObservations: async (app, call) => {
    const query = NodeObservationQuerySchema.parse(call.query)
    return value(
      await app.nodes.observations(caller(call), NodeIdSchema.parse(field(call.params, 'nodeId')), {
        ...(query.capability === undefined ? {} : { capability: query.capability }),
        ...(query.clusterId === undefined ? {} : { clusterId: query.clusterId }),
      }),
    )
  },
  planNodeOperation: async (app, call) =>
    value(
      await app.nodes.planOperation(
        caller(call),
        NodeIdSchema.parse(field(call.params, 'nodeId')),
        NodePlanRequestSchema.parse(call.body),
        idempotency(call),
      ),
    ),
  planCredentialRotation: async (app, call) =>
    value(
      await app.nodes.planCredentialRotation(
        caller(call),
        clusterId(call),
        AccessRoleSchema.parse(field(call.params, 'role')),
        idempotency(call),
      ),
    ),
  // Write-only (owner decision S3): no idempotency key, whose request hash would cover the verifier.
  submitRoleVerifier: async (app, call) =>
    value(
      await app.nodes.submitRoleVerifier(
        call.meta.requestId,
        caller(call),
        clusterId(call),
        RoleVerifierSubmissionSchema.parse(call.body),
      ),
    ),

  // ----- /api/v1: schema, drift, sessions (Wave 4) -----
  getSchemaOverview: async (app, call) =>
    value(await app.registry.schemaOverview(caller(call), target(call))),
  getSchemaObject: async (app, call) =>
    value(
      await app.registry.schemaObject(
        caller(call),
        target(call),
        SchemaObjectKindSchema.parse(field(call.params, 'kind')),
        String(field(call.params, 'qualifiedName')),
      ),
    ),
  searchSchema: async (app, call) => {
    const kinds = field(call.query, 'kinds')
    return value(
      await app.registry.searchSchema(
        caller(call),
        target(call),
        {
          q: String(field(call.query, 'q')),
          kinds: Array.isArray(kinds)
            ? kinds.map((k) => SchemaObjectKindSchema.parse(k))
            : undefined,
        },
        pageOf(call.query),
      ),
    )
  },
  // Wave 8 completion: the objects of the snapshot without a search term (REST only).
  listSchemaObjects: async (app, call) => {
    const kinds = field(call.query, 'kinds')
    const limit = field(call.query, 'limit')
    const cursor = optionalText(call.query, 'cursor')
    return value(
      await app.registry.listSchemaObjects(
        caller(call),
        target(call),
        {
          kinds: Array.isArray(kinds)
            ? kinds.map((k) => SchemaObjectKindSchema.parse(k))
            : undefined,
          schema: optionalText(call.query, 'schema'),
          parent: optionalText(call.query, 'parent'),
          q: optionalText(call.query, 'q'),
        },
        {
          limit: typeof limit === 'number' ? limit : 100,
          ...(cursor === undefined ? {} : { cursor }),
        },
      ),
    )
  },
  getSchemaFingerprint: async (app, call) =>
    value(await app.registry.schemaFingerprint(caller(call), target(call))),
  createSchemaDiff: async (app, call) =>
    value(await app.registry.schemaDiff(caller(call), SchemaDiffRequestSchema.parse(call.body))),
  runDriftCheck: async (app, call) =>
    value(await app.registry.runDriftCheck(caller(call), target(call))),
  // Wave 8 completion: the past drift checks of a target (REST only).
  listDriftChecks: async (app, call) =>
    value(await app.registry.driftChecks(caller(call), target(call), pageOf(call.query))),
  // ----- data reads (Wave 7, ADR-0028): the same use cases as sql_query, sql_explain, sql_cancel -----
  runQuery: async (app, call) =>
    value(
      await app.queries.run(caller(call), target(call), call.body as QueryRequest, {
        requestId: call.meta.requestId,
        // A closed connection cancels the read on the worker.
        signal: call.c.req.raw.signal,
      }),
    ),
  explainQuery: async (app, call) =>
    value(
      await app.queries.explain(caller(call), target(call), call.body as ExplainRequest, {
        requestId: call.meta.requestId,
        signal: call.c.req.raw.signal,
      }),
    ),
  cancelQuery: async (app, call) =>
    value(
      await app.queries.cancel(caller(call), target(call), String(field(call.params, 'queryId'))),
    ),
  // ----- Wave 8 (order §9, endpoints 6 and 7): own query history, saved queries -----
  listQueryHistory: async (app, call) =>
    value(await app.queries.history(caller(call), target(call), pageOf(call.query))),
  listSavedQueries: async (app, call) => {
    const scope = optional(call.query, 'target', (v) => TargetRefSchema.parse(v))
    return value(
      await app.savedQueries.list(caller(call), {
        ...pageOf(call.query),
        ...(scope === undefined ? {} : { target: scope }),
      }),
    )
  },
  createSavedQuery: async (app, call) =>
    value(
      await app.savedQueries.create(caller(call), call.body as SavedQueryCreateRequest, {
        requestId: call.meta.requestId,
      }),
    ),
  getSavedQuery: async (app, call) =>
    value(await app.savedQueries.get(caller(call), savedQueryId(call))),
  updateSavedQuery: async (app, call) =>
    value(
      await app.savedQueries.update(
        caller(call),
        savedQueryId(call),
        call.body as SavedQueryUpdateRequest,
        { requestId: call.meta.requestId },
      ),
    ),
  deleteSavedQuery: async (app, call) =>
    value(
      await app.savedQueries.remove(caller(call), savedQueryId(call), {
        requestId: call.meta.requestId,
      }),
    ),
  listSessions: async (app, call) => {
    const minAge = field(call.query, 'minAgeSeconds')
    const limit = field(call.query, 'limit')
    return value(
      await app.registry.sessions(caller(call), target(call), {
        state: optionalText(call.query, 'state'),
        minAgeSeconds: typeof minAge === 'number' ? minAge : undefined,
        application: optionalText(call.query, 'application'),
        limit: typeof limit === 'number' ? limit : undefined,
      }),
    )
  },
  getLockGraph: async (app, call) => value(await app.registry.locks(caller(call), target(call))),
  getRawStatement: async (app, call) => {
    const pid = field(call.query, 'pid')
    return value(
      await app.rawStatements.view(
        caller(call),
        TargetRefSchema.parse(field(call.query, 'target')),
        {
          digest: Sha256DigestSchema.parse(field(call.params, 'digest')),
          pid: typeof pid === 'number' ? pid : undefined,
          backendStart: optionalText(call.query, 'backendStart'),
        },
        { requestId: call.meta.requestId },
      ),
    )
  },

  disableOAuthClient: async (app, call) =>
    value(
      await app.disableOAuthClient(
        call.meta,
        caller(call),
        OAuthClientIdSchema.parse(field(call.params, 'oauthClientId')),
        ClientDecisionReasonSchema.parse(call.body).reason,
      ),
    ),
}

/** The routes this release serves: every contract route that has a handler (the `/auth` ceremonies and the Wave 3A resources). */
export function servedRoutes(): readonly {
  readonly base: string
  readonly route: RouteContract
}[] {
  return [
    ...AUTH_ROUTES.map((route) => ({ base: AUTH_BASE_PATH, route })),
    ...ROUTE_LIST.map((route) => ({ base: REST_API_BASE_PATH, route })),
  ].filter(({ route }) => Object.hasOwn(HANDLERS, route.operationId))
}

function honoPath(path: string): string {
  return path.replace(/\{([A-Za-z]+)\}/g, ':$1')
}

function issues(
  list: readonly {
    readonly path: readonly PropertyKey[]
    readonly code: string
    readonly message: string
  }[],
): { path: string; code: string; message: string }[] {
  return list.slice(0, 100).map((issue) => ({
    path: `/${issue.path.map(String).join('/')}`,
    code: issue.code.replace(/[^a-z0-9_]/g, '_').slice(0, 64) || 'invalid',
    message: issue.message.slice(0, 512),
  }))
}

function applyCookies(headers: Headers, cookies: Outcome<unknown>['cookies']): void {
  if (cookies.session === 'clear') {
    headers.append('set-cookie', clearCookie(SESSION_COOKIE, true))
    headers.append('set-cookie', clearCookie(CSRF_COOKIE, false))
  } else if (cookies.session !== undefined) {
    headers.append(
      'set-cookie',
      setCookie(SESSION_COOKIE, cookies.session.token, {
        maxAgeSeconds: SESSION_ABSOLUTE_SECONDS,
        httpOnly: true,
      }),
    )
    headers.append(
      'set-cookie',
      setCookie(CSRF_COOKIE, cookies.session.csrfToken, {
        maxAgeSeconds: SESSION_ABSOLUTE_SECONDS,
        httpOnly: false,
      }),
    )
  }
  if (cookies.ceremony === 'clear') {
    headers.append('set-cookie', clearCookie(CEREMONY_COOKIE, true))
  } else if (cookies.ceremony !== undefined) {
    headers.append(
      'set-cookie',
      setCookie(CEREMONY_COOKIE, cookies.ceremony.handle, {
        maxAgeSeconds: cookies.ceremony.maxAgeSeconds,
        httpOnly: true,
      }),
    )
  }
}

/**
 * The raw body of a `rawBody` route: the declared media type must be one the
 * route names (its essence, without parameters), the bytes at most the
 * route's limit. What the bytes are is the use case's check.
 */
async function readRawBody(
  c: Context<Env>,
  route: RouteContract & { readonly rawBody: { readonly mediaTypes: readonly string[] } },
): Promise<{ bytes: Uint8Array; mediaType: string }> {
  const mediaType = (c.req.header('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
  if (!route.rawBody.mediaTypes.includes(mediaType)) {
    throw new HttpRefusal('VALIDATION_FAILED', {
      errors: [
        {
          path: '/headers/content-type',
          code: 'invalid',
          message: `One of ${route.rawBody.mediaTypes.join(', ')}.`,
        },
      ],
    })
  }
  const bytes = await readLimitedBytes(c.req.raw, route.maxBodyBytes ?? DEFAULT_BODY_LIMIT_BYTES)
  if (bytes === undefined) {
    throw new HttpRefusal('VALIDATION_FAILED', {
      errors: [
        {
          path: '/body',
          code: 'too_large',
          message: `At most ${route.maxBodyBytes ?? DEFAULT_BODY_LIMIT_BYTES} bytes.`,
        },
      ],
    })
  }
  return { bytes, mediaType }
}

async function readBody(c: Context<Env>, route: RouteContract): Promise<unknown> {
  if (route.body === undefined) {
    return undefined
  }
  const type = c.req.header('content-type') ?? ''
  if (!type.toLowerCase().startsWith('application/json')) {
    throw new HttpRefusal('VALIDATION_FAILED')
  }
  // Counted as it arrives: a chunked or mislabeled body never grows past the limit.
  const raw = await readLimitedText(c.req.raw, route.maxBodyBytes ?? DEFAULT_BODY_LIMIT_BYTES)
  if (raw === undefined) {
    throw new HttpRefusal('VALIDATION_FAILED')
  }
  let parsed: unknown
  try {
    parsed = raw.length === 0 ? {} : JSON.parse(raw)
  } catch {
    throw new HttpRefusal('VALIDATION_FAILED')
  }
  return parsed
}

/** The browser-binding cookie of an OAuth authorization request (HttpOnly, `__Host-`). */
export const OAUTH_BINDING_COOKIE = '__Host-exdb_oauth'

export function mountApi(app: Hono<Env>, deps: ApiDeps): void {
  const challenge = (
    response: Response,
    error?: 'invalid_token' | 'insufficient_scope',
    scope?: Scope,
  ): Response => {
    response.headers.set(
      'www-authenticate',
      oauth.bearerChallenge(
        deps.publicOrigin,
        'api',
        error === undefined
          ? undefined
          : { code: error, ...(scope === undefined ? {} : { scope }) },
      ),
    )
    return response
  }
  for (const { base, route } of servedRoutes()) {
    const handler = HANDLERS[route.operationId]
    if (handler === undefined) {
      continue
    }
    const definition = actionDefinition(route.action)
    const publicCeremony = definition.permission.kind === 'public'
    const mutating = route.method !== 'get'
    const path = `${base}${honoPath(route.path)}`
    const serveRoute = async (c: Context<Env>): Promise<Response> => {
      const requestId = c.get('requestId')
      const fail = (error: unknown, retryAfterSeconds?: number) => {
        const planId = c.req.param('planId')
        return problemResponse(requestId, error, {
          ...(planId === undefined ? {} : { planId }),
          ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
        })
      }
      try {
        if (!deps.available()) {
          return fail(new HttpRefusal('CONTROL_PLANE_DEGRADED'))
        }
        const cookies = parseCookies(c.req.header('cookie'))
        const sessionCookie = cookies.get(SESSION_COOKIE)
        const authorization = authorizationHeaders(c)
        let bearer: Caller | undefined
        if (authorization.length > 0) {
          if (sessionCookie !== undefined) {
            return fail(new HttpRefusal('AMBIGUOUS_CREDENTIALS'))
          }
          // The Web App ceremonies take the session cookie only.
          if (base === AUTH_BASE_PATH || publicCeremony) {
            return fail(new HttpRefusal('UNAUTHENTICATED'))
          }
          const authenticated = await authenticateBearer(deps.application, authorization, 'api')
          if (authenticated.kind !== 'ok') {
            return challenge(fail(new HttpRefusal('UNAUTHENTICATED')), 'invalid_token')
          }
          bearer = {
            kind: 'bearer',
            principal: authenticated.principal,
            resource: 'api',
            requestId,
          }
          // The grant's last use (data basis only, decision 10): in the background.
          deps.application.noteGrantUse(bearer, 'rest')
        }
        // A step-up receipt (ADR-0026) is named by a bearer request only; its bound use case redeems it.
        const stepUpHeader = c.req.header(STEP_UP_HEADER)
        if (stepUpHeader !== undefined) {
          const id = StepUpIdSchema.safeParse(stepUpHeader)
          if (bearer === undefined || bearer.kind !== 'bearer' || !id.success) {
            return fail(
              new HttpRefusal('VALIDATION_FAILED', {
                errors: [
                  {
                    path: `/headers/${STEP_UP_HEADER}`,
                    code: 'invalid',
                    message: 'A step-up id goes with a bearer request only.',
                  },
                ],
              }),
            )
          }
          bearer = { ...bearer, stepUpId: id.data }
        }
        if (mutating && bearer === undefined) {
          const origin = c.req.header('origin')
          const site = c.req.header('sec-fetch-site')
          if (origin !== deps.publicOrigin || (site !== undefined && site !== 'same-origin')) {
            return fail(new HttpRefusal('CSRF_FAILED'))
          }
        }
        let rawBody: unknown
        let raw: { bytes: Uint8Array; mediaType: string } | undefined
        try {
          rawBody = await readBody(c, route)
          if (route.rawBody !== undefined) {
            raw = await readRawBody(c, { ...route, rawBody: route.rawBody })
          }
        } catch (error) {
          return fail(error)
        }
        const paramsCheck = route.pathParams.safeParse(c.req.param())
        const queryCheck =
          route.query === undefined
            ? undefined
            : route.query.safeParse(decodeQuery(route.query, c.req.queries()))
        const bodyCheck = route.body === undefined ? undefined : route.body.safeParse(rawBody)
        for (const check of [paramsCheck, queryCheck, bodyCheck]) {
          if (check !== undefined && !check.success) {
            return problemResponse(
              requestId,
              new HttpRefusal('VALIDATION_FAILED', { errors: issues(check.error.issues) }),
            )
          }
        }
        const userAgent = c.req.header('user-agent')
        let current: SessionContext | undefined
        if (!publicCeremony && bearer === undefined) {
          current = await deps.application.authenticate(sessionCookie, userAgent)
          if (current === undefined) {
            const refused = fail(
              new HttpRefusal(sessionCookie === undefined ? 'UNAUTHENTICATED' : 'SESSION_EXPIRED'),
            )
            return base === REST_API_BASE_PATH ? challenge(refused) : refused
          }
          if (
            mutating &&
            !verifyCsrf(current, c.req.header(CSRF_HEADER), cookies.get(CSRF_COOKIE))
          ) {
            return fail(new HttpRefusal('CSRF_FAILED'))
          }
        }
        const peer = c.env?.incoming?.socket.remoteAddress
        const call: Call = {
          c,
          meta: {
            requestId,
            clientIp: clientAddress(peer, c.req.header('x-forwarded-for'), deps.trustedProxies),
            userAgent,
          },
          body: bodyCheck?.success === true ? bodyCheck.data : undefined,
          ...(raw === undefined ? {} : { raw }),
          params: paramsCheck.success ? paramsCheck.data : {},
          query: queryCheck?.success === true ? queryCheck.data : {},
          session: current,
          caller: bearer ?? (current === undefined ? undefined : sessionCaller(current, requestId)),
          ceremony: cookies.get(CEREMONY_COOKIE),
          oauthBinding: cookies.get(OAUTH_BINDING_COOKIE),
        }
        const result = await handler(deps.application, call)
        if (result.kind === 'bytes') {
          if (
            route.rawResponse === undefined ||
            !route.rawResponse.mediaTypes.includes(result.mediaType)
          ) {
            deps.logger.error('http.response_contract_violation', { route: route.operationId })
            return fail(new HttpRefusal('INTERNAL'))
          }
          const headers = new Headers({ ...result.headers, 'content-type': result.mediaType })
          if (result.etag !== undefined) {
            headers.set('etag', result.etag)
            if (matchesEtag(c.req.header('if-none-match'), result.etag)) {
              headers.delete('content-type')
              return new Response(null, { status: 304, headers })
            }
          }
          return new Response(result.body, { status: route.response.status, headers })
        }
        if (result.kind === 'text') {
          if (route.mediaType === undefined) {
            deps.logger.error('http.response_contract_violation', { route: route.operationId })
            return fail(new HttpRefusal('INTERNAL'))
          }
          // The use case validated the lines it wrote against the contract; a download is never cached.
          return new Response(result.body, {
            status: route.response.status,
            headers: new Headers({
              'content-type': route.mediaType,
              'cache-control': 'no-store',
              'x-content-type-options': 'nosniff',
              'content-disposition': 'attachment; filename="exponetdb-audit-export.ndjson"',
            }),
          })
        }
        const headers = new Headers({ 'content-type': 'application/json' })
        let payload: unknown
        if (result.kind === 'outcome') {
          applyCookies(headers, result.outcome.cookies)
          if (!result.outcome.ok) {
            const problem = fail(result.outcome.error, result.outcome.retryAfterSeconds)
            headers.forEach((v, k) => {
              if (k === 'set-cookie') problem.headers.append(k, v)
            })
            return problem
          }
          payload = result.outcome.value
        } else {
          payload = result.value
        }
        const checked = route.response.schema.safeParse(payload)
        if (!checked.success) {
          deps.logger.error('http.response_contract_violation', { route: route.operationId })
          return fail(new HttpRefusal('INTERNAL'))
        }
        return new Response(JSON.stringify(checked.data), {
          status: route.response.status,
          headers,
        })
      } catch (error) {
        const known = error instanceof Error && 'code' in error && typeof error.code === 'string'
        if (!known || error.code === 'INTERNAL') {
          deps.logger.error('http.request_failed', {
            ...describeError(error),
            route: route.operationId,
          })
        }
        // A target outside a restricted delegation answers like an unknown one; why is
        // kept here (request id and reason, never the path), not in the answer.
        if (error instanceof AuthError && error.concealed !== undefined) {
          deps.logger.info('authz.denial_concealed', {
            // The route template, never the requested path.
            route: route.path,
            requestId,
            reason: error.concealed,
          })
        }
        // Step-up (RFC 6750 §3.1): a bearer caller learns the scope the action needs.
        if (
          error instanceof AuthError &&
          error.code === 'INSUFFICIENT_SCOPE' &&
          c.req.header('authorization') !== undefined
        ) {
          const required = error.details?.['requiredScope']
          return challenge(
            fail(error),
            'insufficient_scope',
            typeof required === 'string' && isScope(required) ? required : undefined,
          )
        }
        // A bound of the data-read lane names when to try again.
        const retryAfter =
          error instanceof Error &&
          'retryAfterSeconds' in error &&
          typeof error.retryAfterSeconds === 'number'
            ? error.retryAfterSeconds
            : undefined
        return fail(error, retryAfter)
      }
    }
    app.on(route.method.toUpperCase(), path, async (c) => {
      const started = performance.now()
      const response = await serveRoute(c)
      // One time class for "not there", concealed or real (existence.ts).
      if (response.status === 404) await existenceFloor(started)
      return response
    })
  }
}
