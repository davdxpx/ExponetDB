import { createHash, randomBytes } from 'node:crypto'
import { expectOk, newId, parseId } from '@exponetdb/kernel'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { isAuthError, oauth, type SessionContext } from '../src/index.ts'
import { signIn } from './support/access.ts'
import {
  age,
  type Enrolled,
  enrollFirstOwner,
  type Harness,
  harness,
  meta,
  ORIGIN,
} from './support/flows.ts'
import { type TlsWorld, tlsWorld } from './support/tls.ts'

/**
 * The client registry against PostgreSQL 17 (OD-5, G3B CIMD and DCR
 * items): CIMD discovery is not trust, an approval binds the exact client
 * and the reviewed fingerprint, a changed fingerprint returns the client to
 * review and ends its grants, DCR registrations are pending public clients
 * under exhaustion limits, and the requester is never stored in clear.
 */
const HOST = 'client.example.test'
const CIMD_URL = `https://${HOST}/oauth/client.json`
const CALLBACK = `https://${HOST}/callback`

let h: Harness
let world: TlsWorld
let owner: Enrolled
let session: SessionContext
let registry: oauth.RegistryDeps
let doc: Record<string, unknown>

let ip = 0
const m = () => {
  ip += 1
  return meta(`198.51.${100 + Math.floor(ip / 250)}.${(ip % 250) + 1}`)
}

beforeAll(async () => {
  h = await harness('exdb_it_auth_oauth_clients')
  world = await tlsWorld([HOST])
  owner = await enrollFirstOwner(h)
  session = await signIn(h, owner)
  registry = { auth: h.deps, network: world.network() }
})

afterAll(async () => {
  await world?.close()
  await h?.db.drop()
})

beforeEach(() => {
  doc = {
    client_id: CIMD_URL,
    client_name: 'Example Agent',
    redirect_uris: [CALLBACK],
    grant_types: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_method: 'none',
  }
  world.setHandler((_req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(doc))
  })
})

async function code(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise
    return undefined
  } catch (error) {
    if (isAuthError(error)) {
      const reason = error.details?.['reason']
      return typeof reason === 'string' ? `${error.code}:${reason}` : error.code
    }
    if (error instanceof oauth.OAuthError) {
      return error.error
    }
    throw error
  }
}

const by = () => oauth.sessionDecider(session)

function authorizeQuery(clientId: string) {
  const verifier = randomBytes(48).toString('base64url')
  return {
    verifier,
    query: new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: CALLBACK,
      scope: 'targets.read',
      state: 's',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      resource: `${ORIGIN}/mcp`,
    }).toString(),
  }
}

async function tokensFor(clientId: string) {
  const { verifier, query } = authorizeQuery(clientId)
  const started = await oauth.startAuthorization(
    h.deps,
    m(),
    query,
    undefined,
    oauth.cimdRefresher(registry),
  )
  if (started.kind !== 'consent') {
    throw new Error(`no consent: ${JSON.stringify(started)}`)
  }
  const handle = new URL(started.location).hash.slice('#request='.length)
  const decided = await h.deps.store.transaction('test.consent', (tx) =>
    oauth.decideConsent(
      tx,
      h.deps,
      m(),
      session,
      {
        request: handle,
        decision: 'allow',
        scopes: ['targets.read'],
        tiers: ['nonprod'],
        lifetimeDays: 30,
      },
      started.binding,
    ),
  )
  return oauth.tokenEndpoint({ auth: h.deps }, m(), {
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      code: new URL(decided.redirectTo).searchParams.get('code') ?? '',
      redirect_uri: CALLBACK,
      code_verifier: verifier,
    }).toString(),
    contentType: 'application/x-www-form-urlencoded',
    authorizationHeader: false,
  })
}

async function approve(clientId: string, fingerprint: string) {
  return h.deps.store.transaction('test.approve', (tx) =>
    oauth.approveClient(tx, h.deps, m(), by(), newIdOf(clientId), fingerprint),
  )
}

const newIdOf = (id: string) => expectOk(parseId('cli', id), 'client id')

