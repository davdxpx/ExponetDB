import { createHash } from 'node:crypto'
import {
  CLIENT_ASSERTION_TYPE_JWT_BEARER,
  GRANT_TYPE_AUTHORIZATION_CODE,
  GRANT_TYPE_CLIENT_CREDENTIALS,
  GRANT_TYPE_DEVICE_CODE,
  GRANT_TYPE_REFRESH_TOKEN,
  OAUTH_LIMITS,
  type OAuthResource,
  type Scope,
  type TokenResponse,
} from '@exponetdb/contracts'
import { ControlStoreError, type Tx } from '@exponetdb/control-store'
import { type GrantId, isId } from '@exponetdb/kernel'
import { appendAudit, auditRequest, SERVE_ACTOR } from '../audit.ts'
import type { AuthDeps } from '../deps.ts'
import type { RequestMeta } from '../request.ts'
import { newToken, parseToken, tokenHash } from '../tokens.ts'
import { type OAuthClientRecord, readClientByExternalId } from './clients.ts'
import { auditClient } from './consent.ts'
import { OAuthError, rateLimited } from './errors.ts'
import { type GrantRecord, readGrant, revokeGrant } from './grants.ts'
import { addressBucket, hit } from './limits.ts'
import { resourceOf } from './metadata.ts'
import {
  isValidCodeVerifier,
  type ProtocolParams,
  parseProtocolParams,
  parseScopeParam,
  scopeParam,
} from './params.ts'

/**
 * The token and revocation endpoints (oauth.md §5, OAuth 2.1 §3.2, §4.1.3,
 * §4.3, RFC 7009, RFC 8707). Requests are `application/x-www-form-urlencoded`
 * of at most 16 KiB with no repeated parameter; errors are normative OAuth
 * errors. Client authentication is exactly one method: `none` (public
 * clients: `client_id` only) or `private_key_jwt` (service-account clients);
 * a client secret or an `Authorization` header is refused (no shared secrets
 * in V1).
 *
 * - `authorization_code`: the code is found by its hash under a row lock,
 *   belongs to the authenticating client, is live and unused, the
 *   `redirect_uri` equals the one of the request, and
 *   BASE64URL(SHA-256(code_verifier)) equals the challenge. A second
 *   presentation of a used code is a replay: the grant and every token of
 *   it are revoked.
 * - `refresh_token`: rotation on every use. The token is locked; a
 *   rotated-out (spent) token presented again is reuse: the grant and every
 *   token of it are revoked at once and `oauth.token_refresh_reuse_detected`
 *   is audited. There is no grace window: of two concurrent refreshes with
 *   the same token one wins, the other revokes the family.
 * - `resource`, when sent, must name the grant's resource (`invalid_target`);
 *   `scope` on a refresh may only narrow the access token.
 */
export interface TokenRequest {
  /** The raw form body; undefined when it was too large or not UTF-8. */
  readonly body: string | undefined
  readonly contentType: string | undefined
  /** An `Authorization` header was sent (client_secret_basic is not supported). */
  readonly authorizationHeader: boolean
}

/** Verifies a `private_key_jwt` client assertion (RFC 7523 §3) and records its `jti`. */
export interface ClientAssertionVerifier {
  verify(tx: Tx, client: OAuthClientRecord, assertion: string): Promise<boolean>
}

/** Device code and client credentials grants, provided by their modules. */
export interface ExtraGrants {
  deviceCode?(tx: Tx, client: OAuthClientRecord, params: ProtocolParams): Promise<GrantOutcome>
  clientCredentials?(
    tx: Tx,
    client: OAuthClientRecord,
    params: ProtocolParams,
  ): Promise<GrantOutcome>
}

export interface TokenEndpointDeps {
  readonly auth: AuthDeps
  readonly assertions?: ClientAssertionVerifier
  readonly grants?: ExtraGrants
}

/** A grant's result: tokens, or an error that must still commit (revocations). */
export type GrantOutcome =
  | { readonly ok: true; readonly response: TokenResponse }
  | { readonly ok: false; readonly error: OAuthError }

const failed = (error: OAuthError): GrantOutcome => ({ ok: false, error })
const invalidGrant = () => failed(new OAuthError('invalid_grant'))

