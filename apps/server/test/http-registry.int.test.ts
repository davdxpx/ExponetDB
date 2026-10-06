import { bootstrapOwner, totpCodeAt } from '@exponetdb/auth'
import { SoftAuthenticator } from '@exponetdb/auth/testing'
import { type MigratedTestDatabase, migratedTestDatabase } from '@exponetdb/control-store/testing'
import { newId, systemClock } from '@exponetdb/kernel'
import { MetricsRegistry, silentLogger } from '@exponetdb/observability'
import { KindRegistry, processNextOperation } from '@exponetdb/operations'
import {
  clusterBootstrapStatements,
  databaseBootstrapStatements,
  passwordStatements,
  ROLE_NAMES,
} from '@exponetdb/postgres'
import {
  generateKeyringText,
  type Keyring,
  parseKeyring,
  registerActiveKey,
} from '@exponetdb/secrets'
import {
  createDatabase,
  loginPassword,
  provisionRoles,
  runAsSuperuser,
  serverFor,
  testTargets,
} from '@exponetdb/testkit'
import * as oauth4 from 'oauth4webapi'
import { Secret } from 'otpauth'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { codeVersion, composeAccess, POLICY_RULES, workerKinds } from '../src/composition/access.ts'
import { type ObservationTasks, workerObservation } from '../src/composition/registry.ts'
import type { ServeConfig } from '../src/config/env.ts'
import { createPublicApp, httpMetrics } from '../src/interfaces/http/app.ts'

/**
 * Wave 4 end to end over HTTP (G4 items 1, 3, 9 to 12): a person registers
 * an external cluster, submits the role passwords through the write-only
 * endpoint, confirms the cluster and registers a nonprod and a production
 * target, all through `/api/v1` plans and `plan.apply` executed by the real
 * worker kinds; health, schema, drift, findings and diffs are read back;
 * a service account reads targets with an API key and with a
 * `private_key_jwt` client-credentials token, restricted to nonprod; no
 * response carries a password, a connection string or a credential
 * reference. Real PostgreSQL 17 Control Store and PostgreSQL 17 target.
 */
const ORIGIN = 'https://db.example.test'
const RP_ID = 'db.example.test'
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36'
const PASSWORD = 'tangerine fjord radiator 42'
const pg17 = serverFor(17)
const slug = `e2e${Date.now().toString(36)}`

let db: MigratedTestDatabase
let app: ReturnType<typeof createPublicApp>
let keyring: Keyring
let stores: {
  serve: ReturnType<MigratedTestDatabase['store']>
  worker: ReturnType<MigratedTestDatabase['store']>
}
let kinds: KindRegistry
let observation: ObservationTasks

beforeAll(async () => {
  db = await migratedTestDatabase('exdb_it_http_registry')
  const parsed = parseKeyring(generateKeyringText('test-key'))
  if (!parsed.ok) throw new Error('keyring')
  keyring = parsed.value
  stores = { serve: db.store('exdb_serve'), worker: db.store('exdb_worker') }
  await registerActiveKey(stores.worker, keyring)
  const config: ServeConfig = {
    role: 'serve',
    logLevel: 'warn',
    otlpEndpoint: undefined,
    controlStoreUrl: db.url('exdb_serve'),
    installationId: db.installationId,
    keyringEnv: {},
    internalListen: { host: '127.0.0.1', port: 0 },
    shutdownTimeoutMs: 10_000,
    listen: { host: '127.0.0.1', port: 0 },
    publicUrl: ORIGIN,
    webauthnRpId: undefined,
    trustedProxies: [],
  }
  const access = composeAccess(config, { store: stores.serve, keyring }, { clock: systemClock })
  expect((await access.roleCatalogCheck.run()).status).toBe('pass')
  expect((await access.scopeCatalogCheck.run()).status).toBe('pass')
  app = createPublicApp(
    {
      readiness: () => ({ status: 'ready', evaluatedAt: new Date().toISOString(), checks: [] }),
      version: '0.0.0-test',
      logger: silentLogger,
      metrics: httpMetrics(new MetricsRegistry()),
      clock: systemClock,
    },
    {
      api: {
        application: access.application,
        publicOrigin: ORIGIN,
        trustedProxies: [],
        logger: silentLogger,
        available: access.available,
      },
    },
  )
  const rt = {
    store: stores.worker,
    keyring,
    clock: systemClock,
    installationId: db.installationId,
  }
  const list = workerKinds(
    { store: stores.worker, keyring },
    { clock: systemClock },
    db.installationId,
  )
  kinds = new KindRegistry(list)
  observation = workerObservation(rt, list, POLICY_RULES, codeVersion(), silentLogger)
  // The person ran the product's bootstrap SQL on the target server and set each password.
  await provisionRoles(pg17, {
    roles: ROLE_NAMES,
    cluster: (v) => clusterBootstrapStatements(v),
    passwords: (v) => passwordStatements(v),
  })
})