describe('CIMD clients (OD-5)', () => {
  let clientId: string
  let fingerprint: string

  it('records a fetched client as pending; discovery is not approval', async () => {
    const client = await oauth.registerCimdClient(registry, m(), by(), CIMD_URL)
    clientId = client.clientId
    fingerprint = client.metadataFingerprint
    expect(client).toMatchObject({
      externalId: CIMD_URL,
      registration: 'cimd',
      kind: 'mcp',
      state: 'pending',
      displayName: 'Example Agent',
      redirectUris: [CALLBACK],
      tokenEndpointAuthMethod: 'none',
      approvedFingerprint: null,
    })
    expect(await code(oauth.registerCimdClient(registry, m(), by(), CIMD_URL))).toBe('CONFLICT')
    const outcome = await oauth.startAuthorization(
      h.deps,
      m(),
      authorizeQuery(CIMD_URL).query,
      undefined,
    )
    expect(outcome).toEqual({ kind: 'error', reason: 'client_not_approved' })
  })

  it('refuses unsafe or invalid documents with the reason', async () => {
    expect(
      await code(oauth.registerCimdClient(registry, m(), by(), 'https://127.0.0.1/c.json')),
    ).toBe('CLIENT_METADATA_INVALID:url_invalid')
    const internal = {
      ...registry,
      network: world.network({ 'internal.example.test': ['10.0.0.8'] }),
    }
    expect(
      await code(
        oauth.registerCimdClient(internal, m(), by(), 'https://internal.example.test/c.json'),
      ),
    ).toBe('CLIENT_METADATA_INVALID:address_refused')
    doc = { ...doc, client_id: 'https://other.example.test/c.json' }
    expect(
      await code(oauth.registerCimdClient(registry, m(), by(), `https://${HOST}/oauth/other.json`)),
    ).toBe('CLIENT_METADATA_INVALID:client_id_mismatch')
  })

  it('approves exactly the reviewed fingerprint', async () => {
    expect(await code(approve(clientId, `sha256:${'0'.repeat(64)}`))).toBe('PLAN_STALE')
    const approved = await approve(clientId, fingerprint)
    expect(approved).toMatchObject({
      state: 'active',
      approvedFingerprint: fingerprint,
      approvedBy: owner.identityId,
    })
    expect(await code(approve(clientId, fingerprint))).toBe('CONFLICT')
    const tokens = await tokensFor(CIMD_URL)
    expect(tokens.access_token).toMatch(/^exat_/)
  })

  it('keeps an approval through a display change and refreshes a stale cache at the authorization endpoint', async () => {
    doc = { ...doc, client_name: 'Example Agent 2' }
    await age(
      h,
      `UPDATE oauth.clients SET metadata_expires_at = now() - interval '1 second' WHERE external_id = $1`,
      [CIMD_URL],
    )
    const tokens = await tokensFor(CIMD_URL)
    expect(tokens.access_token).toMatch(/^exat_/)
    const client = await oauth.readClientByExternalId(h.deps.store, CIMD_URL)
    expect(client).toMatchObject({
      state: 'active',
      displayName: 'Example Agent 2',
      metadataStale: false,
    })
  })

  it('refuses a stale client whose document cannot be fetched, without changing its state', async () => {
    world.setHandler((_req, res) => {
      res.statusCode = 503
      res.end()
    })
    await age(
      h,
      `UPDATE oauth.clients SET metadata_expires_at = now() - interval '1 second' WHERE external_id = $1`,
      [CIMD_URL],
    )
    const outcome = await oauth.startAuthorization(
      h.deps,
      m(),
      authorizeQuery(CIMD_URL).query,
      undefined,
      oauth.cimdRefresher(registry),
    )
    expect(outcome).toEqual({ kind: 'error', reason: 'client_not_approved' })
    expect((await oauth.readClientByExternalId(h.deps.store, CIMD_URL))?.state).toBe('active')
  })

  it('returns the client to review and ends its grants when security metadata changes', async () => {
    const tokens = await tokensFor(CIMD_URL)
    doc = { ...doc, redirect_uris: [CALLBACK, `https://${HOST}/second`] }
    const after = await oauth.refreshCimdClient(registry, newIdOf(clientId), by(), m())
    expect(after.state).toBe('pending')
    expect(after.metadataFingerprint).not.toBe(fingerprint)
    expect((await oauth.authenticateBearer(h.deps.store, tokens.access_token, 'mcp')).ok).toBe(
      false,
    )
    const { rows } = await h.db.asSuperuser((c) =>
      c.query(
        `SELECT count(*)::int AS n FROM oauth.grants g JOIN oauth.clients c ON c.client_id = g.client_id
          WHERE c.external_id = $1 AND g.state = 'active'`,
        [CIMD_URL],
      ),
    )
    expect(rows[0]?.n).toBe(0)
    const audit = await h.db.asSuperuser((c) =>
      c.query(
        `SELECT count(*)::int AS n FROM audit.audit_events WHERE action = 'oauth.client_metadata_changed'`,
      ),
    )
    expect(audit.rows[0]?.n).toBe(1)
    // The new fingerprint needs a new approval.
    const again = await approve(clientId, after.metadataFingerprint)
    expect(again.state).toBe('active')
  })

  it('disabling ends every grant; rejecting closes a pending client', async () => {
    const tokens = await tokensFor(CIMD_URL)
    await h.deps.store.transaction('test.disable', (tx) =>
      oauth.disableClient(tx, h.deps, m(), by(), newIdOf(clientId), 'incident drill'),
    )
    expect((await oauth.authenticateBearer(h.deps.store, tokens.access_token, 'mcp')).ok).toBe(
      false,
    )
    expect(
      await code(
        h.deps.store.transaction('test.reject', (tx) =>
          oauth.rejectClient(tx, h.deps, m(), by(), newIdOf(clientId), undefined),
        ),
      ),
    ).toBe('CONFLICT')
  })
})

