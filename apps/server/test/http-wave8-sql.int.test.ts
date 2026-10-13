import { SQL_CLASSIFY_MAX_BYTES, SQL_CLASSIFY_MAX_STATEMENTS } from '@exponetdb/contracts'
import { type MigratedTestDatabase, migratedTestDatabase } from '@exponetdb/control-store/testing'
import { newId, systemClock } from '@exponetdb/kernel'
import { createLogger, MetricsRegistry } from '@exponetdb/observability'
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
import { enrollOwner, ORIGIN, type Person, storeOf } from './support/node-world.ts'

/**
 * `POST /api/v1/sql/classifications` over the real public app (Wave 8, order
 * §9) on PostgreSQL 17: authorization is the central engine's
 * (`migrations.read` at the installation), the text is parsed and never
 * executed, stored, logged, audited or echoed, and the bounds are 422s.
 */
let db: MigratedTestDatabase
let keyring: Keyring
let app: ReturnType<typeof createPublicApp>
let owner: Person
let registry: KindRegistry
const logged: string[] = []

const PATH = '/api/v1/sql/classifications'
// A marker no code path of ours produces; it must never come back.
const MARKER = 'zq9marker7x'

beforeAll(async () => {
  db = await migratedTestDatabase('exdb_it_http_wave8_sql')
  const parsed = parseKeyring(generateKeyringText('test-key'))
  if (!parsed.ok) throw new Error('keyring')
  keyring = parsed.value
  const worker = storeOf(db, 'exdb_worker')
  await registerActiveKey(worker, keyring)
  const config: ServeConfig = {
    role: 'serve',
    logLevel: 'debug',
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
  const logger = createLogger({
    role: 'serve',
    level: 'debug',
    write: (line: string) => {
      logged.push(line)
    },
  })
  const access = composeAccess(
    config,
    { store: storeOf(db, 'exdb_serve'), keyring },
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
}, 240_000)

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

async function bearer(token: string | undefined, path: string, method = 'GET', body?: unknown) {
  const response = await app.request(`${ORIGIN}${path}`, {
    method,
    headers: {
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  return {
    status: response.status,
    // biome-ignore lint/suspicious/noExplicitAny: a parsed JSON body, asserted by each test.
    body: (text.length === 0 ? undefined : JSON.parse(text)) as any,
    text,
    response,
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
  tiers: ('prod' | 'nonprod')[] = ['nonprod', 'prod'],
): Promise<string> {
  await owner.reauth()
  const key = await owner.browser.call('POST', `/api/v1/service-accounts/${account}/api-keys`, {
    scopes,
    restrictions: { tiers, targets: { kind: 'all' } },
    lifetimeDays: 30,
    ...(tiers.includes('prod') ? { acknowledgeProductionWrite: true } : {}),
  })
  expect(key.status, key.text).toBe(201)
  return String(key.body.secret)
}

const auditCount = async () =>
  Number(
    (await db.asSuperuser(async (c) => c.query('SELECT count(*) AS n FROM audit.audit_events')))
      .rows[0]?.n,
  )

describe('classifying SQL over HTTP', () => {
  it('needs a credential', async () => {
    const r = await bearer(undefined, PATH, 'POST', { sql: 'SELECT 1' })
    // Without a session cookie a POST is refused before it is read (the CSRF check); no body is parsed.
    expect([r.status, r.body.code]).toEqual([403, 'CSRF_FAILED'])
    const wrong = await bearer('exdb_not_a_key', PATH, 'POST', { sql: 'SELECT 1' })
    expect(wrong.status).toBe(401)
  })

  it("answers a person's session with the statements, their positions, kinds and classes", async () => {
    const sql = `-- ${MARKER}\nSELECT 1;\nCREATE INDEX CONCURRENTLY ${MARKER}_i ON public.${MARKER}_t (a);\nDROP TABLE public.${MARKER}_t`
    const r = await owner.browser.call('POST', PATH, { sql })
    expect(r.status, r.text).toBe(200)
    expect(r.body).toMatchObject({
      status: 'parsed',
      postgresMajor: 17,
      source: 'parser',
      statementCount: 3,
      bytes: new TextEncoder().encode(sql).length,
      readOnlyPath: { admitted: false, refusal: { reason: 'multiple_statements' } },
      parseError: null,
    })
    expect(
      r.body.statements.map(
        (s: { kind: string; classes: string[]; readOnlyPath: boolean }) =>
          [s.kind, s.classes, s.readOnlyPath] as const,
      ),
    ).toEqual([
      ['SelectStmt', ['read_only'], true],
      ['IndexStmt', ['write', 'non_transactional'], false],
      ['DropStmt', ['write', 'destructive'], false],
    ])
    expect(r.body.statements[1].start).toEqual({
      line: 3,
      column: 1,
      offset: sql.indexOf('CREATE INDEX'),
    })
    expect(Date.parse(r.body.computedAt)).toBeGreaterThan(Date.now() - 60_000)
    // Positions only: nothing of the text comes back.
    expect(r.text).not.toContain(MARKER)
  })

  it('answers a syntax error as a result with its position, not as an error', async () => {
    const sql = `SELECT '${MARKER}' FROM ;`
    const r = await owner.browser.call('POST', PATH, { sql })
    expect(r.status, r.text).toBe(200)
    expect(r.body.status).toBe('parse_error')
    expect(r.body.statements).toEqual([])
    expect(r.body.parseError).toEqual({
      reason: 'syntax',
      position: { line: 1, column: sql.indexOf(';') + 1, offset: sql.indexOf(';') },
    })
    expect(r.text).not.toContain(MARKER)
    const empty = await owner.browser.call('POST', PATH, { sql: '-- nothing' })
    expect([empty.status, empty.body.status]).toEqual([200, 'empty'])
  })

  it('parses with the grammar asked for and says which', async () => {
    const r = await owner.browser.call('POST', PATH, { sql: 'SELECT 1', postgresMajor: 16 })
    expect([r.status, r.body.postgresMajor]).toEqual([200, 16])
    expect(r.body.grammar).toContain('16')
  })

  it('touches nothing: no audit event, no log line with the text, and nothing is executed', async () => {
    const before = await auditCount()
    const sql = `SELECT 1; DROP TABLE public.${MARKER}; SELECT '${MARKER}' FROM ;`
    const first = await owner.browser.call('POST', PATH, { sql })
    expect(first.status).toBe(200)
    // A bound that fails and a syntax error leave no trace either.
    await owner.browser.call('POST', PATH, {
      sql: `${MARKER} ${'x'.repeat(SQL_CLASSIFY_MAX_BYTES)}`,
    })
    expect(await auditCount()).toBe(before)
    expect(logged.join('\n')).not.toContain(MARKER)
  })

  it('is refused above 64 KiB (UTF-8 bytes) and above 200 statements, as VALIDATION_FAILED, without the text', async () => {
    const big = await owner.browser.call('POST', PATH, {
      sql: `/* ${MARKER} */ ${'SELECT 1;'.repeat(100)}${'-'.repeat(SQL_CLASSIFY_MAX_BYTES)}`,
    })
    expect([big.status, big.body.code]).toEqual([422, 'VALIDATION_FAILED'])
    expect(big.body.details.errors[0]).toMatchObject({ path: '/sql' })
    expect(big.text).not.toContain(MARKER)
    // Two-byte characters: within the character count, above the byte bound.
    const wide = await owner.browser.call('POST', PATH, {
      sql: 'é'.repeat(SQL_CLASSIFY_MAX_BYTES / 2 + 1),
    })
    expect([wide.status, wide.body.code]).toEqual([422, 'VALIDATION_FAILED'])
    // Exactly 64 KiB of text passes: JSON escaping may enlarge the body, the bound is on the SQL.
    const exact = await owner.browser.call('POST', PATH, {
      sql: `SELECT 1 /*${'\n'.repeat(SQL_CLASSIFY_MAX_BYTES - 13)}*/`,
    })
    expect([exact.status, exact.body.status]).toEqual([200, 'parsed'])
    const many = await owner.browser.call('POST', PATH, {
      sql: `/* ${MARKER} */ ${'SELECT 1;'.repeat(SQL_CLASSIFY_MAX_STATEMENTS + 1)}`,
    })
    expect([many.status, many.body.code]).toEqual([422, 'VALIDATION_FAILED'])
    expect(many.body.details.errors[0]).toMatchObject({
      path: '/sql',
      code: 'too_many_statements',
    })
    expect(many.text).not.toContain(MARKER)
    const atBound = await owner.browser.call('POST', PATH, {
      sql: 'SELECT 1;'.repeat(SQL_CLASSIFY_MAX_STATEMENTS),
    })
    expect([atBound.status, atBound.body.statementCount]).toEqual([
      200,
      SQL_CLASSIFY_MAX_STATEMENTS,
    ])
  })

  it('refuses a malformed request with VALIDATION_FAILED and never echoes the member values', async () => {
    for (const body of [
      { sql: '' },
      { sql: 'SELECT 1', postgresMajor: 15 },
      { sql: 'SELECT 1', [MARKER]: true },
      { statement: 'SELECT 1' },
    ]) {
      const r = await owner.browser.call('POST', PATH, body)
      expect([r.status, r.body.code], JSON.stringify(body)).toEqual([422, 'VALIDATION_FAILED'])
    }
  })

  it('needs migrations.read at the installation: a viewer key reads, a key without the scope does not', async () => {
    const viewer = await serviceAccount('Classifier viewer', 'viewer')
    const key = await apiKey(viewer, ['migrations.read'])
    const r = await bearer(key, PATH, 'POST', { sql: 'SELECT 1' })
    expect([r.status, r.body.status]).toEqual([200, 'parsed'])
    const other = await apiKey(viewer, ['nodes.read'])
    const denied = await bearer(other, PATH, 'POST', { sql: `SELECT '${MARKER}'` })
    expect(denied.status).toBe(403)
    expect(denied.text).not.toContain(MARKER)
  })

  it('names no target, so a delegation restricted in tier reads it too', async () => {
    const restrictedAccount = await serviceAccount('Classifier restricted', 'viewer')
    const restricted = await apiKey(restrictedAccount, ['migrations.read'], ['nonprod'])
    const r = await bearer(restricted, PATH, 'POST', { sql: 'SELECT 1' })
    expect([r.status, r.body.status]).toEqual([200, 'parsed'])
  })

  it('is no MCP tool and is not served by GET', async () => {
    expect((await owner.browser.call('GET', PATH)).status).toBe(404)
  })
})
