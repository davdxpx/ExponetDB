import { spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bootstrapOwner, type NotificationChannel, totpCodeAt } from '@exponetdb/auth'
import { SoftAuthenticator } from '@exponetdb/auth/testing'
import { type MigratedTestDatabase, migratedTestDatabase } from '@exponetdb/control-store/testing'
import { newId, newUlid, systemClock } from '@exponetdb/kernel'
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
  superuserClient,
  testTargets,
} from '@exponetdb/testkit'
import { type ServerType, serve } from '@hono/node-server'
import { Secret } from 'otpauth'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { codeVersion, composeAccess, POLICY_RULES, workerKinds } from '../src/composition/access.ts'
import { type ObservationTasks, workerObservation } from '../src/composition/registry.ts'
import type { ServeConfig } from '../src/config/env.ts'
import { createPublicApp, httpMetrics } from '../src/interfaces/http/app.ts'

/**
 * Wave 6 over HTTP (G6 order §19 to §35, §73 items 1, 4, 9, 10): bundles
 * are linted and ingested with the server hashing the exact bytes itself, a
 * migration is planned and applied on staging through `plan.apply` and the
 * real worker, read back live, verified again, and promoted to production
 * with the staging evidence bound live. A production plan without evidence
 * is denied; break-glass is refused without a notification channel and,
 * with one, needs a re-authenticated person, names overridable rules only,
 * notifies the owners and is used once by the plan made under it.
 * Real PostgreSQL 17 Control Store and targets.
 */
const ORIGIN = 'https://db.example.test'
const RP_ID = 'db.example.test'
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36'
const PASSWORD = 'tangerine fjord radiator 42'
const OWNER_ROLE = 'exdb_http_mig_owner'
/** An application role the migrations grant to (the strict profile wants explicit grants). */
const APP_ROLE = 'exdb_http_mig_app'
const pg17 = serverFor(17)
const slug = `mg${Date.now().toString(36)}`

let db: MigratedTestDatabase
let app: Awaited<ReturnType<typeof compose>>
/** The same installation composed without a notification channel (the production default). */
let silent: Awaited<ReturnType<typeof compose>>
let keyring: Keyring
let stores: {
  serve: ReturnType<MigratedTestDatabase['store']>
  worker: ReturnType<MigratedTestDatabase['store']>
}
let kinds: KindRegistry
let observation: ObservationTasks
const delivered: { kind: string; to: string }[] = []
const channel: NotificationChannel = {
  name: 'email',
  async deliver(n) {
    delivered.push({ kind: n.kind, to: n.to })
    return { ok: true }
  },
}

async function compose(withChannel: boolean) {
  const logger = createLogger({ role: 'serve', level: 'warn', write: () => undefined })
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
  }
  const access = composeAccess(
    config,
    { store: stores.serve, keyring },
    { clock: systemClock },
    withChannel ? { channel } : {},
  )
  expect((await access.roleCatalogCheck.run()).status).toBe('pass')
  expect((await access.scopeCatalogCheck.run()).status).toBe('pass')
  return createPublicApp(
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
}

beforeAll(async () => {
  db = await migratedTestDatabase('exdb_it_http_migrations')
  const parsed = parseKeyring(generateKeyringText('test-key'))
  if (!parsed.ok) throw new Error('keyring')
  keyring = parsed.value
  stores = { serve: db.store('exdb_serve'), worker: db.store('exdb_worker') }
  await registerActiveKey(stores.worker, keyring)
  app = await compose(true)
  silent = await compose(false)
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
  const workerLogger = createLogger({ role: 'worker', level: 'warn', write: () => undefined })
  observation = workerObservation(rt, list, POLICY_RULES, codeVersion(), workerLogger)
  await provisionRoles(pg17, {
    roles: ROLE_NAMES,
    cluster: (v) => clusterBootstrapStatements(v),
    passwords: (v) => passwordStatements(v),
  })
  // The project's execution role: a NOLOGIN owner the migrator may only SET ROLE into.
  await runAsSuperuser(pg17, 'postgres', [
    `DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${OWNER_ROLE}') THEN CREATE ROLE ${OWNER_ROLE} NOLOGIN; END IF; END $$`,
    `GRANT ${OWNER_ROLE} TO ${ROLE_NAMES.migrator} WITH INHERIT FALSE, SET TRUE`,
    `DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN CREATE ROLE ${APP_ROLE} NOLOGIN; END IF; END $$`,
  ])
}, 120_000)

afterAll(async () => {
  await db?.drop()
})

class Browser {
  readonly jar = new Map<string, string>()

