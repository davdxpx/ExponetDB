import { createHash, randomBytes } from 'node:crypto'
import { isJsonObject, newId } from '@exponetdb/kernel'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  Authorizer,
  auditRequest,
  ControlPlaneSubjectResolver,
  disableIdentity,
  isAuthError,
  oauth,
  type SessionContext,
} from '../src/index.ts'
import {
  type AccessHarness,
  accessHarness,
  bindRole,
  idn,
  invitePerson,
  signIn,
} from './support/access.ts'
import {
  age,
  type Enrolled,
  enrollFirstOwner,
  type Harness,
  harness,
  meta,
  ORIGIN,
} from './support/flows.ts'

/**
 * The authorization code flow against PostgreSQL 17 (G3B items: exact
 * redirect URIs, PKCE S256 only, `iss`, resource binding, consent
 * re-evaluation and non-escalation, single-use codes with replay
 * revocation, refresh rotation with reuse detection and no grace window,
 * RFC 7009 revocation, live bearer validation, scopes as a ceiling).
 */
let h: Harness
let a: AccessHarness
let owner: Enrolled
let ownerSession: SessionContext
let nobody: Enrolled
let nobodySession: SessionContext

const CLI = 'exponetdb-cli'
const API = `${ORIGIN}/api`
const MCP = `${ORIGIN}/mcp`
const CALLBACK = 'https://agent.example.test/callback'

let ipCounter = 0
/** A distinct client address per call: the protocol rate limits never interfere with a test. */
const m = () => {
  ipCounter += 1
  return meta(`198.51.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`)
}

let mcpClient: { readonly externalId: string; readonly clientId: string }

async function activeMcpClient(name = 'Example Agent'): Promise<typeof mcpClient> {
  const externalId = `exdb-dcr-${randomBytes(32).toString('base64url')}`
  const clientId = newId('cli', Date.now())
  const fingerprint = oauth.clientFingerprint({
    externalId,
    redirectUris: [CALLBACK],
    tokenEndpointAuthMethod: 'none',
    applicationType: 'web',
    grantTypes: ['authorization_code', 'refresh_token'],
    jwks: [],
  })
  await h.deps.store.query(
    'test.client.register',
    `INSERT INTO oauth.clients (client_id, external_id, registration, kind, state, display_name, redirect_uris,
                                application_type, token_endpoint_auth_method, grant_types, metadata_fingerprint,
                                created_at, state_changed_at)
     VALUES ($1, $2, 'dcr', 'mcp', 'pending', $3, ARRAY[$4], 'web', 'none',
             ARRAY['authorization_code', 'refresh_token'], $5, now(), now())`,
    [clientId, externalId, name, CALLBACK, fingerprint],
  )
  await h.deps.store.query(
    'test.client.approve',
    `UPDATE oauth.clients SET state = 'active', approved_fingerprint = metadata_fingerprint,
            approved_by_identity_id = $2 WHERE client_id = $1`,
    [clientId, owner.identityId],
  )
  return { externalId, clientId }
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

interface AuthorizeInput {
  readonly clientId?: string
  readonly redirectUri?: string
  readonly scope?: string
  readonly resource?: string
  readonly challenge?: string
  readonly extra?: string
}

function query(input: AuthorizeInput, challenge: string): string {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: input.clientId ?? mcpClient.externalId,
    redirect_uri: input.redirectUri ?? CALLBACK,
    scope: input.scope ?? 'targets.read schema.read',
    state: 'state-123',
    code_challenge: input.challenge ?? challenge,
    code_challenge_method: 'S256',
    resource: input.resource ?? API,
  })
  return input.extra === undefined ? q.toString() : `${q.toString()}&${input.extra}`
}

async function start(input: AuthorizeInput = {}, binding?: string) {
  const { verifier, challenge } = pkce()
  const outcome = await oauth.startAuthorization(h.deps, m(), query(input, challenge), binding)
  return { outcome, verifier }
}

function handleOf(outcome: oauth.AuthorizeOutcome): string {
  if (outcome.kind !== 'consent') {
    throw new Error(`expected consent, got ${JSON.stringify(outcome)}`)
  }
  return new URL(outcome.location).hash.slice('#request='.length)
}

async function decide(
  session: SessionContext,
  outcome: oauth.AuthorizeOutcome,
  choice: Partial<oauth.DelegationChoice> & { decision?: 'allow' | 'deny' } = {},
): Promise<string> {
  if (outcome.kind !== 'consent') {
    throw new Error('expected consent')
  }
  const result = await h.deps.store.transaction('test.consent', (tx) =>
    oauth.decideConsent(
      tx,
      h.deps,
      m(),
      session,
      {
        request: handleOf(outcome),
        decision: choice.decision ?? 'allow',
        scopes: choice.scopes ?? ['targets.read', 'schema.read'],
        tiers: choice.tiers ?? ['nonprod'],
        lifetimeDays: choice.lifetimeDays ?? 30,
        acknowledgeProduction: choice.acknowledgeProduction,
      },
      outcome.binding,
    ),
  )
  return result.redirectTo
}

function tokenRequest(form: Record<string, string>): oauth.TokenRequest {
  return {
    body: new URLSearchParams(form).toString(),
    contentType: 'application/x-www-form-urlencoded',
    authorizationHeader: false,
  }
}

async function token(form: Record<string, string>) {
  return oauth.tokenEndpoint({ auth: h.deps }, m(), tokenRequest(form))
}

async function oauthError(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise
    return undefined
  } catch (error) {
    if (error instanceof oauth.OAuthError) {
      return error.error
    }
    throw error
  }
}

