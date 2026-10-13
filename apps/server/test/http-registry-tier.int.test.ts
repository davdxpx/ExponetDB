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
import { Secret } from 'otpauth'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { codeVersion, composeAccess, POLICY_RULES, workerKinds } from '../src/composition/access.ts'
import { type ObservationTasks, workerObservation } from '../src/composition/registry.ts'
import type { ServeConfig } from '../src/config/env.ts'
import { createPublicApp, httpMetrics } from '../src/interfaces/http/app.ts'

/**
 * The declared tier of clusters and the tier-aware `registry.manage`
 * (OD-22, extended by the owner on 2026-10-13; authorization.md §5.1), over
 * HTTP against a real PostgreSQL 17 Control Store and a PostgreSQL 17
 * target:
 *
 * - the cluster view shows the declared tier (null until declared);
 * - a person whose registry authority is a nonprod environment binding
 *   cannot declare a tier, cannot place a database of a cluster declared
 *   prod (or undeclared) even into the nonprod environment, and can place
 *   one of a cluster declared nonprod into it;
 * - a CLI grant for nonprod only cannot declare a tier or record a
 *   database of a production cluster, and can on a cluster declared nonprod;
 * - the owner's existing untiered bindings (global) and a CLI grant for
 *   both tiers keep working: production authority.
 */
const ORIGIN = 'https://db.example.test'
const RP_ID = 'db.example.test'
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36'
const PASSWORD = 'tangerine fjord radiator 42'
const CLI_REDIRECT = 'http://127.0.0.1:51234/callback'
const CLI_SCOPES = ['targets.read', 'nodes.read', 'registry.manage']
const pg17 = serverFor(17)
const slug = `tier${Date.now().toString(36)}`

let db: MigratedTestDatabase
let app: ReturnType<typeof createPublicApp>
let keyring: Keyring
let kinds: KindRegistry
let observation: ObservationTasks

beforeAll(async () => {
  db = await migratedTestDatabase('exdb_it_http_registry_tier')
  const parsed = parseKeyring(generateKeyringText('test-key'))
  if (!parsed.ok) throw new Error('keyring')
  keyring = parsed.value
  const serve = db.store('exdb_serve')
  const worker = db.store('exdb_worker')
  await registerActiveKey(worker, keyring)
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
  const logger = createLogger({ role: 'serve', level: 'warn', write: () => undefined })
  const access = composeAccess(config, { store: serve, keyring }, { clock: systemClock })
  expect((await access.roleCatalogCheck.run()).status).toBe('pass')
  expect((await access.scopeCatalogCheck.run()).status).toBe('pass')
  app = createPublicApp(
    {
      readiness: () => ({ status: 'ready', evaluatedAt: new Date().toISOString(), checks: [] }),
      version: '0.0.0-test',
      logger,
      metrics: httpMetrics(new MetricsRegistry()),
      clock: systemClock,
    },
    {
      api: {
        application: access.application,
        publicOrigin: ORIGIN,
        trustedProxies: [],
        logger,
        available: access.available,
      },
    },
  )
  const list = workerKinds({ store: worker, keyring }, { clock: systemClock }, db.installationId)
  kinds = new KindRegistry(list)
  observation = workerObservation(
    { store: worker, keyring, clock: systemClock, installationId: db.installationId },
    list,
    POLICY_RULES,
    codeVersion(),
    createLogger({ role: 'worker', level: 'warn', write: () => undefined }),
  )
  await provisionRoles(pg17, {
    roles: ROLE_NAMES,
    cluster: (v) => clusterBootstrapStatements(v),
    passwords: (v) => passwordStatements(v),
  })
}, 120_000)

afterAll(async () => {
  await db?.drop()
})

class Browser {
  readonly jar = new Map<string, string>()

  async call(method: string, path: string, body?: unknown) {
    const headers: Record<string, string> = { 'user-agent': UA }
    if (this.jar.size > 0) headers['cookie'] = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ')
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
    return {
      status: response.status,
      body: text.length === 0 ? undefined : JSON.parse(text),
      text,
      response,
    }
  }
}

interface Person {
  readonly browser: Browser
  readonly authenticator: SoftAuthenticator
}

/** A person completes enrollment from a one-time link (passkey, password, TOTP). */
async function enrollWithLink(link: string): Promise<Person> {
  const browser = new Browser()
  const token = new URL(link).hash.replace('#token=', '')
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
  expect((await browser.call('POST', '/auth/enrollment/complete', {})).status).toBe(200)
  return { browser, authenticator }
}