  async call(method: string, path: string, body?: unknown, via = app) {
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
    const response = await via.request(`${ORIGIN}${path}`, {
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

/** Moves every re-authentication of this run into the past (test-only aging, as the auth suites do). */
async function ageReauth() {
  await db.asSuperuser(async (c) => {
    await c.query('BEGIN')
    await c.query('SET LOCAL session_replication_role = replica')
    await c.query(`UPDATE auth.reauth_events SET occurred_at = occurred_at - interval '10 minutes'`)
    await c.query(`UPDATE auth.web_sessions SET reauth_at = reauth_at - interval '10 minutes'
                    WHERE reauth_at IS NOT NULL`)
    await c.query('COMMIT')
  })
}

async function drive() {
  for (let i = 0; i < 30; i++) {
    const r = await processNextOperation(stores.worker, {
      workerId: newId('prc', Date.now()),
      kinds,
      clock: systemClock,
    })
    if (r.status === 'idle') return
  }
}

async function planAndApply(path: string, body: unknown, options: { reauth?: boolean } = {}) {
  const planned = await owner.browser.call('POST', path, body)
  expect([planned.status, planned.body?.code]).toEqual([201, undefined])
  if (options.reauth === true) await reauth()
  const applied = await owner.browser.call('POST', `/api/v1/plans/${planned.body.id}/apply`, {})
  expect([applied.status, applied.body?.code]).toEqual([202, undefined])
  await drive()
  return { plan: planned.body, operation: applied.body }
}

async function operation(id: string) {
  return (await owner.browser.call('GET', `/api/v1/operations/${id}`)).body
}

let last = ''
function ulid(): string {
  let id = newUlid(Date.now())
  while (id <= last) id = newUlid(Date.now())
  last = id
  return id
}

function bundle(spec: {
  readonly id: string
  readonly name: string
  readonly up: string
  readonly verify?: string
  readonly dependsOn?: readonly string[]
}) {
  const yaml = [
    'schema: exponetdb.migration/v1',
    `id: ${spec.id}`,
    `name: ${spec.name}`,
    'description: "Adds what the lead inbox needs, tested on staging first."',
    `dependsOn: ${JSON.stringify(spec.dependsOn ?? [])}`,
    'execution:',
    '  transactional: true',
    'compatibility:',
    '  declared: additive',
    'verification:',
    '  expectations: auto',
    `  runtimeChecks: ${spec.verify === undefined ? 'none' : 'verify.sql'}`,
    '',
  ].join('\n')
  return {
    directory: `${spec.id}_${spec.name}`,
    files: {
      'migration.yaml': yaml,
      'up.sql': spec.up,
      ...(spec.verify === undefined ? {} : { 'verify.sql': spec.verify }),
    },
  }
}

const DEFAULTS = {
  lockTimeout: '5s',
  statementTimeout: '15m',
  role: 'owner',
  searchPath: ['public'],
}

const ids = {
  product: '',
  staging: '',
  production: '',
  project: '',
  cluster: '',
  stagingTarget: '',
  productionTarget: '',
}

async function registerDatabase(label: string): Promise<string> {
  const name = await createDatabase(pg17, label)
  await runAsSuperuser(pg17, name, [
    ...databaseBootstrapStatements(name),
    `GRANT CREATE, USAGE ON SCHEMA public TO ${OWNER_ROLE}`,
  ])
  await planAndApply(`/api/v1/clusters/${ids.cluster}/databases`, { name })
  const dbs = await owner.browser.call('GET', `/api/v1/clusters/${ids.cluster}/databases`)
  return dbs.body.items.find((d: { name: string }) => d.name === name).id
}

describe('setup over REST', () => {
  it('builds the registry, the cluster with its credentials, the execution role and two targets', async () => {
    owner = await enrollOwner()
    await planAndApply('/api/v1/products', { slug, displayName: 'Migrations E2E' })
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
    // The execution role alias is registry data, mapped by a project change plan.
    await planAndApply(`/api/v1/projects/${ids.project}/change-plans`, {
      executionRoles: { owner: OWNER_ROLE },
    })

    await planAndApply(
      '/api/v1/clusters',
      {
        displayName: 'pg17 migrations',
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
    const clusters = await owner.browser.call('GET', '/api/v1/clusters')
    ids.cluster = clusters.body.items.find(
      (c: { displayName: string }) => c.displayName === 'pg17 migrations',
    ).id
    await reauth()
    expect(
      (
        await owner.browser.call('POST', `/api/v1/clusters/${ids.cluster}/credentials/observer`, {
          password: loginPassword(ROLE_NAMES.observer),
        })
      ).status,
    ).toBe(202)
    await observation.verifyCredentials()
    await planAndApply(`/api/v1/clusters/${ids.cluster}/confirm`, {}, { reauth: true })
    await reauth()
    for (const role of ['migrator', 'reader', 'verifier'] as const) {
      const r = await owner.browser.call(
        'POST',
        `/api/v1/clusters/${ids.cluster}/credentials/${role}`,
        { password: loginPassword(ROLE_NAMES[role]) },
      )
      expect(r.status).toBe(202)
    }
    await observation.verifyCredentials()

    const stagingDb = await registerDatabase('e2e_mig_staging')
    await planAndApply('/api/v1/targets', {
      projectId: ids.project,
      environmentId: ids.staging,
      databaseId: stagingDb,
    })
    ids.stagingTarget = (
      await owner.browser.call(
        'GET',
        `/api/v1/targets/${encodeURIComponent(`${slug}/platform/staging`)}`,
      )
    ).body.id
    // Production registration needs an approval (self-approval acknowledged, re-authenticated).
    const prodDb = await registerDatabase('e2e_mig_prod')
    const planned = await owner.browser.call('POST', '/api/v1/targets', {
      projectId: ids.project,
      environmentId: ids.production,
      databaseId: prodDb,
    })
    await reauth()
    const applied = await owner.browser.call('POST', `/api/v1/plans/${planned.body.id}/apply`, {})
    expect(applied.body).toMatchObject({ state: 'awaiting_approval' })
    await reauth()
    expect(
      (
        await owner.browser.call('POST', `/api/v1/approvals/${applied.body.id}/approve`, {
          planHash: planned.body.planHash,
          acknowledgeSelfApproval: true,
        })
      ).status,
    ).toBe(200)
    await drive()
    ids.productionTarget = (
      await owner.browser.call(
        'GET',
        `/api/v1/targets/${encodeURIComponent(`${slug}/platform/production`)}`,
      )
    ).body.id
    expect(ids.productionTarget).toMatch(/^tgt_/)
  })
})

const first = ulid()
const LEADS = `CREATE TABLE public.leads (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email text NOT NULL
);
GRANT SELECT, INSERT ON public.leads TO ${APP_ROLE};
`
const LEADS_VERIFY =
  '-- check: the table is readable\nSELECT count(*) >= 0 AS ok FROM public.leads;\n'

describe('migrations over REST', () => {
  it('lints and ingests the exact bytes, with the digests the server computed itself', async () => {
    const b = bundle({ id: first, name: 'add-leads', up: LEADS, verify: LEADS_VERIFY })
    const lint = await owner.browser.call(
      'POST',
      `/api/v1/projects/${ids.project}/migrations/lint`,
      {
        bundles: [b],
        defaults: DEFAULTS,
      },
    )
    expect(lint.status).toBe(200)
    expect(lint.body.graph.valid).toBe(true)
    const linted = lint.body.bundles[0]
    expect(linted).toMatchObject({
      migrationId: first,
      checksum: expect.stringMatching(/^sha256:c1:/),
    })
    const ingest = await owner.browser.call('POST', `/api/v1/projects/${ids.project}/bundles`, {
      bundles: [b],
      defaults: DEFAULTS,
    })
    expect(ingest.status).toBe(200)
    expect(ingest.body.items).toEqual([
      expect.objectContaining({ migrationId: first, checksum: linted.checksum, revision: 1 }),
    ])
    const stored = await owner.browser.call(
      'GET',
      `/api/v1/projects/${ids.project}/bundles/${first}/revisions/1/files/up.sql`,
    )
    expect(stored.status).toBe(200)
    expect(stored.text).toContain('public.leads')
  })

  it('plans on staging, applies through plan.apply, verifies and reads the ledger back live', async () => {
    const { plan, operation: op } = await planAndApply(
      `/api/v1/targets/${ids.stagingTarget}/migrations/plans`,
      { migrationIds: [first], defaults: DEFAULTS },
    )
    expect(plan).toMatchObject({ kind: 'migration.apply', decision: 'allow' })
    const done = await operation(op.id)
    expect(done).toMatchObject({
      state: 'succeeded',
      applyOutcome: 'applied',
      verificationOutcome: 'passed',
      nextAction: 'none',
      waitingFor: null,
      // The driver's steps, from the operation's events (what a CLI watch shows).
      steps: [
        expect.objectContaining({ index: 0, name: 'execute', state: 'succeeded' }),
        expect.objectContaining({ index: 1, name: 'verify', state: 'succeeded' }),
      ],
    })
    expect(Number(done.lastEventId)).toBeGreaterThan(0)
    expect(Date.parse(done.observedAt)).toBeGreaterThanOrEqual(Date.parse(done.updatedAt))
    expect(done.steps[0].finishedAt).not.toBeNull()
    const status = await owner.browser.call(
      'GET',
      `/api/v1/targets/${ids.stagingTarget}/migrations`,
    )
    expect(status.status).toBe(200)
    expect(status.body.applied).toEqual([expect.objectContaining({ migrationId: first })])
    expect(status.body.source).toBe('live')
    const detail = await owner.browser.call(
      'GET',
      `/api/v1/targets/${ids.stagingTarget}/migrations/${first}`,
    )
    expect(detail.status).toBe(200)
    const again = await owner.browser.call(
      'POST',
      `/api/v1/targets/${ids.stagingTarget}/migrations/${first}/verifications`,
      {},
    )
    expect(again.status).toBe(202)
    await drive()
    expect(await operation(again.body.id)).toMatchObject({
      kind: 'migration.verify',
      state: 'succeeded',
      verificationOutcome: 'passed',
    })
  })

  it('promotes to production with the staging evidence bound live', async () => {
    const planned = await owner.browser.call(
      'POST',
      `/api/v1/targets/${ids.productionTarget}/migrations/plans`,
      { migrationIds: [first], defaults: DEFAULTS },
    )
    expect(planned.status).toBe(201)
    expect(planned.body).toMatchObject({ decision: 'allow', policyRules: [] })
    await reauth()
    const applied = await owner.browser.call('POST', `/api/v1/plans/${planned.body.id}/apply`, {})
    expect(applied.status).toBe(202)
    await drive()
    expect(await operation(applied.body.id)).toMatchObject({
      state: 'succeeded',
      applyOutcome: 'applied',
      verificationOutcome: 'passed',
    })
  })
})

let waiting = ''

describe('break-glass over REST', () => {
  const orphan = ulid()
  const orphanBundle = () =>
    bundle({
      id: orphan,
      name: 'prod-only',
      up: `CREATE TABLE public.prod_only (id int);\nGRANT SELECT ON public.prod_only TO ${APP_ROLE};\n`,
      verify: '-- check: readable\nSELECT count(*) >= 0 AS ok FROM public.prod_only;\n',
      dependsOn: [first],
    })

  it('denies a production plan without evidence: there is no override setting', async () => {
    const planned = await owner.browser.call(
      'POST',
      `/api/v1/targets/${ids.productionTarget}/migrations/plans`,
      { bundles: [orphanBundle()], defaults: DEFAULTS },
    )
    expect(planned.status).toBe(201)
    expect(planned.body.decision).toBe('deny')
    // The plan read says why: the evidence rule failed, and break-glass could override it.
    expect(planned.body.policyRules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'migration.staging-evidence',
          result: 'fail',
          overridableByBreakGlass: true,
        }),
      ]),
    )
    // The plan names bundles by digest; the SQL text stays in the bundle store.
    expect(JSON.stringify(planned.body.change)).not.toContain('prod_only (id int)')
  })

  it('refuses an activation without a notification channel, and without a fresh re-authentication', async () => {
    await reauth()
    const refused = await owner.browser.call(
      'POST',
      `/api/v1/targets/${ids.productionTarget}/break-glass-grants`,
      { rules: ['migration.staging-evidence'], reason: 'Hotfix for an outage, staging is down.' },
      silent,
    )
    expect(refused.status).toBe(409)
    expect(refused.body).toMatchObject({
      code: 'BREAK_GLASS_UNAVAILABLE',
      details: { reason: 'notification_channel_not_configured' },
    })
    await ageReauth()
    const stale = await owner.browser.call(
      'POST',
      `/api/v1/targets/${ids.productionTarget}/break-glass-grants`,
      { rules: ['migration.staging-evidence'], reason: 'Hotfix for an outage, staging is down.' },
    )
    expect(stale.body.code).toBe('REAUTH_REQUIRED')
  })

  it('refuses rules break-glass cannot override and a reason that is too short', async () => {
    await reauth()
    const locked = await owner.browser.call(
      'POST',
      `/api/v1/targets/${ids.productionTarget}/break-glass-grants`,
      { rules: ['migration.lint-errors'], reason: 'Hotfix for an outage, staging is down.' },
    )
    expect(locked.body).toMatchObject({
      code: 'BREAK_GLASS_UNAVAILABLE',
      details: { reason: 'rule_not_overridable' },
    })
    const short = await owner.browser.call(
      'POST',
      `/api/v1/targets/${ids.productionTarget}/break-glass-grants`,
      { rules: ['migration.staging-evidence'], reason: 'hotfix' },
    )
    expect(short.body.code).toBe('VALIDATION_FAILED')
  })

  it('activates a grant that notifies the owner, and a plan under it is accepted once', async () => {
    await reauth()
    const granted = await owner.browser.call(
      'POST',
      `/api/v1/targets/${ids.productionTarget}/break-glass-grants`,
      {
        rules: ['migration.staging-evidence', 'migration.dependencies-verified'],
        reason: 'Hotfix for an outage, staging is down.',
        durationMinutes: 15,
        maxUses: 1,
      },
    )
    expect(granted.status).toBe(201)
    expect(granted.body).toMatchObject({
      grantId: expect.stringMatching(/^bgl_/),
      targetId: ids.productionTarget,
      uses: 0,
      maxUses: 1,
      notifications: { recorded: 1, sent: 1, failed: 0 },
    })
    expect(delivered).toEqual([{ kind: 'breakglass.activated', to: 'owner@example.test' }])
    const audit = await db.asSuperuser((c) =>
      c.query(
        `SELECT event::jsonb -> 'changes' AS changes FROM audit.audit_events
          WHERE action = 'breakglass.activated' ORDER BY seq DESC LIMIT 1`,
      ),
    )
    expect(audit.rows[0]?.changes).toMatchObject({
      grantId: granted.body.grantId,
      reason: 'Hotfix for an outage, staging is down.',
    })

    const planned = await owner.browser.call(
      'POST',
      `/api/v1/targets/${ids.productionTarget}/migrations/plans`,
      { bundles: [orphanBundle()], defaults: DEFAULTS, breakGlassGrantId: granted.body.grantId },
    )
    expect(planned.status).toBe(201)
    // The evidence rule is overridden and shown; what break-glass cannot override still applies.
    expect(planned.body).toMatchObject({
      decision: 'require',
      overriddenRules: ['migration.staging-evidence'],
      requirements: expect.arrayContaining([
        { kind: 'break_glass', rules: ['migration.staging-evidence'] },
      ]),
    })
    // Without staging, lineage is unknown: an approval is still required (not overridable).
    expect(planned.body.policyRules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'migration.fingerprint-lineage', result: 'unknown' }),
      ]),
    )
    expect(JSON.stringify(planned.body)).toContain('migration.staging-evidence')
    await reauth()
    const applied = await owner.browser.call('POST', `/api/v1/plans/${planned.body.id}/apply`, {})
    expect(applied.status).toBe(202)
    waiting = applied.body.id
    const grants = await db.asSuperuser((c) =>
      c.query('SELECT uses FROM breakglass.grants WHERE grant_id = $1', [granted.body.grantId]),
    )
    expect(grants.rows[0]?.uses).toBe(1)
    const used = await db.asSuperuser((c) =>
      c.query(
        `SELECT event::jsonb -> 'actor' ->> 'viaBreakGlass' AS grant_id, operation_id
           FROM audit.audit_events WHERE action = 'breakglass.used' ORDER BY seq DESC LIMIT 1`,
      ),
    )
    expect(used.rows[0]).toEqual({ grant_id: granted.body.grantId, operation_id: applied.body.id })
    // Used up: another plan under it is refused.
    const again = await owner.browser.call(
      'POST',
      `/api/v1/targets/${ids.productionTarget}/migrations/plans`,
      { bundles: [orphanBundle()], defaults: DEFAULTS, breakGlassGrantId: granted.body.grantId },
    )
    expect(again.body).toMatchObject({
      code: 'BREAK_GLASS_UNAVAILABLE',
      details: { reason: 'grant_not_usable' },
    })
  })
})

