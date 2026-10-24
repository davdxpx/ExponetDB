import { dataReadAuditEvent, type ReadParties } from '@exponetdb/application'
import { appendAuditEvent } from '@exponetdb/audit'
import { oauth } from '@exponetdb/auth'
import {
  DriftCheckSummarySchema,
  MCP_TOOL_LIST,
  OAuthClientViewSchema,
  SchemaObjectListSchema,
  TargetHealthViewSchema,
} from '@exponetdb/contracts'
import { type MigratedTestDatabase, migratedTestDatabase } from '@exponetdb/control-store/testing'
import { type HealthSample, persistSnapshot, reduceHealth } from '@exponetdb/diagnostics'
import { type GrantId, type IdentityId, newId, systemClock } from '@exponetdb/kernel'
import { createLogger, MetricsRegistry, pass, Readiness } from '@exponetdb/observability'
import { KindRegistry, processNextOperation } from '@exponetdb/operations'
import {
  type ActivitySummary,
  type CanonicalDocument,
  fingerprintOf,
  makeDocument,
  makeEntry,
  type Snapshot,
  scopeHeader,
} from '@exponetdb/postgres'
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
  enrollFromLink,
  enrollOwner,
  ORIGIN,
  type Person,
  placeTarget,
  registryWorld,
  storeOf,
  type World,
} from './support/node-world.ts'

/**
 * The Wave 8 completion: five additive server changes the Web App needs, over
 * the real public app on PostgreSQL 17 (a registered target with a stored
 * schema snapshot and health samples, drift checks, audit events and OAuth
 * grants in the Control Store):
 *
 * - A1 `GET /targets/{target}/schema/objects`: the objects of the snapshot
 *   without a search term, filters, a total, a cursor bound to the snapshot;
 * - A2 `GET /targets/{target}/drift-checks`: the history of past checks;
 * - A3 `capacity` on `GET /targets/{target}/health`: measured, or absent;
 * - A4 `identity` on `GET /audit-events`;
 * - A5 `lastUsedAt` and `activeGrantCount` on the OAuth clients.
 *
 * Each is REST only (the MCP announcements are unchanged: the contract suite
 * pins that) and answers under the permission of the closest existing read.
 */
let db: MigratedTestDatabase
let keyring: Keyring
let app: ReturnType<typeof createPublicApp>
let application: ReturnType<typeof composeAccess>['application']
let registry: KindRegistry
let world: World
let owner: Person
let alice: Person
let nonprod = ''
let prod = ''
/** API keys of service accounts with one scope each (a viewer or an auditor role globally). */
const key = {
  schema: '',
  schemaProdOnly: '',
  diagnostics: '',
  diagnosticsProdOnly: '',
  targetsOnly: '',
  audit: '',
  auditNonprod: '',
  viewerAny: '',
}

// biome-ignore lint/suspicious/noExplicitAny: a parsed JSON body, asserted by each test.
type Body = any

beforeAll(async () => {
  db = await migratedTestDatabase('exdb_it_http_wave8_parity')
  const parsed = parseKeyring(generateKeyringText('test-key'))
  if (!parsed.ok) throw new Error('keyring')
  keyring = parsed.value
  const worker = storeOf(db, 'exdb_worker')
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
  application = access.application
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
  world = await registryWorld(db)
  nonprod = await placeTarget(db, world, 'nonprod')
  prod = await placeTarget(db, world, 'prod')
  // The nonprod target is live; the production target stays registered (a read of its schema is refused).
  await setTargetState(nonprod, 'active')
  alice = await invitePerson('alice@example.test', 'viewer')
  const viewer = await serviceAccount('Parity viewer', 'viewer')
  const auditor = await serviceAccount('Parity auditor', 'auditor')
  key.schema = await apiKey(viewer, ['schema.read'], ['nonprod'])
  key.schemaProdOnly = await apiKey(viewer, ['schema.read'], ['prod'])
  key.diagnostics = await apiKey(viewer, ['diagnostics.read'], ['nonprod'])
  key.diagnosticsProdOnly = await apiKey(viewer, ['diagnostics.read'], ['prod'])
  key.targetsOnly = await apiKey(viewer, ['targets.read'], ['nonprod', 'prod'])
  key.viewerAny = await apiKey(
    viewer,
    ['targets.read', 'schema.read', 'diagnostics.read'],
    ['nonprod', 'prod'],
  )
  key.audit = await apiKey(auditor, ['audit.read'], ['nonprod', 'prod'])
  key.auditNonprod = await apiKey(auditor, ['audit.read'], ['nonprod'])
}, 300_000)

afterAll(async () => {
  await db?.drop()
})

// ----- fixtures -----

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

/** Sets a target's lifecycle state directly (the registry workflows have their own tests). */
async function setTargetState(targetId: string, state: 'registered' | 'active') {
  await db.asSuperuser(async (c) => {
    await c.query('BEGIN')
    await c.query("SET LOCAL session_replication_role = 'replica'")
    await c.query(
      'UPDATE registry.targets SET state = $2, state_changed_at = now() WHERE target_id = $1',
      [targetId, state],
    )
    await c.query('COMMIT')
  })
}

async function bindRole(identityId: string, roleId: string, scope: object) {
  await owner.reauth()
  const planned = await owner.browser.call('POST', '/api/v1/role-bindings', {
    identityId,
    roleId,
    scope,
  })
  expect(planned.status, planned.text).toBe(201)
  await owner.reauth()
  const applied = await owner.browser.call('POST', `/api/v1/plans/${planned.body.id}/apply`, {})
  expect(applied.status, applied.text).toBe(202)
  await drive()
}

async function invitePerson(email: string, roleId: string): Promise<Person> {
  await owner.reauth()
  const invited = await owner.browser.call('POST', '/api/v1/identities', { email })
  expect(invited.status, invited.text).toBe(201)
  const person = await enrollFromLink(
    (input, init) => app.request(input, init),
    invited.body.invitation.link,
  )
  await bindRole(person.identityId, roleId, { kind: 'global' })
  return person
}

async function serviceAccount(name: string, roleId: string): Promise<string> {
  await owner.reauth()
  const created = await owner.browser.call('POST', '/api/v1/service-accounts', {
    displayName: name,
  })
  expect(created.status, created.text).toBe(201)
  await bindRole(String(created.body.id), roleId, { kind: 'global' })
  return String(created.body.id)
}

async function apiKey(
  account: string,
  scopes: string[],
  tiers: ('prod' | 'nonprod')[],
): Promise<string> {
  await owner.reauth()
  const created = await owner.browser.call('POST', `/api/v1/service-accounts/${account}/api-keys`, {
    scopes,
    restrictions: { tiers, targets: { kind: 'all' } },
    lifetimeDays: 30,
    ...(tiers.includes('prod') ? { acknowledgeProductionWrite: true } : {}),
  })
  expect(created.status, created.text).toBe(201)
  return String(created.body.secret)
}

