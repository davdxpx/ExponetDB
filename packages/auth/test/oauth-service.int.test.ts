import { generateKeyPairSync, randomBytes } from 'node:crypto'
import type { PublicJwk } from '@exponetdb/contracts'
import { expectOk, type IdentityId, parseId } from '@exponetdb/kernel'
import { exportJWK, generateKeyPair, type JWTPayload, SignJWT } from 'jose'
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
import { type AccessHarness, accessHarness, bindRole, signIn } from './support/access.ts'
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
 * Service accounts against PostgreSQL 17 (G3B items: no human credentials,
 * `private_key_jwt` with the jose library, assertion replay and algorithm
 * attacks refused, key rotation without ending grants, machine grants,
 * API keys shown once and stored as hashes, lifecycle revocation, live RBAC
 * for the service identity).
 */
let h: Harness
let a: AccessHarness
let owner: Enrolled
let session: SessionContext
let serviceId: IdentityId
let client: oauth.OAuthClientRecord
type PrivateKey = Awaited<ReturnType<typeof generateKeyPair>>['privateKey']
let signing: { privateKey: PrivateKey; jwk: PublicJwk }

const TOKEN_ENDPOINT = `${ORIGIN}/oauth/token`
let ip = 0
const m = () => {
  ip += 1
  return meta(`198.51.${Math.floor(ip / 250)}.${(ip % 250) + 1}`)
}

async function ecKey(kid: string) {
  const pair = await generateKeyPair('ES256', { extractable: true })
  const exported = await exportJWK(pair.publicKey)
  const jwk = {
    kty: 'EC',
    crv: 'P-256',
    x: String(exported.x),
    y: String(exported.y),
    kid,
    alg: 'ES256',
    use: 'sig',
  } satisfies PublicJwk
  return { privateKey: pair.privateKey, jwk }
}

async function change<T>(
  fn: (
    tx: Parameters<Parameters<typeof h.deps.store.transaction>[1]>[0],
    request: Awaited<ReturnType<typeof auditRequest>>,
  ) => Promise<T>,
) {
  const request = await auditRequest(h.deps.keys, m())
  return h.deps.store.transaction('test.change', (tx) => fn(tx, request))
}

async function assertion(
  claims: Partial<JWTPayload> = {},
  options: { readonly key?: PrivateKey; readonly kid?: string; readonly alg?: string } = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  return new SignJWT({ jti: randomBytes(16).toString('hex'), ...claims })
    .setProtectedHeader({ alg: options.alg ?? 'ES256', kid: options.kid ?? signing.jwk.kid })
    .setIssuer(claims.iss ?? client.externalId)
    .setSubject(claims.sub ?? client.externalId)
    .setAudience(claims.aud ?? ORIGIN)
    .setIssuedAt(claims.iat ?? now)
    .setExpirationTime(claims.exp ?? now + 60)
    .sign(options.key ?? signing.privateKey)
}

const deps = () => ({
  auth: h.deps,
  assertions: oauth.assertionVerifier(h.deps),
  grants: {
    clientCredentials: (
      tx: Parameters<NonNullable<oauth.ExtraGrants['clientCredentials']>>[0],
      c: oauth.OAuthClientRecord,
      p: oauth.ProtocolParams,
    ) => oauth.clientCredentialsGrant(tx, c, p, ORIGIN),
  },
})

async function token(jwt: string, extra: Record<string, string> = {}) {
  return oauth.tokenEndpoint(deps(), m(), {
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: jwt,
      ...extra,
    }).toString(),
    contentType: 'application/x-www-form-urlencoded',
    authorizationHeader: false,
  })
}

async function refusal(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise
    return undefined
  } catch (error) {
    if (error instanceof oauth.OAuthError) return error.error
    if (isAuthError(error)) return error.code
    throw error
  }
}

beforeAll(async () => {
  h = await harness('exdb_it_auth_oauth_service')
  a = accessHarness(h)
  owner = await enrollFirstOwner(h)
  session = await signIn(h, owner)
  signing = await ecKey('key-1')
})

afterAll(async () => {
  await h?.db.drop()
})

