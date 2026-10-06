import type { Application } from '@exponetdb/application'
import { oauth } from '@exponetdb/auth'
import {
  AuthorizationServerMetadataSchema,
  OAUTH_LIMITS,
  type OAuthErrorResponse,
  OAuthErrorResponseSchema,
  ProtectedResourceMetadataSchema,
  TokenResponseSchema,
} from '@exponetdb/contracts'
import type { RequestId } from '@exponetdb/kernel'
import { describeError, type Logger } from '@exponetdb/observability'
import type { Context, Hono } from 'hono'
import { OAUTH_BINDING_COOKIE } from './api.ts'
import type { HttpEnv } from './env.ts'
import { clientAddress, parseCookies, readLimitedText, setCookie } from './request.ts'

/**
 * The OAuth protocol surface of the authorization server (oauth.md §2, §4,
 * §5): discovery documents, the authorization endpoint, the token and the
 * revocation endpoints. Every endpoint calls `@exponetdb/application`
 * (C-9). Their errors are the normative OAuth errors as JSON
 * (`{"error": …}`), never RFC 9457 problems; token responses carry
 * `Cache-Control: no-store`. No CORS: browsers never call these endpoints
 * from another origin.
 *
 * Not served, on purpose: `/.well-known/openid-configuration` (ExponetDB
 * issues no ID tokens, so advertising OpenID Connect would be untruthful)
 * and the root `/.well-known/oauth-protected-resource` (RFC 9728 §3.3: the
 * metadata's `resource` must equal the resource it was fetched for; each
 * resource has its own path-inserted document).
 */
export interface OAuthHttpDeps {
  readonly application: Application
  readonly publicOrigin: string
  readonly trustedProxies: readonly string[]
  readonly logger: Logger
  readonly available: () => boolean
}

type Env = HttpEnv

/** Lifetime of the browser-binding cookie: the lifetime of an authorization request. */
const BINDING_SECONDS = OAUTH_LIMITS.authorizationRequestSeconds

function oauthError(error: oauth.OAuthError): Response {
  const body: OAuthErrorResponse = {
    error: error.error,
    ...(error.description === undefined ? {} : { error_description: error.description }),
  }
  const checked = OAuthErrorResponseSchema.safeParse(body)
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    pragma: 'no-cache',
  }
  if (error.retryAfterSeconds !== undefined) {
    headers['retry-after'] = String(error.retryAfterSeconds)
  }
  return new Response(JSON.stringify(checked.success ? checked.data : { error: 'server_error' }), {
    status: checked.success ? error.status : 500,
    headers,
  })
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      pragma: 'no-cache',
    },
  })
}

function redirect(location: string, cookies: readonly string[] = []): Response {
  const headers = new Headers({ location, 'cache-control': 'no-store' })
  for (const cookie of cookies) {
    headers.append('set-cookie', cookie)
  }
  return new Response(null, { status: 302, headers })
}

function meta(c: Context<Env>, deps: OAuthHttpDeps, requestId: RequestId) {
  return {
    requestId,
    clientIp: clientAddress(
      c.env?.incoming?.socket.remoteAddress,
      c.req.header('x-forwarded-for'),
      deps.trustedProxies,
    ),
    userAgent: c.req.header('user-agent'),
  }
}

function rawAuthorizationCount(c: Context<Env>): number {
  const raw = c.env?.incoming?.rawHeaders
  if (Array.isArray(raw)) {
    let n = 0
    for (let i = 0; i < raw.length; i += 2) {
      if (raw[i]?.toLowerCase() === 'authorization') {
        n += 1
      }
    }
    return n
  }
  return c.req.header('authorization') === undefined ? 0 : 1
}

export function mountOAuth(app: Hono<Env>, deps: OAuthHttpDeps): void {
  const unavailable = () =>
    oauthError(new oauth.OAuthError('temporarily_unavailable', { status: 503 }))
  const failure = (error: unknown, route: string): Response => {
    if (error instanceof oauth.OAuthError) {
      return oauthError(error)
    }
    deps.logger.error('http.request_failed', { ...describeError(error), route })
    return oauthError(new oauth.OAuthError('server_error'))
  }

  // ----- discovery -----
  app.get(oauth.AUTHORIZATION_SERVER_METADATA_PATH, async () => {
    try {
      const document = AuthorizationServerMetadataSchema.parse(
        await deps.application.authorizationServerMetadata(),
      )
      return json(document)
    } catch (error) {
      return failure(error, oauth.AUTHORIZATION_SERVER_METADATA_PATH)
    }
  })
  for (const resource of ['api', 'mcp'] as const) {
    const path = oauth.protectedResourceMetadataPath(resource)
    app.get(path, async () => {
      try {
        return json(
          ProtectedResourceMetadataSchema.parse(
            await deps.application.protectedResourceMetadata(resource),
          ),
        )
      } catch (error) {
        return failure(error, path)
      }
    })
  }

  // ----- authorization endpoint -----
  app.get(oauth.OAUTH_PATHS.authorize, async (c) => {
    const requestId = c.get('requestId')
    const errorPage = (reason: oauth.AuthorizeLocalError) =>
      redirect(`${deps.publicOrigin}${oauth.OAUTH_PATHS.errorPage}?reason=${reason}`)
    try {
      if (!deps.available()) {
        return errorPage('unavailable')
      }
      const url = c.req.url
      const index = url.indexOf('?')
      const query = index < 0 ? '' : url.slice(index + 1)
      const binding = parseCookies(c.req.header('cookie')).get(OAUTH_BINDING_COOKIE)
      const outcome = await deps.application.authorize(meta(c, deps, requestId), query, binding)
      switch (outcome.kind) {
        case 'consent':
          // The binding is set again with a fresh lifetime, whether it is new or kept.
          return redirect(outcome.location, [
            setCookie(OAUTH_BINDING_COOKIE, outcome.binding, {
              maxAgeSeconds: BINDING_SECONDS,
              httpOnly: true,
            }),
          ])
        case 'redirect':
          return redirect(outcome.location)
        case 'error':
          return errorPage(outcome.reason)
      }
    } catch (error) {
      deps.logger.error('http.request_failed', {
        ...describeError(error),
        route: oauth.OAUTH_PATHS.authorize,
      })
      return errorPage('unavailable')
    }
  })

  // ----- token and revocation endpoints -----
  const formRequest = async (c: Context<Env>): Promise<oauth.TokenRequest> => ({
    body: await readLimitedText(c.req.raw, OAUTH_LIMITS.maxFormBytes),
    contentType: c.req.header('content-type'),
    authorizationHeader: rawAuthorizationCount(c) > 0,
  })

  app.post(oauth.OAUTH_PATHS.token, async (c) => {
    try {
      if (!deps.available()) {
        return unavailable()
      }
      const request = await formRequest(c)
      const response = await deps.application.token(meta(c, deps, c.get('requestId')), request)
      return json(TokenResponseSchema.parse(response))
    } catch (error) {
      return failure(error, oauth.OAUTH_PATHS.token)
    }
  })

  app.post(oauth.OAUTH_PATHS.revoke, async (c) => {
    try {
      if (!deps.available()) {
        return unavailable()
      }
      const request = await formRequest(c)
      await deps.application.revokeToken(meta(c, deps, c.get('requestId')), request)
      return new Response(null, {
        status: 200,
        headers: { 'cache-control': 'no-store', pragma: 'no-cache' },
      })
    } catch (error) {
      return failure(error, oauth.OAUTH_PATHS.revoke)
    }
  })
}
