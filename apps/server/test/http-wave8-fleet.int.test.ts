import { FleetFindingSchema, FleetSchema } from '@exponetdb/contracts'
import { type MigratedTestDatabase, migratedTestDatabase } from '@exponetdb/control-store/testing'
import { recordFinding, resolveFinding } from '@exponetdb/diagnostics'
import { newId, systemClock } from '@exponetdb/kernel'
import { initPki } from '@exponetdb/nodes'
import { createLogger, MetricsRegistry, pass, Readiness } from '@exponetdb/observability'
import { KindRegistry, processNextOperation } from '@exponetdb/operations'
import {
  generateKeyringText,
  type Keyring,
  parseKeyring,
  registerActiveKey,
} from '@exponetdb/secrets'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { composeAccess, workerKinds } from '../src/composition/access.ts'
import type { ServeConfig } from '../src/config/env.ts'
import { createPublicApp, httpMetrics } from '../src/interfaces/http/app.ts'
import {
  enrollOwner,
  ORIGIN,
  type Person,
  placeTarget,
  registryWorld,
  storeOf,
  type World,
} from './support/node-world.ts'

/**
 * The fleet overview (`GET /fleet`) and the findings across targets
 * (`GET /findings`) of Wave 8 (order §9) over the real public app, on
 * PostgreSQL 17: four targets of two tiers in two organizations, their
 * health in every source state, findings of every severity, and operations
 * in the three states the overview counts. Authorization is the central
 * engine's: a person, and service accounts whose keys are restricted in
 * tier, in targets or in scopes.
 */
let db: MigratedTestDatabase
let keyring: Keyring
let app: ReturnType<typeof createPublicApp>
let owner: Person
let registry: KindRegistry
let worldA: World
let worldB: World
/** API keys, minted before any operation is seeded: applying an access plan drives the worker, which would pick up seeded operations. */
const key = {
  nonprod: '',
  oneProdTarget: '',
  oneNonprodTarget: '',
  targetsOnly: '',
  diagnosticsOnly: '',
}
const t = { nonprodA: '', prodA: '', nonprodB: '', prodB: '' }
const path = { nonprodA: '', prodA: '', nonprodB: '', prodB: '' }
/** Every finding seeded: id, target key, severity, kind, state. */
const seeded: {
  id: string
  target: keyof typeof t
  severity: string
  kind: string
  state: string
}[] = []

beforeAll(async () => {
  db = await migratedTestDatabase('exdb_it_http_wave8_fleet')
  const parsed = parseKeyring(generateKeyringText('test-key'))
  if (!parsed.ok) throw new Error('keyring')
  keyring = parsed.value
  const worker = storeOf(db, 'exdb_worker')
  await registerActiveKey(worker, keyring)
  await worker.transaction('test.pki', (tx) =>
    initPki(tx, keyring, systemClock, {
      gatewayUrl: 'https://10.8.2.2:7443',
      serverName: 'gateway.exdb.test',
    }),
  )
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
  const readiness = new Readiness(systemClock)
  readiness.register({ name: 'control_store', severity: 'critical', run: async () => pass() })
  readiness.register({ name: 'schema', severity: 'critical', run: async () => pass() })
  await readiness.evaluate()
  const access = composeAccess(
    config,
    { store: storeOf(db, 'exdb_serve'), keyring, readiness },
    { clock: systemClock },
  )
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
  owner = await enrollOwner(db, (input, init) => app.request(input, init))
  registry = new KindRegistry(
    workerKinds({ store: worker, keyring }, { clock: systemClock }, db.installationId),
  )
  worldA = await registryWorld(db)
  worldB = await registryWorld(db)
  t.nonprodA = await placeTarget(db, worldA, 'nonprod')
  t.prodA = await placeTarget(db, worldA, 'prod')
  t.nonprodB = await placeTarget(db, worldB, 'nonprod')
  t.prodB = await placeTarget(db, worldB, 'prod')
  path.nonprodA = `${worldA.slug}/platform/staging`
  path.prodA = `${worldA.slug}/platform/production`
  path.nonprodB = `${worldB.slug}/platform/staging`
  path.prodB = `${worldB.slug}/platform/production`
  await seedHealth()
  await seedFindings()
  await mintKeys()
  await seedOperations()
}, 240_000)

