import { createHash } from 'node:crypto'
import { dataReadAuditEvent, type ReadParties } from '@exponetdb/application'
import { appendAuditEvent } from '@exponetdb/audit'
import { MCP_TOOL_LIST } from '@exponetdb/contracts'
import { type MigratedTestDatabase, migratedTestDatabase } from '@exponetdb/control-store/testing'
import { type IdentityId, newId, systemClock } from '@exponetdb/kernel'
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
 * Wave 8, order §9, endpoints 6 and 7, over the real public app on
 * PostgreSQL 17: the history of one's own data reads (from the audit's
 * `data.read` events, never another identity's, never more than the audit
 * holds) and saved queries (owner-only changes, visibility decided on the
 * scope, hidden objects answer NOT_FOUND, a stale revision CONFLICT, the
 * audit records the digest only). People: the owner (global), Alice
 * (developer on the project), Bob (developer on the nonprod target only),
 * Vic (viewer, no data.read) and a service account with an API key
 * restricted to nonprod.
 */
let db: MigratedTestDatabase
let keyring: Keyring
let app: ReturnType<typeof createPublicApp>
let registry: KindRegistry
let world: World
let owner: Person
let alice: Person
let bob: Person
let vic: Person
let account = ''
let accountKey = ''
let nonprodTarget = ''
let prodTarget = ''

beforeAll(async () => {
  db = await migratedTestDatabase('exdb_it_http_saved_queries')
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
  const request = (input: string, init: RequestInit) => app.request(input, init)
  owner = await enrollOwner(db, request)
  registry = new KindRegistry(
    workerKinds({ store: worker, keyring }, { clock: systemClock }, db.installationId),
  )
  world = await registryWorld(db)
  nonprodTarget = await placeTarget(db, world, 'nonprod')
  prodTarget = await placeTarget(db, world, 'prod')
  alice = await invitePerson('alice@example.test', 'developer', {
    kind: 'project',
    projectId: world.projectId,
  })
  bob = await invitePerson('bob@example.test', 'developer', {
    kind: 'target',
    targetId: nonprodTarget,
  })
  vic = await invitePerson('vic@example.test', 'viewer', { kind: 'global' })
  account = await serviceAccount('ci reader', 'developer')
  accountKey = await apiKey(account, ['data.read:nonprod', 'targets.read'], ['nonprod'])
}, 300_000)

afterAll(async () => {
  await db?.drop()
})

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

async function invitePerson(email: string, roleId: string, scope: object): Promise<Person> {
  await owner.reauth()
  const invited = await owner.browser.call('POST', '/api/v1/identities', { email })
  expect(invited.status, invited.text).toBe(201)
  const person = await enrollFromLink(
    (input, init) => app.request(input, init),
    invited.body.invitation.link,
  )
  await bindRole(person.identityId, roleId, scope)
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

async function apiKey(id: string, scopes: string[], tiers: ('prod' | 'nonprod')[]) {
  await owner.reauth()
  const key = await owner.browser.call('POST', `/api/v1/service-accounts/${id}/api-keys`, {
    scopes,
    restrictions: { tiers, targets: { kind: 'all' } },
    lifetimeDays: 30,
  })
  expect(key.status, key.text).toBe(201)
  return String(key.body.secret)
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
  return {
    status: response.status,
    // biome-ignore lint/suspicious/noExplicitAny: a parsed JSON body, asserted by each test.
    body: (text.length === 0 ? undefined : JSON.parse(text)) as any,
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

const sha = (s: string) => `sha256:${createHash('sha256').update(s).digest('hex')}`

/**
 * A completed or failed data read, written to the audit with the event
 * builder serve itself uses (`dataReadAuditEvent`), so the history reads
 * exactly the shape a real read leaves.
 */
async function recordRead(
  identityId: string,
  targetId: string,
  tier: 'prod' | 'nonprod',
  read: {
    readonly kind?: 'query' | 'explain'
    readonly statement: string
    readonly client?: ReadParties['client']['kind']
    readonly rows?: number
    readonly failed?: string
    readonly actorKind?: 'human' | 'service'
  },
): Promise<string> {
  const queryId = newId('qry', Date.now())
  const kind = read.kind ?? 'query'
  const parties: ReadParties = {
    actor: {
      kind: read.actorKind ?? 'human',
      identityId: identityId as IdentityId,
      label: read.actorKind === 'service' ? 'service #1' : 'human #1',
    },
    client: { clientId: null, kind: read.client ?? 'web', grantId: null },
  }
  const outcome =
    read.failed !== undefined
      ? { error: read.failed as never, reason: 'statement_class' }
      : kind === 'explain'
        ? ({ kind: 'explain', plan: {}, summary: {}, durationMs: 7 } as never)
        : ({
            kind: 'query',
            columns: [],
            rows: [],
            rowCount: read.rows ?? 3,
            truncated: false,
            truncation: null,
            durationMs: 12.7,
            rlsRelations: [],
          } as never)
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
          kind,
          queryId,
          requestId: newId('req', Date.now()),
          statement: { text: read.statement, digest: sha(read.statement) },
          analyze: false,
          callerClass: read.client === 'mcp' ? 'agent' : 'human',
          outcome,
        },
      ),
      { clock: systemClock },
    ),
  )
  return queryId
}