export function parseForm(request: TokenRequest): ProtocolParams {
  const type = (request.contentType ?? '').split(';')[0]?.trim().toLowerCase()
  if (type !== 'application/x-www-form-urlencoded' || request.body === undefined) {
    throw new OAuthError('invalid_request', {
      description: 'The request must be a form of at most 16 KiB.',
    })
  }
  const params = parseProtocolParams(request.body, OAUTH_LIMITS.maxFormBytes)
  if (params === undefined) {
    throw new OAuthError('invalid_request', { description: 'The form is not well-formed.' })
  }
  if (params.repeated.size > 0) {
    throw new OAuthError('invalid_request', { description: 'A parameter is repeated.' })
  }
  return params
}

/**
 * Authenticates the client of a token or revocation request. Exactly one
 * method; a public client may not present an assertion, a
 * `private_key_jwt` client must.
 */
export async function authenticateClient(
  tx: Tx,
  deps: TokenEndpointDeps,
  request: TokenRequest,
  params: ProtocolParams,
): Promise<OAuthClientRecord> {
  if (request.authorizationHeader) {
    throw new OAuthError('invalid_client', {
      description: 'Client authentication by the Authorization header is not supported.',
    })
  }
  if (params.has('client_secret')) {
    throw new OAuthError('invalid_client', { description: 'Client secrets are not supported.' })
  }
  const assertionType = params.get('client_assertion_type')
  const assertion = params.get('client_assertion')
  const clientId = params.get('client_id')
  if (clientId === undefined && assertion === undefined) {
    throw new OAuthError('invalid_client')
  }
  if ((assertionType === undefined) !== (assertion === undefined)) {
    throw new OAuthError('invalid_client')
  }
  if (assertion !== undefined) {
    if (assertionType !== CLIENT_ASSERTION_TYPE_JWT_BEARER || deps.assertions === undefined) {
      throw new OAuthError('invalid_client')
    }
    // RFC 7523 §3: the client is the assertion's issuer and subject; `client_id`, when sent, must agree.
    const issuer = unverifiedIssuer(assertion)
    if (issuer === undefined || (clientId !== undefined && clientId !== issuer)) {
      throw new OAuthError('invalid_client')
    }
    const client = await readClientByExternalId(tx, issuer)
    if (
      client === undefined ||
      client.state !== 'active' ||
      client.tokenEndpointAuthMethod !== 'private_key_jwt' ||
      !(await deps.assertions.verify(tx, client, assertion))
    ) {
      throw new OAuthError('invalid_client')
    }
    return client
  }
  const client = clientId === undefined ? undefined : await readClientByExternalId(tx, clientId)
  if (
    client === undefined ||
    client.state !== 'active' ||
    client.tokenEndpointAuthMethod !== 'none'
  ) {
    throw new OAuthError('invalid_client')
  }
  return client
}

/** The `iss` claim of a compact JWS, read without trusting it (only to find the client's keys). */
function unverifiedIssuer(assertion: string): string | undefined {
  if (assertion.length > 8192) {
    return undefined
  }
  const parts = assertion.split('.')
  if (parts.length !== 3 || parts[1] === undefined) {
    return undefined
  }
  try {
    const payload: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      return undefined
    }
    const iss = Object.getOwnPropertyDescriptor(payload, 'iss')?.value
    return typeof iss === 'string' && iss.length > 0 && iss.length <= 512 ? iss : undefined
  } catch {
    return undefined
  }
}

function pkceMatches(verifier: string, challenge: string): boolean {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url') === challenge
}

/** RFC 8707: a `resource` sent to the token endpoint must name the grant's resource. */
function checkResource(issuer: string, params: ProtocolParams, resource: OAuthResource): void {
  if (!params.has('resource')) {
    return
  }
  if (resourceOf(issuer, params.get('resource')) !== resource) {
    throw new OAuthError('invalid_target')
  }
}

/**
 * Issues an access token (and a refresh token for a delegated grant whose
 * client uses refresh tokens) from a live grant. The Control Store re-checks
 * grant, client and identity and computes the lifetimes.
 */