afterAll(async () => {
  await db?.drop()
})

const SQL_ID = (prefix: 'op' | 'pln', ms = Date.now()) => newId(prefix, ms)

/**
 * Health in every source state: fresh and healthy, fresh and degraded, a
 * healthy sample ten minutes old (the sampler is lagging: unknown, cached),
 * and a target never sampled (unknown, inferred).
 */
async function seedHealth() {
  await db.asSuperuser(async (c) => {
    await c.query(
      `INSERT INTO observation.target_status (target_id, state, conditions, probes, observed_at)
       VALUES ($1, 'healthy', '[]', '[]', now()), ($2, 'degraded', '[]', '[]', now())`,
      [t.nonprodA, t.prodA],
    )
    await c.query(
      `INSERT INTO observation.target_status (target_id, state, conditions, probes, observed_at)
       VALUES ($1, 'healthy', '[]', '[]', now() - interval '10 minutes')`,
      [t.nonprodB],
    )
  })
}

async function addFinding(
  target: keyof typeof t,
  severity: 'info' | 'warning' | 'critical',
  kind: 'drift' | 'health',
  n: number,
  resolve = false,
) {
  await storeOf(db, 'exdb_worker').transaction('test.finding', async (tx) => {
    const r = await recordFinding(tx, {
      targetId: t[target],
      kind,
      code: kind === 'drift' ? 'object_added' : 'connections_high',
      severity,
      dedupKey: `${target}:${severity}:${kind}:${n}`,
      summary: `Finding ${n} on ${target}`,
      details: { object: `table public.t${n}` },
    })
    if (resolve) await resolveFinding(tx, r.findingId, 'cleared', null)
    seeded.push({
      id: r.findingId,
      target,
      severity,
      kind,
      state: resolve ? 'resolved' : 'open',
    })
  })
}

async function seedFindings() {
  let n = 0
  // 3 on nonprodA, 2 on prodA, 1 on nonprodB, plus 118 more spread over the four targets so
  // that paging crosses several pages; one resolved finding on prodB.
  for (const [target, severity, kind] of [
    ['nonprodA', 'warning', 'drift'],
    ['nonprodA', 'info', 'health'],
    ['nonprodA', 'critical', 'health'],
    ['prodA', 'critical', 'drift'],
    ['prodA', 'warning', 'health'],
    ['nonprodB', 'info', 'drift'],
  ] as const) {
    await addFinding(target, severity, kind, n++)
  }
  const keys = Object.keys(t) as (keyof typeof t)[]
  const severities = ['info', 'warning', 'critical'] as const
  for (let i = 0; i < 118; i++) {
    await addFinding(
      keys[i % 4] as keyof typeof t,
      severities[i % 3] as 'info',
      i % 5 === 0 ? 'health' : 'drift',
      n++,
    )
  }
  await addFinding('prodB', 'warning', 'drift', n++, true)
}

/** An operation of a kind, in a state, on a plan whose subject is a target (or none). */
async function addOperation(
  state: 'running' | 'awaiting_approval' | 'needs_attention' | 'succeeded',
  target: keyof typeof t | null,
  tier: 'prod' | 'nonprod',
) {
  const outcomes: Record<string, [string, string]> = {
    running: ['not_started', 'pending'],
    awaiting_approval: ['not_started', 'pending'],
    needs_attention: ['applied', 'error'],
    succeeded: ['applied', 'passed'],
  }
  const [apply, verification] = outcomes[state] as [string, string]
  const planId = target === null ? null : SQL_ID('pln')
  const operationId = SQL_ID('op')
  await db.asSuperuser(async (c) => {
    await c.query('BEGIN')
    await c.query("SET LOCAL session_replication_role = 'replica'")
    if (planId !== null && target !== null) {
      const body = JSON.stringify({ nonce: operationId, subject: { targetId: t[target], tier } })
      await c.query(
        `INSERT INTO operations.plans (plan_id, kind, kind_version, action_class, state, decision, plan_hash,
           content_checksum, policy_version, actor_kind, client_kind, target_id, tier, created_at, expires_at)
         VALUES ($1, 'migration.apply', 1, 'standard', 'consumed', 'allow',
           'sha256:' || encode(sha256(convert_to($2::text, 'UTF8')), 'hex'),
           'sha256:' || repeat('a', 64), 'sha256:pv1:' || repeat('b', 64), 'system', 'system', $3, $4,
           now() - interval '1 hour', now() + interval '30 minutes')`,
        [planId, body, t[target], tier],
      )
      await c.query('INSERT INTO operations.plan_bodies (plan_id, body) VALUES ($1, $2)', [
        planId,
        body,
      ])
    }
    await c.query(
      `INSERT INTO operations.operations (operation_id, plan_id, kind, kind_version, state, apply_outcome,
         verification_outcome, actor_kind, client_kind)
       VALUES ($1, $2, 'migration.apply', 1, $3, $4, $5, 'system', 'system')`,
      [operationId, planId, state, apply, verification],
    )
    await c.query('COMMIT')
  })
}

