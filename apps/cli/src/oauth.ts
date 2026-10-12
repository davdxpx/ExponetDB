import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import {
  type AuthorizationServerMetadata,
  AuthorizationServerMetadataSchema,
  DeviceAuthorizationResponseSchema,
  FIRST_PARTY_CLIENT_IDS,
  GRANT_TYPE_AUTHORIZATION_CODE,
  GRANT_TYPE_DEVICE_CODE,
  GRANT_TYPE_REFRESH_TOKEN,
  OAuthErrorResponseSchema,
  type TokenResponse,
  TokenResponseSchema,
} from '@exponetdb/contracts'
import { CliError } from './errors.ts'
import type { StoredCredentials, TokenStore } from './store.ts'

/**
 * The CLI side of OAuth (oauth.md §4, §5; RFC 8252, RFC 7636, RFC 9207,
 * RFC 8628, RFC 7009) with the first-party public client `exponetdb-cli`:
 *
 * - discovery: the authorization server metadata must name exactly the
 *   server the user chose as `issuer`, and every endpoint must be on it;
 * - loopback sign-in: a one-shot HTTP listener on 127.0.0.1 and a random
 *   port, PKCE S256 with a fresh verifier, a fresh `state`; the callback must
 *   carry that `state` and the expected `iss` (mix-up defense) before the
 *   code is exchanged; the page shown in the browser reflects nothing;
 * - device sign-in: the user code is shown, the CLI polls at the server's
 *   interval and slows down when told;
 * - refresh under the store lock (rotation, see `TokenStore.withLock`);
 * - sign-out revokes the refresh token (the grant ends on the server)
 *   before the local copy is deleted.
 */
export const CLI_CLIENT_ID = FIRST_PARTY_CLIENT_IDS.cli
export const DEFAULT_SCOPES = ['targets.read'] as const
const CALLBACK_PATH = '/callback'
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000
const REQUEST_TIMEOUT_MS = 15_000

export type Fetch = typeof fetch

export interface ServerInfo {
  readonly origin: string
  readonly metadata: AuthorizationServerMetadata
}

/** The server's origin: https, or http on a loopback host (local development). */
export function parseServer(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new CliError('server_invalid', 'The server must be a URL such as https://db.example.com.')
  }
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    (url.pathname !== '/' && url.pathname !== '')
  ) {
    throw new CliError('server_invalid', 'The server must be an https origin without a path.')
  }
  return url.origin
}

async function request(fetchImpl: Fetch, url: string, init: RequestInit = {}): Promise<Response> {
  try {
    return await fetchImpl(url, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch {
    throw new CliError('network', `The server at ${new URL(url).origin} could not be reached.`)
  }
}

async function json(response: Response): Promise<unknown> {
  try {
    return JSON.parse(await response.text())
  } catch {
    throw new CliError('protocol', 'The server answered something that is not JSON.')
  }
}

export async function discover(fetchImpl: Fetch, origin: string): Promise<ServerInfo> {
  const response = await request(fetchImpl, `${origin}/.well-known/oauth-authorization-server`)
  if (response.status !== 200) {
    throw new CliError(
      'discovery_failed',
      `The server did not publish its OAuth metadata (${response.status}).`,
    )
  }
  const parsed = AuthorizationServerMetadataSchema.safeParse(await json(response))
  if (!parsed.success) {
    throw new CliError('discovery_failed', 'The OAuth metadata of the server is not valid.')
  }
  const metadata = parsed.data
  const endpoints = [
    metadata.authorization_endpoint,
    metadata.token_endpoint,
    metadata.revocation_endpoint,
    metadata.device_authorization_endpoint,
  ]
  if (metadata.issuer !== origin || !endpoints.every((e) => new URL(e).origin === origin)) {
    throw new CliError(
      'discovery_failed',
      'The OAuth metadata names another server; refusing to sign in.',
    )
  }
  if (!metadata.code_challenge_methods_supported.includes('S256')) {
    throw new CliError('discovery_failed', 'The server does not support PKCE S256.')
  }
  return { origin, metadata }
}

async function oauthFailure(response: Response): Promise<CliError> {
  const parsed = OAuthErrorResponseSchema.safeParse(await json(response).catch(() => undefined))
  const error = parsed.success ? parsed.data.error : `http_${response.status}`
  return new CliError(`oauth_${error}`, `The server refused the request (${error}).`)
}

async function postForm(
  fetchImpl: Fetch,
  url: string,
  fields: Record<string, string>,
): Promise<Response> {
  return request(fetchImpl, url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(fields).toString(),
  })
}

async function tokenRequest(
  fetchImpl: Fetch,
  server: ServerInfo,
  fields: Record<string, string>,
): Promise<TokenResponse> {
  const response = await postForm(fetchImpl, server.metadata.token_endpoint, {
    client_id: CLI_CLIENT_ID,
    ...fields,
  })
  if (response.status !== 200) {
    throw await oauthFailure(response)
  }
  const parsed = TokenResponseSchema.safeParse(await json(response))
  if (!parsed.success) {
    throw new CliError('protocol', 'The token response of the server is not valid.')
  }
  return parsed.data
}

export function credentialsFrom(
  server: ServerInfo,
  tokens: TokenResponse,
  now = Date.now(),
): StoredCredentials {
  return {
    server: server.origin,
    clientId: CLI_CLIENT_ID,
    accessToken: tokens.access_token,
    accessExpiresAt: now + tokens.expires_in * 1000,
    refreshToken: tokens.refresh_token ?? null,
    scope: tokens.scope,
    obtainedAt: now,
  }
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier, 'ascii').digest('base64url') }
}