describe('dynamic client registration (RFC 7591, approval-gated)', () => {
  const register = (body: unknown, contentType = 'application/json', meta = m()) =>
    oauth.registerDcrClient(h.deps, meta, {
      body: typeof body === 'string' ? body : JSON.stringify(body),
      contentType,
    })

  it('creates a pending public client without a secret and stores only a pseudonym of the requester', async () => {
    const requester = meta('198.51.100.77')
    const registered = await register(
      {
        client_name: 'Legacy Agent',
        redirect_uris: ['http://127.0.0.1/callback', CALLBACK],
        grant_types: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_method: 'none',
        contacts: ['someone@example.test'],
      },
      'application/json',
      requester,
    )
    expect(registered).toMatchObject({
      client_name: 'Legacy Agent',
      token_endpoint_auth_method: 'none',
      response_types: ['code'],
    })
    expect(registered.client_id).toMatch(/^exdb-dcr-[A-Za-z0-9_-]{43}$/)
    expect(JSON.stringify(registered)).not.toMatch(/secret|registration_access_token/)
    const client = await oauth.readClientByExternalId(h.deps.store, registered.client_id)
    expect(client).toMatchObject({ registration: 'dcr', state: 'pending' })
    expect(client?.requesterHash).toMatch(/^hmac-sha256:[0-9a-f]{64}$/)
    expect(client?.pendingExpiresAt).not.toBeNull()
    const stored = await h.db.asSuperuser((c) =>
      c.query(`SELECT to_jsonb(c)::text AS row FROM oauth.clients c WHERE external_id = $1`, [
        registered.client_id,
      ]),
    )
    expect(stored.rows[0]?.row).not.toMatch(/198\.51\.100\.77|someone@/)
    const events = await h.db.asSuperuser((c) =>
      c.query(
        `SELECT event::text AS e FROM audit.audit_events WHERE action = 'oauth.client_registered'`,
      ),
    )
    expect(events.rows.map((r) => r.e).join()).not.toMatch(/198\.51\.100\.77/)
    // Pending: nothing can use it until it is approved.
    expect(
      await oauth.startAuthorization(
        h.deps,
        m(),
        authorizeQuery(registered.client_id).query,
        undefined,
      ),
    ).toEqual({
      kind: 'error',
      reason: 'client_not_approved',
    })
    if (client === undefined) return
    await approve(client.clientId, client.metadataFingerprint)
    expect((await tokensFor(registered.client_id)).access_token).toMatch(/^exat_/)
  })

  it('refuses secrets, confidential methods, bad redirects and non-JSON', async () => {
    const base = { redirect_uris: [CALLBACK] }
    expect(
      await code(register({ ...base, token_endpoint_auth_method: 'client_secret_basic' })),
    ).toBe('invalid_client_metadata')
    expect(await code(register({ ...base, client_secret: 'abc' }))).toBe('invalid_client_metadata')
    expect(await code(register({ ...base, jwks_uri: 'https://x.example.test/jwks' }))).toBe(
      'invalid_client_metadata',
    )
    expect(await code(register({ ...base, client_id: 'chosen-by-client' }))).toBe(
      'invalid_client_metadata',
    )
    expect(await code(register({ redirect_uris: ['https://evil.example.test/cb#frag'] }))).toBe(
      'invalid_redirect_uri',
    )
    expect(await code(register({ redirect_uris: [] }))).toBe('invalid_redirect_uri')
    expect(await code(register({ ...base, grant_types: ['client_credentials'] }))).toBe(
      'invalid_client_metadata',
    )
    expect(
      await code(register('{"redirect_uris": ["https://a.example.test/cb"], "redirect_uris": []}')),
    ).toBe('invalid_client_metadata')
    expect(await code(register(base, 'application/x-www-form-urlencoded'))).toBe(
      'invalid_client_metadata',
    )
  })

  it('limits registrations per address, pending ones per requester and the number pending', async () => {
    // At most 3 pending registrations per requester; another address is not affected.
    const one = meta('198.51.100.200')
    for (let i = 0; i < 3; i++) {
      await register({ redirect_uris: [CALLBACK] }, 'application/json', one)
    }
    expect(await code(register({ redirect_uris: [CALLBACK] }, 'application/json', one))).toBe(
      'temporarily_unavailable',
    )
    await register({ redirect_uris: [CALLBACK] }, 'application/json', meta('198.51.100.201'))
    // At most 10 registrations per address and hour, even when none stays pending.
    const busy = meta('198.51.100.202')
    for (let i = 0; i < 10; i++) {
      const registered = await register({ redirect_uris: [CALLBACK] }, 'application/json', busy)
      await h.withoutGuards(async (c) => {
        await c.query(
          `UPDATE oauth.clients SET state = 'rejected', pending_expires_at = NULL WHERE external_id = $1`,
          [registered.client_id],
        )
      })
    }
    expect(await code(register({ redirect_uris: [CALLBACK] }, 'application/json', busy))).toBe(
      'temporarily_unavailable',
    )
    // Fill the pending pool up to its bound (50), then any address is refused.
    const { rows } = await h.db.asSuperuser((c) =>
      c.query(
        `SELECT count(*)::int AS n FROM oauth.clients WHERE registration = 'dcr' AND state = 'pending'`,
      ),
    )
    const missing = 50 - (rows[0]?.n ?? 0)
    await h.withoutGuards(async (c) => {
      for (let i = 0; i < missing; i++) {
        await c.query(
          `INSERT INTO oauth.clients (client_id, external_id, registration, kind, state, display_name, redirect_uris,
                                      application_type, token_endpoint_auth_method, grant_types, metadata_fingerprint,
                                      created_at, state_changed_at, pending_expires_at)
           VALUES ($1, $2, 'dcr', 'mcp', 'pending', 'Filler', ARRAY[$3], 'web', 'none', ARRAY['authorization_code'],
                   $4, now(), now(), now() + interval '7 days')`,
          [
            newId('cli', Date.now() + i),
            `exdb-dcr-${randomBytes(32).toString('base64url')}`,
            CALLBACK,
            `sha256:${'2'.repeat(64)}`,
          ],
        )
      }
    })
    expect(await code(register({ redirect_uris: [CALLBACK] }))).toBe('temporarily_unavailable')
  })
})