async function reauth(person: Person) {
  const options = await person.browser.call('POST', '/auth/reauth/passkey/options', {})
  const credential = person.authenticator.assert({
    challenge: options.body.challenge,
    origin: ORIGIN,
    rpId: RP_ID,
  })
  expect((await person.browser.call('POST', '/auth/reauth/passkey', { credential })).status).toBe(
    200,
  )
}

async function drive() {
  for (let i = 0; i < 20; i++) {
    const r = await processNextOperation(db.store('exdb_worker'), {
      workerId: newId('prc', Date.now()),
      kinds,
      clock: systemClock,
    })
    if (r.status === 'idle') return
  }
}

/** Plan through a route, apply as the planner, let the worker execute. */
async function planAndApply(person: Person, path: string, body: unknown, withReauth = false) {
  const planned = await person.browser.call('POST', path, body)
  expect([planned.status, planned.body?.code], planned.text).toEqual([201, undefined])
  if (withReauth) await reauth(person)
  const applied = await person.browser.call('POST', `/api/v1/plans/${planned.body.id}/apply`, {})
  expect([applied.status, applied.body?.code], applied.text).toEqual([202, undefined])
  await drive()
  return { plan: planned.body, operation: applied.body }
}

async function form(path: string, fields: Record<string, string>) {
  const response = await app.request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  })
  const text = await response.text()
  return { status: response.status, body: text.length === 0 ? undefined : JSON.parse(text) }
}

/** The first-party CLI's loopback sign-in for the owner, consented for the given tiers. */
async function cliToken(tiers: ('prod' | 'nonprod')[]): Promise<string> {
  await reauth(owner)
  const verifier =
    'v'.repeat(20) + Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')
  const challenge = Buffer.from(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)),
  ).toString('base64url')
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: 'exponetdb-cli',
    redirect_uri: CLI_REDIRECT,
    scope: CLI_SCOPES.join(' '),
    state: 'cli-state',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: `${ORIGIN}/api`,
  })
  const authorize = await owner.browser.call('GET', `/oauth/authorize?${query.toString()}`)
  const location = authorize.response.headers.get('location') ?? ''
  const request = location.slice(location.indexOf('#request=') + '#request='.length)
  expect((await owner.browser.call('POST', '/auth/oauth/consent/view', { request })).status).toBe(
    200,
  )
  const decided = await owner.browser.call('POST', '/auth/oauth/consent', {
    request,
    decision: 'allow',
    scopes: CLI_SCOPES,
    tiers,
    lifetimeDays: 30,
    ...(tiers.includes('prod') ? { acknowledgeProduction: true } : {}),
  })
  expect(decided.status, decided.text).toBe(200)
  const redirect = new URL(decided.body.redirectTo)
  const issued = await form('/oauth/token', {
    grant_type: 'authorization_code',
    client_id: 'exponetdb-cli',
    code: redirect.searchParams.get('code') ?? '',
    redirect_uri: CLI_REDIRECT,
    code_verifier: verifier,
  })
  expect(issued.status).toBe(200)
  return issued.body.access_token
}