async function authCode(
  session: SessionContext = ownerSession,
  choice: Partial<oauth.DelegationChoice> = {},
  input: AuthorizeInput = {},
): Promise<{ code: string; verifier: string; redirectUri: string }> {
  const { outcome, verifier } = await start(input)
  const redirect = new URL(await decide(session, outcome, choice))
  const code = redirect.searchParams.get('code')
  if (code === null) {
    throw new Error('no code')
  }
  return { code, verifier, redirectUri: input.redirectUri ?? CALLBACK }
}

async function tokens(
  session: SessionContext = ownerSession,
  choice: Partial<oauth.DelegationChoice> = {},
  input: AuthorizeInput = {},
) {
  const { code, verifier, redirectUri } = await authCode(session, choice, input)
  return token({
    grant_type: 'authorization_code',
    client_id: input.clientId ?? mcpClient.externalId,
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  })
}

async function grantState(accessToken: string): Promise<string | undefined> {
  const { rows } = await h.deps.store.query(
    'test.grant.state',
    `SELECT g.state FROM oauth.grants g JOIN oauth.tokens t ON t.grant_id = g.grant_id WHERE t.token_hash = $1`,
    [
      `sha256:${createHash('sha256').update(`exponetdb/auth-token/v1\naccess\n${accessToken}`).digest('hex')}`,
    ],
  )
  return rows[0]?.text('state')
}

beforeAll(async () => {
  h = await harness('exdb_it_auth_oauth')
  a = accessHarness(h)
  owner = await enrollFirstOwner(h)
  ownerSession = await signIn(h, owner)
  nobody = await invitePerson(h, ownerSession, 'nobody@example.test')
  nobodySession = await signIn(h, nobody)
  mcpClient = await activeMcpClient()
})

afterAll(async () => {
  await h?.db.drop()
})

describe('authorization request (oauth.md §4)', () => {
  it('stores a valid request and sends the browser to the consent page with an opaque handle', async () => {
    const { outcome } = await start()
    expect(outcome.kind).toBe('consent')
    if (outcome.kind !== 'consent') return
    expect(outcome.location).toMatch(
      new RegExp(`^${ORIGIN}/oauth/consent#request=exar_[A-Za-z0-9_-]{43}$`),
    )
    expect(outcome.binding).toMatch(/^exob_[A-Za-z0-9_-]{43}$/)
    expect(outcome.setBinding).toBe(true)
    // An existing binding of this browser is kept, so concurrent requests stay valid.
    const second = await start({}, outcome.binding)
    expect(second.outcome).toMatchObject({
      kind: 'consent',
      binding: outcome.binding,
      setBinding: false,
    })
  })

  it('never redirects before the client and the redirect URI are established (no open redirector)', async () => {
    const cases: [AuthorizeInput | string, string][] = [
      [{ clientId: 'exdb-dcr-unknownunknownunknownunknownunknown12345' }, 'client_unknown'],
      [{ clientId: 'https://client.example.test/never-approved.json' }, 'client_unknown'],
      [{ redirectUri: 'https://evil.example.test/callback' }, 'redirect_uri_invalid'],
      [{ redirectUri: `${CALLBACK}/` }, 'redirect_uri_invalid'],
      [{ redirectUri: `${CALLBACK}?x=1` }, 'redirect_uri_invalid'],
      [{ extra: `redirect_uri=${encodeURIComponent(CALLBACK)}` }, 'request_invalid'],
      [{ extra: `client_id=${encodeURIComponent('exponetdb-cli')}` }, 'request_invalid'],
      [{ clientId: 'exponetdb-web', redirectUri: CALLBACK }, 'client_unsupported'],
    ]
    for (const [input, reason] of cases) {
      const { outcome } = await start(typeof input === 'string' ? {} : input)
      expect(outcome, JSON.stringify(input)).toEqual({ kind: 'error', reason })
    }
    const missing = await oauth.startAuthorization(h.deps, m(), 'response_type=code', undefined)
    expect(missing).toEqual({ kind: 'error', reason: 'request_invalid' })
  })

  it('refuses a pending client locally: registration is not approval', async () => {
    const pending = `exdb-dcr-${randomBytes(32).toString('base64url')}`
    await h.deps.store.query(
      'test.client.pending',
      `INSERT INTO oauth.clients (client_id, external_id, registration, kind, state, display_name, redirect_uris,
                                  application_type, token_endpoint_auth_method, grant_types, metadata_fingerprint,
                                  created_at, state_changed_at)
       VALUES ($1, $2, 'dcr', 'mcp', 'pending', 'Pending Agent', ARRAY[$3], 'web', 'none',
               ARRAY['authorization_code'], $4, now(), now())`,
      [newId('cli', Date.now()), pending, CALLBACK, `sha256:${'1'.repeat(64)}`],
    )
    expect((await start({ clientId: pending })).outcome).toEqual({
      kind: 'error',
      reason: 'client_not_approved',
    })
  })

  it('answers every other error at the matched redirect URI with error, state and iss', async () => {
    const cases: [AuthorizeInput, string][] = [
      [{ extra: 'scope=targets.read' }, 'invalid_request'],
      [{ resource: `${ORIGIN}/other` }, 'invalid_target'],
      [{ resource: 'https://evil.example.test/api' }, 'invalid_target'],
      [{ scope: 'targets.read access.manage' }, 'invalid_scope'],
      [{ scope: 'plans.approve' }, 'invalid_scope'],
      [{ scope: 'api' }, 'invalid_scope'],
      [{ scope: 'offline_access' }, 'invalid_scope'],
      [{ scope: 'targets.*' }, 'invalid_scope'],
      [{ challenge: 'too-short' }, 'invalid_request'],
      [{ extra: 'request_uri=urn%3Aexample' }, 'invalid_request'],
      [{ extra: 'response_mode=fragment' }, 'invalid_request'],
    ]
    for (const [input, error] of cases) {
      const { outcome } = await start(input)
      expect(outcome.kind, JSON.stringify(input)).toBe('redirect')
      if (outcome.kind !== 'redirect') continue
      const url = new URL(outcome.location)
      expect(`${url.origin}${url.pathname}`).toBe(CALLBACK)
      expect(url.searchParams.get('error'), JSON.stringify(input)).toBe(error)
      expect(url.searchParams.get('state')).toBe('state-123')
      expect(url.searchParams.get('iss')).toBe(ORIGIN)
      expect(url.searchParams.get('code')).toBeNull()
    }
    const { challenge } = pkce()
    const plain = new URLSearchParams({
      response_type: 'code',
      client_id: mcpClient.externalId,
      redirect_uri: CALLBACK,
      scope: 'targets.read',
      state: 's',
      code_challenge: challenge,
      code_challenge_method: 'plain',
      resource: API,
    })
    const refused = await oauth.startAuthorization(h.deps, m(), plain.toString(), undefined)
    expect(refused.kind === 'redirect' && new URL(refused.location).searchParams.get('error')).toBe(
      'invalid_request',
    )
    const token = new URLSearchParams(plain)
    token.set('code_challenge_method', 'S256')
    token.set('response_type', 'token')
    const implicit = await oauth.startAuthorization(h.deps, m(), token.toString(), undefined)
    expect(
      implicit.kind === 'redirect' && new URL(implicit.location).searchParams.get('error'),
    ).toBe('unsupported_response_type')
  })

  it('lets the first-party CLI use any loopback port, for the REST API only', async () => {
    const ok = await start({
      clientId: CLI,
      redirectUri: 'http://127.0.0.1:49152/callback',
      scope: 'targets.read access.read',
    })
    expect(ok.outcome.kind).toBe('consent')
    const mcp = await start({
      clientId: CLI,
      redirectUri: 'http://127.0.0.1:49152/callback',
      resource: MCP,
    })
    expect(
      mcp.outcome.kind === 'redirect' && new URL(mcp.outcome.location).searchParams.get('error'),
    ).toBe('invalid_target')
  })
})

