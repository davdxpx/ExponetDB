import { bootstrapOwner, totpCodeAt } from '@exponetdb/auth'
import { SoftAuthenticator } from '@exponetdb/auth/testing'
import { type MigratedTestDatabase, migratedTestDatabase } from '@exponetdb/control-store/testing'
import { newId, systemClock } from '@exponetdb/kernel'
import { createLogger, MetricsRegistry } from '@exponetdb/observability'
import { KindRegistry, processNextOperation } from '@exponetdb/operations'
import {
  clusterBootstrapStatements,
  databaseBootstrapStatements,
  passwordStatements,
  ROLE_NAMES,
} from '@exponetdb/postgres'
import { type ApiError, ExponetDB } from '@exponetdb/sdk'
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
import { type Listener, listen } from '../src/roles/lifecycle.ts'

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
/** Every log line of serve and the worker in this run, for the secret scan at the end. */
const logLines: string[] = []
const serveLogger = createLogger({ role: 'serve', level: 'debug', write: (l) => logLines.push(l) })
const workerLogger = createLogger({
  role: 'worker',
  level: 'debug',
  write: (l) => logLines.push(l),
})
/** API key secrets issued in this run (they must appear nowhere at rest or in logs). */
const issuedKeys: string[] = []

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
    egressAddresses: [],
    mcpAllowedOrigins: [],
    clientRegistration: 'review',
  }
  const access = composeAccess(config, { store: stores.serve, keyring }, { clock: systemClock })
  expect((await access.roleCatalogCheck.run()).status).toBe('pass')
  expect((await access.scopeCatalogCheck.run()).status).toBe('pass')
  app = createPublicApp(
    {
      readiness: () => ({ status: 'ready', evaluatedAt: new Date().toISOString(), checks: [] }),
      version: '0.0.0-test',
      logger: serveLogger,
      metrics: httpMetrics(new MetricsRegistry()),
      clock: systemClock,
    },
    {
      api: {
        application: access.application,
        publicOrigin: ORIGIN,
        trustedProxies: [],
        logger: serveLogger,
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
  observation = workerObservation(rt, list, POLICY_RULES, codeVersion(), workerLogger)
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

/** A service account with the `viewer` role at one scope (bound by the owner through a plan). */
async function viewerAccount(name: string, scope: Record<string, string>) {
  const created = await owner.browser.call('POST', '/api/v1/service-accounts', {
    displayName: name,
  })
  expect(created.status).toBe(201)
  const binding = await owner.browser.call('POST', '/api/v1/role-bindings', {
    identityId: created.body.id,
    roleId: 'viewer',
    scope,
  })
  expect(binding.status).toBe(201)
  await reauth()
  const applied = await owner.browser.call('POST', `/api/v1/plans/${binding.body.id}/apply`, {})
  expect(applied.status).toBe(202)
  await drive()
  return String(created.body.id)
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
    // A bounded list says whether it was cut.
    expect(credentials.body.truncated).toBe(false)
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
    // An approver who has not re-authenticated lately still sees what they may decide on.
    await db.asSuperuser(async (c) => {
      // Test-only aging, as the auth suites do: the guards would refuse an edited time.
      await c.query('BEGIN')
      await c.query('SET LOCAL session_replication_role = replica')
      await c.query(
        `UPDATE auth.reauth_events SET occurred_at = occurred_at - interval '10 minutes'`,
      )
      await c.query(`UPDATE auth.web_sessions SET reauth_at = reauth_at - interval '10 minutes'
                      WHERE reauth_at IS NOT NULL`)
      await c.query('COMMIT')
    })
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
    return viewerAccount(name, { kind: 'global' })
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
    issuedKeys.push(String(key.body.secret))
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
    // Owner decision R2 (2026-10-07): outside its tier, an existing target answers
    // exactly like an unknown path; why is logged, never answered.
    const unknown = await bearer(
      key.body.secret,
      `/api/v1/targets/${encodeURIComponent(`${slug}/platform/nowhere`)}`,
    )
    expect([prod.status, prod.body.code]).toEqual([404, 'TARGET_NOT_FOUND'])
    expect(unknown.status).toBe(404)
    const { requestId: prodRequest, ...prodBody } = prod.body
    const { requestId: unknownRequest, ...unknownBody } = unknown.body
    expect(prodBody).toEqual(unknownBody)
    expect(prod.text.includes('production')).toBe(false)
    const concealed = logLines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((l) => l['msg'] === 'authz.denial_concealed' && l['requestId'] === prodRequest)
    expect(concealed).toMatchObject({ reason: 'tier_restriction', route: '/targets/{target}' })
    expect(JSON.stringify(concealed)).not.toContain('production')
    expect(
      logLines.some(
        (l) => l.includes('authz.denial_concealed') && l.includes(String(unknownRequest)),
      ),
    ).toBe(false)
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

describe('the SDK against a live listener (order §265 to §267)', () => {
  let listener: Listener
  /** Real HTTP over TCP to the same public app `serve` runs; the SDK keeps the public origin. */
  let wire: typeof fetch
  const stagingPath = () => `${slug}/platform/staging`
  const productionPath = () => `${slug}/platform/production`

  beforeAll(async () => {
    listener = await listen(app.fetch, { host: '127.0.0.1', port: 0 })
    const local = `http://127.0.0.1:${listener.port}`
    wire = ((input: string | URL | Request, init?: RequestInit) =>
      fetch(String(input).replace(ORIGIN, local), init)) as typeof fetch
  })

  afterAll(async () => {
    await listener?.close(1000)
  })

  /** A `fetch` that records what the SDK sends. */
  function recording() {
    const sent: { url: string; method: string; body: string | undefined }[] = []
    const impl = ((input: string | URL | Request, init?: RequestInit) => {
      sent.push({
        url: String(input),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? init.body : undefined,
      })
      return wire(input, init)
    }) as typeof fetch
    return { sent, fetch: impl }
  }

  const errorOf = (r: { ok: boolean; error?: ApiError }) => (r.ok ? undefined : r.error)

  async function apiKey(account: string, scopes: string[], restrictions: unknown) {
    await reauth()
    const key = await owner.browser.call('POST', `/api/v1/service-accounts/${account}/api-keys`, {
      scopes,
      restrictions,
      lifetimeDays: 30,
    })
    expect(key.status).toBe(201)
    issuedKeys.push(String(key.body.secret))
    return String(key.body.secret)
  }

  it('reads the one permitted target with an API key: list, get, resolve, health, schema, findings', async () => {
    const account = await viewerAccount('SDK reader', { kind: 'target', targetId: ids.target })
    const key = await apiKey(account, ['targets.read', 'schema.read', 'diagnostics.read'], {
      tiers: ['nonprod'],
      targets: { kind: 'list', targetIds: [ids.target] },
    })
    const sdk = new ExponetDB({ baseUrl: ORIGIN, auth: { kind: 'apiKey', key }, fetch: wire })
    // The installation is read at installation scope: a target binding does not reach it,
    // and the SDK reports the refusal instead of assuming compatibility.
    expect(errorOf(await sdk.installation.compatible())).toMatchObject({
      code: 'PERMISSION_DENIED',
    })

    const all = await sdk.targets.all()
    expect(all.ok && all.value.map((t) => t.id)).toEqual([ids.target])
    const one = await sdk.targets.get(ids.target)
    expect(one.ok && one.value).toMatchObject({
      id: ids.target,
      tier: 'nonprod',
      path: stagingPath(),
    })
    const resolved = await sdk.targets.resolve(stagingPath())
    expect(resolved.ok && resolved.value.id).toBe(ids.target)

    const health = await sdk.health.get(ids.target)
    expect(health.ok && health.value).toMatchObject({
      targetId: ids.target,
      source: expect.any(String),
      observedAt: expect.any(String),
    })
    const overview = await sdk.schema.overview(ids.target)
    expect(overview.ok && overview.value).toMatchObject({ complete: true, pgMajor: 17 })
    const fingerprint = await sdk.schema.fingerprint(ids.target)
    expect(fingerprint.ok && fingerprint.value.fingerprint).toMatch(/^fp1:17:[0-9a-f]{64}$/)
    const search = await sdk.schema.search(ids.target, { q: 'accounts', kinds: ['table'] })
    expect(search.ok && search.value.items.map((i) => i.name)).toEqual(['accounts'])
    const object = await sdk.schema.object(ids.target, 'table', 'public.accounts')
    expect(object.ok).toBe(true)
    const findings = await sdk.findings.list(ids.target)
    expect(findings.ok && findings.value.items.map((f) => f.kind)).toContain('drift')

    for (const r of [all, one, resolved, health, overview, fingerprint, search, object, findings]) {
      expectNoConnectionMaterial(JSON.stringify(r))
    }
  })

  it('keeps a denial a denial: production, an unbound target, a missing scope, admin routes, a bad key', async () => {
    const account = await viewerAccount('SDK narrow', { kind: 'target', targetId: ids.target })
    const nonprodKey = await apiKey(account, ['targets.read'], {
      tiers: ['nonprod'],
      targets: { kind: 'all' },
    })
    const sdk = new ExponetDB({
      baseUrl: ORIGIN,
      auth: { kind: 'apiKey', key: nonprodKey },
      fetch: wire,
    })
    // Production is neither bound nor in the key's tiers; the SDK does not look elsewhere.
    // Outside the key's tier it answers like an unknown target (owner decision R2).
    expect(errorOf(await sdk.targets.resolve(productionPath()))).toMatchObject({
      code: 'TARGET_NOT_FOUND',
      status: 404,
      retryable: false,
      requestId: expect.stringMatching(/^req_/),
    })
    // A key that may reach production tiers still has no binding there: production is outside
    // the account's role scope and answers like an unknown path (error-model.md §4, Wave 7).
    const bothKey = await apiKey(account, ['targets.read'], {
      tiers: ['nonprod', 'prod'],
      targets: { kind: 'all' },
    })
    const both = new ExponetDB({
      baseUrl: ORIGIN,
      auth: { kind: 'apiKey', key: bothKey },
      fetch: wire,
    })
    const outside = errorOf(await both.targets.resolve(productionPath()))
    const unknown = errorOf(await both.targets.resolve(`${slug}/platform/nowhere`))
    expect(outside).toMatchObject({ code: 'TARGET_NOT_FOUND', status: 404 })
    expect({ ...outside, requestId: undefined }).toEqual({ ...unknown, requestId: undefined })
    const listed = await both.targets.all()
    expect(listed.ok && listed.value.map((t) => t.id)).toEqual([ids.target])
    // No schema.read scope: the schema stays closed.
    expect(errorOf(await sdk.schema.overview(ids.target))).toMatchObject({ status: 403 })
    // The SDK has no administration surface, and the key reaches none.
    for (const name of [
      'identities',
      'approvals',
      'roleBindings',
      'serviceAccounts',
      'credentials',
    ]) {
      expect(name in sdk).toBe(false)
    }
    const admin = await wire(`${ORIGIN}/api/v1/identities`, {
      headers: { authorization: `Bearer ${nonprodKey}` },
    })
    expect(admin.status).toBe(403)
    // An unknown key: 401, sent once (nothing to renew).
    const { sent, fetch: counted } = recording()
    const stranger = new ExponetDB({
      baseUrl: ORIGIN,
      auth: { kind: 'apiKey', key: `exak_${'Z'.repeat(40)}` },
      fetch: counted,
    })
    expect(errorOf(await stranger.targets.list())).toMatchObject({ status: 401 })
    expect(sent).toHaveLength(1)
  })

  it('checks compatibility for an account bound at installation scope', async () => {
    const account = await viewerAccount('SDK global', { kind: 'global' })
    const key = await apiKey(account, ['targets.read'], {
      tiers: ['nonprod'],
      targets: { kind: 'all' },
    })
    const sdk = new ExponetDB({ baseUrl: ORIGIN, auth: { kind: 'apiKey', key }, fetch: wire })
    expect(await sdk.installation.compatible()).toEqual({ ok: true, value: true })
    const installation = await sdk.installation.get()
    expect(installation.ok && installation.value.contracts.restApi).toBe('v1')
    // Wave 6: the installation id is public metadata, so a CLI profile notices another installation.
    expect(installation.ok && installation.value.installationId).toMatch(/^ins_/)
  })

  it('reads with a private_key_jwt service account, asking only for an /api token', async () => {
    const account = await viewerAccount('SDK interop', { kind: 'project', projectId: ids.project })
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
      scopes: ['targets.read', 'schema.read'],
      restrictions: { tiers: ['nonprod'], targets: { kind: 'all' } },
      lifetimeDays: 30,
    })
    expect(granted.status).toBe(201)

    const { sent, fetch: recorded } = recording()
    const sdk = new ExponetDB({
      baseUrl: ORIGIN,
      auth: {
        kind: 'serviceAccount',
        clientId: String(registered.body.clientId),
        privateKey: pair.privateKey,
        keyId: 'k1',
        scopes: ['targets.read', 'schema.read'],
      },
      fetch: recorded,
    })
    const list = await sdk.targets.all()
    expect(list.ok && list.value.map((t) => t.id)).toEqual([ids.target])
    const fingerprint = await sdk.schema.fingerprint(stagingPath())
    expect(fingerprint.ok && fingerprint.value.fingerprint).toMatch(/^fp1:17:/)
    expect(errorOf(await sdk.targets.resolve(productionPath()))).toMatchObject({
      code: 'TARGET_NOT_FOUND',
    })
    // One token for all three calls, for the API audience only; no refresh token.
    const tokenRequests = sent.filter((s) => s.url === `${ORIGIN}/oauth/token`)
    expect(tokenRequests).toHaveLength(1)
    const form = new URLSearchParams(tokenRequests[0]?.body)
    expect(form.get('resource')).toBe(`${ORIGIN}/api`)
    expect(form.get('grant_type')).toBe('client_credentials')
    expect(sent.some((s) => s.url.includes('/mcp') || (s.body ?? '').includes('/mcp'))).toBe(false)

    // A key the client never registered: the token endpoint refuses, no API call follows.
    const other = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, [
      'sign',
      'verify',
    ])
    const impostor = recording()
    const refused = new ExponetDB({
      baseUrl: ORIGIN,
      auth: {
        kind: 'serviceAccount',
        clientId: String(registered.body.clientId),
        privateKey: other.privateKey,
        keyId: 'k1',
        scopes: ['targets.read'],
      },
      fetch: impostor.fetch,
    })
    expect(errorOf(await refused.targets.list())).toMatchObject({
      code: 'CLIENT_AUTHENTICATION_FAILED',
      status: 401,
      details: { error: 'invalid_client' },
    })
    expect(impostor.sent.map((s) => s.url)).toEqual([`${ORIGIN}/oauth/token`])
  })
})

describe('pagination and organization visibility', () => {
  /** Follows nextCursor with limit=1 and returns every item id, in order. */
  interface ListPage {
    readonly items: readonly Record<string, unknown>[]
    readonly nextCursor: string | null
    readonly code?: string
  }
  async function walk(
    path: string,
    call: (p: string) => Promise<{ status: number; body: unknown }>,
  ) {
    const ids: string[] = []
    let cursor: string | null = null
    for (let i = 0; i < 50; i++) {
      const sep = path.includes('?') ? '&' : '?'
      const response = await call(
        `${path}${sep}limit=1${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`,
      )
      const page = response.body as ListPage
      expect([response.status, page.code]).toEqual([200, undefined])
      expect(page.items.length).toBeLessThanOrEqual(1)
      for (const item of page.items) ids.push(String(item['id'] ?? item['name']))
      cursor = page.nextCursor
      if (cursor === null) return ids
      expect(cursor).toMatch(/^[A-Za-z0-9_-]{1,512}$/)
    }
    throw new Error('the cursor never ended')
  }
  const asOwner = (p: string) => owner.browser.call('GET', p)

  it('pages every Wave 4 list past its first page with contract-valid cursors', async () => {
    await planAndApply('/api/v1/products', { slug: `${slug}b`, displayName: 'Second' })
    const products = await walk('/api/v1/products', asOwner)
    expect(products.length).toBeGreaterThanOrEqual(2)
    expect(new Set(products).size).toBe(products.length)
    expect(await walk('/api/v1/targets', asOwner)).toHaveLength(2)
    expect((await walk(`/api/v1/products/${ids.product}/environments`, asOwner)).length).toBe(2)
    const findings = await walk(`/api/v1/targets/${ids.target}/findings`, asOwner)
    expect(findings.length).toBeGreaterThanOrEqual(1)
    const hits = await walk(`/api/v1/targets/${ids.target}/schema/search?q=accounts`, asOwner)
    expect(hits.length).toBeGreaterThanOrEqual(2)
    // A cursor from another list or a forged one is a validation failure, never a page.
    const forged = await asOwner('/api/v1/targets?cursor=r1_bm90LWFuLWlk')
    expect([forged.status, forged.body.code]).toEqual([422, 'VALIDATION_FAILED'])
  })

  it('gives a caller without access the same answer for an existing and an unknown target', async () => {
    const created = await owner.browser.call('POST', '/api/v1/service-accounts', {
      displayName: 'No access',
    })
    expect(created.status).toBe(201)
    await reauth()
    const key = await owner.browser.call(
      'POST',
      `/api/v1/service-accounts/${created.body.id}/api-keys`,
      {
        scopes: ['targets.read'],
        restrictions: { tiers: ['nonprod', 'prod'], targets: { kind: 'all' } },
        lifetimeDays: 30,
      },
    )
    expect(key.status).toBe(201)
    issuedKeys.push(String(key.body.secret))
    const answers = []
    for (const path of [`${slug}/platform/staging`, `${slug}/platform/nowhere`]) {
      const r = await bearer(key.body.secret, `/api/v1/targets/${encodeURIComponent(path)}`)
      answers.push([r.status, r.body.code])
    }
    expect(answers).toEqual([
      [403, 'PERMISSION_DENIED'],
      [403, 'PERMISSION_DENIED'],
    ])
  })

  it('lists only the organization a caller reaches, and none to a restricted token', async () => {
    const bound = await viewerAccount('Org reader', { kind: 'target', targetId: ids.target })
    await reauth()
    const key = await owner.browser.call('POST', `/api/v1/service-accounts/${bound}/api-keys`, {
      scopes: ['targets.read'],
      restrictions: { tiers: ['nonprod', 'prod'], targets: { kind: 'all' } },
      lifetimeDays: 30,
    })
    expect(key.status).toBe(201)
    issuedKeys.push(String(key.body.secret))
    const products = await bearer(key.body.secret, '/api/v1/products')
    expect(products.body.items.map((p: { id: string }) => p.id)).toEqual([ids.product])
    const projects = await bearer(key.body.secret, '/api/v1/projects')
    expect(projects.body.items.map((p: { id: string }) => p.id)).toEqual([ids.project])
    // Paging through what it cannot see never yields a hidden id or cursor.
    const paged = await bearer(key.body.secret, '/api/v1/products?limit=1')
    expect(paged.body).toEqual({
      items: [expect.objectContaining({ id: ids.product })],
      nextCursor: null,
    })
    await reauth()
    const narrow = await owner.browser.call('POST', `/api/v1/service-accounts/${bound}/api-keys`, {
      scopes: ['targets.read'],
      restrictions: { tiers: ['nonprod'], targets: { kind: 'all' } },
      lifetimeDays: 30,
    })
    issuedKeys.push(String(narrow.body.secret))
    for (const path of ['/api/v1/products', '/api/v1/projects']) {
      const refused = await bearer(narrow.body.secret, path)
      expect([path, refused.status, refused.body.code]).toEqual([path, 403, 'PERMISSION_DENIED'])
    }
  })
})

describe('no secret at rest or in logs (G4 item 36)', () => {
  it('no Control Store row and no log line carries a password, an API key, a DSN or a secret reference', async () => {
    const secrets = [
      ...Object.values(ROLE_NAMES).map((role) => loginPassword(role)),
      PASSWORD,
      ...issuedKeys,
    ]
    expect(issuedKeys.length).toBeGreaterThanOrEqual(4)
    // Every row of every table of the Control Store, as text.
    const dump = await db.asSuperuser(async (c) => {
      const tables = await c.query<{ t: string }>(
        `SELECT format('%I.%I', table_schema, table_name) AS t FROM information_schema.tables
          WHERE table_type = 'BASE TABLE' AND table_schema NOT IN ('pg_catalog', 'information_schema')
          ORDER BY 1`,
      )
      const parts: string[] = []
      for (const { t } of tables.rows) {
        const r = await c.query<{ s: string }>(
          `SELECT coalesce(string_agg(x::text, E'\\n'), '') AS s FROM ${t} x`,
        )
        parts.push(r.rows[0]?.s ?? '')
      }
      return parts.join('\n')
    })
    expect(dump).toContain(ids.target)
    for (const secret of secrets) expect(dump).not.toContain(secret)
    expect(dump).not.toMatch(/postgres(ql)?:\/\//i)
    // Serve and the worker log failures only (error descriptions, never request bodies;
    // redaction is unit-tested in packages/observability): whatever this run logged,
    // at debug level, carries none of it.
    const logs = logLines.join('\n')
    for (const secret of secrets) expect(logs).not.toContain(secret)
    expect(logs).not.toMatch(/postgres(ql)?:\/\//i)
    expect(logs).not.toMatch(/\bsec_[0-7][0-9A-HJKMNP-TV-Z]{25}\b/)
  })
})
