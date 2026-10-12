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
  testTargets,
} from '@exponetdb/testkit'
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
    expect(await operation(op.id)).toMatchObject({
      state: 'succeeded',
      applyOutcome: 'applied',
      verificationOutcome: 'passed',
    })
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