describe('consent (oauth.md §4)', () => {
  it('shows the request only to the browser that started it', async () => {
    const { outcome } = await start()
    const handle = handleOf(outcome)
    const view = await oauth.consentView(
      h.deps,
      ownerSession,
      handle,
      outcome.kind === 'consent' ? outcome.binding : undefined,
    )
    expect(view.client.clientId).toBe(mcpClient.externalId)
    expect(view.client.redirectHost).toBe('agent.example.test')
    expect(view.resource).toBe('api')
    expect(view.defaults.tiers).toEqual(['nonprod'])
    expect(view.scopes.map((s) => [s.scope, s.available])).toEqual([
      ['targets.read', true],
      ['schema.read', true],
    ])
    for (const binding of [undefined, `exob_${'A'.repeat(43)}`]) {
      const refused = await oauth.consentView(h.deps, ownerSession, handle, binding).catch((e) => e)
      expect(isAuthError(refused) ? refused.code : refused).toBe('AUTHORIZATION_REQUEST_INVALID')
    }
  })

  it('never lets a person delegate what they do not hold', async () => {
    const { outcome } = await start()
    const view = await oauth.consentView(
      h.deps,
      nobodySession,
      handleOf(outcome),
      outcome.kind === 'consent' ? outcome.binding : undefined,
    )
    expect(view.scopes.every((s) => !s.available && s.reason === 'not_held')).toBe(true)
    const refused = await decide(nobodySession, outcome).catch((e) => e)
    expect(isAuthError(refused) ? refused.code : refused).toBe('SCOPE_NOT_DELEGABLE')
  })

  it('needs an explicit acknowledgement for production and a fresh re-authentication for production writes', async () => {
    const write = { scope: 'targets.read migrations.apply:prod' }
    const first = await start(write)
    const unacknowledged = await decide(ownerSession, first.outcome, {
      scopes: ['targets.read'],
      tiers: ['nonprod', 'prod'],
    }).catch((e) => e)
    expect(isAuthError(unacknowledged) ? unacknowledged.code : unacknowledged).toBe(
      'PRODUCTION_CONFIRMATION_REQUIRED',
    )
    const second = await start(write)
    const stale = { ...ownerSession, reauthAgeSeconds: 3600 }
    const notFresh = await decide(stale, second.outcome, {
      scopes: ['targets.read', 'migrations.apply:prod'],
      tiers: ['prod'],
      acknowledgeProduction: true,
    }).catch((e) => e)
    expect(isAuthError(notFresh) ? notFresh.code : notFresh).toBe('REAUTH_REQUIRED')
    // A tiered scope needs its tier in the restriction.
    const third = await start(write)
    const mismatch = await decide(ownerSession, third.outcome, {
      scopes: ['migrations.apply:prod'],
      tiers: ['nonprod'],
    }).catch((e) => e)
    expect(isAuthError(mismatch) ? mismatch.code : mismatch).toBe('VALIDATION_FAILED')
    const fourth = await start(write)
    const redirect = await decide(ownerSession, fourth.outcome, {
      scopes: ['targets.read', 'migrations.apply:prod'],
      tiers: ['prod'],
      acknowledgeProduction: true,
    })
    expect(new URL(redirect).searchParams.get('code')).toMatch(/^exac_/)
  })

  it('accepts only requested scopes, decides once and denies with access_denied', async () => {
    const { outcome } = await start()
    const extra = await decide(ownerSession, outcome, { scopes: ['diagnostics.read'] }).catch(
      (e) => e,
    )
    expect(isAuthError(extra) ? extra.code : extra).toBe('VALIDATION_FAILED')
    const denied = new URL(await decide(ownerSession, outcome, { decision: 'deny' }))
    expect(denied.searchParams.get('error')).toBe('access_denied')
    expect(denied.searchParams.get('state')).toBe('state-123')
    expect(denied.searchParams.get('iss')).toBe(ORIGIN)
    const again = await decide(ownerSession, outcome).catch((e) => e)
    expect(isAuthError(again) ? again.code : again).toBe('AUTHORIZATION_REQUEST_INVALID')
  })

  it('returns the code with state and iss, and refuses an expired request', async () => {
    const { outcome } = await start()
    const url = new URL(await decide(ownerSession, outcome))
    expect(url.searchParams.get('code')).toMatch(/^exac_[A-Za-z0-9_-]{43}$/)
    expect(url.searchParams.get('state')).toBe('state-123')
    expect(url.searchParams.get('iss')).toBe(ORIGIN)
    const late = await start()
    await age(
      h,
      `UPDATE oauth.authorization_requests SET created_at = created_at - interval '11 minutes',
              expires_at = expires_at - interval '11 minutes' WHERE decision IS NULL`,
      [],
    )
    const expired = await decide(ownerSession, late.outcome).catch((e) => e)
    expect(isAuthError(expired) ? expired.code : expired).toBe('AUTHORIZATION_REQUEST_INVALID')
  })
})

