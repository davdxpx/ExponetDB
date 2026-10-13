import { createHash, randomBytes } from 'node:crypto'
import { operationView } from '@exponetdb/application'
import { isScramSha256Verifier, RoleVerifierSubmissionSchema } from '@exponetdb/contracts'
import { type MigratedTestDatabase, migratedTestDatabase } from '@exponetdb/control-store/testing'
import { isJsonObject, type JsonObject, newId, systemClock } from '@exponetdb/kernel'
import { scramSha256Verifier } from '@exponetdb/kernel/hash'
import { initPki } from '@exponetdb/nodes'
import { createLogger, MetricsRegistry } from '@exponetdb/observability'
import {
  type DispatchAdmission,
  KindRegistry,
  type OperationKind,
  processNextOperation,
} from '@exponetdb/operations'
import {
  generateKeyringText,
  type Keyring,
  parseKeyring,
  registerActiveKey,
} from '@exponetdb/secrets'
import {
  createDatabase,
  logsIn,
  type TestServer,
  testTargets,
  withSuperuser,
} from '@exponetdb/testkit'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { composeAccess, workerDispatchAdmission, workerKinds } from '../src/composition/access.ts'
import type { ServeConfig } from '../src/config/env.ts'
import { createPublicApp, httpMetrics } from '../src/interfaces/http/app.ts'
import {
  agentClusterOn,
  enrollFromLink,
  enrollOwner,
  ORIGIN,
  type Person,
  placeTarget,
  type SimulatedNode,
  simulatedNode,
  storeOf,
  type World,
} from './support/node-world.ts'

/**
 * Role verifiers (owner decision S3, Wave 8): a person submits a consumer
 * role's SCRAM-SHA-256 verifier (never the password) through the REST API
 * of `serve`; it is sealed at once and `postgres.roles.verifier.set` is
 * planned; `plan.apply` runs it on the worker as `runWorker` composes it,
 * and a simulated node opens the sealed verifier and sets it on a real
 * PostgreSQL 17 as the agent does (statement logging off, the verifier a
 * session value). The role then logs in with the password over verified
 * TLS. The password and the verifier appear nowhere in the Control Store,
 * the audit, the server log or any response.
 */

let db: MigratedTestDatabase
let keyring: Keyring
let app: ReturnType<typeof createPublicApp>
let owner: Person
let kinds: readonly OperationKind[]
let registry: KindRegistry
let admit: DispatchAdmission
let server: TestServer
let w: World & { readonly endpointId: string }
let node: SimulatedNode
const logs: string[] = []
const responses: string[] = []
/** Every role this file creates on the shared server (dropped after). */
const created: string[] = []
const PREFIX = `acme_rvf_${randomBytes(3).toString('hex')}`

const record = async (r: Response | Promise<Response>): Promise<Response> => {
  const response = await r
  responses.push(await response.clone().text())
  return response
}

/** The roles of this file as the agent's `postgres.roles.inspect@2` reports them (no password value). */
async function inspectRoles(): Promise<JsonObject> {
  const rows = await withSuperuser(server, 'postgres', async (c) => {
    const r = await c.query(
      `SELECT r.rolname AS name, r.rolcanlogin AS login, r.rolsuper AS superuser, r.rolinherit AS inherit,
              r.rolcreatedb AS createdb, r.rolcreaterole AS createrole, r.rolreplication AS replication,
              r.rolbypassrls AS bypassrls, r.rolconnlimit AS "connectionLimit",
              CASE WHEN a.rolpassword IS NULL THEN 'none' WHEN a.rolpassword LIKE 'SCRAM-SHA-256$%'
                   THEN 'scram-sha-256' ELSE 'other' END AS password
         FROM pg_catalog.pg_roles r JOIN pg_catalog.pg_authid a ON a.oid = r.oid
        WHERE r.rolname LIKE $1 ORDER BY 1`,
      [`${PREFIX}%`],
    )
    return r.rows as JsonObject[]
  })
  const roles: JsonObject[] = rows.map((r) => ({
    ...r,
    connectionLimit: Number(r['connectionLimit']),
    validUntil: null,
  }))
  // Like the agent's digest: the roles as read, never the password.
  const digest = createHash('sha256')
    .update(JSON.stringify(roles.map(({ password: _p, ...rest }) => rest)))
    .digest('hex')
  return { rolesDigest: `kd1:${digest}`, roles, memberships: [], settings: [], expectations: [] }
}