async function cli(token: string, method: string, path: string, body?: unknown) {
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

/** A new database of the target cluster, prepared for registration. */
async function newDatabase(label: string): Promise<string> {
  const name = await createDatabase(pg17, label)
  await runAsSuperuser(pg17, name, databaseBootstrapStatements(name))
  return name
}

async function databaseId(name: string): Promise<string> {
  const dbs = await owner.browser.call('GET', `/api/v1/clusters/${ids.cluster}/databases`)
  return dbs.body.items.find((d: { name: string }) => d.name === name).id
}

let owner: Person
let colleague: Person
const ids = { product: '', staging: '', qa: '', production: '', project: '', cluster: '' }
const tokens = { nonprod: '', both: '' }

async function declare(tier: 'prod' | 'nonprod') {
  await planAndApply(
    owner,
    `/api/v1/clusters/${ids.cluster}/declared-tier`,
    { declaredTier: tier },
    true,
  )
  const cluster = await owner.browser.call('GET', `/api/v1/clusters/${ids.cluster}`)
  expect(cluster.body.declaredTier).toBe(tier)
}

describe('declared cluster tier and tier-aware registry.manage over REST', () => {
  it('builds the registry and a confirmed, undeclared cluster as the owner (untiered global binding)', async () => {
    const issued = await bootstrapOwner(
      {
        store: db.store('exdb_serve'),
        clock: systemClock,
        config: { publicOrigin: ORIGIN, rpId: RP_ID, rpName: 'ExponetDB' },
        channel: undefined,
      },
      { email: 'owner@example.test', reissue: false },
    )
    owner = await enrollWithLink(issued.link)
    await planAndApply(owner, '/api/v1/products', { slug, displayName: 'Acme' })
    const products = await owner.browser.call('GET', '/api/v1/products')
    ids.product = products.body.items.find((p: { slug: string }) => p.slug === slug).id
    await planAndApply(owner, `/api/v1/products/${ids.product}/environments`, {
      slug: 'staging',
      displayName: 'Staging',
      tier: 'nonprod',
    })
    await planAndApply(owner, `/api/v1/products/${ids.product}/environments`, {
      slug: 'qa',
      displayName: 'QA',
      tier: 'nonprod',
    })
    await planAndApply(owner, `/api/v1/products/${ids.product}/environments`, {
      slug: 'production',
      displayName: 'Production',
      tier: 'prod',
      evidenceFrom: 'staging',
    })
    const envs = await owner.browser.call('GET', `/api/v1/products/${ids.product}/environments`)
    for (const e of envs.body.items) {
      if (e.slug === 'staging') ids.staging = e.id
      if (e.slug === 'qa') ids.qa = e.id
      if (e.slug === 'production') ids.production = e.id
    }
    await planAndApply(owner, '/api/v1/projects', {
      product: slug,
      slug: 'platform',
      displayName: 'Platform',
    })
    ids.project = (
      await owner.browser.call('GET', `/api/v1/projects?product=${slug}`)
    ).body.items[0].id
    await planAndApply(
      owner,
      '/api/v1/clusters',
      {
        displayName: 'pg17 tier',
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
      true,
    )
    ids.cluster = (await owner.browser.call('GET', '/api/v1/clusters')).body.items[0].id
    const submit = async (role: 'observer' | 'migrator' | 'reader') => {
      const r = await owner.browser.call(
        'POST',
        `/api/v1/clusters/${ids.cluster}/credentials/${role}`,
        { password: loginPassword(ROLE_NAMES[role]) },
      )
      expect(r.status, r.text).toBe(202)
    }
    await reauth(owner)
    await submit('observer')
    await observation.verifyCredentials()
    await planAndApply(owner, `/api/v1/clusters/${ids.cluster}/confirm`, {}, true)
    await reauth(owner)
    await submit('migrator')
    await submit('reader')
    await observation.verifyCredentials()
    // The cluster view carries the declared tier: undeclared until a person declares it.
    const cluster = await owner.browser.call('GET', `/api/v1/clusters/${ids.cluster}`)
    expect(cluster.body).toMatchObject({ state: 'active', declaredTier: null, derivedTier: null })
    const list = await owner.browser.call('GET', '/api/v1/clusters')
    expect(list.body.items[0].declaredTier).toBeNull()
  })

  it('gives a colleague registry.manage on the staging environment only (nonprod authority)', async () => {
    await reauth(owner)
    const invited = await owner.browser.call('POST', '/api/v1/identities', {
      email: 'colleague@example.test',
      displayName: 'Colleague',
    })
    expect(invited.status, invited.text).toBe(201)
    colleague = await enrollWithLink(invited.body.invitation.link)
    const planned = await owner.browser.call('POST', '/api/v1/role-bindings', {
      identityId: invited.body.identity.id,
      roleId: 'admin',
      scope: { kind: 'environment', environmentId: ids.staging },
    })
    expect(planned.status, planned.text).toBe(201)
    await reauth(owner)
    const applied = await owner.browser.call('POST', `/api/v1/plans/${planned.body.id}/apply`, {})
    expect(applied.status, applied.text).toBe(202)
    await drive()
    tokens.nonprod = await cliToken(['nonprod'])
    tokens.both = await cliToken(['nonprod', 'prod'])
  })

  it('refuses a declared tier to nonprod authority: the colleague and a nonprod-only CLI grant', async () => {
    const path = `/api/v1/clusters/${ids.cluster}/declared-tier`
    for (const tier of ['prod', 'nonprod']) {
      const byColleague = await colleague.browser.call('POST', path, { declaredTier: tier })
      expect([byColleague.status, byColleague.body.code]).toEqual([403, 'PERMISSION_DENIED'])
      const byCli = await cli(tokens.nonprod, 'POST', path, { declaredTier: tier })
      expect([byCli.status, byCli.body.code]).toEqual([403, 'TIER_NOT_PERMITTED'])
    }
    // A CLI grant for both tiers (the untiered registry.manage scope) plans it.
    const planned = await cli(tokens.both, 'POST', path, { declaredTier: 'nonprod' })
    expect([planned.status, planned.body.kind], planned.text).toEqual([
      201,
      'registry.cluster.declare_tier',
    ])
    expect(planned.body.subject).toMatchObject({ clusterId: ids.cluster, tier: 'prod' })
    // Still undeclared: a plan changes nothing until it is applied (here it simply expires).
    const cluster = await owner.browser.call('GET', `/api/v1/clusters/${ids.cluster}`)
    expect(cluster.body.declaredTier).toBeNull()
  })

  it('treats an undeclared cluster as production: no placement with nonprod authority', async () => {
    const name = await newDatabase('tier_undeclared')
    await planAndApply(owner, `/api/v1/clusters/${ids.cluster}/databases`, { name })
    const refused = await colleague.browser.call('POST', '/api/v1/targets', {
      projectId: ids.project,
      environmentId: ids.staging,
      databaseId: await databaseId(name),
    })
    expect([refused.status, refused.body.code]).toEqual([403, 'PERMISSION_DENIED'])
    const byCli = await cli(tokens.nonprod, 'POST', `/api/v1/clusters/${ids.cluster}/databases`, {
      name: await newDatabase('tier_undeclared_cli'),
    })
    expect([byCli.status, byCli.body.code]).toEqual([403, 'TIER_NOT_PERMITTED'])
  })

  it('refuses nonprod authority every placement on a cluster declared prod, even into staging', async () => {
    await declare('prod')
    const name = await newDatabase('tier_prod')
    await planAndApply(owner, `/api/v1/clusters/${ids.cluster}/databases`, { name })
    const body = {
      projectId: ids.project,
      environmentId: ids.staging,
      databaseId: await databaseId(name),
    }
    const refused = await colleague.browser.call('POST', '/api/v1/targets', body)
    expect([refused.status, refused.body.code]).toEqual([403, 'PERMISSION_DENIED'])
    const byCli = await cli(tokens.nonprod, 'POST', `/api/v1/clusters/${ids.cluster}/databases`, {
      name: await newDatabase('tier_prod_cli'),
    })
    expect([byCli.status, byCli.body.code]).toEqual([403, 'TIER_NOT_PERMITTED'])
    // The owner holds production authority: a database of the prod cluster is placed into the
    // nonprod environment qa (the colleague's staging stays free for the next test).
    await planAndApply(owner, '/api/v1/targets', { ...body, environmentId: ids.qa })
    const target = await owner.browser.call(
      'GET',
      `/api/v1/targets/${encodeURIComponent(`${slug}/platform/qa`)}`,
    )
    expect(target.body).toMatchObject({ state: 'active', tier: 'nonprod' })
    // The cluster now hosts a nonprod target; its declared tier stays what the person declared.
    const cluster = await owner.browser.call('GET', `/api/v1/clusters/${ids.cluster}`)
    expect(cluster.body).toMatchObject({ declaredTier: 'prod', derivedTier: 'nonprod' })
  })

  it('lets the environment decide on a cluster declared nonprod', async () => {
    await declare('nonprod')
    // The nonprod-only CLI grant records the database of the nonprod cluster.
    const name = await newDatabase('tier_nonprod')
    const planned = await cli(tokens.nonprod, 'POST', `/api/v1/clusters/${ids.cluster}/databases`, {
      name,
    })
    expect([planned.status, planned.body.code], planned.text).toEqual([201, undefined])
    const applied = await cli(tokens.nonprod, 'POST', `/api/v1/plans/${planned.body.id}/apply`, {})
    expect([applied.status, applied.body.code], applied.text).toEqual([202, undefined])
    await drive()
    // The colleague places it into staging (nonprod) but never into production.
    const id = await databaseId(name)
    const intoProduction = await colleague.browser.call('POST', '/api/v1/targets', {
      projectId: ids.project,
      environmentId: ids.production,
      databaseId: id,
    })
    expect(intoProduction.status).toBe(403)
    await planAndApply(colleague, '/api/v1/targets', {
      projectId: ids.project,
      environmentId: ids.staging,
      databaseId: id,
    })
    const target = await colleague.browser.call(
      'GET',
      `/api/v1/targets/${encodeURIComponent(`${slug}/platform/staging`)}`,
    )
    expect(target.body).toMatchObject({ state: 'active', tier: 'nonprod' })
  })
})