const history = (who: Person, target: string, query = '') =>
  who.browser.call('GET', `/api/v1/targets/${target}/queries/history${query}`)

describe('query history', () => {
  it("shows the caller's own reads on the target, newest first, never another identity's", async () => {
    const first = await recordRead(alice.identityId, nonprodTarget, 'nonprod', {
      statement: 'SELECT * FROM orders WHERE id = $1',
      rows: 1,
    })
    // The owner reads the same target: never part of Alice's history.
    await recordRead(owner.identityId, nonprodTarget, 'nonprod', {
      statement: 'SELECT secret_owner_marker FROM t',
    })
    // An MCP client reading in Alice's name is Alice's read, labeled as such.
    const explain = await recordRead(alice.identityId, nonprodTarget, 'nonprod', {
      kind: 'explain',
      client: 'mcp',
      statement: 'SELECT count(*) FROM orders',
    })
    const failed = await recordRead(alice.identityId, nonprodTarget, 'nonprod', {
      statement: 'DELETE FROM orders WHERE id = $1',
      failed: 'QUERY_NOT_READ_ONLY',
    })
    const r = await history(alice, nonprodTarget)
    expect(r.status, r.text).toBe(200)
    expect(r.body.source).toBe('audit')
    expect(r.body.nextCursor).toBeNull()
    expect(r.body.items.map((i: { queryId: string }) => i.queryId)).toEqual([
      failed,
      explain,
      first,
    ])
    expect(r.text).not.toContain('secret_owner_marker')
    const [f, e, q] = r.body.items
    expect(q).toMatchObject({
      kind: 'query',
      statement: 'SELECT * FROM orders WHERE id = $1',
      statementDigest: sha('SELECT * FROM orders WHERE id = $1'),
      rows: 1,
      truncated: false,
      durationMs: 12,
      outcome: 'succeeded',
      errorCode: null,
      client: 'web',
      callerClass: 'human',
    })
    // What the audit does not hold is null, never invented.
    expect(e).toMatchObject({ kind: 'explain', rows: null, truncated: null, durationMs: 7 })
    expect(e).toMatchObject({ client: 'mcp', callerClass: 'agent' })
    expect(f).toMatchObject({
      outcome: 'failed',
      errorCode: 'QUERY_NOT_READ_ONLY',
      rows: null,
      truncated: null,
      durationMs: null,
    })
    // The owner's history of the same target holds only the owner's read.
    const own = await history(owner, nonprodTarget)
    expect(own.status).toBe(200)
    expect(own.text).not.toContain('orders')
    expect(own.body.items.map((i: { statement: string }) => i.statement)).toEqual([
      'SELECT secret_owner_marker FROM t',
    ])
  })

  it('returns the redacted statement a real refused read left in the audit, never the text sent', async () => {
    await setTargetState(prodTarget, 'active')
    try {
      const sent = "DELETE FROM accounts WHERE email = 'carol@example.test'"
      const run = await owner.browser.call('POST', `/api/v1/targets/${prodTarget}/queries`, {
        sql: sent,
      })
      expect(run.status, run.text).toBe(422)
      expect(run.body.code).toBe('QUERY_NOT_READ_ONLY')
      const r = await history(owner, prodTarget)
      expect(r.status, r.text).toBe(200)
      const [entry] = r.body.items
      expect(entry).toMatchObject({ outcome: 'failed', errorCode: 'QUERY_NOT_READ_ONLY' })
      expect(entry.statement).toContain('DELETE FROM accounts')
      expect(r.text).not.toContain('carol@example.test')
      expect(entry.statement.length).toBeLessThanOrEqual(256)
    } finally {
      await setTargetState(prodTarget, 'registered')
    }
  })

  it('pages by audit sequence, newest first, at most 200 a page', async () => {
    const ids: string[] = []
    for (let i = 0; i < 5; i++) {
      ids.push(
        await recordRead(bob.identityId, nonprodTarget, 'nonprod', {
          statement: `SELECT ${i}`,
        }),
      )
    }
    const seen: string[] = []
    let cursor: string | null = null
    let pages = 0
    do {
      const r = await history(
        bob,
        nonprodTarget,
        `?limit=2${cursor === null ? '' : `&cursor=${cursor}`}`,
      )
      expect(r.status, r.text).toBe(200)
      expect(r.body.items.length).toBeLessThanOrEqual(2)
      seen.push(...r.body.items.map((i: { queryId: string }) => i.queryId))
      cursor = r.body.nextCursor
      pages++
    } while (cursor !== null && pages < 10)
    expect(pages).toBe(3)
    expect(seen).toEqual([...ids].reverse())
    expect((await history(bob, nonprodTarget, '?limit=201')).status).toBe(422)
    const bad = await history(bob, nonprodTarget, '?cursor=nope')
    expect([bad.status, bad.body.code]).toEqual([422, 'VALIDATION_FAILED'])
  })

  it('enforces data.read at the tier: role scope, missing permission, restricted and missing scopes', async () => {
    // Bob reads data on the nonprod target only: the prod target is not even visible.
    const hidden = await history(bob, prodTarget)
    expect([hidden.status, hidden.body.code]).toEqual([404, 'TARGET_NOT_FOUND'])
    // A viewer holds no data.read at all.
    const viewer = await history(vic, nonprodTarget)
    expect([viewer.status, viewer.body.code]).toEqual([403, 'PERMISSION_DENIED'])
    // The service account: its own reads only, and its grant ends at nonprod.
    await recordRead(account, nonprodTarget, 'nonprod', {
      statement: 'SELECT ci_marker',
      client: 'ci',
      actorKind: 'service',
    })
    const mine = await bearer(accountKey, `/api/v1/targets/${nonprodTarget}/queries/history`)
    expect(mine.status).toBe(200)
    expect(mine.body.items.map((i: { statement: string }) => i.statement)).toEqual([
      'SELECT ci_marker',
    ])
    const prod = await bearer(accountKey, `/api/v1/targets/${prodTarget}/queries/history`)
    expect([prod.status, prod.body.code]).toEqual([404, 'TARGET_NOT_FOUND'])
  })
})