/** What the agent's `postgres.roles.apply@2` does with one `set_password` step. */
async function applyRoles(args: JsonObject, open: (field: string, v: unknown) => Uint8Array) {
  const before = await inspectRoles()
  if (args['expectedRolesDigest'] !== before['rolesDigest']) {
    throw new Error('the roles changed since the plan')
  }
  const steps = Array.isArray(args['steps']) ? args['steps'] : []
  for (const step of steps) {
    if (!isJsonObject(step) || step['op'] !== 'set_password') throw new Error('unexpected step')
    const verifier = Buffer.from(open('verifier', step['verifier'])).toString('utf8')
    await withSuperuser(server, 'postgres', async (c) => {
      await c.query("SET log_statement = 'none'")
      await c.query('BEGIN')
      await c.query(
        `SELECT pg_catalog.set_config('exponetdb.role', $1, true), pg_catalog.set_config('exponetdb.verifier', $2, true)`,
        [step['role'], verifier],
      )
      await c.query(`DO $do$ BEGIN
        EXECUTE pg_catalog.format('ALTER ROLE %I PASSWORD %L',
          pg_catalog.current_setting('exponetdb.role'), pg_catalog.current_setting('exponetdb.verifier'));
        END $do$`)
      await c.query('COMMIT')
    })
  }
  return {
    rolesDigest: (await inspectRoles())['rolesDigest'] as string,
    appliedSteps: steps.length,
  }
}

