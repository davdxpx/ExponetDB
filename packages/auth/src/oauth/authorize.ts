import {
  GRANT_TYPE_AUTHORIZATION_CODE,
  isScopeGrantableTo,
  OAUTH_LIMITS,
  type OAuthErrorCode,
  RESOURCES_BY_CLIENT_KIND,
} from '@exponetdb/contracts'
import { ControlStoreError } from '@exponetdb/control-store'
import type { AuthDeps } from '../deps.ts'
import type { RequestMeta } from '../request.ts'
import { newToken, parseToken, tokenHash } from '../tokens.ts'
import { matchRedirectUri, type OAuthClientRecord, readClientByExternalId } from './clients.ts'
import type { AuthorizeLocalError } from './errors.ts'
import { addressBucket, hit } from './limits.ts'
import { OAUTH_PATHS, resourceOf } from './metadata.ts'
import {
  isValidCodeChallenge,
  isValidState,
  parseProtocolParams,
  parseScopeParam,
} from './params.ts'

/**
 * The authorization endpoint (oauth.md §4, OAuth 2.1 §4.1.1, RFC 9207,
 * RFC 8707). The request is validated completely before anything is
 * stored, in this order:
 *
 * 1. the client (`client_id` once, known, active, a public client of kind
 *    `cli` or `mcp` that may use the authorization code grant) and its
 *    redirect URI (exact match; loopback on any port). Until both are
 *    established every error is a local error page: ExponetDB never
 *    redirects to a URI it has not matched (no open redirector);
 * 2. then every other error redirects to that URI with `error`, `state`
 *    (when it was valid) and `iss`: a repeated parameter, `response_type`
 *    other than `code`, a `response_mode` other than `query`, a missing or
 *    invalid `state`, PKCE other than S256, a missing or foreign
 *    `resource`, a scope that is unknown or that this client kind may never
 *    hold, request objects (not supported).
 *
 * A valid request is stored on the server (10 minutes) under the hash of an
 * opaque handle and bound to the hash of an HttpOnly browser-binding cookie;
 * the browser goes to the Web App consent page with the handle in the URL
 * fragment (never sent to a server, never in a `Referer`). Nothing about
 * the person is decided here: the consent page signs them in if needed.
 */
export type AuthorizeOutcome =
  | {
      readonly kind: 'consent'
      readonly location: string
      /** The binding cookie value: a new one is set, an existing valid one is kept. */
      readonly binding: string
      readonly setBinding: boolean
    }
  | { readonly kind: 'redirect'; readonly location: string }
  | {
      readonly kind: 'error'
      readonly reason: AuthorizeLocalError
      readonly retryAfterSeconds?: number
    }

/**
 * Re-reads a CIMD client whose cached metadata is stale (Phase CIMD);
 * absent: stale is refused. Under open registration (oauth.md §3) it also
 * discovers an unknown CIMD `client_id` and approves a pending client
 * automatically; both answer undefined when the policy is `review`.
 */
export interface ClientMetadataRefresher {
  refresh(client: OAuthClientRecord): Promise<OAuthClientRecord | undefined>
  discover?(clientId: string, meta: RequestMeta): Promise<OAuthClientRecord | undefined>
  activate?(client: OAuthClientRecord, meta: RequestMeta): Promise<OAuthClientRecord | undefined>
}

function errorRedirect(
  redirectUri: string,
  issuer: string,
  error: OAuthErrorCode,
  state: string | undefined,
): AuthorizeOutcome {
  const url = new URL(redirectUri)
  url.searchParams.append('error', error)
  if (state !== undefined) {
    url.searchParams.append('state', state)
  }
  url.searchParams.append('iss', issuer)
  return { kind: 'redirect', location: url.href }
}

const local = (reason: AuthorizeLocalError, retryAfterSeconds?: number): AuthorizeOutcome => ({
  kind: 'error',
  reason,
  ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
})

