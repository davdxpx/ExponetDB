import type { Application } from '@exponetdb/application'
import { type oauth as authOauth, oauth } from '@exponetdb/auth'
import type { OAuthResource } from '@exponetdb/contracts'
import type { Context } from 'hono'
import type { HttpEnv } from './env.ts'

/**
 * Bearer authentication of a protected resource, shared by `/api/v1` and
 * `/mcp` (oauth.md §5, ADR-0027 §6): the resource is a parameter, the check
 * is the `auth` package's live lookup on every request (token, grant,
 * client, identity; no cache), and every failure is the same answer. The
 * interfaces never parse, store or forward a token themselves.
 */
export type BearerOutcome =
  /** No `Authorization` header at all. */
  | { readonly kind: 'none' }
  /** Present but not one valid credential for this resource (malformed, several, unknown, expired, revoked, other audience). */
  | { readonly kind: 'invalid' }
  | { readonly kind: 'ok'; readonly principal: authOauth.DelegatedPrincipal }

/**
 * Every `Authorization` header of the request, as sent: two headers are two
 * credentials (refused), never merged into one.
 */
export function authorizationHeaders(c: Context<HttpEnv>): string[] {
  const raw = c.env?.incoming?.rawHeaders
  if (Array.isArray(raw)) {
    const out: string[] = []
    for (let i = 0; i + 1 < raw.length; i += 2) {
      if (raw[i]?.toLowerCase() === 'authorization') {
        out.push(raw[i + 1] ?? '')
      }
    }
    return out
  }
  const merged = c.req.header('authorization')
  return merged === undefined ? [] : [merged]
}

export async function authenticateBearer(
  application: Pick<Application, 'authenticateBearer'>,
  headers: readonly string[],
  resource: OAuthResource,
): Promise<BearerOutcome> {
  if (headers.length === 0) {
    return { kind: 'none' }
  }
  const token = oauth.bearerValue(headers)
  if (token === undefined || token === 'invalid') {
    return { kind: 'invalid' }
  }
  const principal = await application.authenticateBearer(token, resource)
  return principal === undefined ? { kind: 'invalid' } : { kind: 'ok', principal }
}