beforeAll(async () => {
  const targets = testTargets()
  const found = targets.servers.find((s) => s.major === 17)
  if (found === undefined) throw new Error('no PostgreSQL 17 test server')
  server = found
  db = await migratedTestDatabase('exdb_it_role_verifiers')
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
  const logger = createLogger({ role: 'serve', level: 'debug', write: (l) => logs.push(l) })
  const access = composeAccess(
    config,
    { store: storeOf(db, 'exdb_serve'), keyring },
    { clock: systemClock, logger },
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
  owner = await enrollOwner(db, (input, init) => record(app.request(input, init)))
  kinds = workerKinds({ store: worker, keyring }, { clock: systemClock }, db.installationId)
  registry = new KindRegistry(kinds)
  admit = workerDispatchAdmission(kinds, { clock: systemClock })
  const sysid = await withSuperuser(server, 'postgres', async (c) => {
    const r = await c.query('SELECT system_identifier::text AS s FROM pg_control_system()')
    return String(r.rows[0]?.s)
  })
  w = await agentClusterOn(db, {
    systemIdentifier: sysid,
    caPem: targets.caPem,
    host: server.host === 'localhost' ? '127.0.0.1' : server.host,
    port: server.port,
    serverName: targets.serverName,
  })
  await placeTarget(db, w, 'nonprod', await createDatabase(server, 'role_verifiers'))
  node = await simulatedNode(db, keyring, w, async (capability, args, job) => {
    switch (capability) {
      case 'postgres.roles.inspect@2':
        return inspectRoles()
      case 'postgres.roles.apply@2':
        return applyRoles(args, (field, v) => job.open(field, v))
      default:
        throw new Error(`no answer for ${capability}`)
    }
  })
  node.start()
}, 180_000)

afterAll(async () => {
  await node?.stop()
  if (server !== undefined) {
    await withSuperuser(server, 'postgres', async (c) => {
      for (const role of created) await c.query(`DROP ROLE IF EXISTS ${role}`)
    })
  }
  await db?.drop()
})

async function drive() {
  for (let i = 0; i < 30; i++) {
    const r = await processNextOperation(storeOf(db, 'exdb_worker'), {
      workerId: newId('prc', Date.now()),
      kinds: registry,
      clock: systemClock,
      admit,
    })
    if (r.status === 'idle') return
  }
}

async function view(operationId: string) {
  return operationView(storeOf(db, 'exdb_serve'), operationId, ORIGIN)
}

async function jobsOf(operationId: string): Promise<string[]> {
  const { rows } = await db.asSuperuser((c) =>
    c.query('SELECT capability FROM nodes.jobs WHERE operation_id = $1 ORDER BY created_at', [
      operationId,
    ]),
  )
  return rows.map((r) => String(r.capability))
}

/** A new login role without a password on the real server. */
async function newRole(): Promise<string> {
  const role = `${PREFIX}_${created.length}`
  created.push(role)
  await withSuperuser(server, 'postgres', (c) => c.query(`CREATE ROLE ${role} LOGIN`))
  return role
}

/** A fresh node-signed roles observation of the cluster, the basis of a plan. */
async function observeRoles(as: Person = owner) {
  const inspected = await as.browser.call('POST', `/api/v1/nodes/${node.nodeId}/inspections`, {
    capability: 'postgres.roles.inspect@2',
    clusterId: w.clusterId,
    args: { expectSettings: [] },
  })
  expect([inspected.status, inspected.body?.code]).toEqual([202, undefined])
  await drive()
}

/** A marker password and its verifier, as the browser derives it (the password never leaves it). */
function secretPair() {
  const password = `rvf-marker-${randomBytes(12).toString('hex')}`
  return { password, verifier: scramSha256Verifier(password) }
}

async function submit(role: string, verifier: string, as: Person = owner) {
  await as.reauth()
  return as.browser.call('POST', `/api/v1/clusters/${w.clusterId}/role-verifiers`, {
    role,
    verifier,
  })
}

async function apply(planId: string, as: Person = owner) {
  await as.reauth()
  return as.browser.call('POST', `/api/v1/plans/${planId}/apply`, {})
}

/** The needles a leak would show: the password, the verifier and its parts, as text and as hex. */
function needles(pair: { password: string; verifier: string }): string[] {
  const [, , keys = ''] = pair.verifier.split('$')
  const [storedKey = '', serverKey = ''] = keys.split(':')
  return [
    pair.password,
    pair.verifier,
    storedKey,
    serverKey,
    Buffer.from(pair.password).toString('hex'),
    Buffer.from(pair.verifier).toString('hex'),
  ]
}

/** Every base table of the Control Store whose row text holds a needle. */
async function storeHits(list: readonly string[]): Promise<string[]> {
  const { rows } = await db.asSuperuser((c) =>
    c.query(
      `SELECT format('%I.%I', table_schema, table_name) AS t FROM information_schema.tables
        WHERE table_type = 'BASE TABLE' AND table_schema NOT IN ('pg_catalog', 'information_schema')`,
    ),
  )
  const hits: string[] = []
  for (const { t } of rows as { t: string }[]) {
    const { rows: found } = await db.asSuperuser((c) =>
      c.query(
        `SELECT count(*)::int AS n FROM ${t} x
          WHERE EXISTS (SELECT FROM unnest($1::text[]) n WHERE position(n IN x::text) > 0)`,
        [list],
      ),
    )
    if (Number(found[0]?.n) > 0) hits.push(t)
  }
  return hits
}

describe('role verifiers (owner decision S3)', () => {
  it('submits, plans, applies and verifies a verifier; the role logs in with the password; nothing leaks', async () => {
    const role = await newRole()
    const pair = secretPair()
    await observeRoles()
    const planned = await submit(role, pair.verifier)
    expect([planned.status, planned.body?.code], planned.text).toEqual([201, undefined])
    expect(planned.body.kind).toBe('postgres.roles.verifier.set')
    const verifierId = String(planned.body.change.analysis.verifierId)
    expect(verifierId).toMatch(/^rvf_/)
    expect(planned.body.change.analysis).toMatchObject({ roleName: role, passwordBefore: 'none' })
    // Stored sealed: the raw column is ciphertext, and serve cannot read it.
    const { rows: sealed } = await db.asSuperuser((c) =>
      c.query('SELECT state, ciphertext FROM role_verifiers.verifiers WHERE verifier_id = $1', [
        verifierId,
      ]),
    )
    expect(sealed[0]?.state).toBe('submitted')
    expect(Buffer.from(sealed[0]?.ciphertext).toString('latin1')).not.toContain('SCRAM-SHA-256')
    await expect(
      storeOf(db, 'exdb_serve').query(
        'test.read_sealed',
        'SELECT ciphertext FROM role_verifiers.verifiers WHERE verifier_id = $1',
        [verifierId],
      ),
    ).rejects.toThrow()
    expect(await logsIn(server, role, pair.password)).toBe(false)

    const applied = await apply(planned.body.id)
    expect([applied.status, applied.body?.code], applied.text).toEqual([202, undefined])
    await drive()
    const op = await view(applied.body.id)
    expect([op.state, op.applyOutcome, op.verificationOutcome]).toEqual([
      'succeeded',
      'applied',
      'passed',
    ])
    expect(await jobsOf(applied.body.id)).toEqual([
      'postgres.roles.inspect@2',
      'postgres.roles.apply@2',
      'postgres.roles.inspect@2',
    ])
    // The verifier is the one PostgreSQL authenticates the password with.
    expect(await logsIn(server, role, pair.password)).toBe(true)
    expect(await logsIn(server, role, `${pair.password}x`)).toBe(false)
    // Consumed: cleared in the transaction that handed it to the node.
    const { rows: after } = await db.asSuperuser((c) =>
      c.query(
        'SELECT state, operation_id, ciphertext, nonce FROM role_verifiers.verifiers WHERE verifier_id = $1',
        [verifierId],
      ),
    )
    expect(after[0]).toMatchObject({ state: 'consumed', operation_id: applied.body.id })
    expect([after[0]?.ciphertext, after[0]?.nonce]).toEqual([null, null])
    // The audit names the role, the cluster, the verifier id and the operation.
    const { rows: audit } = await db.asSuperuser((c) =>
      c.query(
        `SELECT action, event::jsonb AS event FROM audit.audit_events
          WHERE action LIKE 'role_verifier.%' AND position($1 IN event) > 0 ORDER BY seq`,
        [verifierId],
      ),
    )
    expect(audit.map((a) => a.action)).toEqual([
      'role_verifier.submitted',
      'role_verifier.consumed',
    ])
    expect(audit.every((a) => JSON.stringify(a.event).includes(role))).toBe(true)
    expect(JSON.stringify(audit[1]?.event)).toContain(applied.body.id)
    // Nowhere: no table (sealed rows, plans, jobs, audit), no log line, no response.
    const secret = needles(pair)
    expect(await storeHits(secret)).toEqual([])
    for (const n of secret) {
      expect(logs.some((l) => l.includes(n))).toBe(false)
      expect(responses.some((r) => r.includes(n))).toBe(false)
    }
    // The store's guard: a consumed row is never sealed again or deleted, and serve
    // cannot even select the sealed columns of it.
    const worker = storeOf(db, 'exdb_worker')
    await expect(
      worker.query(
        'test.reseal',
        `UPDATE role_verifiers.verifiers SET state = 'submitted' WHERE verifier_id = $1`,
        [verifierId],
      ),
    ).rejects.toThrow()
    await expect(
      worker.query('test.delete', 'DELETE FROM role_verifiers.verifiers WHERE verifier_id = $1', [
        verifierId,
      ]),
    ).rejects.toThrow()
    // No route reads it back: the plan and the operation name the id only.
    const plan = await owner.browser.call('GET', `/api/v1/plans/${planned.body.id}`)
    expect(plan.status).toBe(200)
    expect(plan.text).toContain(verifierId)
    for (const n of secret) expect(plan.text.includes(n)).toBe(false)
  })

  it('refuses a password, an invalid verifier, a predefined or own role, without echoing the value', async () => {
    const role = await newRole()
    const marker = `rvf-echo-${randomBytes(12).toString('hex')}`
    for (const body of [
      { role, password: marker },
      { role, verifier: marker },
      { role, verifier: scramSha256Verifier(marker), password: marker },
      { role: 'exponetdb_reader', verifier: scramSha256Verifier(marker) },
      { role: 'pg_monitor', verifier: scramSha256Verifier(marker) },
    ]) {
      await owner.reauth()
      const r = await owner.browser.call(
        'POST',
        `/api/v1/clusters/${w.clusterId}/role-verifiers`,
        body,
      )
      expect([r.status, r.body?.code], r.text).toEqual([422, 'VALIDATION_FAILED'])
      expect(r.text).not.toContain(marker)
      if (body.verifier !== undefined) expect(r.text).not.toContain(body.verifier)
    }
    expect(logs.some((l) => l.includes(marker))).toBe(false)
    expect(await storeHits([marker, Buffer.from(marker).toString('hex')])).toEqual([])
  })

  it("accepts PostgreSQL's own SCRAM-SHA-256 verifier format, as psql \\password and libpq compute it", async () => {
    const role = await newRole()
    const password = `rvf-pg-${randomBytes(12).toString('hex')}`
    const stored = await withSuperuser(server, 'postgres', async (c) => {
      await c.query("SET password_encryption = 'scram-sha-256'")
      await c.query(`ALTER ROLE ${role} PASSWORD ${c.escapeLiteral(password)}`)
      const r = await c.query('SELECT rolpassword FROM pg_catalog.pg_authid WHERE rolname = $1', [
        role,
      ])
      await c.query(`ALTER ROLE ${role} PASSWORD NULL`)
      return String(r.rows[0]?.rolpassword)
    })
    expect(isScramSha256Verifier(stored)).toBe(true)
    expect(RoleVerifierSubmissionSchema.safeParse({ role, verifier: stored }).success).toBe(true)
  })

  it('refuses a role the node did not report (REGISTRY_CONFLICT role_missing)', async () => {
    await observeRoles()
    const r = await submit(`${PREFIX}_absent`, secretPair().verifier)
    expect([r.status, r.body?.code]).toEqual([409, 'REGISTRY_CONFLICT'])
  })

  it('makes the plan stale when the role changed after planning, and when a newer verifier superseded it', async () => {
    const role = await newRole()
    await observeRoles()
    const first = await submit(role, secretPair().verifier)
    expect(first.status, first.text).toBe(201)
    // The role changes on the host: the worker's fresh read differs from the plan's.
    await withSuperuser(server, 'postgres', (c) => c.query(`ALTER ROLE ${role} CONNECTION LIMIT 7`))
    const applied = await apply(first.body.id)
    expect(applied.status, applied.text).toBe(202)
    await drive()
    const op = await view(applied.body.id)
    expect([op.state, op.applyOutcome, op.errorCode]).toEqual([
      'failed',
      'not_applied',
      'PLAN_STALE',
    ])
    expect(await jobsOf(applied.body.id)).toEqual(['postgres.roles.inspect@2'])

    await observeRoles()
    const older = await submit(role, secretPair().verifier)
    expect(older.status, older.text).toBe(201)
    const newer = await submit(role, secretPair().verifier)
    expect(newer.status, newer.text).toBe(201)
    expect(newer.body.change.analysis.supersededVerifierIds).toEqual([
      older.body.change.analysis.verifierId,
    ])
    const stale = await apply(older.body.id)
    expect([stale.status, stale.body?.code], stale.text).toEqual([409, 'PLAN_STALE'])
    const { rows } = await db.asSuperuser((c) =>
      c.query('SELECT state, ciphertext FROM role_verifiers.verifiers WHERE verifier_id = $1', [
        older.body.change.analysis.verifierId,
      ]),
    )
    expect(rows[0]).toMatchObject({ state: 'superseded', ciphertext: null })
  })

  it('keeps refusing set_password in postgres.roles.apply and names the role-verifier route', async () => {
    await observeRoles()
    const r = await owner.browser.call('POST', `/api/v1/nodes/${node.nodeId}/plans`, {
      clusterId: w.clusterId,
      change: {
        kind: 'postgres.roles.apply',
        steps: [
          {
            op: 'set_password',
            role: `${PREFIX}_0`,
            attributes: null,
            verifier: { ns1: { enc: 'A'.repeat(43), ct: 'B'.repeat(22) } },
            member: null,
            admin: null,
            inherit: null,
            set: null,
            database: null,
            setting: null,
            value: null,
          },
        ],
      },
    })
    expect([r.status, r.body?.code]).toEqual([422, 'VALIDATION_FAILED'])
    expect(r.text).toContain('/clusters/{clusterId}/role-verifiers')
  })

  it('refuses a person without nodes.operate and a non-human caller; on production it waits for a human approval', async () => {
    const role = await newRole()
    await observeRoles()
    // A developer has no nodes.operate.
    const developer = await person('developer.rvf@example.test', 'developer', { kind: 'global' })
    const denied = await submit(role, secretPair().verifier, developer)
    expect([denied.status, denied.body?.code]).toEqual([403, 'PERMISSION_DENIED'])
    // An operator (on call) holds nodes.operate; a cluster is covered by global bindings only.
    const operator = await person('operator.rvf@example.test', 'operator', { kind: 'global' })
    const allowed = await submit(role, secretPair().verifier, operator)
    expect([allowed.status, allowed.body?.code], allowed.text).toEqual([201, undefined])
    // A service account's API key (not a human session) is refused.
    const key = await apiKey()
    const bearer = await record(
      app.request(`${ORIGIN}/api/v1/clusters/${w.clusterId}/role-verifiers`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ role, verifier: secretPair().verifier }),
      }),
    )
    expect(bearer.status).toBe(403)

    // A production target on the cluster makes it production.
    await placeTarget(db, w, 'prod', await createDatabase(server, 'role_verifiers_prod'))
    await observeRoles()
    const pair = secretPair()
    const planned = await submit(role, pair.verifier)
    expect(planned.status, planned.text).toBe(201)
    expect(planned.body.requirements).toEqual([
      { kind: 'approval', count: 1, permission: 'plans.approve' },
    ])
    const applied = await apply(planned.body.id)
    expect(applied.body).toMatchObject({ state: 'awaiting_approval' })
    await drive()
    expect(await jobsOf(applied.body.id)).toEqual([])
    await owner.reauth()
    const approved = await owner.browser.call(
      'POST',
      `/api/v1/approvals/${applied.body.id}/approve`,
      {
        planHash: planned.body.planHash,
        acknowledgeSelfApproval: true,
      },
    )
    expect(approved.status, approved.text).toBe(200)
    await drive()
    const op = await view(applied.body.id)
    expect([op.state, op.verificationOutcome]).toEqual(['succeeded', 'passed'])
    expect(await logsIn(server, role, pair.password)).toBe(true)
  })
})