async function seedOperations() {
  await addOperation('running', 'nonprodA', 'nonprod')
  await addOperation('running', 'nonprodB', 'nonprod')
  await addOperation('awaiting_approval', 'nonprodA', 'nonprod')
  await addOperation('running', 'prodA', 'prod')
  await addOperation('needs_attention', 'prodB', 'prod')
  // Terminal operations are not counted.
  await addOperation('succeeded', 'prodA', 'prod')
}

async function drive() {
  for (let i = 0; i < 20; i++) {
    const r = await processNextOperation(storeOf(db, 'exdb_worker'), {
      workerId: newId('prc', Date.now()),
      kinds: registry,
      clock: systemClock,
    })
    if (r.status === 'idle') return
  }
}

async function bearer(token: string | undefined, route: string) {
  const response = await app.request(`${ORIGIN}${route}`, {
    method: 'GET',
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  })
  const text = await response.text()
  return {
    status: response.status,
    // biome-ignore lint/suspicious/noExplicitAny: a parsed JSON body, asserted by each test.
    body: (text.length === 0 ? undefined : JSON.parse(text)) as any,
    text,
  }
}

async function serviceAccount(name: string, roleId: string): Promise<string> {
  await owner.reauth()
  const created = await owner.browser.call('POST', '/api/v1/service-accounts', {
    displayName: name,
  })
  expect(created.status).toBe(201)
  const planned = await owner.browser.call('POST', '/api/v1/role-bindings', {
    identityId: created.body.id,
    roleId,
    scope: { kind: 'global' },
  })
  expect(planned.status, planned.text).toBe(201)
  await owner.reauth()
  expect(
    (await owner.browser.call('POST', `/api/v1/plans/${planned.body.id}/apply`, {})).status,
  ).toBe(202)
  await drive()
  return String(created.body.id)
}

async function apiKey(
  account: string,
  scopes: string[],
  tiers: ('prod' | 'nonprod')[] = ['nonprod'],
  targetIds?: string[],
): Promise<string> {
  await owner.reauth()
  const key = await owner.browser.call('POST', `/api/v1/service-accounts/${account}/api-keys`, {
    scopes,
    restrictions: {
      tiers,
      targets: targetIds === undefined ? { kind: 'all' } : { kind: 'list', targetIds },
    },
    lifetimeDays: 30,
    ...(tiers.includes('prod') ? { acknowledgeProductionWrite: true } : {}),
  })
  expect(key.status, key.text).toBe(201)
  return String(key.body.secret)
}

const READ_SCOPES = ['targets.read', 'diagnostics.read', 'migrations.read']

async function mintKeys() {
  const viewer = await serviceAccount('Fleet viewer', 'viewer')
  key.nonprod = await apiKey(viewer, READ_SCOPES, ['nonprod'])
  key.oneProdTarget = await apiKey(viewer, READ_SCOPES, ['nonprod', 'prod'], [t.prodA])
  key.oneNonprodTarget = await apiKey(viewer, READ_SCOPES, ['nonprod', 'prod'], [t.nonprodB])
  key.targetsOnly = await apiKey(viewer, ['targets.read'], ['nonprod', 'prod'])
  key.diagnosticsOnly = await apiKey(viewer, ['diagnostics.read'], ['nonprod'])
}

const countOf = (pred: (f: (typeof seeded)[number]) => boolean) => seeded.filter(pred).length