describe('service accounts (identity.md §5)', () => {
  it('creates a service identity with a responsible person and nothing else', async () => {
    serviceId = await change((tx, request) =>
      oauth.createServiceAccount(tx, h.deps, session, request, { displayName: 'CI pipeline' }),
    )
    const [view] = await oauth.serviceAccountViews(h.deps.store, ORIGIN, {
      identityId: serviceId,
      limit: 1,
    })
    expect(view).toMatchObject({
      id: serviceId,
      displayName: 'CI pipeline',
      state: 'active',
      responsibleIdentityId: owner.identityId,
      client: null,
      apiKeys: [],
      grants: [],
    })
    expect(view?.label).toMatch(/^service #\d+$/)
    const { rows } = await h.db.asSuperuser((c) =>
      c.query(
        `SELECT (SELECT count(*) FROM auth.factors WHERE identity_id = $1)::int AS factors,
                (SELECT count(*) FROM auth.role_bindings WHERE identity_id = $1)::int AS bindings,
                (SELECT email FROM auth.identities WHERE identity_id = $1) AS email`,
        [serviceId],
      ),
    )
    expect(rows[0]).toEqual({ factors: 0, bindings: 0, email: null })
  })

  it('registers one private_key_jwt client with public keys only', async () => {
    client = await change((tx, request) =>
      oauth.registerServiceClient(tx, h.deps, session, request, serviceId, [signing.jwk]),
    )
    expect(client).toMatchObject({
      registration: 'pre_registered',
      kind: 'ci',
      state: 'active',
      tokenEndpointAuthMethod: 'private_key_jwt',
      grantTypes: ['client_credentials'],
      serviceIdentityId: serviceId,
    })
    expect(client.externalId).toBe(client.clientId)
    expect(oauth.clientView(client).keys).toEqual([
      {
        kid: 'key-1',
        kty: 'EC',
        alg: 'ES256',
        thumbprint: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      },
    ])
    expect(
      await refusal(
        change((tx, request) =>
          oauth.registerServiceClient(tx, h.deps, session, request, serviceId, [signing.jwk]),
        ),
      ),
    ).toBe('CONFLICT')
    const weak = generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey.export({
      format: 'jwk',
    })
    expect(
      await refusal(
        oauth.checkKeys([{ kty: 'RSA', n: String(weak.n), e: String(weak.e), kid: 'weak' }]),
      ),
    ).toBe('VALIDATION_FAILED')
  })

  it('bounds machine grants: ci scopes only, held by the creator, production writes acknowledged', async () => {
    const create = (authority: oauth.MachineAuthority & { lifetimeDays: number }) =>
      change((tx, request) =>
        oauth.createMachineGrant(tx, h.deps, session, request, serviceId, authority),
      )
    expect(
      await refusal(
        create({
          scopes: ['access.read'],
          restrictions: { tiers: ['nonprod'], targets: { kind: 'all' } },
          lifetimeDays: 30,
        }),
      ),
    ).toBe('SCOPE_NOT_DELEGABLE')
    expect(
      await refusal(
        create({
          scopes: ['migrations.apply:prod'],
          restrictions: { tiers: ['prod'], targets: { kind: 'all' } },
          lifetimeDays: 30,
        }),
      ),
    ).toBe('PRODUCTION_CONFIRMATION_REQUIRED')
    expect(
      await refusal(
        create({
          scopes: ['migrations.apply:prod'],
          restrictions: { tiers: ['nonprod'], targets: { kind: 'all' } },
          lifetimeDays: 30,
        }),
      ),
    ).toBe('VALIDATION_FAILED')
    const grantId = await create({
      scopes: ['targets.read', 'migrations.plan'],
      restrictions: { tiers: ['nonprod'], targets: { kind: 'all' } },
      lifetimeDays: 90,
    })
    const [view] = await oauth.listGrantViews(h.deps.store, ORIGIN, { grantId, limit: 1 })
    expect(view).toMatchObject({
      kind: 'machine',
      identityId: serviceId,
      resource: 'api',
      state: 'active',
      consentAt: null,
    })
  })
})

describe('private_key_jwt and client_credentials (RFC 7523, RFC 6749 §4.4)', () => {
  it('issues a short access token without a refresh token to a valid assertion, once', async () => {
    const jwt = await assertion()
    const issued = await token(jwt)
    expect(issued.access_token).toMatch(/^exat_/)
    expect(issued).not.toHaveProperty('refresh_token')
    expect(issued.scope).toBe('targets.read migrations.plan')
    expect(await refusal(token(jwt))).toBe('invalid_client')
    const narrowed = await token(await assertion(), { scope: 'targets.read' })
    expect(narrowed.scope).toBe('targets.read')
    expect(await refusal(token(await assertion(), { scope: 'audit.read' }))).toBe('invalid_scope')
    expect(await refusal(token(await assertion(), { resource: `${ORIGIN}/mcp` }))).toBe(
      'invalid_target',
    )
  })

  it('refuses forged, foreign, expired and unbounded assertions', async () => {
    const other = await ecKey('key-1')
    const now = Math.floor(Date.now() / 1000)
    const unsigned = `${Buffer.from(JSON.stringify({ alg: 'none', kid: 'key-1' })).toString('base64url')}.${Buffer.from(
      JSON.stringify({
        iss: client.externalId,
        sub: client.externalId,
        aud: ORIGIN,
        exp: now + 60,
        iat: now,
        jti: 'x',
      }),
    ).toString('base64url')}.`
    const hmac = await new SignJWT({ jti: 'h' })
      .setProtectedHeader({ alg: 'HS256', kid: 'key-1' })
      .setIssuer(client.externalId)
      .setSubject(client.externalId)
      .setAudience(ORIGIN)
      .setIssuedAt()
      .setExpirationTime(now + 60)
      .sign(new TextEncoder().encode('a-shared-secret-that-must-never-work'))
    for (const [name, jwt] of [
      ['alg none', unsigned],
      ['HMAC', hmac],
      ['other key, same kid', await assertion({}, { key: other.privateKey })],
      ['unknown kid', await assertion({}, { kid: 'key-9' })],
      ['wrong issuer', await assertion({ iss: 'cli_someone_else' })],
      ['wrong subject', await assertion({ sub: 'cli_someone_else' })],
      ['wrong audience', await assertion({ aud: 'https://evil.example.test/oauth/token' })],
      // Audience injection: only the issuer as a single string, never the token endpoint or an array.
      ['token endpoint as audience', await assertion({ aud: TOKEN_ENDPOINT })],
      [
        'audience array with the issuer',
        await assertion({ aud: [ORIGIN, 'https://evil.example.test'] }),
      ],
      ['expired', await assertion({ iat: now - 600, exp: now - 300 })],
      ['far future', await assertion({ iat: now, exp: now + 3600 })],
      ['issued in the future', await assertion({ iat: now + 600, exp: now + 660 })],
    ] as const) {
      expect(await refusal(token(jwt)), name).toBe('invalid_client')
    }
    const noJti = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: 'key-1' })
      .setIssuer(client.externalId)
      .setSubject(client.externalId)
      .setAudience(ORIGIN)
      .setIssuedAt()
      .setExpirationTime(now + 60)
      .sign(signing.privateKey)
    expect(await refusal(token(noJti))).toBe('invalid_client')
    // The issuer as the single audience works; a client_id that disagrees with the assertion is refused.
    expect((await token(await assertion({ aud: ORIGIN }))).access_token).toMatch(/^exat_/)
    expect(await refusal(token(await assertion(), { client_id: 'exponetdb-cli' }))).toBe(
      'invalid_client',
    )
  })

  it('rotates keys without ending the grant', async () => {
    const next = await ecKey('key-2')
    await change((tx, request) =>
      oauth.replaceServiceClientKeys(tx, h.deps, session, request, serviceId, [
        signing.jwk,
        next.jwk,
      ]),
    )
    expect(
      (await token(await assertion({}, { key: next.privateKey, kid: 'key-2' }))).access_token,
    ).toMatch(/^exat_/)
    await change((tx, request) =>
      oauth.replaceServiceClientKeys(tx, h.deps, session, request, serviceId, [next.jwk]),
    )
    expect(await refusal(token(await assertion()))).toBe('invalid_client')
    expect(
      (await token(await assertion({}, { key: next.privateKey, kid: 'key-2' }))).access_token,
    ).toMatch(/^exat_/)
    signing = next
  })

  it('a service token holds no permission until the service account has a role', async () => {
    const issued = await token(await assertion())
    const at = await oauth.authenticateBearer(h.deps.store, issued.access_token, 'api')
    if (!at.ok) throw new Error('bearer')
    expect(at.principal).toMatchObject({
      identityKind: 'service',
      client: 'ci',
      delegation: { credential: { type: 'access_token', grantKind: 'machine' } },
    })
    const authorizer = new Authorizer(new ControlPlaneSubjectResolver())
    const read = () =>
      authorizer.authorize(
        h.deps.store,
        { action: 'installation.get', principal: at.principal, resource: 'api' },
        { kind: 'installation' },
      )
    expect(await read()).toMatchObject({ allowed: false, reason: 'no_permission' })
    await bindRole(h, a, session, serviceId, 'viewer')
    expect(await read()).toMatchObject({ allowed: true })
    // Never an owner.
    expect(await refusal(bindRole(h, a, session, serviceId, 'owner'))).toBe('VALIDATION_FAILED')
  })
})