/** A person invited by the owner and bound to a role (the planned access change, applied). */
async function person(email: string, roleId: string, scope: JsonObject): Promise<Person> {
  await owner.reauth()
  const invited = await owner.browser.call('POST', '/api/v1/identities', { email })
  expect(invited.status, invited.text).toBe(201)
  const enrolled = await enrollFromLink(
    (input, init) => record(app.request(input, init)),
    invited.body.invitation.link,
  )
  const planned = await owner.browser.call('POST', '/api/v1/role-bindings', {
    identityId: enrolled.identityId,
    roleId,
    scope,
  })
  expect(planned.status, planned.text).toBe(201)
  const applied = await apply(planned.body.id)
  expect(applied.status, applied.text).toBe(202)
  await drive()
  return enrolled
}

/** An admin service account's API key with nodes.operate on nonprod (the cluster is nonprod then). */
async function apiKey(): Promise<string> {
  await owner.reauth()
  const account = await owner.browser.call('POST', '/api/v1/service-accounts', {
    displayName: 'ci admin',
  })
  expect(account.status, account.text).toBe(201)
  const planned = await owner.browser.call('POST', '/api/v1/role-bindings', {
    identityId: account.body.id,
    roleId: 'admin',
    scope: { kind: 'global' },
  })
  expect(planned.status, planned.text).toBe(201)
  expect((await apply(planned.body.id)).status).toBe(202)
  await drive()
  await owner.reauth()
  const key = await owner.browser.call(
    'POST',
    `/api/v1/service-accounts/${account.body.id}/api-keys`,
    {
      scopes: ['nodes.operate:nonprod'],
      restrictions: { tiers: ['nonprod'], targets: { kind: 'all' } },
      lifetimeDays: 30,
    },
  )
  expect(key.status, key.text).toBe(201)
  return String(key.body.secret)
}