export async function startAuthorization(
  deps: AuthDeps,
  meta: RequestMeta,
  rawQuery: string,
  bindingCookie: string | undefined,
  refresher?: ClientMetadataRefresher,
): Promise<AuthorizeOutcome> {
  const issuer = deps.config.publicOrigin
  const wait = await hit(deps.store, await addressBucket(deps.keys, 'authorize-ip', meta.clientIp))
  if (wait > 0) {
    return local('rate_limited', wait)
  }
  const params = parseProtocolParams(rawQuery, OAUTH_LIMITS.maxQueryLength)
  if (params === undefined) {
    return local('request_invalid')
  }
  // 1. The client and the redirect URI: local errors only.
  const clientId = params.get('client_id')
  if (clientId === undefined || params.repeated.has('redirect_uri')) {
    return local('request_invalid')
  }
  let client = await readClientByExternalId(deps.store, clientId)
  if (client === undefined) {
    // Open registration discovers a CIMD client here; under `review` an
    // unknown URL is never fetched (OD-5, owner decision 2026-10-13).
    client = await refresher?.discover?.(clientId, meta)
    if (client === undefined) {
      return local('client_unknown')
    }
  }
  if (client.state === 'pending' && refresher?.activate !== undefined) {
    client = (await refresher.activate(client, meta)) ?? client
  }
  if (client.state === 'active' && client.registration === 'cimd' && client.metadataStale) {
    client = refresher === undefined ? undefined : await refresher.refresh(client)
    if (client === undefined) {
      return local('client_not_approved')
    }
  }
  if (client.state !== 'active') {
    return local('client_not_approved')
  }
  if (
    (client.kind !== 'cli' && client.kind !== 'mcp') ||
    client.tokenEndpointAuthMethod !== 'none' ||
    !client.grantTypes.includes(GRANT_TYPE_AUTHORIZATION_CODE)
  ) {
    return local('client_unsupported')
  }
  const requestedRedirect = params.get('redirect_uri')
  const redirectUri =
    requestedRedirect === undefined
      ? undefined
      : matchRedirectUri(client.redirectUris, requestedRedirect)
  if (redirectUri === undefined) {
    return local('redirect_uri_invalid')
  }

  // 2. Everything else: an error response at the matched redirect URI.
  const rawState = params.get('state')
  const state = isValidState(rawState) && !params.repeated.has('state') ? rawState : undefined
  const fail = (error: OAuthErrorCode) => errorRedirect(redirectUri, issuer, error, state)
  if (params.repeated.size > 0) {
    return fail('invalid_request')
  }
  if (params.get('response_type') !== 'code') {
    return fail(params.has('response_type') ? 'unsupported_response_type' : 'invalid_request')
  }
  const responseMode = params.get('response_mode')
  if (
    (responseMode !== undefined && responseMode !== 'query') ||
    params.has('request') ||
    params.has('request_uri')
  ) {
    return fail('invalid_request')
  }
  if (state === undefined) {
    return fail('invalid_request')
  }
  const challenge = params.get('code_challenge')
  if (params.get('code_challenge_method') !== 'S256' || !isValidCodeChallenge(challenge)) {
    return fail('invalid_request')
  }
  const resource = resourceOf(issuer, params.get('resource'))
  if (resource === undefined || !RESOURCES_BY_CLIENT_KIND[client.kind].includes(resource)) {
    return fail('invalid_target')
  }
  const scopes = parseScopeParam(params.get('scope'))
  const kind = client.kind
  if (scopes === undefined || !scopes.every((s) => isScopeGrantableTo(s, kind))) {
    return fail('invalid_scope')
  }

  const existing = parseToken('binding', bindingCookie)
  const binding = existing ?? newToken('binding')
  const handle = newToken('request')
  try {
    await deps.store.query(
      'oauth.authorize.store',
      `INSERT INTO oauth.authorization_requests
         (handle_hash, binding_hash, client_id, client_fingerprint, redirect_uri, scopes, resource,
          code_challenge, state, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6::text[], $7, $8, $9, clock_timestamp(), clock_timestamp())`,
      [
        tokenHash('request', handle),
        tokenHash('binding', binding),
        client.clientId,
        client.metadataFingerprint,
        redirectUri,
        scopes,
        resource,
        challenge,
        state,
      ],
    )
  } catch (error) {
    // The client left `active` or changed its metadata in the meantime.
    if (error instanceof ControlStoreError && error.sqlstate === 'EXO04') {
      return local('client_not_approved')
    }
    throw error
  }
  return {
    kind: 'consent',
    location: `${issuer}${OAUTH_PATHS.consentPage}#request=${handle}`,
    binding,
    setBinding: existing === undefined,
  }
}