describe('GET /fleet', () => {
  it('counts targets by tier and health, findings by severity and the three operation states, each with source and time', async () => {
    const r = await owner.browser.call('GET', '/api/v1/fleet')
    expect(r.status, r.text).toBe(200)
    expect(FleetSchema.safeParse(r.body).success).toBe(true)
    expect(r.body.targets).toMatchObject({
      total: 4,
      decommissioned: 0,
      byTier: { prod: 2, nonprod: 2 },
      // The lagging sample and the never-sampled target are unknown, not healthy.
      byHealth: { healthy: 1, degraded: 1, unhealthy: 0, unreachable: 0, unknown: 2, suspended: 0 },
      bySource: { sampled: 2, cached: 1, inferred: 1 },
      source: 'live',
      lowerBound: false,
      lowerBoundReason: null,
    })
    expect(r.body.targets.oldestSampleAt).not.toBeNull()
    const open = (s?: string) =>
      countOf((f) => f.state === 'open' && (s === undefined || f.severity === s))
    expect(r.body.findings).toMatchObject({
      available: true,
      open: open(),
      bySeverity: { info: open('info'), warning: open('warning'), critical: open('critical') },
      source: 'live',
      lowerBound: false,
    })
    expect(r.body.operations).toMatchObject({
      available: true,
      running: 3,
      needs_attention: 1,
      awaiting_approval: 1,
      source: 'live',
      lowerBound: false,
      lowerBoundReason: null,
    })
    for (const part of [r.body.targets, r.body.findings, r.body.operations]) {
      expect(Date.parse(part.observedAt)).toBeGreaterThan(Date.now() - 60_000)
    }
    expect(Date.parse(r.body.asOf)).toBeGreaterThan(Date.now() - 60_000)
  })

  it('shows a caller restricted to nonprod only nonprod: no prod target, finding or operation is counted', async () => {
    const r = await bearer(key.nonprod, '/api/v1/fleet')
    expect(r.status, r.text).toBe(200)
    expect(r.body.targets).toMatchObject({
      total: 2,
      byTier: { prod: 0, nonprod: 2 },
      byHealth: { healthy: 1, degraded: 0, unknown: 1 },
    })
    const nonprodOpen = (s: string) =>
      countOf(
        (f) =>
          f.state === 'open' &&
          (f.target === 'nonprodA' || f.target === 'nonprodB') &&
          f.severity === s,
      )
    expect(r.body.findings.bySeverity).toEqual({
      info: nonprodOpen('info'),
      warning: nonprodOpen('warning'),
      critical: nonprodOpen('critical'),
    })
    expect(r.body.operations).toMatchObject({
      running: 2,
      needs_attention: 0,
      awaiting_approval: 1,
    })
  })

  it('shows a delegated key on one target only that target', async () => {
    const r = await bearer(key.oneProdTarget, '/api/v1/fleet')
    expect(r.status, r.text).toBe(200)
    expect(r.body.targets).toMatchObject({
      total: 1,
      byTier: { prod: 1, nonprod: 0 },
      byHealth: { degraded: 1, healthy: 0, unknown: 0 },
    })
    const mine = (s: string) =>
      countOf((f) => f.state === 'open' && f.target === 'prodA' && f.severity === s)
    expect(r.body.findings.bySeverity).toEqual({
      info: mine('info'),
      warning: mine('warning'),
      critical: mine('critical'),
    })
    expect(r.body.operations).toMatchObject({
      running: 1,
      needs_attention: 0,
      awaiting_approval: 0,
    })
  })

  it('serves the part a caller lacks the permission for as unavailable with a reason, never as zero; and refuses without targets.read', async () => {
    const r = await bearer(key.targetsOnly, '/api/v1/fleet')
    expect(r.status, r.text).toBe(200)
    expect(r.body.targets.total).toBe(4)
    expect(r.body.findings).toEqual({ available: false, reason: 'permission_denied' })
    // Operations are filtered by the operation read rule: without migrations.read, none is visible.
    expect(r.body.operations).toMatchObject({
      running: 0,
      needs_attention: 0,
      awaiting_approval: 0,
    })
    const refused = await bearer(key.diagnosticsOnly, '/api/v1/fleet')
    expect([refused.status, refused.body.code]).toEqual([403, expect.any(String)])
    expect((await bearer(undefined, '/api/v1/fleet')).status).toBe(401)
  })

  it('answers an error, not zeros, when a read fails', async () => {
    await db.asSuperuser(async (c) => {
      await c.query('ALTER TABLE observation.target_status RENAME TO target_status_hidden')
    })
    try {
      const r = await owner.browser.call('GET', '/api/v1/fleet')
      expect(r.status).toBeGreaterThanOrEqual(500)
      expect(r.body.targets).toBeUndefined()
    } finally {
      await db.asSuperuser(async (c) => {
        await c.query('ALTER TABLE observation.target_status_hidden RENAME TO target_status')
      })
    }
    expect((await owner.browser.call('GET', '/api/v1/fleet')).status).toBe(200)
  })
})