async function bearer(token: string | undefined, path: string, method = 'GET') {
  const response = await app.request(`${ORIGIN}${path}`, {
    method,
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  })
  const text = await response.text()
  return {
    status: response.status,
    body: (text.length === 0 ? undefined : JSON.parse(text)) as Body,
    text,
  }
}

const asOwner = (path: string) => owner.browser.call('GET', path)

const targetPath = (id: string, tail: string) => `/api/v1/targets/${encodeURIComponent(id)}${tail}`

// ============================================================================
// A1. The objects of a schema snapshot without a search term
// ============================================================================

const header = scopeHeader(17, { excludeSchemas: [] })
const tableEntry = (schema: string, name: string) =>
  makeEntry('table', [schema, name], { owner: 'app', rowSecurity: false } as never)
const columnEntry = (schema: string, table: string, name: string, position: number) =>
  makeEntry('column', [schema, table, name], { position, type: 'text', notNull: false } as never)
const functionEntry = (schema: string, name: string, args: string) =>
  makeEntry('function', [schema, name, args], {
    language: 'sql',
    bodyDigest: 'a'.repeat(64),
    owner: 'app',
  } as never)
const indexEntry = (schema: string, name: string, table: string) =>
  makeEntry('index', [schema, name], { table: [schema, table], unique: false } as never)

/** Two schemas, 42 tables, 83 columns, 3 functions (two overloads) and 2 indexes: 132 objects. */
function documentA(): CanonicalDocument {
  const entries = [
    makeEntry('schema', ['public'], { owner: 'app' } as never),
    makeEntry('schema', ['billing'], { owner: 'app' } as never),
    tableEntry('billing', 'invoices'),
    columnEntry('billing', 'invoices', 'id', 1),
    columnEntry('billing', 'invoices', 'amount', 2),
    tableEntry('billing', 'payments'),
    columnEntry('billing', 'payments', 'id', 1),
    functionEntry('public', 'helper', 'integer'),
    functionEntry('public', 'helper', 'text'),
    functionEntry('billing', 'total', ''),
    indexEntry('billing', 'invoices_amount_idx', 'invoices'),
    indexEntry('public', 't00_label_idx', 't00'),
  ]
  for (let i = 0; i < 40; i++) {
    const name = `t${String(i).padStart(2, '0')}`
    entries.push(
      tableEntry('public', name),
      columnEntry('public', name, 'id', 1),
      columnEntry('public', name, 'label', 2),
    )
  }
  return makeDocument(header, entries)
}

/** The schema changed: one table more, so another fingerprint. */
function documentB(): CanonicalDocument {
  const a = documentA()
  return makeDocument(header, [...a.entries, tableEntry('public', 'added_later')])
}

function snapshotOf(document: CanonicalDocument): Snapshot {
  return {
    document,
    fingerprint: fingerprintOf(document),
    complete: true,
    visibility: [],
    missingSchemas: [],
    excludedSchemas: [],
    comments: new Map(),
    serverVersionNum: 170004,
    stats: { durationMs: 3, queries: 1, entries: document.entries.length },
  }
}

/** The snapshot a read reuses (it is no older than 30 seconds): a fresh one of this document. */
async function useSnapshot(document: CanonicalDocument) {
  await storeOf(db, 'exdb_worker').transaction('test.snapshot', (tx) =>
    persistSnapshot(tx, { targetId: nonprod, generation: 1 }, snapshotOf(document), 'read', null),
  )
}

const objects = (query = '', target = nonprod) =>
  asOwner(`${targetPath(target, '/schema/objects')}${query}`)

const label = (i: { schema: string; kind: string; name: string; signature: string | null }) =>
  `${i.schema}.${i.kind}.${i.name}${i.signature === null ? '' : `(${i.signature})`}`

/** Every page of a list, following the cursor. */
async function walk(query: string) {
  const items: Body[] = []
  let cursor: string | null = null
  const sizes: number[] = []
  let first: Body
  do {
    const path: string = `${targetPath(nonprod, '/schema/objects')}?${query}${
      cursor === null ? '' : `&cursor=${cursor}`
    }`
    const r: { status: number; body: Body; text: string } = await asOwner(path)
    expect(r.status, r.text).toBe(200)
    first ??= r.body
    items.push(...r.body.items)
    sizes.push(r.body.items.length)
    cursor = r.body.nextCursor
  } while (cursor !== null)
  return { items, sizes, first }
}