describe('abuse resistance of client authentication (adversarial review)', () => {
  const form = (fields: Record<string, string>): oauth.TokenRequest => ({
    body: new URLSearchParams(fields).toString(),
    contentType: 'application/x-www-form-urlencoded',
    authorizationHeader: false,
  })
  const ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'
  const tokenFrom = (from: ReturnType<typeof meta>, jwt: string) =>
    oauth.tokenEndpoint(
      deps(),
      from,
      form({
        grant_type: 'client_credentials',
        client_assertion_type: ASSERTION_TYPE,
        client_assertion: jwt,
      }),
    )
  /** An unsigned look-alike naming the client: no signature is needed to be counted. */
  const junk = () =>
    `${Buffer.from(JSON.stringify({ alg: 'ES256', kid: signing.jwk.kid })).toString('base64url')}.${Buffer.from(
      JSON.stringify({ iss: client.externalId, sub: client.externalId }),
    ).toString('base64url')}.AAAA`
  const recorded = async () =>
    Number(
      (
        await h.db.asSuperuser((c) =>
          c.query('SELECT count(*)::int AS n FROM oauth.client_assertions WHERE client_id = $1', [
            client.clientId,
          ]),
        )
      ).rows[0]?.n,
    )

  it('never holds one connection while waiting for another: concurrent assertions cannot stall the pool', async () => {
    // The test pool has 4 connections; 16 concurrent requests all finish, refused.
    const started = Date.now()
    const outcomes = await Promise.all(Array.from({ length: 16 }, () => refusal(token(junk()))))
    expect(outcomes.every((o) => o === 'invalid_client')).toBe(true)
    expect(Date.now() - started).toBeLessThan(4000)
  })

  it('counts assertions per client and address: another address cannot lock the client out', async () => {
    const attacker = meta('203.0.113.60')
    for (let i = 0; i < 60; i++) {
      expect(await refusal(tokenFrom(attacker, junk()))).toBe('invalid_client')
    }
    expect(await refusal(tokenFrom(attacker, junk()))).toBe('temporarily_unavailable')
    // The service itself, from its own address, is not affected.
    expect((await tokenFrom(meta('203.0.113.61'), await assertion())).access_token).toMatch(
      /^exat_/,
    )
  })

  it('spends an assertion used for a refused request, and never verifies one an endpoint cannot use', async () => {
    // Refused after authentication: the jti is recorded anyway, a second use is a replay.
    const once = await assertion()
    expect(await refusal(token(once, { scope: 'audit.read' }))).toBe('invalid_scope')
    expect(await refusal(token(once))).toBe('invalid_client')
    // The device endpoint and an API key at the revocation endpoint refuse before verification.
    const before = await recorded()
    const unused = await assertion()
    expect(
      await refusal(
        oauth.startDeviceAuthorization(
          deps(),
          m(),
          form({
            client_assertion_type: ASSERTION_TYPE,
            client_assertion: unused,
            scope: 'targets.read',
          }),
        ),
      ),
    ).toBe('invalid_client')
    expect(
      await refusal(
        oauth.revocationEndpoint(
          deps(),
          m(),
          form({
            client_assertion_type: ASSERTION_TYPE,
            client_assertion: unused,
            token: `exak_${'A'.repeat(43)}`,
          }),
        ),
      ),
    ).toBe('unsupported_token_type')
    expect(await recorded()).toBe(before)
  })
})