describe('GET /findings', () => {
  async function allPages(token: string | undefined, query: string, limit: number) {
    const ids: string[] = []
    let cursor: string | null = null
    let pages = 0
    do {
      const route: string = `/api/v1/findings?limit=${limit}${query}${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`
      const r =
        token === undefined ? await owner.browser.call('GET', route) : await bearer(token, route)
      expect(r.status, r.text).toBe(200)
      expect(r.body.items.length).toBeLessThanOrEqual(limit)
      for (const item of r.body.items) {
        expect(FleetFindingSchema.safeParse(item).success).toBe(true)
        ids.push(item.id)
      }
      cursor = r.body.nextCursor
      pages++
      expect(pages).toBeLessThan(100)
    } while (cursor !== null)
    return { ids, pages }
  }

  it('lists the open findings of all targets newest first, with the target id and path, and pages with no duplicate and no gap', async () => {
    const open = seeded.filter((f) => f.state === 'open').map((f) => f.id)
    const paged = await allPages(undefined, '', 7)
    expect(paged.pages).toBe(Math.ceil(open.length / 7))
    expect(new Set(paged.ids).size).toBe(paged.ids.length)
    expect([...paged.ids].sort()).toEqual([...open].sort())
    // Newest first: ULIDs descend.
    expect(paged.ids).toEqual([...paged.ids].sort().reverse())
    // One page of 200 holds all of them and agrees with the small pages.
    const big = await allPages(undefined, '', 200)
    expect(big.pages).toBe(1)
    expect(big.ids).toEqual(paged.ids)
    const first = await owner.browser.call('GET', '/api/v1/findings?limit=3')
    for (const item of first.body.items) {
      const mine = seeded.find((f) => f.id === item.id)
      expect(mine).toBeDefined()
      expect(item.targetId).toBe(t[mine?.target as keyof typeof t])
      expect(item.targetPath).toBe(path[mine?.target as keyof typeof path])
      expect(item.subject.targetId).toBe(item.targetId)
    }
    // The default page is 50.
    const dflt = await owner.browser.call('GET', '/api/v1/findings')
    expect(dflt.body.items).toHaveLength(50)
    expect(dflt.body.nextCursor).not.toBeNull()
  })

  it('filters by severity, state, kind and target, and combines them', async () => {
    const critical = await allPages(undefined, '&severity=critical', 50)
    expect(critical.ids.sort()).toEqual(
      seeded
        .filter((f) => f.state === 'open' && f.severity === 'critical')
        .map((f) => f.id)
        .sort(),
    )
    const resolved = await owner.browser.call('GET', '/api/v1/findings?state=resolved')
    expect(resolved.body.items.map((i: { id: string }) => i.id)).toEqual(
      seeded.filter((f) => f.state === 'resolved').map((f) => f.id),
    )
    expect(resolved.body.items[0]).toMatchObject({ state: 'resolved', targetPath: path.prodB })
    const all = await allPages(undefined, '&state=all', 60)
    expect(all.ids).toHaveLength(seeded.length)
    const health = await allPages(undefined, '&kind=health&severity=warning', 50)
    expect(health.ids.sort()).toEqual(
      seeded
        .filter((f) => f.state === 'open' && f.kind === 'health' && f.severity === 'warning')
        .map((f) => f.id)
        .sort(),
    )
    const one = await allPages(undefined, `&target=${encodeURIComponent(path.prodA)}`, 20)
    expect(one.ids.sort()).toEqual(
      seeded
        .filter((f) => f.state === 'open' && f.target === 'prodA')
        .map((f) => f.id)
        .sort(),
    )
    const byId = await owner.browser.call('GET', `/api/v1/findings?target=${t.nonprodB}&limit=200`)
    expect(byId.body.items.every((i: { targetId: string }) => i.targetId === t.nonprodB)).toBe(true)
    const unknownTarget = await owner.browser.call(
      'GET',
      `/api/v1/findings?target=${encodeURIComponent('nobody/none/nowhere')}`,
    )
    expect([unknownTarget.status, unknownTarget.body.code]).toEqual([404, 'TARGET_NOT_FOUND'])
  })

  it('answers 422 for an unknown filter value, an unknown parameter, a bad limit or a bad cursor', async () => {
    for (const query of [
      '?severity=fatal',
      '?state=closed',
      '?kind=advisor',
      '?limit=201',
      '?limit=0',
      '?limit=abc',
      '?target=not a target',
      '?includeResolved=true',
      '?cursor=nonsense',
    ]) {
      const r = await owner.browser.call('GET', `/api/v1/findings${query}`)
      expect([r.status, r.body.code], query).toEqual([422, 'VALIDATION_FAILED'])
    }
  })

  it('lists only the findings of targets the caller may read with diagnostics.read', async () => {
    const nonprodKey = key.nonprod
    const mine = await allPages(nonprodKey, '', 25)
    expect(mine.ids.sort()).toEqual(
      seeded
        .filter((f) => f.state === 'open' && (f.target === 'nonprodA' || f.target === 'nonprodB'))
        .map((f) => f.id)
        .sort(),
    )
    // A prod target named explicitly does not exist for this key.
    const hidden = await bearer(
      nonprodKey,
      `/api/v1/findings?target=${encodeURIComponent(path.prodA)}`,
    )
    expect([hidden.status, hidden.body.code]).toEqual([404, 'TARGET_NOT_FOUND'])
    // A key on one target sees that target's findings only.
    const oneKey = key.oneNonprodTarget
    const one = await allPages(oneKey, '&state=all', 50)
    expect(one.ids.sort()).toEqual(
      seeded
        .filter((f) => f.target === 'nonprodB')
        .map((f) => f.id)
        .sort(),
    )
    // Without diagnostics.read the list is refused, and without a credential it is unauthenticated.
    expect((await bearer(key.targetsOnly, '/api/v1/findings')).status).toBe(403)
    expect((await bearer(undefined, '/api/v1/findings')).status).toBe(401)
  })

  it('answers an error, not an empty list, when the read fails', async () => {
    await db.asSuperuser(async (c) => {
      await c.query('ALTER TABLE observation.findings RENAME TO findings_hidden')
    })
    try {
      const r = await owner.browser.call('GET', '/api/v1/findings')
      expect(r.status).toBeGreaterThanOrEqual(500)
      expect(r.body.items).toBeUndefined()
    } finally {
      await db.asSuperuser(async (c) => {
        await c.query('ALTER TABLE observation.findings_hidden RENAME TO findings')
      })
    }
  })
})

