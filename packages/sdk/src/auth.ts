import { randomUUID, type webcrypto } from 'node:crypto'
import { SignJWT } from 'jose'
import type { ApiError } from './result.ts'

type CryptoKey = webcrypto.CryptoKey

/**
 * Server-side authentication of the SDK (sdk.md §4, order §125). Nothing is
 * stored: an API key is held in memory as given; a service account signs a
 * short-lived `private_key_jwt` assertion with the caller's key (a WebCrypto
 * `CryptoKey`, which may be non-extractable) and keeps only the resulting
 * access token in memory until shortly before it expires. Browsers are not
 * supported: tokens and keys must not reach one.
 */
export type AuthOptions =
  | { readonly kind: 'apiKey'; readonly key: string }
  | {
      readonly kind: 'serviceAccount'
      /** The service account's OAuth client id (`cli_…`). */
      readonly clientId: string
      /** The private key registered with the client, by its `kid`. */
      readonly privateKey: CryptoKey
      readonly keyId: string
      /** Derived from the key when omitted: ES256, ES384, EdDSA, RS256 (PKCS#1 v1.5) or PS256. */
      readonly algorithm?: 'ES256' | 'ES384' | 'EdDSA' | 'RS256' | 'PS256'
      /** Scopes to request, e.g. `['targets.read']`. */
      readonly scopes: readonly string[]
    }

export interface Authenticator {
  /** The `Authorization` header value for the next request. */
  header(): Promise<
    { readonly ok: true; readonly value: string } | { readonly ok: false; readonly error: ApiError }
  >
  /** A 401 answered: forget a cached token so the next request obtains a fresh one. */
  invalidate(): void
  /** Whether a 401 may be answered by obtaining a fresh token (and the request sent once more). */
  readonly renewable: boolean
}

const ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'
/** Seconds before expiry at which a cached token is renewed. */
const RENEW_BEFORE_SECONDS = 30
/** The assertion lives one minute (the server allows at most five). */
const ASSERTION_LIFETIME_SECONDS = 60

type Algorithm = NonNullable<Extract<AuthOptions, { kind: 'serviceAccount' }>['algorithm']>

/** The JWS algorithm a key signs with, or undefined (an RSA key must hash with SHA-256). */
export function algorithmOf(key: CryptoKey): Algorithm | undefined {
  const a = key.algorithm as { name: string; namedCurve?: string; hash?: { name?: string } }
  if (a.name === 'ECDSA' && a.namedCurve === 'P-256') return 'ES256'
  if (a.name === 'ECDSA' && a.namedCurve === 'P-384') return 'ES384'
  if (a.name === 'Ed25519') return 'EdDSA'
  const sha256 = a.hash?.name === 'SHA-256'
  if (a.name === 'RSASSA-PKCS1-v1_5' && sha256) return 'RS256'
  if (a.name === 'RSA-PSS' && sha256) return 'PS256'
  return undefined
}

/**
 * A `private_key_jwt` client assertion (RFC 7523 §3), signed by `jose` (no
 * custom JOSE): `iss` and `sub` are the client id, `aud` the issuer as one
 * string, a one-minute lifetime and a fresh random `jti` for every assertion
 * (the server refuses a replay).
 */
export async function clientAssertion(input: {
  readonly clientId: string
  readonly issuer: string
  readonly privateKey: CryptoKey
  readonly keyId: string
  readonly algorithm: Algorithm
  readonly nowSeconds: number
}): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: input.algorithm, kid: input.keyId, typ: 'JWT' })
    .setIssuer(input.clientId)
    .setSubject(input.clientId)
    .setAudience(input.issuer)
    .setIssuedAt(input.nowSeconds)
    .setExpirationTime(input.nowSeconds + ASSERTION_LIFETIME_SECONDS)
    .setJti(randomUUID())
    .sign(input.privateKey)
}

export function apiKeyAuthenticator(key: string): Authenticator {
  if (!/^exak_[A-Za-z0-9_-]{20,200}$/.test(key)) {
    throw new TypeError('An API key starts with exak_.')
  }
  return {
    header: async () => ({ ok: true, value: `Bearer ${key}` }),
    invalidate: () => undefined,
    renewable: false,
  }
}

export function serviceAccountAuthenticator(
  options: Extract<AuthOptions, { kind: 'serviceAccount' }>,
  context: {
    readonly baseUrl: string
    readonly fetch: typeof fetch
    readonly now: () => number
    readonly timeoutMs: number
  },
): Authenticator {
  const derived = algorithmOf(options.privateKey)
  const algorithm = options.algorithm ?? derived
  if (algorithm === undefined || derived !== algorithm) {
    throw new TypeError(
      'The private key needs ES256, ES384, EdDSA, RS256 or PS256, matching the algorithm.',
    )
  }
  if (!options.privateKey.usages.includes('sign')) {
    throw new TypeError('The private key must allow signing.')
  }
  const issuer = new URL(context.baseUrl).origin
  let cached: { readonly token: string; readonly expiresAt: number } | undefined
  let inflight: Promise<Awaited<ReturnType<Authenticator['header']>>> | undefined

  async function obtain(): Promise<Awaited<ReturnType<Authenticator['header']>>> {
    const nowSeconds = Math.floor(context.now() / 1000)
    const assertion = await clientAssertion({
      clientId: options.clientId,
      issuer,
      privateKey: options.privateKey,
      keyId: options.keyId,
      algorithm: algorithm as Algorithm,
      nowSeconds,
    })
    const form = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: options.clientId,
      client_assertion_type: ASSERTION_TYPE,
      client_assertion: assertion,
      scope: options.scopes.join(' '),
      resource: `${issuer}/api`,
    })
    let response: Response
    try {
      response = await context.fetch(`${issuer}/oauth/token`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: form.toString(),
        signal: AbortSignal.timeout(context.timeoutMs),
        // Never follow a redirect with a client assertion in the body.
        redirect: 'error',
      })
    } catch {
      // Asking for a token changes nothing: it may be asked again.
      return {
        ok: false,
        error: { code: 'TRANSPORT_FAILED', status: null, requestId: null, retryable: true },
      }
    }
    let body: unknown
    try {
      body = await response.json()
    } catch {
      body = undefined
    }
    const field = (name: string) =>
      typeof body === 'object' && body !== null && name in body
        ? (body as Record<string, unknown>)[name]
        : undefined
    const token = field('access_token')
    const expiresIn = field('expires_in')
    if (!response.ok || typeof token !== 'string' || typeof expiresIn !== 'number') {
      const oauthError = field('error')
      return {
        ok: false,
        error: {
          code: response.ok ? 'RESPONSE_INVALID' : 'CLIENT_AUTHENTICATION_FAILED',
          status: response.status,
          requestId: response.headers.get('x-request-id'),
          retryable: response.status >= 500,
          ...(typeof oauthError === 'string' ? { details: { error: oauthError } } : {}),
        },
      }
    }
    cached = { token, expiresAt: context.now() + expiresIn * 1000 }
    return { ok: true, value: `Bearer ${token}` }
  }

  return {
    renewable: true,
    invalidate() {
      cached = undefined
    },
    async header() {
      if (cached !== undefined && cached.expiresAt - context.now() > RENEW_BEFORE_SECONDS * 1000) {
        return { ok: true, value: `Bearer ${cached.token}` }
      }
      // One token request at a time; concurrent calls share it.
      inflight ??= obtain().finally(() => {
        inflight = undefined
      })
      return inflight
    },
  }
}