export async function issueTokens(
  tx: Tx,
  grant: GrantRecord,
  client: OAuthClientRecord,
  scopes: readonly Scope[],
  refresh: {
    readonly issue: boolean
    readonly parentTokenId?: number
    readonly generation?: number
  },
): Promise<TokenResponse> {
  const access = newToken('access')
  const issued = await tx.query(
    'oauth.token.issue_access',
    `INSERT INTO oauth.tokens (kind, token_hash, grant_id, client_id, identity_id, resource, scopes, issued_at, expires_at)
     VALUES ('access', $1, $2, $3, $4, $5, $6::text[], clock_timestamp(), clock_timestamp())
     RETURNING greatest(1, floor(extract(epoch FROM expires_at - issued_at)))::int AS expires_in`,
    [
      tokenHash('access', access),
      grant.grantId,
      client.clientId,
      grant.identityId,
      grant.resource,
      scopes,
    ],
  )
  let refreshToken: string | undefined
  if (refresh.issue) {
    refreshToken = newToken('refresh')
    await tx.query(
      'oauth.token.issue_refresh',
      `INSERT INTO oauth.tokens (kind, token_hash, grant_id, client_id, identity_id, resource, scopes,
                                 generation, parent_token_id, issued_at, expires_at)
       VALUES ('refresh', $1, $2, $3, $4, $5, $6::text[], $7, $8, clock_timestamp(), clock_timestamp())`,
      [
        tokenHash('refresh', refreshToken),
        grant.grantId,
        client.clientId,
        grant.identityId,
        grant.resource,
        grant.scopes,
        refresh.generation ?? 1,
        refresh.parentTokenId ?? null,
      ],
    )
  }
  return {
    access_token: access,
    token_type: 'Bearer',
    expires_in: Math.min(issued.rows[0]?.int('expires_in') ?? 1, OAUTH_LIMITS.accessTokenSeconds),
    scope: scopeParam(scopes),
    ...(refreshToken === undefined ? {} : { refresh_token: refreshToken }),
  }
}

async function auditRevocation(
  tx: Tx,
  deps: AuthDeps,
  meta: RequestMeta,
  action:
    | 'oauth.token_refresh_reuse_detected'
    | 'oauth.code_replay_detected'
    | 'oauth.grant_revoked',
  client: OAuthClientRecord,
  grantId: GrantId,
  reason: string,
): Promise<void> {
  await appendAudit(
    tx,
    {
      action,
      phase: 'completed',
      actor: SERVE_ACTOR,
      client: auditClient(client, { grantId }),
      changes: { reason },
      result: { status: 'succeeded' },
      request: await auditRequest(deps.keys, meta),
    },
    deps.clock,
  )
}

async function exchangeCode(
  tx: Tx,
  deps: AuthDeps,
  meta: RequestMeta,
  client: OAuthClientRecord,
  params: ProtocolParams,
): Promise<GrantOutcome> {
  const code = parseToken('code', params.get('code'))
  if (code === undefined) {
    return invalidGrant()
  }
  const { rows } = await tx.query(
    'oauth.code.redeem',
    `SELECT grant_id, client_id, redirect_uri, code_challenge, resource, consumed_at IS NOT NULL AS consumed,
            expires_at > clock_timestamp() AS live
       FROM oauth.authorization_codes WHERE code_hash = $1 FOR UPDATE`,
    [tokenHash('code', code)],
  )
  const row = rows[0]
  const grantId = row?.text('grant_id')
  if (row === undefined || grantId === undefined || !isId('grt', grantId)) {
    return invalidGrant()
  }
  if (row.text('client_id') !== client.clientId) {
    return invalidGrant()
  }
  if (row.bool('consumed')) {
    // A replayed code: everything issued from it is suspect (OAuth 2.1 §4.1.3).
    if (await revokeGrant(tx, grantId, 'code_replay', null)) {
      await auditRevocation(
        tx,
        deps,
        meta,
        'oauth.code_replay_detected',
        client,
        grantId,
        'code_replay',
      )
    }
    return invalidGrant()
  }
  const verifier = params.get('code_verifier')
  if (
    !row.bool('live') ||
    params.get('redirect_uri') !== row.text('redirect_uri') ||
    !isValidCodeVerifier(verifier) ||
    !pkceMatches(verifier, row.text('code_challenge'))
  ) {
    return invalidGrant()
  }
  const grant = await readGrant(tx, grantId, { forUpdate: true })
  if (grant === undefined || !grant.live) {
    return invalidGrant()
  }
  checkResource(deps.config.publicOrigin, params, grant.resource)
  await tx.query(
    'oauth.code.consume',
    'UPDATE oauth.authorization_codes SET consumed_at = clock_timestamp() WHERE code_hash = $1',
    [tokenHash('code', code)],
  )
  return {
    ok: true,
    response: await issueTokens(tx, grant, client, grant.scopes, {
      issue: client.grantTypes.includes(GRANT_TYPE_REFRESH_TOKEN),
    }),
  }
}