describe('A1: GET /targets/{target}/schema/objects', () => {
  it('lists the objects without a search term, in schema, kind, name, signature order, with a total', async () => {
    await useSnapshot(documentA())
    const r = await objects('?limit=200')
    expect(r.status, r.text).toBe(200)
    expect(SchemaObjectListSchema.safeParse(r.body).success).toBe(true)
    expect(r.body).toMatchObject({
      total: 132,
      nextCursor: null,
      complete: true,
      source: 'cached',
      fingerprint: fingerprintOf(documentA()),
    })
    expect(r.body.items).toHaveLength(132)
    const labels = r.body.items.map(label)
    expect(labels.slice(0, 4)).toEqual([
      'billing.column.amount',
      'billing.column.id',
      'billing.column.id',
      'billing.function.total()',
    ])
    // Overloads follow each other, by signature.
    const helper = labels.filter((l: string) => l.startsWith('public.function.helper'))
    expect(helper).toEqual(['public.function.helper(integer)', 'public.function.helper(text)'])
    // Deterministic: the same request gives the same bytes.
    expect((await objects('?limit=200')).text).toBe(r.text)
  })

  it('reads the snapshot the overview reads, and says when it was taken (never a time of its own)', async () => {
    await useSnapshot(documentA())
    const overview = await asOwner(targetPath(nonprod, '/schema'))
    expect(overview.status, overview.text).toBe(200)
    const list = await objects('?kinds=schema')
    expect(list.status, list.text).toBe(200)
    expect(list.body.fingerprint).toBe(overview.body.fingerprint)
    expect(list.body.observedAt).toBe(overview.body.observedAt)
    expect(list.body.source).toBe(overview.body.source)
    expect(list.body.items.map(label)).toEqual(['billing.schema.billing', 'public.schema.public'])
  })

  it('answers 100 items by default and pages with a cursor, once through the list without a repeat', async () => {
    await useSnapshot(documentA())
    const firstPage = await objects()
    expect(firstPage.body.items).toHaveLength(100)
    expect(firstPage.body.nextCursor).toMatch(/^[A-Za-z0-9_-]{1,512}$/)
    expect(firstPage.body.total).toBe(132)
    const all = await walk('limit=25')
    expect(all.sizes).toEqual([25, 25, 25, 25, 25, 7])
    expect(all.items).toHaveLength(132)
    expect(new Set(all.items.map((i: Body) => JSON.stringify(i.key) + i.kind)).size).toBe(132)
    // Paging does not change the order: it is the order of one big page.
    const big = await objects('?limit=200')
    expect(all.items.map(label)).toEqual(big.body.items.map(label))
    // total and fingerprint are the same on every page.
    expect(all.first.total).toBe(132)
  })

  it('works with and without q, and filters by kind, schema and parent relation', async () => {
    await useSnapshot(documentA())
    const tables = await objects('?kinds=table&limit=200')
    expect(tables.body.total).toBe(42)
    expect(tables.body.items.every((i: Body) => i.kind === 'table')).toBe(true)
    const two = await objects('?kinds=table&kinds=function&limit=200')
    expect(two.body.total).toBe(45)
    const named = await objects('?q=INV&limit=200')
    expect(named.body.items.map(label)).toEqual([
      'billing.index.invoices_amount_idx',
      'billing.table.invoices',
    ])
    const both = await objects('?q=inv&kinds=table')
    expect(both.body.items.map(label)).toEqual(['billing.table.invoices'])
    const billing = await objects('?schema=billing&kinds=table')
    expect(billing.body.items.map(label)).toEqual([
      'billing.table.invoices',
      'billing.table.payments',
    ])
    const columns = await objects('?schema=billing&parent=invoices')
    expect(columns.body.items.map(label)).toEqual([
      'billing.column.amount',
      'billing.column.id',
      'billing.index.invoices_amount_idx',
    ])
    expect(columns.body.items.every((i: Body) => i.parent === 'invoices')).toBe(true)
    // A parent that exists in no schema: an empty list with a total of 0 (the snapshot has none), not an error.
    const none = await objects('?parent=nothing')
    expect(none.status).toBe(200)
    expect(none.body).toMatchObject({ items: [], total: 0, nextCursor: null })
  })

  it('refuses a cursor from an older snapshot with SCHEMA_FINGERPRINT_MISMATCH, and starts again on request', async () => {
    await useSnapshot(documentA())
    const first = await objects('?kinds=table&limit=5')
    expect(first.body.total).toBe(42)
    const cursor = first.body.nextCursor
    // The same snapshot continues.
    const same = await objects(`?kinds=table&limit=5&cursor=${cursor}`)
    expect(same.status, same.text).toBe(200)
    expect(same.body.items[0]).not.toEqual(first.body.items[0])
    // The schema changes between the pages.
    await useSnapshot(documentB())
    const stale = await objects(`?kinds=table&limit=5&cursor=${cursor}`)
    expect([stale.status, stale.body.code]).toEqual([409, 'SCHEMA_FINGERPRINT_MISMATCH'])
    // Starting again reads the new snapshot.
    const again = await objects('?kinds=table&limit=5')
    expect(again.status, again.text).toBe(200)
    expect(again.body.total).toBe(43)
    expect(again.body.fingerprint).toBe(fingerprintOf(documentB()))
    expect(again.body.fingerprint).not.toBe(first.body.fingerprint)
  })

  it('refuses a cursor made for other filters, one that is not ours and every bad parameter', async () => {
    await useSnapshot(documentA())
    const first = await objects('?kinds=table&limit=5')
    const cursor = first.body.nextCursor
    const wrongFilter = await objects(`?kinds=function&limit=5&cursor=${cursor}`)
    expect([wrongFilter.status, wrongFilter.body.code]).toEqual([422, 'VALIDATION_FAILED'])
    expect(wrongFilter.body.details.errors[0]).toMatchObject({
      path: '/cursor',
      code: 'filter_mismatch',
    })
    const search = await asOwner(`${targetPath(nonprod, '/schema/search')}?q=t0&limit=1`)
    expect(search.status).toBe(200)
    for (const bad of [
      'garbage',
      'd2_',
      'd2_AAAA',
      'r1_AAAA',
      // The search's offset cursor is not this list's.
      search.body.nextCursor ?? 'd1_MQ',
    ]) {
      const r = await objects(`?cursor=${bad}`)
      expect([r.status, r.body.code], bad).toEqual([422, 'VALIDATION_FAILED'])
      expect(r.body.details.errors[0], bad).toMatchObject({ path: '/cursor' })
    }
    for (const query of [
      '?limit=0',
      '?limit=201',
      '?limit=many',
      '?q=',
      `?q=${'x'.repeat(129)}`,
      `?schema=${'s'.repeat(64)}`,
      `?${Array.from({ length: 17 }, () => 'kinds=table').join('&')}`,
      '?surprise=1',
      '?kinds=NOT_A_KIND',
    ]) {
      const r = await objects(query)
      expect([r.status, r.body.code], query).toEqual([422, 'VALIDATION_FAILED'])
    }
  })

  it('is an error, never an empty list, when the schema cannot be read', async () => {
    // The production target is registered, not live: there is nothing to read from.
    const r = await objects('', prod)
    expect(r.status).not.toBe(200)
    expect(r.body.code).toBe('TARGET_UNAVAILABLE')
    expect(r.body.items).toBeUndefined()
    const unknown = await objects('', newId('tgt', Date.now()))
    expect([unknown.status, unknown.body.code]).toEqual([404, 'TARGET_NOT_FOUND'])
  })

  it('needs schema.read at the target: the permission of the search, no more and no less', async () => {
    await useSnapshot(documentA())
    const path = `${targetPath(nonprod, '/schema/objects')}?kinds=schema`
    expect((await bearer(key.schema, path)).status).toBe(200)
    expect((await bearer(key.viewerAny, path)).status).toBe(200)
    // The search accepts the same keys and refuses the same ones.
    const search = `${targetPath(nonprod, '/schema/search')}?q=public`
    expect((await bearer(key.schema, search)).status).toBe(200)
    for (const refused of [key.diagnostics, key.targetsOnly]) {
      expect((await bearer(refused, path)).status).toBe(403)
      expect((await bearer(refused, search)).status).toBe(403)
    }
    // A key limited to production does not see the nonprod target: it does not exist for it.
    const hidden = await bearer(key.schemaProdOnly, path)
    expect([hidden.status, hidden.body.code]).toEqual([404, 'TARGET_NOT_FOUND'])
    expect((await bearer(undefined, path)).status).toBe(401)
  })
})