describe('authorization code (oauth.md §5)', () => {
  it('exchanges a code once, with PKCE S256 and the exact redirect URI', async () => {
    const { code, verifier } = await authCode()
    const base = { grant_type: 'authorization_code', client_id: mcpClient.externalId, code }
    expect(
      await oauthError(token({ ...base, redirect_uri: CALLBACK, code_verifier: pkce().verifier })),
    ).toBe('invalid_grant')
    expect(
      await oauthError(token({ ...base, redirect_uri: `${CALLBACK}/`, code_verifier: verifier })),
    ).toBe('invalid_grant')
    expect(await oauthError(token({ ...base, code_verifier: verifier }))).toBe('invalid_grant')
    expect(
      await oauthError(
        token({ ...base, redirect_uri: CALLBACK, code_verifier: verifier, resource: MCP }),
      ),
    ).toBe('invalid_target')
    const issued = await token({
      ...base,
      redirect_uri: CALLBACK,
      code_verifier: verifier,
      resource: API,
    })
    expect(issued.access_token).toMatch(/^exat_[A-Za-z0-9_-]{43}$/)
    expect(issued.refresh_token).toMatch(/^exrt_[A-Za-z0-9_-]{43}$/)
    expect(issued.token_type).toBe('Bearer')
    expect(issued.expires_in).toBeGreaterThan(590)
    expect(issued.expires_in).toBeLessThanOrEqual(600)
    expect(issued.scope).toBe('targets.read schema.read')
    // A replayed code revokes the grant and every token issued from it.
    expect(
      await oauthError(token({ ...base, redirect_uri: CALLBACK, code_verifier: verifier })),
    ).toBe('invalid_grant')
    expect(await grantState(issued.access_token)).toBe('revoked')
    expect((await oauth.authenticateBearer(h.deps.store, issued.access_token, 'api')).ok).toBe(
      false,
    )
  })

  it('binds the code to its client and lives 60 seconds', async () => {
    const other = await activeMcpClient('Other Agent')
    const { code, verifier } = await authCode()
    expect(
      await oauthError(
        token({
          grant_type: 'authorization_code',
          client_id: other.externalId,
          code,
          redirect_uri: CALLBACK,
          code_verifier: verifier,
        }),
      ),
    ).toBe('invalid_grant')
    const late = await authCode()
    await age(
      h,
      `UPDATE oauth.authorization_codes SET created_at = created_at - interval '61 seconds',
              expires_at = expires_at - interval '61 seconds' WHERE consumed_at IS NULL`,
      [],
    )
    expect(
      await oauthError(
        token({
          grant_type: 'authorization_code',
          client_id: mcpClient.externalId,
          code: late.code,
          redirect_uri: CALLBACK,
          code_verifier: late.verifier,
        }),
      ),
    ).toBe('invalid_grant')
  })

  it('lets exactly one of two concurrent exchanges of a code win', async () => {
    const { code, verifier } = await authCode()
    const form = {
      grant_type: 'authorization_code',
      client_id: mcpClient.externalId,
      code,
      redirect_uri: CALLBACK,
      code_verifier: verifier,
    }
    const results = await Promise.allSettled([token(form), token(form)])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find((r) => r.status === 'rejected')
    expect(
      rejected?.status === 'rejected' &&
        rejected.reason instanceof oauth.OAuthError &&
        rejected.reason.error,
    ).toBe('invalid_grant')
  })

  it('refuses client secrets, an Authorization header, repeated parameters and unknown grants', async () => {
    const form = { grant_type: 'authorization_code', client_id: mcpClient.externalId, code: 'x' }
    expect(await oauthError(token({ ...form, client_secret: 'secret' }))).toBe('invalid_client')
    expect(
      await oauthError(
        oauth.tokenEndpoint({ auth: h.deps }, m(), {
          ...tokenRequest(form),
          authorizationHeader: true,
        }),
      ),
    ).toBe('invalid_client')
    expect(
      await oauthError(
        oauth.tokenEndpoint({ auth: h.deps }, m(), {
          body: `${new URLSearchParams(form).toString()}&code=y`,
          contentType: 'application/x-www-form-urlencoded',
          authorizationHeader: false,
        }),
      ),
    ).toBe('invalid_request')
    expect(
      await oauthError(
        oauth.tokenEndpoint({ auth: h.deps }, m(), {
          body: JSON.stringify(form),
          contentType: 'application/json',
          authorizationHeader: false,
        }),
      ),
    ).toBe('invalid_request')
    expect(await oauthError(token({ ...form, grant_type: 'password' }))).toBe(
      'unsupported_grant_type',
    )
    expect(await oauthError(token({ ...form, grant_type: 'client_credentials' }))).toBe(
      'unauthorized_client',
    )
    expect(await oauthError(token({ ...form, client_id: 'unknown-client' }))).toBe('invalid_client')
    expect(
      await oauthError(
        token({
          ...form,
          client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
          client_assertion: 'a.b.c',
        }),
      ),
    ).toBe('invalid_client')
  })
})