const create = (who: Person, body: object) =>
  who.browser.call('POST', '/api/v1/saved-queries', body)
const get = (who: Person, id: string) => who.browser.call('GET', `/api/v1/saved-queries/${id}`)
const list = (who: Person, query = '') => who.browser.call('GET', `/api/v1/saved-queries${query}`)
const ids = (body: { items: { id: string }[] }) => body.items.map((i) => i.id).sort()

describe('saved queries', () => {
  let personal = ''
  let shared = ''
  let onTarget = ''
  const TEXT = "SELECT * FROM invoices WHERE customer = 'zebra-marker-7'"
  const NAME = 'Invoices of zebra'

  it('creates personal and project queries in a project or on a target; nothing runs', async () => {
    const p = await create(alice, {
      name: NAME,
      sql: TEXT,
      scope: { kind: 'project', projectId: world.projectId },
    })
    expect(p.status, p.text).toBe(201)
    expect(p.body).toMatchObject({
      name: NAME,
      sql: TEXT,
      visibility: 'personal',
      scope: { kind: 'project', projectId: world.projectId },
      ownerIdentityId: alice.identityId,
      ownedByCaller: true,
      revision: 1,
    })
    expect(p.body.sqlDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
    // The digest is that of the redacted text: the constant does not decide it.
    const twin = await create(alice, {
      name: 'twin',
      sql: "SELECT * FROM invoices WHERE customer = 'other'",
      scope: { kind: 'project', projectId: world.projectId },
    })
    expect(twin.body.sqlDigest).toBe(p.body.sqlDigest)
    expect(
      (await alice.browser.call('DELETE', `/api/v1/saved-queries/${twin.body.id}`)).status,
    ).toBe(200)
    personal = p.body.id
    const s = await create(alice, {
      name: 'Shared in the project',
      sql: 'SELECT 1',
      visibility: 'project',
      scope: { kind: 'project', projectId: world.projectId },
    })
    expect(s.status, s.text).toBe(201)
    shared = s.body.id
    const t = await create(alice, {
      name: 'On staging',
      sql: 'SELECT 2',
      visibility: 'project',
      scope: { kind: 'target', target: `${world.slug}/platform/staging` },
    })
    expect(t.status, t.text).toBe(201)
    expect(t.body.scope).toEqual({ kind: 'target', targetId: nonprodTarget })
    onTarget = t.body.id
    // A text that is no statement at all is saved as it is: saving never parses it to refuse it.
    const draft = await create(alice, {
      name: 'draft',
      sql: 'SELEC oops (',
      scope: { kind: 'project', projectId: world.projectId },
    })
    expect(draft.status, draft.text).toBe(201)
    expect(
      (await alice.browser.call('DELETE', `/api/v1/saved-queries/${draft.body.id}`)).status,
    ).toBe(200)
  })

  it('hides a personal query from everyone but its owner, the owner of the installation too', async () => {
    expect((await get(alice, personal)).status).toBe(200)
    for (const who of [owner, bob]) {
      const r = await get(who, personal)
      expect([r.status, r.body.code]).toEqual([404, 'NOT_FOUND'])
    }
    // Exactly like an id that does not exist.
    const missing = await get(owner, newId('sqy', Date.now()))
    expect([missing.status, missing.body.code]).toEqual([404, 'NOT_FOUND'])
  })

  it('shows a project query to whoever reads data on the whole scope, and to nobody else', async () => {
    // The owner's global binding covers the project.
    const o = await get(owner, shared)
    expect(o.status, o.text).toBe(200)
    expect(o.body.ownedByCaller).toBe(false)
    // Bob reads data on one target of the project only: the project scope is not covered.
    expect((await get(bob, shared)).status).toBe(404)
    // The target query is in Bob's scope.
    expect((await get(bob, onTarget)).status).toBe(200)
    // A viewer may read no data anywhere.
    const v = await get(vic, shared)
    expect([v.status, v.body.code]).toEqual([403, 'PERMISSION_DENIED'])
    // Lists hold exactly what each may read.
    expect(ids((await list(alice)).body)).toEqual([personal, shared, onTarget].sort())
    expect(ids((await list(owner)).body)).toEqual([shared, onTarget].sort())
    expect(ids((await list(bob)).body)).toEqual([onTarget])
    expect(ids((await list(owner, `?target=${nonprodTarget}`)).body)).toEqual(
      [shared, onTarget].sort(),
    )
    expect(ids((await list(owner, `?target=${prodTarget}`)).body)).toEqual([shared])
    const bobProd = await list(bob, `?target=${prodTarget}`)
    expect([bobProd.status, bobProd.body.code]).toEqual([404, 'TARGET_NOT_FOUND'])
    // A service account reads what its grant covers: the nonprod target's project query.
    const ci = await bearer(accountKey, '/api/v1/saved-queries')
    expect(ci.status).toBe(200)
    expect(ids(ci.body)).toEqual([onTarget])
  })

  it('lets only the owner change or delete, at the revision read; a stale revision is a conflict', async () => {
    const change = (who: Person, id: string, body: object) =>
      who.browser.call('PUT', `/api/v1/saved-queries/${id}`, body)
    const body = { name: 'Renamed', sql: 'SELECT 3', visibility: 'project', revision: 1 }
    // Someone else's visible query: refused; someone else's hidden query: not there.
    expect((await change(owner, shared, body)).body.code).toBe('PERMISSION_DENIED')
    expect((await owner.browser.call('DELETE', `/api/v1/saved-queries/${shared}`)).status).toBe(403)
    expect((await change(owner, personal, body)).status).toBe(404)
    expect((await owner.browser.call('DELETE', `/api/v1/saved-queries/${personal}`)).status).toBe(
      404,
    )
    const ok = await change(alice, shared, body)
    expect(ok.status, ok.text).toBe(200)
    expect(ok.body).toMatchObject({ name: 'Renamed', sql: 'SELECT 3', revision: 2 })
    expect(Date.parse(ok.body.updatedAt)).toBeGreaterThanOrEqual(Date.parse(ok.body.createdAt))
    const stale = await change(alice, shared, body)
    expect([stale.status, stale.body.code]).toEqual([409, 'CONFLICT'])
    expect((await get(alice, shared)).body.revision).toBe(2)
    // Made personal again: the owner of the installation no longer sees it.
    const hide = await change(alice, shared, { ...body, visibility: 'personal', revision: 2 })
    expect(hide.status, hide.text).toBe(200)
    expect((await get(owner, shared)).status).toBe(404)
    // A service account and the CLI never change saved queries (Web App only).
    const ci = await bearer(accountKey, '/api/v1/saved-queries', 'POST', {
      name: 'ci',
      sql: 'SELECT 1',
      scope: { kind: 'target', target: nonprodTarget },
    })
    expect([ci.status, ci.body.code]).toEqual([403, 'PERMISSION_DENIED'])
  })

  it('refuses a scope the person cannot read data on', async () => {
    // Bob cannot see the project at all: it answers like a project that does not exist.
    const project = await create(bob, {
      name: 'x',
      sql: 'SELECT 1',
      scope: { kind: 'project', projectId: world.projectId },
    })
    expect([project.status, project.body.code]).toEqual([404, 'NOT_FOUND'])
    const target = await create(bob, {
      name: 'x',
      sql: 'SELECT 1',
      scope: { kind: 'target', target: prodTarget },
    })
    expect([target.status, target.body.code]).toEqual([404, 'TARGET_NOT_FOUND'])
    const viewer = await create(vic, {
      name: 'x',
      sql: 'SELECT 1',
      scope: { kind: 'target', target: nonprodTarget },
    })
    expect([viewer.status, viewer.body.code]).toEqual([403, 'PERMISSION_DENIED'])
  })

  it('bounds the name and the text (422)', async () => {
    const scope = { kind: 'project', projectId: world.projectId }
    for (const body of [
      { name: 'x'.repeat(121), sql: 'SELECT 1', scope },
      { name: '', sql: 'SELECT 1', scope },
      { name: 'two\nlines', sql: 'SELECT 1', scope },
      { name: 'ok', sql: '', scope },
      { name: 'ok', sql: 'x'.repeat(65_537), scope },
      { name: 'ok', sql: 'SELECT 1', scope, ownerIdentityId: owner.identityId },
    ]) {
      const r = await create(alice, body)
      expect([r.status, r.body.code]).toEqual([422, 'VALIDATION_FAILED'])
    }
    const longest = await create(alice, { name: 'n'.repeat(120), sql: 'x'.repeat(65_536), scope })
    expect(longest.status, longest.text).toBe(201)
    expect(
      (await alice.browser.call('DELETE', `/api/v1/saved-queries/${longest.body.id}`)).status,
    ).toBe(200)
  })

  it('audits create, update and delete with the digest, never the text or the name', async () => {
    const deleted = await alice.browser.call('DELETE', `/api/v1/saved-queries/${personal}`)
    expect(deleted.status, deleted.text).toBe(200)
    expect(deleted.body).toEqual({ id: personal, deleted: true })
    expect((await get(alice, personal)).status).toBe(404)
    const events = await db.asSuperuser(async (c) =>
      (
        await c.query(
          `SELECT action, event FROM audit.audit_events
            WHERE action LIKE 'saved_query.%' AND event::jsonb -> 'changes' ->> 'savedQueryId' = $1
            ORDER BY seq`,
          [personal],
        )
      ).rows.map((r) => ({ action: String(r.action), event: String(r.event) })),
    )
    expect(events.map((e) => e.action)).toEqual(['saved_query.create', 'saved_query.delete'])
    for (const e of events) {
      const parsed = JSON.parse(e.event)
      expect(parsed.changes.sqlDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
      expect(parsed.actor.identityId).toBe(alice.identityId)
      expect(e.event).not.toContain('zebra-marker-7')
      expect(e.event).not.toContain('invoices')
      expect(e.event).not.toContain(NAME)
    }
    const updates = await db.asSuperuser(async (c) =>
      (
        await c.query(
          `SELECT event FROM audit.audit_events WHERE action = 'saved_query.update'
            AND event::jsonb -> 'changes' ->> 'savedQueryId' = $1`,
          [shared],
        )
      ).rows.map((r) => String(r.event)),
    )
    expect(updates.length).toBe(2)
    for (const e of updates) {
      expect(e).not.toContain('Renamed')
      expect(e).not.toContain('SELECT 3')
    }
  })

  it('is enforced by the Control Store: serve changes rows only through the owner-checking functions', async () => {
    const refused = (sql: string, params: unknown[]) =>
      db.asRole('exdb_serve', async (c) => {
        try {
          await c.query(sql, params)
          return undefined
        } catch (error) {
          return String(Reflect.get(error as object, 'code'))
        }
      })
    expect(
      await refused('UPDATE savedq.saved_queries SET name = $2 WHERE saved_query_id = $1', [
        onTarget,
        'x',
      ]),
    ).toBe('42501')
    expect(
      await refused('DELETE FROM savedq.saved_queries WHERE saved_query_id = $1', [onTarget]),
    ).toBe('42501')
    expect(
      await refused('SELECT savedq.update_saved_query($1, $2, 1, $3, $4, $5, $6)', [
        onTarget,
        owner.identityId,
        'x',
        'SELECT 1',
        sha('x'),
        'personal',
      ]),
    ).toBe('EXQ02')
    expect(
      await refused('SELECT savedq.update_saved_query($1, $2, 99, $3, $4, $5, $6)', [
        onTarget,
        alice.identityId,
        'x',
        'SELECT 1',
        sha('x'),
        'personal',
      ]),
    ).toBe('EXQ03')
    expect(
      await refused('SELECT savedq.delete_saved_query($1, $2)', [onTarget, owner.identityId]),
    ).toBe('EXQ02')
    // Even the table owner cannot move a query to another owner or scope.
    expect(
      await db.asSuperuser(async (c) => {
        try {
          await c.query(
            `UPDATE savedq.saved_queries SET owner_identity_id = $2, revision = revision + 1
              WHERE saved_query_id = $1`,
            [onTarget, owner.identityId],
          )
          return undefined
        } catch (error) {
          return String(Reflect.get(error as object, 'code'))
        }
      }),
    ).toBe('EXQ01')
    expect((await get(alice, onTarget)).body.revision).toBe(1)
  })
})

describe('the MCP catalog', () => {
  it('binds none of the query history or saved query actions', () => {
    for (const action of [
      'query.history.list',
      'saved_query.list',
      'saved_query.get',
      'saved_query.create',
      'saved_query.update',
      'saved_query.delete',
    ]) {
      expect(
        MCP_TOOL_LIST.some((t) => t.action === action),
        action,
      ).toBe(false)
    }
  })
})
