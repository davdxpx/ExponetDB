import { type Application, idempotencyRequestHash, isIdempotencyKey } from '@exponetdb/application'
import {
  CEREMONY_COOKIE,
  CSRF_COOKIE,
  CSRF_HEADER,
  type Outcome,
  SESSION_ABSOLUTE_SECONDS,
  SESSION_COOKIE,
  type SessionContext,
  verifyCsrf,
} from '@exponetdb/auth'
import {
  ApprovalDecisionRequestSchema,
  AUTH_BASE_PATH,
  AUTH_ROUTES,
  AuthenticationCredentialSchema,
  AuthFactorIdSchema,
  actionDefinition,
  DisableIdentityRequestSchema,
  EmailSchema,
  IdentityIdSchema,
  IdentityStateSchema,
  InviteIdentityRequestSchema,
  LinkTokenSchema,
  OperationIdSchema,
  PasswordInputSchema,
  PlanIdSchema,
  PolicySettingsPlanRequestSchema,
  REST_API_BASE_PATH,
  RecoveryCodeInputSchema,
  RegistrationCredentialSchema,
  ROUTE_LIST,
  RoleBindingIdSchema,
  RoleBindingPlanRequestSchema,
  RoleIdSchema,
  type RouteContract,
  SessionIdSchema,
  TotpCodeSchema,
} from '@exponetdb/contracts'
import { isJsonObject, type RequestId, toJsonValue } from '@exponetdb/kernel'
import { describeError, type Logger } from '@exponetdb/observability'
import type { Context, Hono } from 'hono'
import type { HttpEnv } from './env.ts'
import {
  clearCookie,
  clientAddress,
  HttpRefusal,
  parseCookies,
  problemResponse,
  setCookie,
} from './request.ts'

/**
 * The authenticated HTTP interfaces of Wave 3A: the Web App ceremonies under
 * `/auth` and the access resources under `/api/v1`. Every route comes from
 * the contracts (path, method, action, body, response); every handler calls
 * `@exponetdb/application` and nothing else (C-9).
 *
 * Per request, before any handler:
 * - credential mode: a bearer token together with the session cookie is
 *   `AMBIGUOUS_CREDENTIALS`; a bearer token alone is `UNAUTHENTICATED`
 *   (tokens arrive with Wave 3B);
 * - state-changing methods need `Origin` equal to the configured public
 *   origin (and `Sec-Fetch-Site: same-origin` when the browser sends it);
 * - session-bound state changes need the CSRF header, equal to the CSRF
 *   cookie and to the session's stored hash;
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

const MAX_BODY = 64 * 1024

interface Call {
  readonly c: Context<Env>
  readonly meta: {
    readonly requestId: RequestId
    readonly clientIp: string | undefined
    readonly userAgent: string | undefined
  }
  readonly body: unknown
  readonly params: unknown
  readonly query: unknown
  readonly session: SessionContext | undefined
  readonly ceremony: string | undefined
}

/** A plain result, or a ceremony outcome (which carries cookie instructions). */
type Result =
  | { readonly kind: 'value'; readonly value: unknown }
  | { readonly kind: 'outcome'; readonly outcome: Outcome<unknown> }

type Handler = (app: Application, call: Call) => Promise<Result>

const value = (v: unknown): Result => ({ kind: 'value', value: v })
const outcome = (o: Outcome<unknown>): Result => ({ kind: 'outcome', outcome: o })

