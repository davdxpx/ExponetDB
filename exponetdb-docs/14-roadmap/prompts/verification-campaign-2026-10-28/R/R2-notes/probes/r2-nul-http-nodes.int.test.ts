import { randomBytes } from 'node:crypto'
import { bootstrapOwner, totpCodeAt } from '@exponetdb/auth'
import { SoftAuthenticator } from '@exponetdb/auth/testing'
import { EnrollRequestSchema, HelloRequestSchema } from '@exponetdb/contracts'
import { type MigratedTestDatabase, migratedTestDatabase } from '@exponetdb/control-store/testing'
import { newId, systemClock } from '@exponetdb/kernel'
import {
  b64u,
  bindProof,
  decodeToken,
  ed25519PrivateKey,
  nodeSigningKeyProofValue,
  rawPublicKey,
  signCanonical,
  tlsKeyProofValue,
  tokenKeys,
  x25519PrivateKey,
} from '@exponetdb/kernel/node'
import { AgentGateway, bindPendingNodes, initPki, loadGatewayPki } from '@exponetdb/nodes'
import { createLogger, MetricsRegistry } from '@exponetdb/observability'
import { KindRegistry, processNextOperation } from '@exponetdb/operations'
import {
  generateKeyringText,
  type Keyring,
  parseKeyring,
  registerActiveKey,
} from '@exponetdb/secrets'
import { Secret } from 'otpauth'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { composeAccess, workerKinds } from '../src/composition/access.ts'
import type { ServeConfig } from '../src/config/env.ts'
import { createPublicApp, httpMetrics } from '../src/interfaces/http/app.ts'

/**
 * Wave 5 node routes over HTTP (control-plane.md §4, §7): a person plans
 * `node.enroll` for a server, applies it with a fresh re-authentication, the
 * worker creates the token record, and the person reveals the token once;
 * a node enrolls with it (the gateway service, with the proofs an agent
 * computes) and is read back with its source and time; revocation and
 * decommissioning are planned and applied the same way. Real PostgreSQL 17.
 */

const ORIGIN = 'https://db.example.test'
const RP_ID = 'db.example.test'
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36'
const PASSWORD = 'tangerine fjord radiator 42'

let db: MigratedTestDatabase
let keyring: Keyring
let app: ReturnType<typeof createPublicApp>
let kinds: KindRegistry
let owner: { browser: Browser; authenticator: SoftAuthenticator; identityId: string }
const logs: string[] = []

beforeAll(async () => {
  db = await migratedTestDatabase('exdb_it_http_nodes')
  const parsed = parseKeyring(generateKeyringText('test-key'))
  if (!parsed.ok) throw new Error('keyring')
  keyring = parsed.value
  const serve = db.store('exdb_serve')
  const worker = db.store('exdb_worker')
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
  const logger = createLogger({ role: 'serve', level: 'debug', write: (l) => logs.push(l) })
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
  kinds = new KindRegistry(
    workerKinds({ store: worker, keyring }, { clock: systemClock }, db.installationId),
  )
}, 120_000)

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
    return {
      status: response.status,
      body: text.length === 0 ? undefined : JSON.parse(text),
      text,
      cacheControl: response.headers.get('cache-control'),
    }
  }
}