async function rotateRefresh(
  tx: Tx,
  deps: AuthDeps,
  meta: RequestMeta,
  client: OAuthClientRecord,
  params: ProtocolParams,
): Promise<GrantOutcome> {
  const presented = parseToken('refresh', params.get('refresh_token'))
  if (presented === undefined) {
    return invalidGrant()
  }
  const hash = tokenHash('refresh', presented)
  // Lock order grant → token, as every revocation takes it (no deadlock with a concurrent revoke).
  const found = await tx.query(
    'oauth.refresh.grant',
    `SELECT grant_id FROM oauth.tokens WHERE token_hash = $1 AND kind = 'refresh'`,
    [hash],
  )
  const grantId = found.rows[0]?.text('grant_id')
  if (grantId === undefined || !isId('grt', grantId)) {
    return invalidGrant()
  }
  const grant = await readGrant(tx, grantId, { forUpdate: true })
  const { rows } = await tx.query(
    'oauth.refresh.find',
    `SELECT token_id, client_id, generation, spent_at IS NOT NULL AS spent, revoked_at IS NOT NULL AS revoked
       FROM oauth.tokens WHERE token_hash = $1 AND kind = 'refresh' FOR UPDATE`,
    [hash],
  )
  const row = rows[0]
  if (grant === undefined || row === undefined || row.text('client_id') !== client.clientId) {
    return invalidGrant()
  }
  if (row.bool('spent')) {
    // Reuse of a rotated-out token: the family (the grant) ends now (RFC 9700 §4.14.2).
    if (await revokeGrant(tx, grantId, 'refresh_reuse', null)) {
      await auditRevocation(
        tx,
        deps,
        meta,
        'oauth.token_refresh_reuse_detected',
        client,
        grantId,
        'refresh_reuse',
      )
    }
    return invalidGrant()
  }
  if (row.bool('revoked') || !grant.live || grant.kind !== 'delegated') {
    return invalidGrant()
  }
  checkResource(deps.config.publicOrigin, params, grant.resource)
  let scopes: readonly Scope[] = grant.scopes
  if (params.has('scope')) {
    const narrowed = parseScopeParam(params.get('scope'))
    if (narrowed === undefined || !narrowed.every((s) => grant.scopes.includes(s))) {
      return failed(new OAuthError('invalid_scope'))
    }
    scopes = narrowed
  }
  await tx.query(
    'oauth.refresh.spend',
    'UPDATE oauth.tokens SET spent_at = clock_timestamp() WHERE token_id = $1',
    [row.int('token_id')],
  )
  return {
    ok: true,
    response: await issueTokens(tx, grant, client, scopes, {
      issue: true,
      parentTokenId: row.int('token_id'),
      generation: row.int('generation') + 1,
    }),
  }
}