function session(call: Call): SessionContext {
  if (call.session === undefined) {
    throw new HttpRefusal('SESSION_EXPIRED')
  }
  return call.session
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

function limitOf(query: unknown): number {
  const raw = field(query, 'limit')
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : 50
  return Number.isInteger(n) && n >= 1 && n <= 200 ? n : 50
}

/** The handlers, by contract operation id. A route without a handler is not served (test: all Wave 3A routes have one). */
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
  getMe: async (app, call) => value(await app.me(session(call))),
  listMySessions: async (app, call) => value({ items: await app.sessions(session(call)) }),
  revokeMySession: async (app, call) =>
    outcome(
      await app.revokeSession(
        call.meta,
        session(call),
        SessionIdSchema.parse(field(call.params, 'sessionId')),
      ),
    ),
  revokeMyOtherSessions: async (app, call) =>
    outcome(await app.revokeOtherSessions(call.meta, session(call))),
  listMyFactors: async (app, call) => value({ items: await app.factors(session(call)) }),

  // ----- /api/v1: identities -----
  listIdentities: async (app, call) => {
    const state = field(call.query, 'state')
    return value(
      await app.identities(session(call), {
        state: state === undefined ? undefined : IdentityStateSchema.parse(state),
        limit: limitOf(call.query),
      }),
    )
  },
  getIdentity: async (app, call) =>
    value(
      await app.identity(session(call), IdentityIdSchema.parse(field(call.params, 'identityId'))),
    ),
  inviteIdentity: async (app, call) =>
    value(await app.invite(call.meta, session(call), InviteIdentityRequestSchema.parse(call.body))),
  reissueInvitation: async (app, call) =>
    value(
      await app.reissueInvitation(
        call.meta,
        session(call),
        IdentityIdSchema.parse(field(call.params, 'identityId')),
      ),
    ),
  disableIdentity: async (app, call) =>
    value(
      await app.disable(
        call.meta,
        session(call),
        IdentityIdSchema.parse(field(call.params, 'identityId')),
        DisableIdentityRequestSchema.parse(call.body).reason,
      ),
    ),
  planIdentityEnable: async (app, call) =>
    value(
      await app.planIdentityChange(
        session(call),
        'access.identity.enable',
        IdentityIdSchema.parse(field(call.params, 'identityId')),
        idempotency(call),
      ),
    ),
  planIdentityErasure: async (app, call) =>
    value(
      await app.planIdentityChange(
        session(call),
        'access.identity.erase',
        IdentityIdSchema.parse(field(call.params, 'identityId')),
        idempotency(call),
      ),
    ),

  // ----- /api/v1: roles, bindings, policy -----
  listRoles: async (app, call) => value(await app.roles(session(call))),
  getRole: async (app, call) =>
    value(await app.role(session(call), RoleIdSchema.parse(field(call.params, 'roleId')))),
  listRoleBindings: async (app, call) => {
    const identity = field(call.query, 'identity')
    const state = field(call.query, 'state')
    return value(
      await app.roleBindings(session(call), {
        identity: identity === undefined ? undefined : IdentityIdSchema.parse(identity),
        state: state === 'active' || state === 'revoked' ? state : undefined,
        limit: limitOf(call.query),
      }),
    )
  },
  planRoleBinding: async (app, call) =>
    value(
      await app.planRoleBinding(
        session(call),
        RoleBindingPlanRequestSchema.parse(call.body),
        idempotency(call),
      ),
    ),
  planRoleBindingRemoval: async (app, call) =>
    value(
      await app.planRoleBindingRemoval(
        session(call),
        RoleBindingIdSchema.parse(field(call.params, 'bindingId')),
        idempotency(call),
      ),
    ),
  getPolicySettings: async (app, call) => value(await app.policySettings(session(call))),
  planPolicySettings: async (app, call) => {
    const body = PolicySettingsPlanRequestSchema.parse(call.body)
    const params = toJsonValue(body.params)
    if (!params.ok || !isJsonObject(params.value)) {
      throw new HttpRefusal('VALIDATION_FAILED')
    }
    return value(
      await app.planPolicySettings(
        session(call),
        { ...body, params: params.value },
        idempotency(call),
      ),
    )
  },

  // ----- /api/v1: approvals and plans -----
  listApprovals: async (app, call) => value(await app.approvals(session(call))),
  approveOperation: async (app, call) =>
    value(
      await app.approve(
        session(call),
        OperationIdSchema.parse(field(call.params, 'operationId')),
        ApprovalDecisionRequestSchema.parse(call.body),
      ),
    ),
  rejectOperation: async (app, call) =>
    value(
      await app.reject(
        session(call),
        OperationIdSchema.parse(field(call.params, 'operationId')),
        ApprovalDecisionRequestSchema.parse(call.body),
      ),
    ),
  applyPlan: async (app, call) =>
    value(await app.apply(session(call), PlanIdSchema.parse(field(call.params, 'planId')))),
  withdrawPlan: async (app, call) =>
    value(await app.withdraw(session(call), PlanIdSchema.parse(field(call.params, 'planId')))),
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

async function readBody(c: Context<Env>, route: RouteContract): Promise<unknown> {
  if (route.body === undefined) {
    return undefined
  }
  const length = Number(c.req.header('content-length') ?? '0')
  const type = c.req.header('content-type') ?? ''
  if (!type.toLowerCase().startsWith('application/json') || length > MAX_BODY) {
    throw new HttpRefusal('VALIDATION_FAILED')
  }
  const raw = await c.req.text()
  if (raw.length > MAX_BODY) {
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

export function mountApi(app: Hono<Env>, deps: ApiDeps): void {
  for (const { base, route } of servedRoutes()) {
    const handler = HANDLERS[route.operationId]
    if (handler === undefined) {
      continue
    }
    const definition = actionDefinition(route.action)
    const publicCeremony = definition.permission.kind === 'public'
    const mutating = route.method !== 'get'
    const path = `${base}${honoPath(route.path)}`
    app.on(route.method.toUpperCase(), path, async (c) => {
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
        if (c.req.header('authorization') !== undefined) {
          return fail(
            new HttpRefusal(
              sessionCookie === undefined ? 'UNAUTHENTICATED' : 'AMBIGUOUS_CREDENTIALS',
            ),
          )
        }
        if (mutating) {
          const origin = c.req.header('origin')
          const site = c.req.header('sec-fetch-site')
          if (origin !== deps.publicOrigin || (site !== undefined && site !== 'same-origin')) {
            return fail(new HttpRefusal('CSRF_FAILED'))
          }
        }
        let rawBody: unknown
        try {
          rawBody = await readBody(c, route)
        } catch (error) {
          return fail(error)
        }
        const paramsCheck = route.pathParams.safeParse(c.req.param())
        const queryCheck =
          route.query === undefined ? undefined : route.query.safeParse(c.req.query())
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
        if (!publicCeremony) {
          current = await deps.application.authenticate(sessionCookie, userAgent)
          if (current === undefined) {
            return fail(
              new HttpRefusal(sessionCookie === undefined ? 'UNAUTHENTICATED' : 'SESSION_EXPIRED'),
            )
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
          params: paramsCheck.success ? paramsCheck.data : {},
          query: queryCheck?.success === true ? queryCheck.data : {},
          session: current,
          ceremony: cookies.get(CEREMONY_COOKIE),
        }
        const result = await handler(deps.application, call)
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
        return fail(error)
      }
    })
  }
}