afterAll(async () => {
  await db?.drop()
})

class Browser {
  readonly jar = new Map<string, string>()

  async call(method: string, path: string, body?: unknown) {
    const headers: Record<string, string> = { 'user-agent': UA }
    if (this.jar.size > 0) {
      headers['cookie'] = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ')
    }
    if (method !== 'GET') {
      headers['origin'] = ORIGIN
      const csrf = this.jar.get('__Host-exdb_csrf')
      if (csrf !== undefined) headers['x-csrf-token'] = csrf
    }
    if (body !== undefined) headers['content-type'] = 'application/json'
    const response = await app.request(`${ORIGIN}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(';')
      const index = (pair ?? '').indexOf('=')
      const name = (pair ?? '').slice(0, index)
      if (/max-age=0/i.test(line)) this.jar.delete(name)
      else this.jar.set(name, (pair ?? '').slice(index + 1))
    }
    const text = await response.text()
    return { status: response.status, body: text.length === 0 ? undefined : JSON.parse(text), text }
  }
}

async function bearer(token: string, path: string, method = 'GET', body?: unknown) {
  const response = await app.request(`${ORIGIN}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  return { status: response.status, body: text.length === 0 ? undefined : JSON.parse(text), text }
}

let owner: { browser: Browser; authenticator: SoftAuthenticator; identityId: string }

async function enrollOwner() {
  const issued = await bootstrapOwner(
    {
      store: stores.serve,
      clock: systemClock,
      config: { publicOrigin: ORIGIN, rpId: RP_ID, rpName: 'ExponetDB' },
      channel: undefined,
    },
    { email: 'owner@example.test', reissue: false },
  )
  const browser = new Browser()
  const token = new URL(issued.link).hash.replace('#token=', '')
  expect((await browser.call('POST', '/auth/enrollment/redeem', { token })).status).toBe(200)
  const options = await browser.call('POST', '/auth/enrollment/passkey/options', {})
  const authenticator = new SoftAuthenticator(
    new Uint8Array(Buffer.from(options.body.user.id, 'base64url')),
  )
  const credential = authenticator.register({
    challenge: options.body.challenge,
    origin: ORIGIN,
    rpId: RP_ID,
  })
  await browser.call('POST', '/auth/enrollment/passkey', { credential, label: 'Laptop' })
  await browser.call('POST', '/auth/enrollment/password', { password: PASSWORD })
  const setup = await browser.call('POST', '/auth/enrollment/totp/options', {})
  const secret = Secret.fromBase32(setup.body.secret).bytes
  await browser.call('POST', '/auth/enrollment/totp', { code: totpCodeAt(secret, Date.now()) })
  const done = await browser.call('POST', '/auth/enrollment/complete', {})
  expect(done.status).toBe(200)
  return { browser, authenticator, identityId: String(done.body.signedIn.identityId) }
}

async function reauth() {
  const options = await owner.browser.call('POST', '/auth/reauth/passkey/options', {})
  const credential = owner.authenticator.assert({
    challenge: options.body.challenge,
    origin: ORIGIN,
    rpId: RP_ID,
  })
  expect((await owner.browser.call('POST', '/auth/reauth/passkey', { credential })).status).toBe(
    200,
  )
}

async function drive() {
  for (let i = 0; i < 20; i++) {
    const r = await processNextOperation(stores.worker, {
      workerId: newId('prc', Date.now()),
      kinds,
      clock: systemClock,
    })
    if (r.status === 'idle') return
  }
}

/** Plan through a route, apply as the planner, let the worker execute. */
async function planAndApply(path: string, body: unknown, options: { reauth?: boolean } = {}) {
  const planned = await owner.browser.call('POST', path, body)
  expect([planned.status, planned.body?.code]).toEqual([201, undefined])
  if (options.reauth === true) await reauth()
  const applied = await owner.browser.call('POST', `/api/v1/plans/${planned.body.id}/apply`, {})
  expect([applied.status, applied.body?.code]).toEqual([202, undefined])
  await drive()
  return { plan: planned.body, operation: applied.body }
}

/** No response may carry a password, a DSN or a secret reference (C-4, C-20). */
function expectNoConnectionMaterial(text: string) {
  expect(text).not.toMatch(/postgres(ql)?:\/\//i)
  expect(text).not.toMatch(/\bsec_[0-7][0-9A-HJKMNP-TV-Z]{25}\b/)
  expect(text).not.toMatch(/"password"/i)
  for (const role of Object.values(ROLE_NAMES)) {
    expect(text).not.toContain(loginPassword(role))
  }
}

const ids = { product: '', staging: '', production: '', project: '', cluster: '', target: '' }

describe('registry over REST', () => {
  it('builds the organization through plans: product, environments, project', async () => {
    owner = await enrollOwner()
    await planAndApply('/api/v1/products', { slug, displayName: 'E2E' })
    const products = await owner.browser.call('GET', '/api/v1/products')
    ids.product = products.body.items.find((p: { slug: string }) => p.slug === slug).id
    await planAndApply(`/api/v1/products/${ids.product}/environments`, {
      slug: 'staging',
      displayName: 'Staging',
      tier: 'nonprod',
    })
    await planAndApply(`/api/v1/products/${ids.product}/environments`, {
      slug: 'production',
      displayName: 'Production',
      tier: 'prod',
      evidenceFrom: 'staging',
    })
    const envs = await owner.browser.call('GET', `/api/v1/products/${ids.product}/environments`)
    for (const e of envs.body.items) {
      if (e.slug === 'staging') ids.staging = e.id
      if (e.slug === 'production') ids.production = e.id
    }
    await planAndApply('/api/v1/projects', {
      product: slug,
      slug: 'platform',
      displayName: 'Platform',
    })
    const projects = await owner.browser.call('GET', `/api/v1/projects?product=${slug}`)
    ids.project = projects.body.items[0].id
    expect(ids).toMatchObject({
      product: expect.stringMatching(/^prd_/),
      staging: expect.stringMatching(/^env_/),
      production: expect.stringMatching(/^env_/),
      project: expect.stringMatching(/^prj_/),
    })
  })

  it('registers an external cluster with write-only credentials verified over TLS', async () => {
    const reg = await planAndApply(
      '/api/v1/clusters',
      {
        displayName: 'pg17 e2e',
        caBundle: testTargets().caPem,
        endpoints: [
          {
            kind: 'private',
            host: '127.0.0.1',
            port: pg17.port,
            tlsServerName: testTargets().serverName,
            label: 'direct',
          },
        ],
      },
      { reauth: true },
    )
    expect(reg.operation.state).toBe('queued')
    const clusters = await owner.browser.call('GET', '/api/v1/clusters')
    ids.cluster = clusters.body.items.find(
      (c: { displayName: string }) => c.displayName === 'pg17 e2e',
    ).id
    const sql = await owner.browser.call('GET', `/api/v1/clusters/${ids.cluster}/bootstrap-sql`)
    expect(sql.status).toBe(200)
    expect(sql.body.script).toContain('CREATE ROLE')
    expect(sql.body.script).not.toMatch(/PASSWORD\s+'/i)
    // The write-only endpoint: accepted, pending, never shown again.
    await reauth()
    const submitted = await owner.browser.call(
      'POST',
      `/api/v1/clusters/${ids.cluster}/credentials/observer`,
      { password: loginPassword(ROLE_NAMES.observer) },
    )
    expect([submitted.status, submitted.body.state]).toEqual([202, 'pending'])
    expectNoConnectionMaterial(submitted.text)
    await observation.verifyCredentials()
    await planAndApply(`/api/v1/clusters/${ids.cluster}/confirm`, {}, { reauth: true })
    const cluster = await owner.browser.call('GET', `/api/v1/clusters/${ids.cluster}`)
    expect(cluster.body).toMatchObject({ state: 'active', systemIdentifier: expect.any(String) })
    await reauth()
    for (const role of ['migrator', 'reader'] as const) {
      const r = await owner.browser.call(
        'POST',
        `/api/v1/clusters/${ids.cluster}/credentials/${role}`,
        { password: loginPassword(ROLE_NAMES[role]) },
      )
      expect(r.status).toBe(202)
    }
    await observation.verifyCredentials()
    const credentials = await owner.browser.call(
      'GET',
      `/api/v1/clusters/${ids.cluster}/credentials`,
    )
    expect(
      credentials.body.items
        .filter((c: { state: string }) => c.state === 'active')
        .map((c: { accessRole: string }) => c.accessRole)
        .sort(),
    ).toEqual(['migrator', 'observer', 'reader'])
    expectNoConnectionMaterial(credentials.text)
    expectNoConnectionMaterial(cluster.text)
  })

  it('registers a nonprod target, reads it back with health, schema, drift and findings', async () => {
    const name = await createDatabase(pg17, 'e2e_staging')
    await runAsSuperuser(pg17, name, [
      ...databaseBootstrapStatements(name),
      'CREATE TABLE public.accounts (id bigint PRIMARY KEY, owner_id uuid)',
      'ALTER TABLE public.accounts ENABLE ROW LEVEL SECURITY',
      'CREATE POLICY own ON public.accounts FOR SELECT USING (owner_id IS NOT NULL)',
    ])
    await planAndApply(`/api/v1/clusters/${ids.cluster}/databases`, { name })
    const dbs = await owner.browser.call('GET', `/api/v1/clusters/${ids.cluster}/databases`)
    const databaseId = dbs.body.items.find((d: { name: string }) => d.name === name).id
    await planAndApply('/api/v1/targets', {
      projectId: ids.project,
      environmentId: ids.staging,
      databaseId,
    })
    const path = `${slug}/platform/staging`
    const target = await owner.browser.call('GET', `/api/v1/targets/${encodeURIComponent(path)}`)
    expect(target.status).toBe(200)
    expect(target.body).toMatchObject({
      path,
      state: 'active',
      tier: 'nonprod',
      generation: 1,
      health: null,
      placement: { clusterId: ids.cluster, managementMode: 'external' },
      openFindingCount: 0,
    })
    expectNoConnectionMaterial(target.text)
    expect(target.text).not.toContain(String(pg17.port))
    ids.target = target.body.id

    await observation.sampleHealth()
    const health = await owner.browser.call('GET', `/api/v1/targets/${ids.target}/health`)
    expect(health.body).toMatchObject({ state: 'healthy', source: 'sampled', lifecycle: 'active' })
    expect(health.body.probes.filter((p: { probe: string }) => p.probe === 'extended')).toEqual([
      expect.objectContaining({ outcome: 'ok', tls: 'verified' }),
    ])

    const schema = await owner.browser.call('GET', `/api/v1/targets/${ids.target}/schema`)
    expect(schema.body).toMatchObject({ complete: true, pgMajor: 17 })
    const search = await owner.browser.call(
      'GET',
      `/api/v1/targets/${ids.target}/schema/search?q=accounts&kinds=table`,
    )
    expect(search.body.items).toEqual([
      expect.objectContaining({ kind: 'table', name: 'accounts' }),
    ])
    const object = await owner.browser.call(
      'GET',
      `/api/v1/targets/${ids.target}/schema/objects/table/${encodeURIComponent('public.accounts')}`,
    )
    expect(object.body).toMatchObject({ rowLevelSecurity: { enabled: true, forced: false } })
    const fingerprint = await owner.browser.call(
      'GET',
      `/api/v1/targets/${ids.target}/schema/fingerprint`,
    )
    expect(fingerprint.body.fingerprint).toMatch(/^fp1:17:[0-9a-f]{64}$/)

    await runAsSuperuser(pg17, name, ['ALTER TABLE public.accounts DISABLE ROW LEVEL SECURITY'])
    const drift = await owner.browser.call('POST', `/api/v1/targets/${ids.target}/drift-checks`, {})
    expect(drift.status).toBe(201)
    expect(drift.body).toMatchObject({ status: 'drifted', counts: { drifted: 1, opened: 1 } })
    expect(drift.body.findings).toEqual([
      expect.objectContaining({
        code: 'object_changed',
        severity: 'critical',
        object: 'table public.accounts',
      }),
    ])
    const findings = await owner.browser.call('GET', `/api/v1/targets/${ids.target}/findings`)
    expect(findings.body.items).toEqual([
      expect.objectContaining({ kind: 'drift', securityRelevant: true, state: 'open' }),
    ])
    const diff = await owner.browser.call('POST', '/api/v1/schema-diffs', {
      left: { fingerprint: drift.body.baselineFingerprint },
      right: { target: ids.target },
    })
    expect(diff.body).toMatchObject({
      comparable: true,
      totals: { changed: 1, securityRelevant: 1 },
    })
    const sessions = await owner.browser.call('GET', `/api/v1/targets/${ids.target}/sessions`)
    expect(sessions.body).toMatchObject({ source: 'live', truncated: false })
    const locks = await owner.browser.call('GET', `/api/v1/targets/${ids.target}/locks`)
    expect(locks.body).toMatchObject({ waits: [], source: 'live' })
  })

  it('needs an approval and re-authentication to register a production target', async () => {
    const name = await createDatabase(pg17, 'e2e_prod')
    await runAsSuperuser(pg17, name, databaseBootstrapStatements(name))
    await planAndApply(`/api/v1/clusters/${ids.cluster}/databases`, { name })
    const dbs = await owner.browser.call('GET', `/api/v1/clusters/${ids.cluster}/databases`)
    const databaseId = dbs.body.items.find((d: { name: string }) => d.name === name).id
    const planned = await owner.browser.call('POST', '/api/v1/targets', {
      projectId: ids.project,
      environmentId: ids.production,
      databaseId,
    })
    expect(planned.status).toBe(201)
    expect(planned.body).toMatchObject({
      decision: 'require',
      subject: { tier: 'prod', targetPath: `${slug}/platform/production` },
      approvals: { required: 1, given: 0 },
    })
    await reauth()
    const applied = await owner.browser.call('POST', `/api/v1/plans/${planned.body.id}/apply`, {})
    expect(applied.body).toMatchObject({ state: 'awaiting_approval' })
    const queue = await owner.browser.call('GET', '/api/v1/approvals')
    const item = queue.body.items.find((i: { planId: string }) => i.planId === planned.body.id)
    expect(item).toMatchObject({ kind: 'target.register', tier: 'prod' })
    await reauth()
    const approved = await owner.browser.call(
      'POST',
      `/api/v1/approvals/${applied.body.id}/approve`,
      { planHash: planned.body.planHash, acknowledgeSelfApproval: true },
    )
    expect(approved.status).toBe(200)
    await drive()
    const target = await owner.browser.call(
      'GET',
      `/api/v1/targets/${encodeURIComponent(`${slug}/platform/production`)}`,
    )
    expect(target.body).toMatchObject({ state: 'active', tier: 'prod' })
  })
})

describe('service accounts read targets (SDK credentials)', () => {
  async function serviceAccountWithViewer(name: string) {
    const created = await owner.browser.call('POST', '/api/v1/service-accounts', {
      displayName: name,
    })
    expect(created.status).toBe(201)
    const binding = await owner.browser.call('POST', '/api/v1/role-bindings', {
      identityId: created.body.id,
      roleId: 'viewer',
      scope: { kind: 'global' },
    })
    expect(binding.status).toBe(201)
    await reauth()
    const applied = await owner.browser.call('POST', `/api/v1/plans/${binding.body.id}/apply`, {})
    expect(applied.status).toBe(202)
    await drive()
    return String(created.body.id)
  }

  it('reads nonprod targets with an API key restricted to nonprod; production stays invisible', async () => {
    const account = await serviceAccountWithViewer('Deploy bot')
    await reauth()
    const key = await owner.browser.call('POST', `/api/v1/service-accounts/${account}/api-keys`, {
      scopes: ['targets.read', 'diagnostics.read'],
      restrictions: { tiers: ['nonprod'], targets: { kind: 'all' } },
      lifetimeDays: 30,
    })
    expect(key.status).toBe(201)
    const list = await bearer(key.body.secret, '/api/v1/targets')
    expect(list.status).toBe(200)
    expect(list.body.items.map((t: { tier: string }) => t.tier)).toEqual(['nonprod'])
    const one = await bearer(key.body.secret, `/api/v1/targets/${ids.target}`)
    expect(one.body).toMatchObject({ id: ids.target, tier: 'nonprod' })
    expectNoConnectionMaterial(one.text)
    const prod = await bearer(
      key.body.secret,
      `/api/v1/targets/${encodeURIComponent(`${slug}/platform/production`)}`,
    )
    expect([prod.status, prod.body.code]).toEqual([403, 'TIER_NOT_PERMITTED'])
    // Registry management is human-only: a key never plans one.
    const refused = await bearer(key.body.secret, '/api/v1/products', 'POST', {
      slug: 'bot',
      displayName: 'Bot',
    })
    expect(refused.status).toBe(403)
    // Credentials are never readable, and never writable by a key.
    const secretAttempt = await bearer(
      key.body.secret,
      `/api/v1/clusters/${ids.cluster}/credentials/observer`,
      'POST',
      { password: 'x'.repeat(20) },
    )
    expect(secretAttempt.status).toBe(403)
  })

  it('reads targets with a private_key_jwt client-credentials token', async () => {
    const account = await serviceAccountWithViewer('Interop bot')
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, [
      'sign',
      'verify',
    ])
    const exported = await crypto.subtle.exportKey('jwk', pair.publicKey)
    await reauth()
    const registered = await owner.browser.call(
      'POST',
      `/api/v1/service-accounts/${account}/oauth-client`,
      {
        jwks: {
          keys: [{ kty: exported.kty, crv: exported.crv, x: exported.x, y: exported.y, kid: 'k1' }],
        },
      },
    )
    expect(registered.status).toBe(201)
    await reauth()
    const granted = await owner.browser.call('POST', `/api/v1/service-accounts/${account}/grants`, {
      scopes: ['targets.read'],
      restrictions: { tiers: ['nonprod'], targets: { kind: 'all' } },
      lifetimeDays: 30,
    })
    expect(granted.status).toBe(201)
    const http = {
      [oauth4.customFetch]: async (
        url: string,
        options: oauth4.CustomFetchOptions<string, RequestInit['body']>,
      ) =>
        app.request(url, {
          method: options.method,
          headers: options.headers,
          redirect: 'manual',
          ...(options.body === undefined ? {} : { body: options.body }),
        }),
    }
    const issuer = new URL(ORIGIN)
    const as = await oauth4.processDiscoveryResponse(
      issuer,
      await oauth4.discoveryRequest(issuer, { algorithm: 'oauth2', ...http }),
    )
    const machine: oauth4.Client = { client_id: registered.body.clientId }
    const issued = await oauth4.processClientCredentialsResponse(
      as,
      machine,
      await oauth4.clientCredentialsGrantRequest(
        as,
        machine,
        oauth4.PrivateKeyJwt({ key: pair.privateKey, kid: 'k1' }),
        { scope: 'targets.read', resource: `${ORIGIN}/api` },
        http,
      ),
    )
    const list = await bearer(issued.access_token, '/api/v1/targets')
    expect(list.status).toBe(200)
    expect(list.body.items.map((t: { id: string }) => t.id)).toEqual([ids.target])
  })
})