async function enrollOwner() {
  const issued = await bootstrapOwner(
    {
      store: db.store('exdb_serve'),
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

/** Test-only aging of the re-authentication, as the auth suites do. */
async function staleReauth() {
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
  for (let i = 0; i < 20; i++) {
    const r = await processNextOperation(db.store('exdb_worker'), {
      workerId: newId('prc', Date.now()),
      kinds,
      clock: systemClock,
    })
    if (r.status === 'idle') return
  }
}

async function plan(path: string) {
  const planned = await owner.browser.call('POST', path, {})
  expect([planned.status, planned.body?.code]).toEqual([201, undefined])
  return planned.body
}

async function apply(planId: string) {
  return owner.browser.call('POST', `/api/v1/plans/${planId}/apply`, {})
}

function agentEnrollment(token: string) {
  const decoded = decodeToken(token)
  if (!decoded.ok) throw new Error(decoded.reason)
  const t = decoded.token
  const k = tokenKeys(t.secret, t.tokenId)
  const tls = new Uint8Array(randomBytes(32))
  const nsk = new Uint8Array(randomBytes(32))
  const nek = new Uint8Array(randomBytes(32))
  const tlsKey = b64u(rawPublicKey(ed25519PrivateKey(tls)))
  const nodeSigningKey = b64u(rawPublicKey(ed25519PrivateKey(nsk)))
  const nodeEncryptionKey = b64u(rawPublicKey(x25519PrivateKey(nek)))
  return EnrollRequestSchema.parse({
    tokenId: t.tokenId,
    redeemKey: b64u(k.redeem),
    tlsKey,
    tlsKeyProof: signCanonical(tls, tlsKeyProofValue(t.tokenId, tlsKey)),
    nodeSigningKey,
    nodeSigningKeyProof: signCanonical(nsk, nodeSigningKeyProofValue(t.tokenId, nodeSigningKey)),
    nodeEncryptionKey,
    bindProof: bindProof(k.bind, {
      installationId: t.installationId,
      serverId: t.serverId,
      tokenId: t.tokenId,
      nodeSigningKey,
      nodeEncryptionKey,
    }),
    agentVersion: '1.0.0',
    protocolMajors: [1],
    host: {
      hostname: 'db-host-01',
      os: 'ubuntu 24.04',
      kernel: '6.8.0',
      cpus: 8,
      memoryBytes: 1 << 30,
      machineIdHash: `sha256:${'3'.repeat(64)}`,
    },
  })
}

describe('node routes over REST', () => {
  it('enrolls through a plan and a one-time reveal, reads the node, revokes and decommissions it', async () => {
    owner = await enrollOwner()
    // A server record (Wave 4 plan), on a provider of the longer list (owner decision S11):
    // the plan, the worker's insert under the widened CHECK and the read all take it.
    const planned = await owner.browser.call('POST', '/api/v1/servers', {
      displayName: 'db host',
      provider: 'on_premises',
    })
    expect(planned.status).toBe(201)
    expect(planned.body).toMatchObject({ change: { content: { provider: 'on_premises' } } })
    expect((await apply(planned.body.id)).status).toBe(202)
    await drive()
    const servers = await owner.browser.call('GET', '/api/v1/servers')
    const serverId: string = servers.body.items[0].id
    expect(servers.body.items[0].provider).toBe('on_premises')

    // node.enroll: re-authentication at apply.
    const enroll = await plan(`/api/v1/servers/${serverId}/nodes/enroll`)
    expect(enroll).toMatchObject({ kind: 'node.enroll', change: { content: { serverId } } })
    const tokenId: string = enroll.change.content.tokenId
    expect(tokenId).toMatch(/^ent_/)
    await staleReauth()
    expect((await apply(enroll.id)).body).toMatchObject({ code: 'REAUTH_REQUIRED' })
    await reauth()
    const applied = await apply(enroll.id)
    expect(applied.status).toBe(202)
    await drive()
    const op = await db.asSuperuser((c) =>
      c.query(
        'SELECT state, verification_outcome FROM operations.operations WHERE operation_id = $1',
        [applied.body.id],
      ),
    )
    expect(op.rows[0]).toMatchObject({ state: 'succeeded', verification_outcome: 'passed' })

    // The reveal: re-authentication, once, never stored.
    await staleReauth()
    const stale = await owner.browser.call(
      'POST',
      `/api/v1/enrollment-tokens/${tokenId}/reveal`,
      {},
    )
    expect(stale.body).toMatchObject({ code: 'REAUTH_REQUIRED' })
    await reauth()
    const revealed = await owner.browser.call(
      'POST',
      `/api/v1/enrollment-tokens/${tokenId}/reveal`,
      {},
    )
    expect(revealed.status).toBe(200)
    expect(revealed.body).toMatchObject({
      tokenId,
      serverId,
      token: expect.stringMatching(/^exdbt1\./),
    })
    expect(revealed.cacheControl).toContain('no-store')
    const again = await owner.browser.call(
      'POST',
      `/api/v1/enrollment-tokens/${tokenId}/reveal`,
      {},
    )
    expect(again.status).toBe(404)
    const token: string = revealed.body.token
    // Nothing logged or audited carries the token.
    const audit = await db.asSuperuser((c) =>
      c.query(`SELECT action, event FROM audit.audit_events ORDER BY seq`),
    )
    expect(audit.rows.map((r) => r.action)).toEqual(
      expect.arrayContaining(['node.enroll', 'node.enrollment_token.revealed']),
    )
    expect(JSON.stringify(audit.rows)).not.toContain(token.slice(7, 47))
    expect(logs.join('\n')).not.toContain(token.slice(7, 47))

    // A node enrolls with it; reads show it with its source and time.
    const gatewayStore = db.store('exdb_gateway')
    const pki = await loadGatewayPki(gatewayStore, keyring)
    if (pki === undefined) throw new Error('no PKI')
    const gateway = new AgentGateway({
      store: gatewayStore,
      pki,
      clock: systemClock,
      installationId: db.installationId,
    })
    const enrolled = await gateway.enroll(agentEnrollment(token))
    const listed = await owner.browser.call('GET', '/api/v1/nodes')
    expect(listed.body.items).toEqual([
      expect.objectContaining({ id: enrolled.nodeId, serverId, state: 'pending_enrollment' }),
    ])
    await bindPendingNodes(db.store('exdb_worker'), keyring, systemClock, db.installationId)
    const offline = await owner.browser.call('GET', `/api/v1/nodes/${enrolled.nodeId}`)
    expect(offline.body).toMatchObject({ state: 'offline', source: 'inferred', host: null })
    const presented = {
      nodeId: enrolled.nodeId,
      certificate: new Uint8Array(Buffer.from(enrolled.certificateChain[0] ?? '', 'base64url')),
    }
    await gateway.hello(
      presented,
      HelloRequestSchema.parse({
        nodeId: enrolled.nodeId,
        agentVersion: '1.0.0',
        protocolMajors: [1],
        // A major the Wave 5 correction retired (F1) is never listed.
        capabilities: [
          { name: 'agent.diagnostics', major: 1 },
          { name: 'agent.diagnostics', major: 2 },
        ],
        clusters: [],
        host: {
          hostname: 'db-host-01',
          os: 'ubuntu 24.04',
          kernel: '6.8.0',
          cpus: 8,
          memoryBytes: 1 << 30,
          machineIdHash: `sha256:${'3'.repeat(64)}`,
        },
        clock: { agentTime: new Date().toISOString() },
        journal: { inFlight: [] },
      }),
    )
    await gateway.heartbeat(presented, {
      nodeId: enrolled.nodeId,
      sentAt: new Date().toISOString(),
      host: {
        cpuPercent: 3,
        memoryUsedBytes: 1024,
        load1: 0.5,
        load5: 0.4,
        load15: 0.3,
        mounts: [{ path: '/', usedBytes: 25, totalBytes: 100, inodesUsedPercent: 1 }],
      },
      clusters: [],
      nodeCertificateExpiresAt: enrolled.certificateExpiresAt,
      clockSkewMs: 12,
      inFlightJobs: [],
      agent: { queueSize: 0, bufferedResults: 0, lastErrors: [] },
    })
    const active = await owner.browser.call('GET', `/api/v1/nodes/${enrolled.nodeId}`)
    expect(active.body).toMatchObject({
      state: 'active',
      source: 'agent_reported',
      clockSkewMs: 12,
      capabilities: [{ name: 'agent.diagnostics', major: 2 }],
      host: { loadAverage1m: 0.5, memoryUsedBytes: 1024, diskUsedPercent: 25 },
    })

    // A grant restricted to a tier sees the nodes whose server it covers, never a refusal of
    // the whole list (authorization.md §1, Wave 7); this server hosts no target, so its tier is
    // unknown and only an unrestricted grant sees its node.
    const account = await owner.browser.call('POST', '/api/v1/service-accounts', {
      displayName: 'Node reader',
    })
    const binding = await owner.browser.call('POST', '/api/v1/role-bindings', {
      identityId: account.body.id,
      roleId: 'viewer',
      scope: { kind: 'global' },
    })
    expect(binding.status, binding.text).toBe(201)
    await reauth()
    expect((await apply(binding.body.id)).status).toBe(202)
    await drive()
    const keyFor = async (tiers: string[]) =>
      (
        await owner.browser.call('POST', `/api/v1/service-accounts/${account.body.id}/api-keys`, {
          scopes: ['nodes.read'],
          restrictions: { tiers, targets: { kind: 'all' } },
          lifetimeDays: 1,
        })
      ).body.secret as string
    const nodesWith = async (secret: string) => {
      const r = await app.request(`${ORIGIN}/api/v1/nodes`, {
        headers: { authorization: `Bearer ${secret}` },
      })
      return { status: r.status, body: JSON.parse(await r.text()) }
    }
    await reauth()
    const restricted = await nodesWith(await keyFor(['nonprod']))
    expect([restricted.status, restricted.body.items]).toEqual([200, []])
    await reauth()
    const everything = await nodesWith(await keyFor(['nonprod', 'prod']))
    expect(everything.status).toBe(200)
    expect(everything.body.items.map((n: { id: string }) => n.id)).toEqual([enrolled.nodeId])

    // One live node per server: a second enrollment plan is refused.
    const refused = await owner.browser.call('POST', `/api/v1/servers/${serverId}/nodes/enroll`, {})
    expect(refused.body).toMatchObject({ code: 'NODE_ALREADY_ENROLLED' })

    // Revocation, then decommissioning, both re-authenticated at apply.
    // R2 PROBE (TC-019 neighbour): an ACTIVE, unexpired plan whose stored body holds an escaped NUL (valid JSON text that
    // jsonb refuses, 22P05; the class fixed for GET /fleet in #44). The impact count of the new revoke plan
    // casts every plan body to jsonb.
    await db.asSuperuser(async (c) => {
      const pid = newId('pln', Date.now())
      const body = JSON.stringify({ nonce: pid, subject: { tier: 'nonprod' }, reason: 'nul \u0000 inside' })
      await c.query('BEGIN')
      await c.query("SET LOCAL session_replication_role = 'replica'")
      await c.query(
        `INSERT INTO operations.plans (plan_id, kind, kind_version, action_class, state, decision, plan_hash,
           content_checksum, policy_version, actor_kind, client_kind, created_at, expires_at)
         VALUES ($1, 'migration.apply', 1, 'standard', 'active', 'allow',
           'sha256:' || encode(sha256(convert_to($2::text, 'UTF8')), 'hex'),
           'sha256:' || repeat('a', 64), 'sha256:pv1:' || repeat('b', 64), 'system', 'system',
           now(), now() + interval '30 minutes')`,
        [pid, body],
      )
      await c.query('INSERT INTO operations.plan_bodies (plan_id, body) VALUES ($1, $2)', [pid, body])
      await c.query('COMMIT')
    })
    // Can a NUL reach a stored plan body through the API itself? (displayName with an escaped NUL)
    const viaApi = await owner.browser.call('POST', '/api/v1/products', { slug: 'r2nulprobe', displayName: 'a\u0000b' })
    console.log('R2-PROBE-NUL product plan with \\u0000 in displayName via REST: status', viaApi.status, String(viaApi.body?.code ?? viaApi.body?.state ?? ''), 'plan id present', Boolean(viaApi.body?.id))
    const probe = await owner.browser.call('POST', `/api/v1/nodes/${enrolled.nodeId}/revoke`, {})
    console.log('R2-PROBE-NUL revoke plan with an escaped-NUL body stored: status', probe.status, JSON.stringify(probe.body).slice(0, 200))
    const revoke = await plan(`/api/v1/nodes/${enrolled.nodeId}/revoke`)
    // The plan says what it does and what it needs (TC-019): the effect, what depends on the
    // node, and the fresh re-authentication that the apply will ask for.
    expect(revoke.requirements).toContainEqual({ kind: 'reauth', withinSeconds: 300 })
    expect(revoke.change.content).toMatchObject({ nodeId: enrolled.nodeId, action: 'revoke' })
    expect(revoke.change.analysis).toMatchObject({
      effect: expect.stringContaining('refuses the node at its next request'),
      impact: {
        waitingJobs: 0,
        runningJobs: 0,
        servedClusters: 0,
        openOperations: 0,
        activePlans: expect.any(Number),
      },
    })
    await reauth()
    expect((await apply(revoke.id)).status).toBe(202)
    await drive()
    const revoked = await owner.browser.call('GET', `/api/v1/nodes/${enrolled.nodeId}`)
    expect(revoked.body).toMatchObject({ state: 'revoked' })
    await expect(gateway.hello(presented, {} as never)).rejects.toThrow()
    const decommission = await plan(`/api/v1/nodes/${enrolled.nodeId}/decommission`)
    expect(decommission.requirements).toContainEqual({ kind: 'reauth', withinSeconds: 300 })
    expect(decommission.change.content).toMatchObject({ action: 'decommission' })
    // The two kinds no longer share a checksum.
    expect(decommission.contentChecksum).not.toBe(revoke.contentChecksum)
    await reauth()
    expect((await apply(decommission.id)).status).toBe(202)
    await drive()
    const gone = await owner.browser.call('GET', `/api/v1/nodes/${enrolled.nodeId}`)
    expect(gone.body).toMatchObject({ state: 'decommissioned' })
    // The server may enroll a new node.
    expect(
      (await owner.browser.call('POST', `/api/v1/servers/${serverId}/nodes/enroll`, {})).status,
    ).toBe(201)
  }, 120_000)
})