describe('refresh tokens (oauth.md §5, RFC 9700 §4.14)', () => {
  it('rotates on every use and may narrow the scope', async () => {
    const first = await tokens()
    const second = await token({
      grant_type: 'refresh_token',
      client_id: mcpClient.externalId,
      refresh_token: first.refresh_token ?? '',
      scope: 'targets.read',
    })
    expect(second.refresh_token).not.toBe(first.refresh_token)
    expect(second.scope).toBe('targets.read')
    expect(
      await oauthError(
        token({
          grant_type: 'refresh_token',
          client_id: mcpClient.externalId,
          refresh_token: second.refresh_token ?? '',
          scope: 'targets.read diagnostics.read',
        }),
      ),
    ).toBe('invalid_scope')
    // The full grant scopes are kept by the new refresh token.
    const third = await token({
      grant_type: 'refresh_token',
      client_id: mcpClient.externalId,
      refresh_token: second.refresh_token ?? '',
    })
    expect(third.scope).toBe('targets.read schema.read')
  })

  it('revokes the whole family when a rotated-out refresh token comes back', async () => {
    const first = await tokens()
    const second = await token({
      grant_type: 'refresh_token',
      client_id: mcpClient.externalId,
      refresh_token: first.refresh_token ?? '',
    })
    expect(
      await oauthError(
        token({
          grant_type: 'refresh_token',
          client_id: mcpClient.externalId,
          refresh_token: first.refresh_token ?? '',
        }),
      ),
    ).toBe('invalid_grant')
    expect(await grantState(second.access_token)).toBe('revoked')
    expect((await oauth.authenticateBearer(h.deps.store, second.access_token, 'api')).ok).toBe(
      false,
    )
    expect(
      await oauthError(
        token({
          grant_type: 'refresh_token',
          client_id: mcpClient.externalId,
          refresh_token: second.refresh_token ?? '',
        }),
      ),
    ).toBe('invalid_grant')
    const { rows } = await h.db.asSuperuser((client) =>
      client.query(
        `SELECT count(*)::int AS n FROM audit.audit_events WHERE action = 'oauth.token_refresh_reuse_detected'`,
      ),
    )
    expect(rows[0]?.n).toBeGreaterThanOrEqual(1)
  })

  it('has no grace window: of two concurrent refreshes one wins and the family ends', async () => {
    const first = await tokens()
    const form = {
      grant_type: 'refresh_token',
      client_id: mcpClient.externalId,
      refresh_token: first.refresh_token ?? '',
    }
    const results = await Promise.allSettled([token(form), token(form)])
    const won = results.filter((r) => r.status === 'fulfilled')
    expect(won).toHaveLength(1)
    const winner = won[0]
    if (winner?.status !== 'fulfilled') return
    expect(await grantState(winner.value.access_token)).toBe('revoked')
  })

  it('refuses a refresh token of another client and an unknown one', async () => {
    const first = await tokens()
    const other = await activeMcpClient('Third Agent')
    expect(
      await oauthError(
        token({
          grant_type: 'refresh_token',
          client_id: other.externalId,
          refresh_token: first.refresh_token ?? '',
        }),
      ),
    ).toBe('invalid_grant')
    expect(
      await oauthError(
        token({
          grant_type: 'refresh_token',
          client_id: mcpClient.externalId,
          refresh_token: `exrt_${'A'.repeat(43)}`,
        }),
      ),
    ).toBe('invalid_grant')
  })
})

describe('revocation (RFC 7009)', () => {
  const revoke = (form: Record<string, string>) =>
    oauth.revocationEndpoint({ auth: h.deps }, m(), tokenRequest(form))

  it('ends the grant for a refresh token and only the token for an access token', async () => {
    const one = await tokens()
    await revoke({ client_id: mcpClient.externalId, token: one.access_token })
    expect((await oauth.authenticateBearer(h.deps.store, one.access_token, 'api')).ok).toBe(false)
    expect(await grantState(one.access_token)).toBe('active')
    await revoke({ client_id: mcpClient.externalId, token: one.refresh_token ?? '' })
    expect(await grantState(one.access_token)).toBe('revoked')
  })

  it('answers success for unknown tokens and tokens of other clients, changing nothing', async () => {
    const one = await tokens()
    const other = await activeMcpClient('Revoking Agent')
    await revoke({ client_id: other.externalId, token: one.refresh_token ?? '' })
    expect(await grantState(one.access_token)).toBe('active')
    await revoke({ client_id: mcpClient.externalId, token: 'not-a-token' })
    expect(
      await oauthError(
        revoke({ client_id: mcpClient.externalId, token: `exak_${'A'.repeat(43)}` }),
      ),
    ).toBe('unsupported_token_type')
  })
})