describe('the fleet operations count when many operations are open', () => {
  it('stays a bounded read and says it is a lower bound when it stopped at the scan limit', async () => {
    // 520 operations that run, with no plan (an installation-wide subject the owner may read).
    const ids = Array.from({ length: 520 }, (_, i) => SQL_ID('op', Date.now() + 1000 + i))
    await db.asSuperuser(async (c) => {
      await c.query('BEGIN')
      await c.query("SET LOCAL session_replication_role = 'replica'")
      await c.query(
        `INSERT INTO operations.operations (operation_id, kind, kind_version, state, apply_outcome,
           verification_outcome, actor_kind, client_kind)
         SELECT id, 'migration.apply', 1, 'running', 'not_started', 'pending', 'system', 'system'
           FROM unnest($1::text[]) AS id`,
        [ids],
      )
      await c.query('COMMIT')
    })
    const r = await owner.browser.call('GET', '/api/v1/fleet')
    expect(r.status, r.text).toBe(200)
    expect(r.body.operations).toMatchObject({
      available: true,
      lowerBound: true,
      lowerBoundReason: 'scan_limit',
    })
    const o = r.body.operations
    expect(o.running + o.needs_attention + o.awaiting_approval).toBe(500)
    // The counts of targets and findings are exact whatever the operations do.
    expect(r.body.targets.lowerBound).toBe(false)
    expect(r.body.findings.lowerBound).toBe(false)
  })
})