// ============================================================================
// A2. The history of the drift checks of a target
// ============================================================================

const checks: { id: string; finishedAt: string; requestedBy: string; status: string }[] = []

async function seedDriftCheck(
  target: string,
  over: {
    readonly status: 'clean' | 'drifted' | 'failed'
    readonly requestedBy: string
    readonly finishedAt: Date
    readonly id?: string
    readonly errorCode?: string
    readonly drifted?: number
  },
) {
  const id = over.id ?? newId('smp', over.finishedAt.getTime())
  const failed = over.status === 'failed'
  await db.asSuperuser((c) =>
    c.query(
      `INSERT INTO observation.drift_checks
         (check_id, target_id, generation, requested_by, status, baseline_fingerprint, current_fingerprint,
          drifted, matched, unmanaged, opened, updated, resolved, error_code, started_at, finished_at)
       VALUES ($1, $2, 1, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [
        id,
        target,
        over.requestedBy,
        over.status,
        failed ? null : fingerprintOf(documentA()),
        failed ? null : fingerprintOf(over.status === 'clean' ? documentA() : documentB()),
        over.drifted ?? (over.status === 'drifted' ? 3 : 0),
        failed ? 0 : 40,
        failed ? 0 : 1,
        over.status === 'drifted' ? 2 : 0,
        over.status === 'drifted' ? 1 : 0,
        0,
        over.errorCode ?? null,
        new Date(over.finishedAt.getTime() - 2_500).toISOString(),
        over.finishedAt.toISOString(),
      ],
    ),
  )
  checks.push({
    id,
    finishedAt: over.finishedAt.toISOString(),
    requestedBy: over.requestedBy,
    status: over.status,
  })
  return id
}

describe('A2: GET /targets/{target}/drift-checks', () => {
  const list = (query = '', target = nonprod) =>
    asOwner(`${targetPath(target, '/drift-checks')}${query}`)

  it('answers an empty list only because none exists, and reads nothing from the database', async () => {
    const r = await list('', prod)
    expect(r.status, r.text).toBe(200)
    expect(r.body).toEqual({ items: [], nextCursor: null })
  })

  it('lists the checks newest first, scheduled and requested, with their stored counts and who asked', async () => {
    const base = Date.now() - 3 * 3_600_000
    for (let i = 0; i < 23; i++) {
      await seedDriftCheck(nonprod, {
        status: i === 7 ? 'failed' : i % 2 === 0 ? 'clean' : 'drifted',
        requestedBy: i % 3 === 0 ? owner.identityId : 'schedule',
        finishedAt: new Date(base + i * 60_000),
        ...(i === 7 ? { errorCode: 'TARGET_UNAVAILABLE' } : {}),
      })
    }
    // Two checks that finished in the same instant: the check id breaks the tie.
    const tie = new Date(base + 30 * 60_000)
    await seedDriftCheck(nonprod, { status: 'clean', requestedBy: 'schedule', finishedAt: tie })
    await seedDriftCheck(nonprod, {
      status: 'drifted',
      requestedBy: owner.identityId,
      finishedAt: tie,
      id: newId('smp', tie.getTime() + 5_000),
    })
    const r = await list('?limit=200')
    expect(r.status, r.text).toBe(200)
    expect(r.body.nextCursor).toBeNull()
    expect(r.body.items).toHaveLength(25)
    for (const item of r.body.items) {
      expect(DriftCheckSummarySchema.safeParse(item).success, JSON.stringify(item)).toBe(true)
      expect(item.targetId).toBe(nonprod)
      expect(item.generation).toBe(1)
    }
    // Newest first, by finish time then check id.
    const order = r.body.items.map((i: Body) => `${i.finishedAt}|${i.id}`)
    expect(order).toEqual([...order].sort().reverse())
    expect(r.body.items.slice(0, 2).map((i: Body) => i.finishedAt)).toEqual([
      tie.toISOString().replace('Z', '000Z'),
      tie.toISOString().replace('Z', '000Z'),
    ])
    const byId = new Map<string, Body>(r.body.items.map((i: Body) => [i.id, i]))
    // Who asked: the schedule, or the identity.
    const scheduled = checks.find((c) => c.requestedBy === 'schedule')
    const requested = checks.find((c) => c.requestedBy === owner.identityId)
    expect(byId.get(scheduled?.id ?? '')?.requestedBy).toEqual({ kind: 'schedule' })
    expect(byId.get(requested?.id ?? '')?.requestedBy).toEqual({
      kind: 'identity',
      identityId: owner.identityId,
    })
    // Every count that is stored is returned as stored.
    const drifted = checks.find((c) => c.status === 'drifted')
    expect(byId.get(drifted?.id ?? '')).toMatchObject({
      status: 'drifted',
      counts: { drifted: 3, matched: 40, unmanaged: 1, opened: 2, updated: 1, resolved: 0 },
      errorCode: null,
      baselineFingerprint: fingerprintOf(documentA()),
      currentFingerprint: fingerprintOf(documentB()),
    })
    // A failed check shows its error code and no fingerprint it never had.
    const failed = r.body.items.filter((i: Body) => i.status === 'failed')
    expect(failed).toHaveLength(1)
    expect(failed[0]).toMatchObject({
      errorCode: 'TARGET_UNAVAILABLE',
      baselineFingerprint: null,
      currentFingerprint: null,
      counts: { drifted: 0, matched: 0, unmanaged: 0, opened: 0, updated: 0, resolved: 0 },
    })
    expect(
      r.body.items.every((i: Body) => (i.status === 'failed') === (i.errorCode !== null)),
    ).toBe(true)
    // The start and the end are the stored ones: 2.5 seconds apart.
    const one = r.body.items[0]
    expect(Date.parse(one.finishedAt) - Date.parse(one.startedAt)).toBe(2_500)
  })

  it('pages with a keyset cursor once through the history, also one row at a time across the tie', async () => {
    const whole = await list('?limit=200')
    const ids = whole.body.items.map((i: Body) => i.id)
    for (const size of [10, 1]) {
      const seen: string[] = []
      const sizes: number[] = []
      let cursor: string | null = null
      do {
        const r: { status: number; body: Body; text: string } = await list(
          `?limit=${size}${cursor === null ? '' : `&cursor=${cursor}`}`,
        )
        expect(r.status, r.text).toBe(200)
        sizes.push(r.body.items.length)
        seen.push(...r.body.items.map((i: Body) => i.id))
        cursor = r.body.nextCursor
      } while (cursor !== null)
      expect(seen, `limit ${size}`).toEqual(ids)
      if (size === 10) expect(sizes).toEqual([10, 10, 5])
    }
  })

  it('does not shift a page when a newer check is recorded meanwhile', async () => {
    const first = await list('?limit=5')
    const cursor = first.body.nextCursor
    await seedDriftCheck(nonprod, {
      status: 'clean',
      requestedBy: 'schedule',
      finishedAt: new Date(),
    })
    const next = await list(`?limit=5&cursor=${cursor}`)
    const all = await list('?limit=200')
    const fromFirst = all.body.items.findIndex((i: Body) => i.id === first.body.items[4].id)
    // The next page continues after the last row shown, not at an offset.
    expect(next.body.items.map((i: Body) => i.id)).toEqual(
      all.body.items.slice(fromFirst + 1, fromFirst + 6).map((i: Body) => i.id),
    )
    expect(all.body.items[0].id).not.toBe(first.body.items[0].id)
  })

  it('reads the history and runs no check: nothing is written', async () => {
    const count = async () =>
      Number(
        (
          await db.asSuperuser((c) =>
            c.query('SELECT count(*)::int AS n FROM observation.drift_checks'),
          )
        ).rows[0].n,
      )
    const before = await count()
    expect((await list('?limit=3')).status).toBe(200)
    expect(await count()).toBe(before)
  })

  it('refuses a limit out of range, a cursor that is not ours and any other parameter', async () => {
    const first = await list('?limit=1')
    const forgedTime = `dc1_${Buffer.from('2026-10-20T10:00:00.000000Z|nothing').toString('base64url')}`
    for (const query of [
      '?limit=0',
      '?limit=201',
      '?limit=abc',
      '?cursor=garbage',
      '?cursor=r1_AAAA',
      `?cursor=${forgedTime}`,
      `?cursor=${first.body.nextCursor}x!`,
      '?state=failed',
    ]) {
      const r = await list(query)
      expect([r.status, r.body.code], query).toEqual([422, 'VALIDATION_FAILED'])
    }
    const unknown = await list('', newId('tgt', Date.now()))
    expect([unknown.status, unknown.body.code]).toEqual([404, 'TARGET_NOT_FOUND'])
  })

  it('needs diagnostics.read at the target, as the findings do, and hides a target outside the key', async () => {
    const path = targetPath(nonprod, '/drift-checks?limit=2')
    const findings = targetPath(nonprod, '/findings')
    expect((await bearer(key.diagnostics, path)).status).toBe(200)
    expect((await bearer(key.viewerAny, path)).status).toBe(200)
    for (const refused of [key.schema, key.targetsOnly]) {
      expect((await bearer(refused, path)).status).toBe(403)
      // The permission of the findings read: the same keys are refused there.
      expect((await bearer(refused, findings)).status).toBe(403)
    }
    const hidden = await bearer(key.diagnosticsProdOnly, path)
    expect([hidden.status, hidden.body.code]).toEqual([404, 'TARGET_NOT_FOUND'])
    expect((await bearer(undefined, path)).status).toBe(401)
  })
})

// ============================================================================
// A3. The connection capacity on the target health
// ============================================================================

const ENDPOINT = newId('end', Date.now())

const activity = (over: Partial<ActivitySummary> = {}): ActivitySummary => ({
  clientBackends: 12,
  active: 2,
  idleInTransaction: 0,
  stalled: [],
  idleInTransactionLong: [],
  longRunning: [],
  lockWaits: [],
  plaintextRemote: 0,
  xidAge: 1000,
  counts: { stalled: 0, idleInTransactionLong: 0, longRunning: 0, lockWaits: 0 },
  oldestIdleInTransactionSeconds: null,
  oldestLongRunningSeconds: null,
  truncated: false,
  ...over,
})

const sample = (over: Partial<HealthSample> = {}): HealthSample => ({
  lifecycle: 'active',
  endpoints: [
    {
      endpointId: ENDPOINT,
      kind: 'private',
      label: 'direct',
      connect: { ok: true },
      simple: { status: 'ok', durationMs: 2 },
      extended: { status: 'ok', durationMs: 3 },
    },
  ],
  diagnosticEndpointId: ENDPOINT,
  identity: { status: 'match' },
  settings: {
    status: 'ok',
    value: {
      maxConnections: 100,
      superuserReserved: 3,
      reserved: 0,
      serverVersionNum: 170004,
      usableSlots: 97,
    },
  },
  activity: { status: 'ok', value: activity() },
  observedAt: new Date().toISOString(),
  ...over,
})

/** What the sampler stores for a sample, `secondsAgo` seconds old: the reducer's own probes and conditions. */
async function storeSample(target: string, s: HealthSample, secondsAgo = 0, strip = false) {
  const result = reduceHealth(s)
  const probes = strip ? result.probes.map(({ values: _values, ...rest }) => rest) : result.probes
  await db.asSuperuser((c) =>
    c.query(
      `INSERT INTO observation.target_status AS st (target_id, state, conditions, probes, unknown_because, observed_at)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, now() - make_interval(secs => $6::double precision))
       ON CONFLICT (target_id) DO UPDATE SET state = EXCLUDED.state, conditions = EXCLUDED.conditions,
         probes = EXCLUDED.probes, unknown_because = EXCLUDED.unknown_because,
         observed_at = EXCLUDED.observed_at, updated_at = clock_timestamp()`,
      [
        target,
        result.state,
        JSON.stringify(result.conditions),
        JSON.stringify(probes),
        result.unknownBecause,
        secondsAgo,
      ],
    ),
  )
}

describe('A3: capacity on GET /targets/{target}/health', () => {
  const health = (token?: string, target = nonprod) =>
    token === undefined
      ? asOwner(targetPath(target, '/health'))
      : bearer(token, targetPath(target, '/health'))
  const tool = MCP_TOOL_LIST.find((t) => t.name === 'target_health')

  it('has no capacity before the first sample: absent, not 0', async () => {
    const r = await health()
    expect(r.status, r.text).toBe(200)
    expect(r.body).toMatchObject({ state: 'unknown', unknownBecause: 'never_sampled' })
    expect(r.body).not.toHaveProperty('capacity')
    expect(r.text).not.toContain('"capacity"')
    expect(TargetHealthViewSchema.safeParse(r.body).success).toBe(true)
  })

  it('shows the connections the latest sample measured, with that sample’s source and time', async () => {
    await storeSample(nonprod, sample())
    const r = await health()
    expect(r.status, r.text).toBe(200)
    expect(TargetHealthViewSchema.safeParse(r.body).success).toBe(true)
    expect(r.body.state).toBe('healthy')
    expect(r.body.capacity).toEqual({
      clientBackends: 12,
      usableSlots: 97,
      source: 'sampled',
      observedAt: r.body.observedAt,
    })
    // The probes keep the public shape: what the sampler stored beside them is not returned.
    expect(r.body.probes.length).toBeGreaterThan(0)
    expect(r.body.probes.every((p: Body) => !('values' in p))).toBe(true)
    expect(r.text).not.toContain('"values"')
    // A threshold is not needed: 12 of 97 raises no condition, yet the numbers are there.
    expect(r.body.conditions).toEqual([])
  })

  it('keeps a measured zero as a zero, distinct from a missing value', async () => {
    await storeSample(
      nonprod,
      sample({
        settings: {
          status: 'ok',
          value: {
            maxConnections: 3,
            superuserReserved: 3,
            reserved: 0,
            serverVersionNum: 170004,
            usableSlots: 0,
          },
        },
        activity: { status: 'ok', value: activity({ clientBackends: 0 }) },
      }),
    )
    const r = await health()
    expect(r.body.capacity).toMatchObject({ clientBackends: 0, usableSlots: 0 })
    expect(r.body.conditions.map((c: Body) => c.condition)).toEqual(['connections_critical'])
  })

  it('has no capacity when the latest sample did not measure both numbers', async () => {
    await storeSample(
      nonprod,
      sample({ settings: { status: 'failed', errorClass: 'insufficient_privilege' } }),
    )
    const noSettings = await health()
    expect(noSettings.body.conditions.map((c: Body) => c.condition)).toEqual([
      'settings_unreadable',
    ])
    expect(noSettings.body).not.toHaveProperty('capacity')
    await storeSample(
      nonprod,
      sample({ activity: { status: 'failed', errorClass: 'query_timeout' } }),
    )
    const noActivity = await health()
    expect(noActivity.body.conditions.map((c: Body) => c.condition)).toEqual([
      'activity_unreadable',
    ])
    expect(noActivity.body).not.toHaveProperty('capacity')
    await storeSample(
      nonprod,
      sample({
        settings: { status: 'not_run' },
        activity: { status: 'not_run' },
        endpoints: [
          {
            endpointId: ENDPOINT,
            kind: 'private',
            label: 'direct',
            connect: { ok: false, code: 'TARGET_UNAVAILABLE', reason: 'connect_refused' },
          },
        ],
      }),
    )
    const down = await health()
    expect(down.body.state).toBe('unreachable')
    expect(down.body).not.toHaveProperty('capacity')
  })

  it('has no capacity for a status row written before the numbers were stored', async () => {
    await storeSample(nonprod, sample(), 0, true)
    const r = await health()
    expect(r.status).toBe(200)
    expect(r.body.state).toBe('healthy')
    expect(r.body).not.toHaveProperty('capacity')
  })

  it('says cached once the sample is older than two intervals, and keeps its own time', async () => {
    await storeSample(nonprod, sample(), 60)
    const stale = await health()
    expect(stale.body.source).toBe('cached')
    expect(stale.body.capacity).toMatchObject({
      clientBackends: 12,
      usableSlots: 97,
      source: 'cached',
      observedAt: stale.body.observedAt,
    })
    // A lagging sampler: the state is unknown, and the numbers stay what they were, with their age.
    await storeSample(nonprod, sample(), 600)
    const lagging = await health()
    expect(lagging.body).toMatchObject({ state: 'unknown', unknownBecause: 'sampler_lagging' })
    expect(lagging.body.capacity).toMatchObject({
      source: 'cached',
      observedAt: lagging.body.observedAt,
    })
    expect(Date.now() - Date.parse(lagging.body.capacity.observedAt)).toBeGreaterThan(590_000)
  })

  it('is REST only: the MCP tool announces and answers the health without it', async () => {
    await storeSample(nonprod, sample())
    const r = await health()
    expect(r.body.capacity).toBeDefined()
    expect(tool).toBeDefined()
    const announced = tool?.output.parse(r.body) as Body
    expect(announced).not.toHaveProperty('capacity')
    expect(announced.state).toBe('healthy')
    // The announced fields are the REST fields but for the capacity.
    const { capacity: _capacity, ...rest } = r.body
    expect(announced).toEqual(rest)
  })

  it('needs diagnostics.read as before, and a target outside the key does not exist for it', async () => {
    expect((await health(key.diagnostics)).status).toBe(200)
    expect((await health(key.diagnostics)).body.capacity).toBeDefined()
    for (const refused of [key.schema, key.targetsOnly]) {
      expect((await health(refused)).status).toBe(403)
    }
    const hidden = await health(key.diagnosticsProdOnly)
    expect([hidden.status, hidden.body.code]).toEqual([404, 'TARGET_NOT_FOUND'])
    expect((await bearer(undefined, targetPath(nonprod, '/health'))).status).toBe(401)
  })
})

// ============================================================================
// A4. The audit filtered by person
// ============================================================================

async function recordRead(identityId: string, targetId: string, tier: 'prod' | 'nonprod') {
  const parties: ReadParties = {
    actor: { kind: 'human', identityId: identityId as IdentityId, label: 'human #1' },
    client: { clientId: null, kind: 'web', grantId: null },
  }
  await storeOf(db, 'exdb_serve').transaction('test.data_read', (tx) =>
    appendAuditEvent(
      tx,
      dataReadAuditEvent(
        {
          targetId: targetId as never,
          path: `${world.slug}/platform/${tier === 'prod' ? 'production' : 'staging'}`,
          tier,
          placement: null,
        },
        parties,
        {
          kind: 'query',
          queryId: newId('qry', Date.now()),
          requestId: newId('req', Date.now()),
          statement: { text: 'SELECT $1', digest: `sha256:${'0'.repeat(64)}` },
          analyze: false,
          callerClass: 'human',
          outcome: {
            kind: 'query',
            columns: [],
            rows: [],
            rowCount: 3,
            truncated: false,
            truncation: null,
            durationMs: 12.7,
            rlsRelations: [],
          } as never,
        },
      ),
      { clock: systemClock },
    ),
  )
}

describe('A4: GET /audit-events?identity=', () => {
  const events = (query: string, token?: string) =>
    token === undefined
      ? asOwner(`/api/v1/audit-events${query}`)
      : bearer(token, `/api/v1/audit-events${query}`)
  const reads = (who: string, extra = '') => `?action=data.read&identity=${who}&limit=100${extra}`

  beforeAll(async () => {
    await recordRead(owner.identityId, nonprod, 'nonprod')
    await recordRead(owner.identityId, nonprod, 'nonprod')
    await recordRead(owner.identityId, prod, 'prod')
    await recordRead(alice.identityId, nonprod, 'nonprod')
    await recordRead(alice.identityId, prod, 'prod')
    await recordRead(alice.identityId, prod, 'prod')
  })

  it('returns the events of that identity only', async () => {
    const mine = await events(reads(owner.identityId))
    expect(mine.status, mine.text).toBe(200)
    expect(mine.body.items).toHaveLength(3)
    expect(mine.body.items.every((e: Body) => e.actor.identityId === owner.identityId)).toBe(true)
    const hers = await events(reads(alice.identityId))
    expect(hers.body.items).toHaveLength(3)
    expect(hers.body.items.every((e: Body) => e.actor.identityId === alice.identityId)).toBe(true)
    // Without an action, every event of the person: more than the reads, all hers.
    const anything = await events(`?identity=${alice.identityId}&limit=100`)
    expect(anything.body.items.length).toBeGreaterThanOrEqual(3)
    expect(anything.body.items.every((e: Body) => e.actor.identityId === alice.identityId)).toBe(
      true,
    )
    // Without the filter both appear, newest first.
    const both = await events('?action=data.read&limit=100')
    expect(both.body.items).toHaveLength(6)
  })

  it('combines with the other filters and with paging', async () => {
    const onProd = await events(reads(alice.identityId, `&target=${prod}`))
    expect(onProd.body.items).toHaveLength(2)
    expect(onProd.body.items.every((e: Body) => e.subject.targetId === prod)).toBe(true)
    const seen: string[] = []
    let cursor: string | null = null
    do {
      const r: { status: number; body: Body; text: string } = await events(
        `${reads(alice.identityId).replace('limit=100', 'limit=2')}${cursor === null ? '' : `&cursor=${cursor}`}`,
      )
      expect(r.status, r.text).toBe(200)
      seen.push(...r.body.items.map((e: Body) => e.id))
      cursor = r.body.nextCursor
    } while (cursor !== null)
    expect(seen).toHaveLength(3)
    expect(new Set(seen).size).toBe(3)
  })

  it('answers an empty list for an identity that did nothing, and keeps actor=self to the caller', async () => {
    const nobody = await events(reads(newId('idn', Date.now())))
    expect(nobody.status).toBe(200)
    expect(nobody.body).toEqual({ items: [], nextCursor: null })
    // Both must hold: someone else's events are not the caller's own.
    const otherSelf = await events(reads(alice.identityId, '&actor=self'))
    expect(otherSelf.body.items).toEqual([])
    const ownSelf = await events(reads(owner.identityId, '&actor=self'))
    expect(ownSelf.body.items).toHaveLength(3)
  })

  it('shows a delegation restricted to nonprod only the events of the targets it covers', async () => {
    const restricted = await events(reads(alice.identityId), key.auditNonprod)
    expect(restricted.status, restricted.text).toBe(200)
    expect(restricted.body.items).toHaveLength(1)
    expect(restricted.body.items[0].subject.targetId).toBe(nonprod)
    const all = await events(reads(alice.identityId), key.audit)
    expect(all.body.items).toHaveLength(3)
    const nobody = await events(reads(newId('idn', Date.now())), key.auditNonprod)
    expect(nobody.body.items).toEqual([])
  })

  it('refuses an identity that is not an idn_ id, as the other id parameters', async () => {
    for (const bad of [
      'alice',
      'idn_',
      'idn_short',
      newId('grt', Date.now()),
      `${owner.identityId}x`,
      '',
    ]) {
      const r = await events(`?identity=${bad}`)
      expect([r.status, r.body.code], bad).toEqual([422, 'VALIDATION_FAILED'])
    }
    const twice = await events(`?identity=${owner.identityId}&identity=${alice.identityId}`)
    expect([twice.status, twice.body.code]).toEqual([422, 'VALIDATION_FAILED'])
  })

  it('keeps the authorization: audit.read, and nothing else reads the audit', async () => {
    expect((await events(reads(owner.identityId), key.audit)).status).toBe(200)
    for (const refused of [key.viewerAny, key.targetsOnly]) {
      expect((await events(reads(owner.identityId), refused)).status).toBe(403)
    }
    expect((await events(reads(owner.identityId), undefined)).status).toBe(200)
    expect((await bearer(undefined, `/api/v1/audit-events${reads(owner.identityId)}`)).status).toBe(
      401,
    )
    // A person without audit.read is refused too.
    const viewer = await alice.browser.call('GET', `/api/v1/audit-events${reads(alice.identityId)}`)
    expect(viewer.status).toBe(403)
  })
})

// ============================================================================
// A5. The use of the OAuth clients
// ============================================================================

const CLI_REDIRECT = 'http://127.0.0.1:51234/callback'

const pick = (c: Body) => ({ lastUsedAt: c.lastUsedAt, activeGrantCount: c.activeGrantCount })

async function form(path: string, fields: Record<string, string>) {
  const response = await app.request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  })
  const text = await response.text()
  return {
    status: response.status,
    body: (text.length === 0 ? undefined : JSON.parse(text)) as Body,
  }
}

/** The first-party CLI's loopback flow for a signed-in person: a delegated grant for `exponetdb-cli`. */
async function cliGrant(person: Person, scope: string) {
  const verifier =
    'v'.repeat(20) + Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')
  const challenge = Buffer.from(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)),
  ).toString('base64url')
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: 'exponetdb-cli',
    redirect_uri: CLI_REDIRECT,
    scope,
    state: 'cli-state',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: `${ORIGIN}/api`,
  })
  const authorize = await person.browser.call('GET', `/oauth/authorize?${query.toString()}`)
  expect(authorize.status, authorize.text).toBe(302)
  const location = authorize.headers.get('location') ?? ''
  const request = location.slice(location.indexOf('#request=') + '#request='.length)
  const decided = await person.browser.call('POST', '/auth/oauth/consent', {
    request,
    decision: 'allow',
    scopes: scope.split(' '),
    tiers: ['nonprod'],
    lifetimeDays: 30,
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
  expect(issued.status, JSON.stringify(issued.body)).toBe(200)
  return issued.body as { access_token: string }
}

describe('A5: lastUsedAt and activeGrantCount on the OAuth clients', () => {
  const clients = async () => {
    const r = await asOwner('/api/v1/oauth-clients?limit=200')
    expect(r.status, r.text).toBe(200)
    return r.body.items as Body[]
  }
  const cli = async () => {
    const found = (await clients()).find((c) => c.clientId === 'exponetdb-cli')
    expect(found).toBeDefined()
    return found as Body
  }
  let ownerGrant = ''
  let aliceGrant = ''
  let ownerToken = ''
  let serviceClient = ''

  it('says no use is recorded and no grant is active before anything happened', async () => {
    const all = await clients()
    expect(all.length).toBeGreaterThan(0)
    for (const c of all) {
      expect(OAuthClientViewSchema.safeParse(c).success, c.clientId).toBe(true)
      expect(c, c.clientId).toMatchObject({ lastUsedAt: null, activeGrantCount: 0 })
    }
    const one = await asOwner(`/api/v1/oauth-clients/${(await cli()).id}`)
    expect(one.body).toMatchObject({ lastUsedAt: null, activeGrantCount: 0 })
  })

  it('counts a grant as soon as it exists, and has no use until a request authenticated with it', async () => {
    const tokens = await cliGrant(owner, 'targets.read')
    ownerToken = tokens.access_token
    const mine = await asOwner('/api/v1/me/grants')
    ownerGrant = mine.body.items.find(
      (g: Body) => g.client.clientId === 'exponetdb-cli' && g.state === 'active',
    ).id
    const client = await cli()
    expect(client).toMatchObject({ activeGrantCount: 1, lastUsedAt: null })
    // Another client is untouched.
    const others = (await clients()).filter((c) => c.clientId !== 'exponetdb-cli')
    expect(others.every((c) => c.activeGrantCount === 0 && c.lastUsedAt === null)).toBe(true)
  })

  it('sets lastUsedAt after a use: the minute of the grant, the same record the grant list shows', async () => {
    expect((await bearer(ownerToken, '/api/v1/installation')).status).toBe(200)
    await application.settled()
    const grants = await asOwner('/api/v1/me/grants')
    const used = grants.body.items.find((g: Body) => g.id === ownerGrant)
    expect(used.lastUsedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:00\.000000Z$/)
    const client = await cli()
    expect(client).toMatchObject({ activeGrantCount: 1, lastUsedAt: used.lastUsedAt })
    const one = await asOwner(`/api/v1/oauth-clients/${client.id}`)
    expect(one.body).toMatchObject({ activeGrantCount: 1, lastUsedAt: used.lastUsedAt })
    expect(Math.abs(Date.now() - Date.parse(client.lastUsedAt))).toBeLessThan(5 * 60_000)
  })

  it('takes the latest use over all grants of the client and counts only the active ones', async () => {
    await alice.reauth()
    const second = await cliGrant(alice, 'targets.read')
    const grants = await asOwner(`/api/v1/grants?identity=${alice.identityId}&state=active`)
    aliceGrant = grants.body.items.find((g: Body) => g.client.clientId === 'exponetdb-cli').id
    expect(second.access_token).toBeTruthy()
    expect((await cli()).activeGrantCount).toBe(2)
    // A later use of her grant moves the client's last use there: the maximum, not the first.
    const later = Math.floor(Date.now() / 60_000) * 60_000 + 3_600_000
    const store = storeOf(db, 'exdb_serve')
    await oauth.recordGrantUse(store, aliceGrant as GrantId, 'rest', new Date(later + 5_000))
    expect((await cli()).lastUsedAt).toBe(
      new Date(later).toISOString().replace('.000Z', '.000000Z'),
    )
    // Revoked, her grant is no longer active, and its use stays part of the client's history.
    await owner.reauth()
    const revoked = await owner.browser.call('POST', `/api/v1/grants/${aliceGrant}/revoke`, {})
    expect(revoked.status, revoked.text).toBe(200)
    expect(await cli()).toMatchObject({
      activeGrantCount: 1,
      lastUsedAt: new Date(later).toISOString().replace('.000Z', '.000000Z'),
    })
    const own = await owner.browser.call('POST', `/api/v1/me/grants/${ownerGrant}/revoke`, {})
    expect(own.body).toEqual({ revoked: true })
    expect((await cli()).activeGrantCount).toBe(0)
    expect((await cli()).lastUsedAt).not.toBeNull()
  })

  it('shows a client without any grant as 0 and null, with the list and the single read agreeing', async () => {
    const account = await serviceAccount('Parity machine', 'viewer')
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, [
      'sign',
      'verify',
    ])
    const exported = await crypto.subtle.exportKey('jwk', pair.publicKey)
    await owner.reauth()
    const registered = await owner.browser.call(
      'POST',
      `/api/v1/service-accounts/${account}/oauth-client`,
      {
        jwks: {
          keys: [{ kty: exported.kty, crv: exported.crv, x: exported.x, y: exported.y, kid: 'k1' }],
        },
      },
    )
    expect(registered.status, registered.text).toBe(201)
    const all = await clients()
    const machine = all.find((c) => c.serviceAccountId === account)
    expect(machine).toMatchObject({ lastUsedAt: null, activeGrantCount: 0 })
    serviceClient = machine?.id
    const one = await asOwner(`/api/v1/oauth-clients/${serviceClient}`)
    expect(one.body).toMatchObject({ lastUsedAt: null, activeGrantCount: 0 })
    // One statement for the page: the numbers of every client in the list equal its own read.
    for (const c of all) {
      const single = await asOwner(`/api/v1/oauth-clients/${c.id}`)
      expect({ id: c.id, ...pick(c) }).toEqual({ id: c.id, ...pick(single.body) })
    }
  })

  it('leaves the two members out of the answers of the decisions, which do not read them', async () => {
    await owner.reauth()
    const disabled = await owner.browser.call(
      'POST',
      `/api/v1/oauth-clients/${serviceClient}/disable`,
      {
        reason: 'parity test',
      },
    )
    expect(disabled.status, disabled.text).toBe(200)
    expect(disabled.body.state).toBe('disabled')
    expect(disabled.body).not.toHaveProperty('lastUsedAt')
    expect(disabled.body).not.toHaveProperty('activeGrantCount')
    // The reads show them again.
    expect((await asOwner(`/api/v1/oauth-clients/${serviceClient}`)).body).toMatchObject({
      state: 'disabled',
      activeGrantCount: 0,
      lastUsedAt: null,
    })
  })

  it('keeps access.read: a person without it, a key and a missing client', async () => {
    const id = (await cli()).id
    expect((await alice.browser.call('GET', '/api/v1/oauth-clients')).status).toBe(403)
    expect((await alice.browser.call('GET', `/api/v1/oauth-clients/${id}`)).status).toBe(403)
    expect((await bearer(key.viewerAny, '/api/v1/oauth-clients')).status).toBe(403)
    expect((await bearer(key.audit, `/api/v1/oauth-clients/${id}`)).status).toBe(403)
    const missing = await asOwner(`/api/v1/oauth-clients/${newId('cli', Date.now())}`)
    expect([missing.status, missing.body.code]).toEqual([404, 'NOT_FOUND'])
    const malformed = await asOwner('/api/v1/oauth-clients/not-a-client')
    expect([malformed.status, malformed.body.code]).toEqual([422, 'VALIDATION_FAILED'])
  })
})