describe('bearer validation and the central engine (oauth.md §5, authorization.md §1.2)', () => {
  const authorizer = new Authorizer(new ControlPlaneSubjectResolver())

  it('authenticates a live token for its own resource only', async () => {
    const issued = await tokens()
    const at = await oauth.authenticateBearer(h.deps.store, issued.access_token, 'api')
    expect(at.ok).toBe(true)
    if (!at.ok) return
    expect(at.principal).toMatchObject({
      kind: 'delegated',
      identityId: owner.identityId,
      identityKind: 'human',
      client: 'mcp',
      delegation: {
        resource: 'api',
        restrictions: { tiers: ['nonprod'], targets: { kind: 'all' } },
      },
    })
    expect([...at.principal.delegation.scopes]).toEqual(['targets.read', 'schema.read'])
    expect((await oauth.authenticateBearer(h.deps.store, issued.access_token, 'mcp')).ok).toBe(
      false,
    )
    expect((await oauth.authenticateBearer(h.deps.store, `exat_${'B'.repeat(43)}`, 'api')).ok).toBe(
      false,
    )
    await age(
      h,
      `UPDATE oauth.tokens SET issued_at = issued_at - interval '20 minutes',
              expires_at = expires_at - interval '20 minutes' WHERE kind = 'access'`,
      [],
    )
    expect((await oauth.authenticateBearer(h.deps.store, issued.access_token, 'api')).ok).toBe(
      false,
    )
  })

  it('decides through the live role bindings: a scope never adds a permission', async () => {
    const issued = await tokens()
    const at = await oauth.authenticateBearer(h.deps.store, issued.access_token, 'api')
    if (!at.ok) throw new Error('token')
    const allowed = await authorizer.authorize(
      h.deps.store,
      { action: 'installation.get', principal: at.principal, resource: 'api' },
      { kind: 'installation' },
    )
    expect(allowed.allowed).toBe(true)
    const admin = await authorizer.authorize(
      h.deps.store,
      { action: 'identity.list', principal: at.principal, resource: 'api' },
      { kind: 'installation' },
    )
    expect(admin).toMatchObject({ allowed: false })
    const wrongResource = await authorizer.authorize(
      h.deps.store,
      { action: 'installation.get', principal: at.principal, resource: 'mcp' },
      { kind: 'installation' },
    )
    expect(wrongResource).toMatchObject({ allowed: false, reason: 'resource' })
  })

  it('ends every grant of an identity that is disabled, and of a client that is disabled', async () => {
    const person = await invitePerson(h, ownerSession, 'delegate@example.test')
    await bindRole(h, a, ownerSession, person.identityId, 'viewer')
    const session = await signIn(h, person)
    const issued = await tokens(session)
    expect((await oauth.authenticateBearer(h.deps.store, issued.access_token, 'api')).ok).toBe(true)
    const request = await auditRequest(h.deps.keys, m())
    await h.deps.store.transaction('test.disable', (tx) =>
      disableIdentity(tx, h.deps, ownerSession, request, idn(person.identityId), undefined),
    )
    expect((await oauth.authenticateBearer(h.deps.store, issued.access_token, 'api')).ok).toBe(
      false,
    )
    expect(await grantState(issued.access_token)).toBe('revoked')

    const client = await activeMcpClient('Disabled Agent')
    const viaClient = await tokens(ownerSession, {}, { clientId: client.externalId })
    await h.deps.store.query(
      'test.client.disable',
      `UPDATE oauth.clients SET state = 'disabled' WHERE client_id = $1`,
      [client.clientId],
    )
    expect((await oauth.authenticateBearer(h.deps.store, viaClient.access_token, 'api')).ok).toBe(
      false,
    )
    expect(await grantState(viaClient.access_token)).toBe('revoked')
  })

  it('audits grant creation without a token, code or address', async () => {
    const { rows } = await h.db.asSuperuser((client) =>
      client.query(
        `SELECT event::jsonb AS event FROM audit.audit_events WHERE action LIKE 'oauth.%' ORDER BY seq`,
      ),
    )
    expect(rows.length).toBeGreaterThan(3)
    const text = JSON.stringify(rows)
    expect(text).not.toMatch(/ex(at|rt|ac|ar|ob)_[A-Za-z0-9_-]{20}/)
    expect(text).not.toMatch(/198\.51\.|example\.test"/)
    const created = rows
      .map((r) => r.event)
      .find((e) => isJsonObject(e) && e['action'] === 'oauth.grant_created')
    expect(created).toMatchObject({ client: { kind: 'mcp' }, changes: { kind: 'delegated' } })
  })
})

describe('rate limits of the protocol endpoints (oauth.md §5)', () => {
  it('limit per address, answer 429 with Retry-After, and never store an address', async () => {
    const address = meta('203.0.113.77')
    const limit = oauth.OAUTH_RATE_LIMITS['token-ip'].limit
    for (let i = 0; i < limit; i++) {
      expect(
        await oauthError(
          oauth.tokenEndpoint({ auth: h.deps }, address, tokenRequest({ grant_type: 'password' })),
        ),
      ).toBe('invalid_client')
    }
    const refused = await oauth
      .tokenEndpoint({ auth: h.deps }, address, tokenRequest({ grant_type: 'password' }))
      .then(
        () => undefined,
        (error: unknown) => error,
      )
    expect(refused).toBeInstanceOf(oauth.OAuthError)
    if (refused instanceof oauth.OAuthError) {
      expect(refused.error).toBe('temporarily_unavailable')
      expect(refused.status).toBe(429)
      expect(refused.retryAfterSeconds).toBeGreaterThan(0)
    }
    // Another address is not affected.
    expect(
      await oauthError(
        oauth.tokenEndpoint(
          { auth: h.deps },
          meta('203.0.113.78'),
          tokenRequest({ grant_type: 'password' }),
        ),
      ),
    ).toBe('invalid_client')

    const authorizeLimit = oauth.OAUTH_RATE_LIMITS['authorize-ip'].limit
    for (let i = 0; i < authorizeLimit; i++) {
      await oauth.startAuthorization(h.deps, address, 'response_type=code', undefined)
    }
    expect(
      await oauth.startAuthorization(h.deps, address, 'response_type=code', undefined),
    ).toEqual(expect.objectContaining({ kind: 'error', reason: 'rate_limited' }))

    const { rows } = await h.db.asSuperuser((c) =>
      c.query(
        `SELECT bucket FROM oauth.rate_limits WHERE bucket LIKE 'token-ip:%' OR bucket LIKE 'authorize-ip:%'`,
      ),
    )
    expect(rows.length).toBeGreaterThan(0)
    expect(JSON.stringify(rows)).not.toMatch(/203\.0\.113|198\.51\./)
  })
})

describe('worker prune (data-retention.md §1)', () => {
  const worker = () => h.db.store('exdb_worker')
  const grantIdOf = async (accessToken: string): Promise<string> => {
    const { rows } = await h.deps.store.query(
      'test.grant.of',
      `SELECT t.grant_id FROM oauth.tokens t WHERE t.token_hash = $1`,
      [
        `sha256:${createHash('sha256').update(`exponetdb/auth-token/v1\naccess\n${accessToken}`).digest('hex')}`,
      ],
    )
    const id = rows[0]?.text('grant_id')
    if (id === undefined) {
      throw new Error('no grant')
    }
    return id
  }
  const count = async (sql: string, params: readonly unknown[] = []): Promise<number> =>
    h.db.asSuperuser(async (c) => Number((await c.query(sql, [...params])).rows[0]?.n ?? -1))
  const pendingDcr = async (): Promise<string> => {
    const clientId = newId('cli', Date.now())
    await h.deps.store.query(
      'test.client.pending',
      `INSERT INTO oauth.clients (client_id, external_id, registration, kind, state, display_name, redirect_uris,
                                  application_type, token_endpoint_auth_method, grant_types, metadata_fingerprint,
                                  created_at, state_changed_at)
       VALUES ($1, $2, 'dcr', 'mcp', 'pending', 'Pending Agent', ARRAY[$3], 'web', 'none',
               ARRAY['authorization_code'], $4, now(), now())`,
      [
        clientId,
        `exdb-dcr-${randomBytes(32).toString('base64url')}`,
        CALLBACK,
        `sha256:${randomBytes(32).toString('hex')}`,
      ],
    )
    return clientId
  }
  const assertion = async (): Promise<void> => {
    await h.deps.store.query(
      'test.assertion',
      `INSERT INTO oauth.client_assertions (client_id, jti_hash, expires_at)
       VALUES ($1, $2, clock_timestamp() + interval '5 minutes')`,
      [mcpClient.clientId, `sha256:${randomBytes(32).toString('hex')}`],
    )
  }
  const device = () =>
    oauth.startDeviceAuthorization(
      { auth: h.deps, grants: { deviceCode: oauth.deviceCodeGrant } },
      m(),
      tokenRequest({ client_id: CLI, scope: 'targets.read', resource: API }),
    )

  it('removes ended protocol state inside the guards and nothing that is live', async () => {
    // A family rotated twice, then revoked: its refresh tokens go 30 days after the grant ended.
    const first = await tokens()
    const second = await token({
      grant_type: 'refresh_token',
      client_id: mcpClient.externalId,
      refresh_token: first.refresh_token ?? '',
    })
    const third = await token({
      grant_type: 'refresh_token',
      client_id: mcpClient.externalId,
      refresh_token: second.refresh_token ?? '',
    })
    await oauth.revocationEndpoint(
      { auth: h.deps },
      m(),
      tokenRequest({ client_id: mcpClient.externalId, token: third.refresh_token ?? '' }),
    )
    const ended = await grantIdOf(first.access_token)
    const oldDcr = await pendingDcr()
    await device()
    await assertion()
    await start()

    await age(
      h,
      `UPDATE oauth.grants SET revoked_at = revoked_at - interval '40 days' WHERE grant_id = $1`,
      [ended],
    )
    await age(
      h,
      `UPDATE oauth.tokens SET issued_at = issued_at - interval '2 days', expires_at = expires_at - interval '2 days'
        WHERE kind = 'access'`,
      [],
    )
    await age(
      h,
      `UPDATE oauth.authorization_requests SET created_at = created_at - interval '2 days',
              expires_at = expires_at - interval '2 days'`,
      [],
    )
    await age(
      h,
      `UPDATE oauth.authorization_codes SET created_at = created_at - interval '2 days',
              expires_at = expires_at - interval '2 days'`,
      [],
    )
    await age(
      h,
      `UPDATE oauth.device_codes SET created_at = created_at - interval '2 days',
              expires_at = expires_at - interval '2 days'`,
      [],
    )
    await age(
      h,
      `UPDATE oauth.client_assertions SET used_at = used_at - interval '3 hours',
              expires_at = expires_at - interval '3 hours'`,
      [],
    )
    await age(h, `UPDATE oauth.rate_limits SET updated_at = updated_at - interval '2 days'`, [])
    await age(
      h,
      `UPDATE oauth.clients SET created_at = created_at - interval '9 days',
              state_changed_at = state_changed_at - interval '9 days',
              pending_expires_at = pending_expires_at - interval '9 days'
        WHERE client_id = $1`,
      [oldDcr],
    )

    // Live state created after the aging must survive the run.
    const live = await tokens()
    const liveGrant = await grantIdOf(live.access_token)
    const freshDcr = await pendingDcr()
    await device()
    await assertion()
    await start()
    const grantsBefore = await count('SELECT count(*)::int AS n FROM oauth.grants')
    const refreshOfEnded = await count(
      `SELECT count(*)::int AS n FROM oauth.tokens WHERE grant_id = $1 AND kind = 'refresh'`,
      [ended],
    )
    expect(refreshOfEnded).toBe(3)

    const pruned = await oauth.pruneOAuthState(worker())
    expect(pruned.refreshTokens).toBeGreaterThanOrEqual(3)
    expect(pruned.accessTokens).toBeGreaterThan(0)
    expect(pruned.requests).toBeGreaterThan(0)
    expect(pruned.codes).toBeGreaterThan(0)
    expect(pruned.deviceCodes).toBeGreaterThan(0)
    expect(pruned.assertions).toBe(1)
    expect(pruned.rateLimits).toBeGreaterThan(0)
    expect(pruned.dcrClients).toBe(1)

    expect(
      await count(`SELECT count(*)::int AS n FROM oauth.tokens WHERE grant_id = $1`, [ended]),
    ).toBe(0)
    expect(
      await count(
        `SELECT count(*)::int AS n FROM oauth.tokens WHERE expires_at < now() - interval '1 day' AND kind = 'access'`,
      ),
    ).toBe(0)
    expect(
      await count(
        `SELECT count(*)::int AS n FROM oauth.authorization_requests WHERE expires_at < now() - interval '1 day'`,
      ),
    ).toBe(0)
    expect(
      await count(`SELECT count(*)::int AS n FROM oauth.clients WHERE client_id = $1`, [oldDcr]),
    ).toBe(0)
    // Nothing live went: the live grant's tokens, the fresh request, code, device code,
    // assertion and registration, every grant and every approved client stay.
    expect((await oauth.authenticateBearer(h.deps.store, live.access_token, 'api')).ok).toBe(true)
    expect(
      await count(`SELECT count(*)::int AS n FROM oauth.tokens WHERE grant_id = $1`, [liveGrant]),
    ).toBe(2)
    expect(
      await count(
        'SELECT count(*)::int AS n FROM oauth.authorization_requests WHERE expires_at > now()',
      ),
    ).toBeGreaterThanOrEqual(1)
    expect(
      await count('SELECT count(*)::int AS n FROM oauth.device_codes WHERE expires_at > now()'),
    ).toBe(1)
    expect(await count('SELECT count(*)::int AS n FROM oauth.client_assertions')).toBe(1)
    expect(
      await count(`SELECT count(*)::int AS n FROM oauth.clients WHERE client_id = $1`, [freshDcr]),
    ).toBe(1)
    expect(await count('SELECT count(*)::int AS n FROM oauth.grants')).toBe(grantsBefore)
    expect(
      await count(
        `SELECT count(*)::int AS n FROM oauth.clients WHERE client_id = $1 AND state = 'active'`,
        [mcpClient.clientId],
      ),
    ).toBe(1)

    // A second run finds nothing (idempotent).
    const again = await oauth.pruneOAuthState(worker())
    expect(Object.values(again).every((n) => n === 0)).toBe(true)
  })

  it('cannot remove live state or read a secret hash even when asked directly', async () => {
    await expect(
      worker().query('test.prune.live', `DELETE FROM oauth.tokens WHERE kind = 'access'`),
    ).rejects.toMatchObject({ sqlstate: 'EXO06' })
    await expect(
      worker().query('test.prune.refresh', `DELETE FROM oauth.tokens WHERE kind = 'refresh'`),
    ).rejects.toMatchObject({ sqlstate: 'EXO06' })
    await expect(
      worker().query('test.prune.client', 'DELETE FROM oauth.clients WHERE client_id = $1', [
        mcpClient.clientId,
      ]),
    ).rejects.toMatchObject({ sqlstate: 'EXO01' })
    await expect(
      worker().query('test.prune.grants', 'DELETE FROM oauth.grants'),
    ).rejects.toMatchObject({ sqlstate: '42501' })
    for (const [table, column] of [
      ['oauth.tokens', 'token_hash'],
      ['oauth.authorization_codes', 'code_hash'],
      ['oauth.device_codes', 'user_code_hash'],
      ['oauth.client_assertions', 'jti_hash'],
      ['oauth.api_keys', 'key_hash'],
      ['oauth.clients', 'jwks'],
    ] as const) {
      await expect(
        worker().query('test.prune.read', `SELECT ${column} FROM ${table} LIMIT 1`),
        `${table}.${column}`,
      ).rejects.toMatchObject({ sqlstate: '42501' })
    }
  })
})

describe('scope catalog (readiness check scope_catalog)', () => {
  it('accepts the seeded catalog and refuses one that differs from the release', async () => {
    await oauth.checkScopeCatalog(h.deps.store)
    expect(oauth.releaseScopeCatalog()).toContain(
      'migrations.apply:prod|migrations.apply|prod|true|ci,cli,mcp|false|true',
    )
    expect(oauth.releaseScopeCatalog().some((row) => row.startsWith('plans.approve|'))).toBe(false)
    expect(oauth.releaseScopeCatalog().some((row) => row.startsWith('api|'))).toBe(false)
    // Test-only tampering with the guards off; the row is restored right after.
    await age(h, `UPDATE oauth.scopes SET write = false WHERE scope = 'migrations.apply:prod'`, [])
    try {
      await expect(oauth.checkScopeCatalog(h.deps.store)).rejects.toMatchObject({
        code: 'scope_catalog_mismatch',
      })
    } finally {
      await age(h, `UPDATE oauth.scopes SET write = true WHERE scope = 'migrations.apply:prod'`, [])
    }
    await oauth.checkScopeCatalog(h.deps.store)
  })
})