const PAGE = (message: string) =>
  `<!doctype html><meta charset="utf-8"><title>ExponetDB</title><p>${message}</p>`

/**
 * Waits for the one authorization response on the loopback listener and
 * returns the code. Anything but the expected `state` and `iss` ends the
 * sign-in; nothing from the request is written into the page.
 */
async function loopbackCode(
  issuer: string,
  state: string,
  onListening: (redirectUri: string) => Promise<void>,
  timeoutMs: number,
): Promise<{ code: string; redirectUri: string }> {
  return new Promise((resolve, reject) => {
    let redirectUri = ''
    let done = false
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (req.method !== 'GET' || url.pathname !== CALLBACK_PATH) {
        res.writeHead(404, { 'content-type': 'text/plain' }).end()
        return
      }
      const finish = (ok: boolean, outcome: { code: string } | CliError) => {
        res.writeHead(ok ? 200 : 400, {
          'content-type': 'text/html; charset=utf-8',
          'content-security-policy': "default-src 'none'",
          'cache-control': 'no-store',
          'referrer-policy': 'no-referrer',
        })
        res.end(
          PAGE(
            ok
              ? 'Signed in. You can close this window.'
              : 'Sign-in failed. Return to the terminal.',
          ),
        )
        if (!done) {
          done = true
          clearTimeout(timer)
          server.close()
          if (outcome instanceof CliError) {
            reject(outcome)
          } else {
            resolve({ code: outcome.code, redirectUri })
          }
        }
      }
      const params = url.searchParams
      if (params.getAll('state').length !== 1 || params.get('state') !== state) {
        finish(
          false,
          new CliError('state_mismatch', 'The sign-in response does not belong to this sign-in.'),
        )
        return
      }
      if (params.get('iss') !== issuer) {
        finish(
          false,
          new CliError('issuer_mismatch', 'The sign-in response comes from another server.'),
        )
        return
      }
      const error = params.get('error')
      if (error !== null) {
        const known = OAuthErrorResponseSchema.shape.error.safeParse(error)
        finish(
          false,
          new CliError(
            `oauth_${known.success ? known.data : 'error'}`,
            `Sign-in was not completed (${known.success ? known.data : 'error'}).`,
          ),
        )
        return
      }
      const code = params.get('code')
      if (
        code === null ||
        params.getAll('code').length !== 1 ||
        !/^exac_[A-Za-z0-9_-]{43}$/.test(code)
      ) {
        finish(false, new CliError('protocol', 'The sign-in response carries no valid code.'))
        return
      }
      finish(true, { code })
    })
    const timer = setTimeout(() => {
      if (!done) {
        done = true
        server.close()
        reject(new CliError('timeout', 'The sign-in was not completed in time.'))
      }
    }, timeoutMs)
    timer.unref()
    server.on('error', () => {
      if (!done) {
        done = true
        clearTimeout(timer)
        reject(new CliError('loopback_failed', 'The local sign-in listener could not start.'))
      }
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`
      onListening(redirectUri).catch((error: unknown) => {
        if (!done) {
          done = true
          clearTimeout(timer)
          server.close()
          reject(error)
        }
      })
    })
  })
}

export interface LoginOptions {
  readonly scopes: readonly string[]
  /** Shows the URL to the person (and may open a browser). */
  readonly present: (url: string) => Promise<void>
  readonly timeoutMs?: number
}

export async function loopbackLogin(
  fetchImpl: Fetch,
  server: ServerInfo,
  options: LoginOptions,
): Promise<StoredCredentials> {
  const { verifier, challenge } = pkce()
  const state = randomBytes(24).toString('base64url')
  const { code, redirectUri } = await loopbackCode(
    server.metadata.issuer,
    state,
    async (redirect) => {
      const url = new URL(server.metadata.authorization_endpoint)
      url.search = new URLSearchParams({
        response_type: 'code',
        client_id: CLI_CLIENT_ID,
        redirect_uri: redirect,
        scope: options.scopes.join(' '),
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        resource: `${server.origin}/api`,
      }).toString()
      await options.present(url.href)
    },
    options.timeoutMs ?? LOGIN_TIMEOUT_MS,
  )
  const tokens = await tokenRequest(fetchImpl, server, {
    grant_type: GRANT_TYPE_AUTHORIZATION_CODE,
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  })
  return credentialsFrom(server, tokens)
}

export interface DeviceOptions {
  readonly scopes: readonly string[]
  readonly present: (verificationUri: string, userCode: string) => Promise<void>
  readonly sleep?: (ms: number) => Promise<void>
}

export async function deviceLogin(
  fetchImpl: Fetch,
  server: ServerInfo,
  options: DeviceOptions,
): Promise<StoredCredentials> {
  const response = await postForm(fetchImpl, server.metadata.device_authorization_endpoint, {
    client_id: CLI_CLIENT_ID,
    scope: options.scopes.join(' '),
    resource: `${server.origin}/api`,
  })
  if (response.status !== 200) {
    throw await oauthFailure(response)
  }
  const parsed = DeviceAuthorizationResponseSchema.safeParse(await json(response))
  if (!parsed.success || new URL(parsed.data.verification_uri).origin !== server.origin) {
    throw new CliError('protocol', 'The device authorization response of the server is not valid.')
  }
  const started = parsed.data
  await options.present(started.verification_uri, started.user_code)
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
  let interval = started.interval
  const deadline = Date.now() + started.expires_in * 1000
  while (Date.now() < deadline) {
    await sleep(interval * 1000)
    try {
      const tokens = await tokenRequest(fetchImpl, server, {
        grant_type: GRANT_TYPE_DEVICE_CODE,
        device_code: started.device_code,
      })
      return credentialsFrom(server, tokens)
    } catch (error) {
      if (error instanceof CliError && error.code === 'oauth_authorization_pending') {
        continue
      }
      if (error instanceof CliError && error.code === 'oauth_slow_down') {
        interval += 5
        continue
      }
      throw error
    }
  }
  throw new CliError('timeout', 'The device sign-in expired before it was approved.')
}

/**
 * Valid credentials for `server`: the stored ones, or refreshed ones when the
 * access token is about to expire. The refresh holds the store lock and
 * re-reads the store, so concurrent CLI processes rotate the refresh token
 * once (a second rotation of the same token would end the grant).
 */
export async function liveCredentials(
  fetchImpl: Fetch,
  store: TokenStore,
  server: ServerInfo,
  now: () => number = Date.now,
  /** An access token the server just refused: refreshed even if it looks fresh. */
  refused?: string,
): Promise<StoredCredentials> {
  const fresh = (c: StoredCredentials | undefined) =>
    c !== undefined && c.accessExpiresAt - now() > 30_000 && c.accessToken !== refused
  const stored = await store.read(server.origin)
  if (stored === undefined) {
    throw new CliError('signed_out', `Not signed in to ${server.origin}. Run: exponetdb login`)
  }
  if (fresh(stored)) {
    return stored
  }
  return store.withLock(async () => {
    const current = await store.read(server.origin)
    if (current === undefined) {
      throw new CliError('signed_out', `Not signed in to ${server.origin}. Run: exponetdb login`)
    }
    if (fresh(current)) {
      return current
    }
    if (current.refreshToken === null) {
      throw new CliError('expired', 'The session expired. Run: exponetdb login')
    }
    try {
      const tokens = await tokenRequest(fetchImpl, server, {
        grant_type: GRANT_TYPE_REFRESH_TOKEN,
        refresh_token: current.refreshToken,
      })
      const next = credentialsFrom(server, tokens, now())
      await store.write(next)
      return next
    } catch (error) {
      if (error instanceof CliError && error.code === 'oauth_invalid_grant') {
        await store.remove(server.origin)
        throw new CliError('expired', 'The sign-in was revoked or expired. Run: exponetdb login')
      }
      throw error
    }
  })
}

/** Revokes the refresh token (ending the grant) and deletes the local copy, in that order. */
export async function logout(
  fetchImpl: Fetch,
  store: TokenStore,
  server: ServerInfo,
): Promise<{ readonly revoked: boolean }> {
  return store.withLock(async () => {
    const current = await store.read(server.origin)
    if (current === undefined) {
      return { revoked: false }
    }
    let revoked = false
    try {
      const response = await postForm(fetchImpl, server.metadata.revocation_endpoint, {
        client_id: CLI_CLIENT_ID,
        token: current.refreshToken ?? current.accessToken,
        token_type_hint: current.refreshToken === null ? 'access_token' : 'refresh_token',
      })
      revoked = response.status === 200
    } finally {
      // The local copy goes in any case; a failed revocation is reported.
      await store.remove(server.origin)
    }
    return { revoked }
  })
}
