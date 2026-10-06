import {
  CLIENT_ASSERTION_ALGORITHMS,
  type ClientAssertionAlgorithm,
  OAUTH_LIMITS,
  type PublicJwk,
} from '@exponetdb/contracts'
import { ControlStoreError, type Tx } from '@exponetdb/control-store'
import { decodeProtectedHeader, importJWK, type JWTPayload, jwtVerify } from 'jose'
import type { AuthDeps } from '../deps.ts'
import { tokenHash } from '../tokens.ts'
import type { OAuthClientRecord } from './clients.ts'
import type { ClientAssertionVerifier } from './token.ts'

/**
 * `private_key_jwt` client authentication (RFC 7523 §2.2, §3; OAuth 2.1
 * §2.4.1) for service-account clients, verified with `jose`:
 *
 * - the header names a registered key by `kid` (an unknown or missing `kid`
 *   is refused, no key is guessed), and an algorithm from the allowlist
 *   (`ES256`, `ES384`, `EdDSA`, `PS256`, `RS256`) that fits that key; `none`
 *   and every HMAC algorithm are refused;
 * - `iss` and `sub` are the client's `client_id`; `aud` is exactly the
 *   issuer as a single string (not an array, not the token endpoint URL:
 *   audience injection); `exp`, `iat` and `jti` are required; the assertion lives
 *   at most 5 minutes (`exp - iat`), `exp` is at most 5 minutes ahead, `iat`
 *   and `nbf` not in the future, 60 seconds of clock skew;
 * - the `jti` is recorded (hashed) until the assertion expires: a second use
 *   is refused (replay). The record commits with the token request.
 *
 * Attempts are counted per client and address before the request's
 * transaction opens (`countAssertionAttempt` in `token.ts`).
 */
const SKEW = OAUTH_LIMITS.clientAssertionClockSkewSeconds
const MAX_LIFETIME = OAUTH_LIMITS.clientAssertionMaxLifetimeSeconds

function algorithmFits(alg: ClientAssertionAlgorithm, key: PublicJwk): boolean {
  if (key.alg !== undefined && key.alg !== alg) {
    return false
  }
  switch (key.kty) {
    case 'EC':
      return (alg === 'ES256' && key.crv === 'P-256') || (alg === 'ES384' && key.crv === 'P-384')
    case 'OKP':
      return alg === 'EdDSA' && key.crv === 'Ed25519'
    case 'RSA':
      return alg === 'PS256' || alg === 'RS256'
  }
}

function isAlgorithm(value: unknown): value is ClientAssertionAlgorithm {
  return typeof value === 'string' && CLIENT_ASSERTION_ALGORITHMS.some((a) => a === value)
}

export type AssertionRefusal =
  | 'malformed'
  | 'algorithm'
  | 'key'
  | 'signature'
  | 'claims'
  | 'lifetime'
  | 'replay'

/** Verifies an assertion; the refusal reason is for tests and metrics, never sent to the client. */
export async function verifyClientAssertion(
  tx: Tx,
  deps: Pick<AuthDeps, 'config'>,
  client: OAuthClientRecord,
  assertion: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: AssertionRefusal }> {
  if (client.tokenEndpointAuthMethod !== 'private_key_jwt' || client.jwks.length === 0) {
    return { ok: false, reason: 'key' }
  }
  let header: ReturnType<typeof decodeProtectedHeader>
  try {
    header = decodeProtectedHeader(assertion)
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  const alg = header.alg
  if (
    !isAlgorithm(alg) ||
    header.crit !== undefined ||
    header.jku !== undefined ||
    header.jwk !== undefined ||
    header.x5u !== undefined
  ) {
    return { ok: false, reason: 'algorithm' }
  }
  if (
    header.typ !== undefined &&
    header.typ !== 'JWT' &&
    header.typ !== 'client-authentication+jwt'
  ) {
    return { ok: false, reason: 'malformed' }
  }
  const key = client.jwks.find((k) => k.kid === header.kid)
  if (key === undefined || header.kid === undefined || !algorithmFits(alg, key)) {
    return { ok: false, reason: 'key' }
  }
  let payload: JWTPayload
  try {
    const { kid: _kid, alg: _alg, use: _use, ...material } = key
    const publicKey = await importJWK({ ...material }, alg)
    const verified = await jwtVerify(assertion, publicKey, {
      algorithms: [alg],
      issuer: client.externalId,
      subject: client.externalId,
      audience: deps.config.publicOrigin,
      requiredClaims: ['exp', 'iat', 'jti'],
      clockTolerance: SKEW,
      currentDate: new Date(nowSeconds * 1000),
    })
    payload = verified.payload
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String(error.code) : ''
    return {
      ok: false,
      reason: code === 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED' ? 'signature' : 'claims',
    }
  }
  const { exp, iat, nbf, jti, aud } = payload
  // A single audience, the issuer (draft-ietf-oauth-rfc7523bis): never an
  // array, never the token endpoint URL, so an assertion a client made for
  // another authorization server cannot be replayed here (audience injection).
  if (aud !== deps.config.publicOrigin) {
    return { ok: false, reason: 'claims' }
  }
  if (
    typeof exp !== 'number' ||
    typeof iat !== 'number' ||
    typeof jti !== 'string' ||
    jti.length === 0 ||
    jti.length > 256 ||
    exp - iat > MAX_LIFETIME ||
    exp > nowSeconds + MAX_LIFETIME + SKEW ||
    iat > nowSeconds + SKEW ||
    (nbf !== undefined && nbf > nowSeconds + SKEW)
  ) {
    return { ok: false, reason: 'lifetime' }
  }
  try {
    await tx.savepoint((inner) =>
      inner.query(
        'oauth.assertion.record',
        `INSERT INTO oauth.client_assertions (client_id, jti_hash, expires_at)
         VALUES ($1, $2, least(to_timestamp($3), clock_timestamp() + interval '10 minutes'))`,
        [client.clientId, tokenHash('assertion_jti', `${client.clientId}\n${jti}`), exp + SKEW],
      ),
    )
  } catch (error) {
    if (error instanceof ControlStoreError && error.sqlstate === '23505') {
      return { ok: false, reason: 'replay' }
    }
    throw error
  }
  return { ok: true }
}

export function assertionVerifier(deps: Pick<AuthDeps, 'config'>): ClientAssertionVerifier {
  return {
    async verify(tx, client, assertion) {
      return (await verifyClientAssertion(tx, deps, client, assertion)).ok
    },
  }
}