describe('API keys (identity.md §5)', () => {
  let secret = ''
  let keyId = ''

  it('shows a key once, stores only its hash and authenticates the REST API with it', async () => {
    const created = await change((tx, request) =>
      oauth.createApiKey(tx, h.deps, session, request, serviceId, {
        scopes: ['targets.read'],
        restrictions: { tiers: ['nonprod'], targets: { kind: 'all' } },
        lifetimeDays: 30,
        label: 'deploy',
      }),
    )
    secret = created.secret
    keyId = created.keyId
    expect(secret).toMatch(/^exak_[A-Za-z0-9_-]{43}$/)
    const [view] = await oauth.listApiKeys(h.deps.store, { identityId: serviceId, limit: 10 })
    expect(view).toMatchObject({
      id: keyId,
      label: 'deploy',
      state: 'active',
      lastUsedAt: null,
      scopes: ['targets.read'],
    })
    expect(JSON.stringify(view)).not.toContain(secret)
    const stored = await h.db.asSuperuser((c) =>
      c.query(`SELECT to_jsonb(k)::text AS row FROM oauth.api_keys k`),
    )
    expect(stored.rows.map((r) => r.row).join()).not.toContain(secret)
    const at = await oauth.authenticateBearer(h.deps.store, secret, 'api')
    expect(at.ok && at.principal).toMatchObject({
      identityId: serviceId,
      identityKind: 'service',
      client: 'ci',
      delegation: { credential: { type: 'api_key' }, resource: 'api' },
    })
    expect((await oauth.authenticateBearer(h.deps.store, secret, 'mcp')).ok).toBe(false)
    const [used] = await oauth.listApiKeys(h.deps.store, { identityId: serviceId, limit: 10 })
    expect(used?.lastUsedAt).not.toBeNull()
  })

  it('needs an expiry within 365 days and ends at revocation and at expiry', async () => {
    expect(
      await refusal(
        change((tx, request) =>
          oauth.createApiKey(tx, h.deps, session, request, serviceId, {
            scopes: ['targets.read'],
            restrictions: { tiers: ['nonprod'], targets: { kind: 'all' } },
            lifetimeDays: 366,
          }),
        ),
      ),
    ).toBe('SCOPE_NOT_DELEGABLE')
    const id = expectOk(parseId('key', keyId), 'key')
    expect(
      await change((tx, request) =>
        oauth.revokeApiKey(tx, h.deps, session, request, id, 'rotation'),
      ),
    ).toBe(true)
    expect(
      await change((tx, request) =>
        oauth.revokeApiKey(tx, h.deps, session, request, id, undefined),
      ),
    ).toBe(false)
    expect((await oauth.authenticateBearer(h.deps.store, secret, 'api')).ok).toBe(false)
    const second = await change((tx, request) =>
      oauth.createApiKey(tx, h.deps, session, request, serviceId, {
        scopes: ['targets.read'],
        restrictions: { tiers: ['nonprod'], targets: { kind: 'all' } },
        lifetimeDays: 1,
      }),
    )
    await age(
      h,
      `UPDATE oauth.api_keys SET created_at = created_at - interval '2 days', expires_at = expires_at - interval '2 days' WHERE key_id = $1`,
      [second.keyId],
    )
    expect((await oauth.authenticateBearer(h.deps.store, second.secret, 'api')).ok).toBe(false)
    const audit = await h.db.asSuperuser((c) =>
      c.query(
        `SELECT event::text AS e FROM audit.audit_events WHERE action IN ('api_key.created', 'api_key.revoked')`,
      ),
    )
    expect(audit.rows.length).toBe(3)
    expect(audit.rows.map((r) => r.e).join()).not.toMatch(/exak_/)
  })

  it('disabling the service account ends its keys, its client and its grants', async () => {
    const key = await change((tx, request) =>
      oauth.createApiKey(tx, h.deps, session, request, serviceId, {
        scopes: ['targets.read'],
        restrictions: { tiers: ['nonprod'], targets: { kind: 'all' } },
        lifetimeDays: 30,
      }),
    )
    const issued = await token(await assertion())
    await change((tx, request) =>
      disableIdentity(tx, h.deps, session, request, serviceId, undefined),
    )
    expect((await oauth.authenticateBearer(h.deps.store, key.secret, 'api')).ok).toBe(false)
    expect((await oauth.authenticateBearer(h.deps.store, issued.access_token, 'api')).ok).toBe(
      false,
    )
    expect((await oauth.readClient(h.deps.store, client.clientId))?.state).toBe('disabled')
    expect(await refusal(token(await assertion()))).toBe('invalid_client')
  })
})