describe('plan list and operation cancel over REST', () => {
  it('lists the plans the caller may read, newest first, with filters and an opaque cursor', async () => {
    const all = await owner.browser.call('GET', '/api/v1/plans?limit=200')
    expect(all.status).toBe(200)
    const ids = all.body.items.map((p: { id: string }) => p.id)
    expect(ids).toEqual([...ids].sort().reverse())
    expect(all.body.items.length).toBeGreaterThanOrEqual(4)
    const denied = await owner.browser.call(
      'GET',
      '/api/v1/plans?state=denied&kind=migration.apply',
    )
    expect(denied.body.items.length).toBeGreaterThanOrEqual(1)
    for (const p of denied.body.items)
      expect(p).toMatchObject({ state: 'denied', kind: 'migration.apply' })
    const first = await owner.browser.call('GET', '/api/v1/plans?limit=1')
    expect(first.body.items).toHaveLength(1)
    expect(first.body.nextCursor).toMatch(/^p1_/)
    const second = await owner.browser.call(
      'GET',
      `/api/v1/plans?limit=1&cursor=${encodeURIComponent(first.body.nextCursor)}`,
    )
    expect(second.body.items[0].id < first.body.items[0].id).toBe(true)
    const bad = await owner.browser.call('GET', '/api/v1/plans?cursor=o1_x', undefined, silent)
    expect(bad.body.code).toBe('VALIDATION_FAILED')
  })

  it('cancels an operation that has not started, once, and never one that ran', async () => {
    expect(waiting).toMatch(/^op_/)
    const before = await operation(waiting)
    expect(before).toMatchObject({ state: 'awaiting_approval', nextAction: 'approve' })
    const canceled = await owner.browser.call('POST', `/api/v1/operations/${waiting}/cancel`, {})
    expect(canceled.status).toBe(200)
    expect(canceled.body).toMatchObject({
      id: waiting,
      state: 'canceled',
      applyOutcome: 'not_started',
      errorCode: 'OPERATION_CANCELLED',
      nextAction: 'none',
    })
    const again = await owner.browser.call('POST', `/api/v1/operations/${waiting}/cancel`, {})
    expect(again.status).toBe(409)
    expect(again.body).toMatchObject({
      code: 'OPERATION_NOT_CANCELABLE',
      details: { state: 'canceled' },
    })
    const done = await owner.browser.call('GET', '/api/v1/operations?state=succeeded&limit=1')
    const ran = done.body.items[0].id
    const refused = await owner.browser.call('POST', `/api/v1/operations/${ran}/cancel`, {})
    expect(refused.body).toMatchObject({
      code: 'OPERATION_NOT_CANCELABLE',
      details: { state: 'succeeded' },
    })
    const unknown = await owner.browser.call(
      'POST',
      `/api/v1/operations/op_${newUlid(Date.now())}/cancel`,
      {},
    )
    expect([unknown.status, unknown.body.code]).toEqual([404, 'OPERATION_NOT_FOUND'])
    const audit = await db.asSuperuser((c) =>
      c.query(
        `SELECT action, event::jsonb -> 'result' ->> 'errorCode' AS code FROM audit.audit_events
          WHERE operation_id = $1 ORDER BY seq DESC LIMIT 1`,
        [waiting],
      ),
    )
    expect(audit.rows[0]?.code).toBe('OPERATION_CANCELLED')
  })

  it('rejects an approval of a kind that verifies: the operation ends canceled, nothing ran', async () => {
    await reauth()
    const granted = await owner.browser.call(
      'POST',
      `/api/v1/targets/${ids.productionTarget}/break-glass-grants`,
      {
        rules: ['migration.staging-evidence', 'migration.dependencies-verified'],
        reason: 'Second hotfix for the outage, staging is still down.',
        durationMinutes: 15,
        maxUses: 1,
      },
    )
    expect(granted.status).toBe(201)
    const planned = await owner.browser.call(
      'POST',
      `/api/v1/targets/${ids.productionTarget}/migrations/plans`,
      {
        bundles: [
          bundle({
            id: ulid(),
            name: 'prod-only-two',
            up: `CREATE TABLE public.prod_only_two (id int);\nGRANT SELECT ON public.prod_only_two TO ${APP_ROLE};\n`,
            verify: '-- check: readable\nSELECT count(*) >= 0 AS ok FROM public.prod_only_two;\n',
            dependsOn: [first],
          }),
        ],
        defaults: DEFAULTS,
        breakGlassGrantId: granted.body.grantId,
      },
    )
    expect(planned.body.decision).toBe('require')
    await reauth()
    const applied = await owner.browser.call('POST', `/api/v1/plans/${planned.body.id}/apply`, {})
    expect(applied.body).toMatchObject({
      state: 'awaiting_approval',
      verificationOutcome: 'pending',
    })
    await reauth()
    const rejected = await owner.browser.call(
      'POST',
      `/api/v1/approvals/${applied.body.id}/reject`,
      {
        planHash: planned.body.planHash,
      },
    )
    expect(rejected.status).toBe(200)
    expect(await operation(applied.body.id)).toMatchObject({
      state: 'canceled',
      applyOutcome: 'not_started',
      verificationOutcome: 'not_applicable',
      errorCode: 'OPERATION_CANCELLED',
    })
  })
})