/** POST /oauth/token. Throws `OAuthError`; a refused grant still commits its revocations. */
export async function tokenEndpoint(
  deps: TokenEndpointDeps,
  meta: RequestMeta,
  request: TokenRequest,
): Promise<TokenResponse> {
  const auth = deps.auth
  const wait = await hit(auth.store, await addressBucket(auth.keys, 'token-ip', meta.clientIp))
  if (wait > 0) {
    throw rateLimited(wait)
  }
  const params = parseForm(request)
  const grantType = params.get('grant_type')
  if (grantType === undefined) {
    throw new OAuthError('invalid_request', { description: 'grant_type is required.' })
  }
  const outcome = await auth.store.transaction('oauth.token', async (tx): Promise<GrantOutcome> => {
    const client = await authenticateClient(tx, deps, request, params)
    // From here on a refusal is returned, not thrown, so what this request
    // recorded (an assertion's jti, a revocation) commits with it.
    try {
      return await grant(tx, client, grantType)
    } catch (error) {
      if (error instanceof OAuthError) {
        return failed(error)
      }
      throw error
    }
  })
  if (!outcome.ok) {
    throw outcome.error
  }
  return outcome.response

  async function grant(
    tx: Tx,
    client: OAuthClientRecord,
    grantType: string,
  ): Promise<GrantOutcome> {
    if (!client.grantTypes.includes(grantType)) {
      return failed(
        new OAuthError(
          [
            GRANT_TYPE_AUTHORIZATION_CODE,
            GRANT_TYPE_REFRESH_TOKEN,
            GRANT_TYPE_CLIENT_CREDENTIALS,
            GRANT_TYPE_DEVICE_CODE,
          ].includes(grantType)
            ? 'unauthorized_client'
            : 'unsupported_grant_type',
        ),
      )
    }
    try {
      return await tx.savepoint(async (inner): Promise<GrantOutcome> => {
        switch (grantType) {
          case GRANT_TYPE_AUTHORIZATION_CODE:
            return exchangeCode(inner, auth, meta, client, params)
          case GRANT_TYPE_REFRESH_TOKEN:
            return rotateRefresh(inner, auth, meta, client, params)
          case GRANT_TYPE_DEVICE_CODE:
            return deps.grants?.deviceCode === undefined
              ? failed(new OAuthError('unsupported_grant_type'))
              : deps.grants.deviceCode(inner, client, params)
          case GRANT_TYPE_CLIENT_CREDENTIALS:
            return deps.grants?.clientCredentials === undefined
              ? failed(new OAuthError('unsupported_grant_type'))
              : deps.grants.clientCredentials(inner, client, params)
          default:
            return failed(new OAuthError('unsupported_grant_type'))
        }
      })
    } catch (error) {
      // The Control Store refused a token: the grant, client or identity ended meanwhile.
      if (error instanceof ControlStoreError && error.sqlstate === 'EXO06') {
        return invalidGrant()
      }
      throw error
    }
  }
}

/**
 * POST /oauth/revoke (RFC 7009). The client authenticates as at the token
 * endpoint. A refresh token of the client ends its grant (and every token of
 * it); an access token of the client ends itself. An unknown token, or one of
 * another client, is answered with success and changes nothing (§2.2). API
 * keys are not OAuth tokens: `unsupported_token_type`.
 */
export async function revocationEndpoint(
  deps: TokenEndpointDeps,
  meta: RequestMeta,
  request: TokenRequest,
): Promise<void> {
  const auth = deps.auth
  const wait = await hit(auth.store, await addressBucket(auth.keys, 'token-ip', meta.clientIp))
  if (wait > 0) {
    throw rateLimited(wait)
  }
  const params = parseForm(request)
  const token = params.get('token')
  if (token === undefined) {
    throw new OAuthError('invalid_request', { description: 'token is required.' })
  }
  await auth.store.transaction('oauth.revoke', async (tx) => {
    const client = await authenticateClient(tx, deps, request, params)
    if (parseToken('apiKey', token) !== undefined) {
      throw new OAuthError('unsupported_token_type')
    }
    const refresh = parseToken('refresh', token)
    const access = parseToken('access', token)
    if (refresh === undefined && access === undefined) {
      return
    }
    const { rows } = await tx.query(
      'oauth.revoke.find',
      `SELECT token_id, grant_id, client_id, kind FROM oauth.tokens WHERE token_hash = $1`,
      [refresh === undefined ? tokenHash('access', token) : tokenHash('refresh', token)],
    )
    const row = rows[0]
    const grantId = row?.text('grant_id')
    if (row === undefined || grantId === undefined || !isId('grt', grantId)) {
      return
    }
    if (row.text('client_id') !== client.clientId) {
      return
    }
    if (row.text('kind') === 'refresh') {
      if (await revokeGrant(tx, grantId, 'token_revocation', null)) {
        await auditRevocation(
          tx,
          auth,
          meta,
          'oauth.grant_revoked',
          client,
          grantId,
          'token_revocation',
        )
      }
      return
    }
    await tx.query(
      'oauth.revoke.access',
      'UPDATE oauth.tokens SET revoked_at = clock_timestamp() WHERE token_id = $1 AND revoked_at IS NULL',
      [row.int('token_id')],
    )
  })
}