/**
 * The CLI as a real process against this server over HTTP (order §68): a
 * service account's API key in a profile, reads, a local project with a
 * new bundle, plan, apply with waiting (the worker runs while the CLI
 * polls), the exit codes, NDJSON, an unreachable server and a watch that
 * times out. The CLI talks REST only; the test reads the database only to
 * check independently.
 */
const CLI_MAIN = fileURLToPath(new URL('../../cli/src/main.ts', import.meta.url))

describe('the CLI as a process', () => {
  let listener: ServerType
  let base = ''
  let home = ''
  let projectDir = ''

  async function cli(args: readonly string[], options: { drive?: boolean; cwd?: string } = {}) {
    const child = spawn('bun', ['--conditions=@exponetdb/source', CLI_MAIN, ...args], {
      cwd: options.cwd ?? projectDir,
      env: {
        PATH: process.env['PATH'] ?? '',
        HOME: home,
        EXPONETDB_CONFIG_DIR: join(home, 'config'),
        NO_COLOR: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (d: string) => {
      stdout += d
    })
    child.stderr.setEncoding('utf8').on('data', (d: string) => {
      stderr += d
    })
    let running = true
    const done = new Promise<number>((resolve) => {
      child.on('close', (code) => {
        running = false
        resolve(code ?? -1)
      })
    })
    if (options.drive === true) {
      while (running) {
        await drive()
        await new Promise((r) => setTimeout(r, 150))
      }
    }
    const code = await done
    return { code, stdout, stderr }
  }

  const json = (out: { stdout: string }) => JSON.parse(out.stdout)

  beforeAll(async () => {
    listener = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 })
    await new Promise((r) => setTimeout(r, 50))
    base = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`
    home = await mkdtemp(join(tmpdir(), 'exdb-cli-proc-'))
    projectDir = join(home, 'repo')
    await mkdir(projectDir)
    // A service account with the developer role and a nonprod-only API key.
    const account = await owner.browser.call('POST', '/api/v1/service-accounts', {
      displayName: 'CI deploy',
    })
    expect(account.status, JSON.stringify(account.body)).toBe(201)
    const binding = await owner.browser.call('POST', '/api/v1/role-bindings', {
      identityId: account.body.id,
      roleId: 'developer',
      scope: { kind: 'global' },
    })
    expect(binding.status, JSON.stringify(binding.body)).toBe(201)
    await reauth()
    expect(
      (await owner.browser.call('POST', `/api/v1/plans/${binding.body.id}/apply`, {})).status,
    ).toBe(202)
    await drive()
    await reauth()
    const key = await owner.browser.call(
      'POST',
      `/api/v1/service-accounts/${account.body.id}/api-keys`,
      {
        scopes: [
          'targets.read',
          'migrations.read',
          'migrations.plan',
          'migrations.apply:nonprod',
          'schema.read',
          'diagnostics.read',
        ],
        restrictions: { tiers: ['nonprod', 'prod'], targets: { kind: 'all' } },
        lifetimeDays: 30,
        // Reading and planning production: the key carries no production apply scope.
        acknowledgeProductionWrite: true,
      },
    )
    expect(key.status, JSON.stringify(key.body)).toBe(201)
    await writeFile(join(home, 'ci.key'), key.body.secret, { mode: 0o600 })
    await chmod(join(home, 'ci.key'), 0o600)
  }, 120_000)

  afterAll(async () => {
    await new Promise<void>((r) => listener?.close(() => r()))
    await rm(home, { recursive: true, force: true })
  })

  it('reads through a profile with an API key, in every output format', async () => {
    const added = await cli([
      'profile',
      'add',
      'ci',
      '--server',
      base,
      '--auth',
      'api-key',
      '--key-file',
      join(home, 'ci.key'),
      '--use',
    ])
    expect(added.code, added.stderr).toBe(0)
    const who = await cli(['whoami', '--json'])
    expect(who.code, who.stderr).toBe(0)
    expect(json(who)).toMatchObject({
      schema: 'exponetdb.cli-output/v1',
      status: 'ok',
      context: { server: base, profile: 'ci', installationId: db.installationId },
      data: { auth: 'api-key' },
    })
    expect(who.stdout + who.stderr).not.toContain('exak_')
    const targets = await cli(['target', 'list', '-o', 'ndjson'])
    expect(targets.code, targets.stderr).toBe(0)
    const records = targets.stdout
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    expect(records.at(-1)).toMatchObject({ type: 'result', status: 'ok' })
    expect(
      records
        .filter((r) => r.type === 'item')
        .map((r) => r.data.id)
        .sort(),
    ).toEqual([ids.stagingTarget, ids.productionTarget].sort())
    const table = await cli(['target', 'show', `${slug}/platform/staging`])
    expect(table.code).toBe(0)
    expect(table.stdout).toContain(`${slug}/platform/staging`)
    expect(table.stdout).not.toContain('\u001b[')
    const status = await cli(['migration', 'status', '--target', ids.stagingTarget, '--json'])
    expect(json(status).data.applied.map((e: { migrationId: string }) => e.migrationId)).toContain(
      first,
    )
    // Audit needs audit.read, which the developer role does not hold: exit 3 with the catalog code.
    const audit = await cli(['audit', 'list', '--json'])
    expect([audit.code, json(audit).error.code]).toEqual([3, 'PERMISSION_DENIED'])
  })

  it('authors a bundle locally, plans it on staging and applies it, exiting 0 only when verified', async () => {
    await writeFile(
      join(projectDir, 'exponetdb.project.yaml'),
      [
        'schema: exponetdb.project/v1',
        `project: ${slug}/platform`,
        'layout: bundles',
        'defaults:',
        '  lockTimeout: 5s',
        '  statementTimeout: 15m',
        '  role: owner',
        '  searchPath: [public]',
        'executionRoles:',
        `  owner: ${OWNER_ROLE}`,
        'managedScope:',
        '  includeSchemas: [public]',
        '  excludeSchemas: []',
        'lintProfile: strict',
        'bundleRoots:',
        '  - migrations',
        '',
      ].join('\n'),
    )
    await mkdir(join(projectDir, 'migrations'))
    // The stream already holds the bundle applied earlier, byte for byte.
    const earlier = bundle({ id: first, name: 'add-leads', up: LEADS, verify: LEADS_VERIFY })
    await mkdir(join(projectDir, 'migrations', earlier.directory))
    for (const [name, text] of Object.entries(earlier.files)) {
      await writeFile(join(projectDir, 'migrations', earlier.directory, name), text)
    }
    const made = await cli(['migration', 'new', 'cli-notes', '--json'])
    expect(json(made).data.dependsOn).toEqual([first])
    expect(made.code, made.stderr).toBe(0)
    const bundleDir = json(made).data.path
    await writeFile(
      join(bundleDir, 'up.sql'),
      `CREATE TABLE public.cli_notes (id bigint PRIMARY KEY, body text NOT NULL);\nGRANT SELECT ON public.cli_notes TO ${APP_ROLE};\n`,
    )
    await writeFile(
      join(bundleDir, 'verify.sql'),
      '-- check: notes readable\nSELECT count(*) >= 0 AS ok FROM public.cli_notes;\n',
    )
    const lint = await cli(['migration', 'lint', '--tier', 'nonprod', '--json'])
    expect(lint.code, lint.stdout).toBe(0)

    const planned = await cli([
      'migration',
      'plan',
      json(made).data.migrationId,
      '--target',
      ids.stagingTarget,
      '--json',
    ])
    expect(planned.code, planned.stdout + planned.stderr).toBe(0)
    const plan = json(planned)
    expect(plan).toMatchObject({
      status: 'ok',
      planId: expect.stringMatching(/^pln_/),
      data: { kind: 'migration.apply', decision: 'allow' },
    })
    expect(plan.next).toEqual([`exponetdb plan apply ${plan.planId} --wait`])
    const shown = await cli(['plan', 'show', plan.planId])
    expect(shown.stdout).toContain('Migration plan')
    expect(shown.stdout).toContain('cli-notes')

    // Accepted without waiting: exit 0, status accepted, never succeeded.
    const accepted = await cli(['plan', 'apply', plan.planId, '--no-wait', '--json'])
    expect(accepted.code, accepted.stderr).toBe(0)
    expect(json(accepted)).toMatchObject({ status: 'accepted', data: { state: 'queued' } })
    const operationId = json(accepted).operationId
    // A watch that ends before the worker ran: exit 6, the operation continues.
    const timedOut = await cli([
      'operation',
      'watch',
      operationId,
      '--timeout-wait',
      '1s',
      '--json',
    ])
    expect([timedOut.code, json(timedOut).error.code]).toEqual([6, 'WATCH_TIMEOUT'])
    // With the worker running: applied and verified, exit 0.
    const watched = await cli(['operation', 'watch', operationId, '-o', 'ndjson'], { drive: true })
    expect(watched.code, watched.stdout + watched.stderr).toBe(0)
    const lines = watched.stdout
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    expect(lines.some((l) => l.type === 'progress')).toBe(true)
    expect(lines.at(-1)).toMatchObject({
      type: 'result',
      status: 'ok',
      data: { state: 'succeeded', applyOutcome: 'applied', verificationOutcome: 'passed' },
    })
    const after = await cli(['migration', 'status', '--target', ids.stagingTarget, '--json'])
    expect(json(after).data.applied.map((e: { migrationId: string }) => e.migrationId)).toContain(
      json(made).data.migrationId,
    )
    // Independently: the staging database's own ledger has the row with the local checksum.
    const sums = json(await cli(['migration', 'checksum', '--json']))
    const local = sums.data.items.find(
      (i: { migrationId: string }) => i.migrationId === json(made).data.migrationId,
    )
    const dbs = await owner.browser.call('GET', `/api/v1/clusters/${ids.cluster}/databases`)
    const stagingName = dbs.body.items.find(
      (d: { placement: { targetId: string } | null }) =>
        d.placement?.targetId === ids.stagingTarget,
    ).name
    const client = await superuserClient(pg17, stagingName)
    try {
      const row = await client.query(
        'SELECT checksum, operation_id FROM exponetdb.schema_migrations WHERE migration_id = $1',
        [json(made).data.migrationId],
      )
      expect(row.rows).toEqual([{ checksum: local.checksum, operation_id: operationId }])
    } finally {
      await client.end()
    }

    // Production: the key holds no production apply scope; planning works, applying is exit 3.
    const prod = await cli([
      'migration',
      'plan',
      json(made).data.migrationId,
      '--target',
      ids.productionTarget,
      '--json',
    ])
    expect(prod.code, prod.stdout + prod.stderr).toBe(0)
    const prodApply = await cli([
      'plan',
      'apply',
      json(prod).planId,
      '--yes',
      '--no-input',
      '--json',
    ])
    expect(prodApply.code, prodApply.stdout).toBe(3)
    expect(json(prodApply).error.code).toBe('INSUFFICIENT_SCOPE')
    const plans = await cli(['plan', 'list', '--mine', '--json'])
    expect(json(plans).data.items.map((p: { id: string }) => p.id)).toEqual(
      expect.arrayContaining([plan.planId, json(prod).planId]),
    )
  })

  it('exits 5 when the server cannot be reached, and 2 on a usage error', async () => {
    const down = await cli(['target', 'list', '--server', 'http://127.0.0.1:9', '--json'])
    expect(down.code).toBe(5)
    expect(json(down).error.code).toBe('TRANSPORT_FAILED')
    const usage = await cli(['target', 'lst'])
    expect(usage.code).toBe(2)
    expect(usage.stderr).toContain('Did you mean: exponetdb target list')
    expect((await readdir(join(home, 'config'))).sort()).toEqual(['profiles.json'])
  })
})
