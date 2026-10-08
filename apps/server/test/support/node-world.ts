import { randomBytes } from 'node:crypto'
import { bootstrapOwner, totpCodeAt } from '@exponetdb/auth'
import { SoftAuthenticator } from '@exponetdb/auth/testing'
import {
  EnrollRequestSchema,
  HeartbeatRequestSchema,
  HelloRequestSchema,
  NODE_CAPABILITY_KEYS,
} from '@exponetdb/contracts'
import type { ControlStore, ControlStoreRole } from '@exponetdb/control-store'
import type { MigratedTestDatabase } from '@exponetdb/control-store/testing'
import { isJsonObject, type JobId, type JsonObject, newId, systemClock } from '@exponetdb/kernel'
import {
  b64u,
  bindProof,
  decodeToken,
  ed25519PrivateKey,
  nodeSigningKeyProofValue,
  openNs1,
  parseNs1,
  rawPublicKey,
  signCanonical,
  signResult,
  tlsKeyProofValue,
  tokenKeys,
  x25519PrivateKey,
} from '@exponetdb/kernel/node'
import {
  AgentGateway,
  bindPendingNodes,
  createEnrollmentToken,
  loadGatewayPki,
  type Presented,
  revealEnrollmentToken,
} from '@exponetdb/nodes'
import type { Keyring } from '@exponetdb/secrets'
import { Secret } from 'otpauth'
import { expect } from 'vitest'

/**
 * Test support for node operations over the real program (Wave 5
 * corrections): a person's Web App session, a registry world with an
 * agent-managed cluster, and a simulated node that enrolls with the proofs
 * an agent computes and answers each job it claims with a node-signed
 * completion. Nothing here runs a host change; it stands in for the agent.
 */

export const ORIGIN = 'https://db.example.test'
export const RP_ID = 'db.example.test'
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36'
const PASSWORD = 'tangerine fjord radiator 42'

export type Requester = (input: string, init: RequestInit) => Promise<Response> | Response

export class Browser {
  readonly jar = new Map<string, string>()
  readonly request: Requester
  constructor(request: Requester) {
    this.request = request
  }

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
    const response = await this.request(`${ORIGIN}${path}`, {
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
    }
  }
}

export interface Person {
  readonly browser: Browser
  readonly authenticator: SoftAuthenticator
  readonly identityId: string
  reauth(): Promise<void>
}

/** The first owner, enrolled through the Web App with a passkey, a password and TOTP. */
export async function enrollOwner(db: MigratedTestDatabase, request: Requester): Promise<Person> {
  const issued = await bootstrapOwner(
    {
      store: storeOf(db, 'exdb_serve'),
      clock: systemClock,
      config: { publicOrigin: ORIGIN, rpId: RP_ID, rpName: 'ExponetDB' },
      channel: undefined,
    },
    { email: 'owner@example.test', reissue: false },
  )
  const browser = new Browser(request)
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
  const person: Person = {
    browser,
    authenticator,
    identityId: String(done.body.signedIn.identityId),
    async reauth() {
      const o = await browser.call('POST', '/auth/reauth/passkey/options', {})
      const c = authenticator.assert({ challenge: o.body.challenge, origin: ORIGIN, rpId: RP_ID })
      expect((await browser.call('POST', '/auth/reauth/passkey', { credential: c })).status).toBe(
        200,
      )
    },
  }
  return person
}

const pools = new WeakMap<MigratedTestDatabase, Map<string, ControlStore>>()

/** One pool per database and role for the whole file (each `db.store` call opens a new one). */
export function storeOf(db: MigratedTestDatabase, role: ControlStoreRole): ControlStore {
  let byRole = pools.get(db)
  if (byRole === undefined) {
    byRole = new Map()
    pools.set(db, byRole)
  }
  let store = byRole.get(role)
  if (store === undefined) {
    store = db.store(role)
    byRole.set(role, store)
  }
  return store
}

/** A registry row's creating operation (test-only, as the schema suites insert it). */
async function systemOperation(db: MigratedTestDatabase): Promise<string> {
  const id = newId('op', Date.now())
  await db.asSuperuser((c) =>
    c.query(
      `INSERT INTO operations.operations (operation_id, kind, kind_version, state, apply_outcome, verification_outcome,
                                          actor_kind, client_kind)
       VALUES ($1, 'registry.test', 1, 'queued', 'not_started', 'pending', 'system', 'system')`,
      [id],
    ),
  )
  return id
}

let worlds = 0

export interface Organization {
  readonly productId: string
  readonly projectId: string
  readonly nonprodEnvironmentId: string
  readonly prodEnvironmentId: string
  readonly slug: string
}

export interface World extends Organization {
  readonly serverId: string
  readonly clusterId: string
  readonly systemIdentifier: string
}

/** A product with a nonprod and a prod environment and one project. */
export async function organization(db: MigratedTestDatabase): Promise<Organization> {
  const o = await systemOperation(db)
  const n = ++worlds
  const now = Date.now()
  const org: Organization = {
    productId: newId('prd', now),
    projectId: newId('prj', now),
    nonprodEnvironmentId: newId('env', now),
    prodEnvironmentId: newId('env', now + 1),
    slug: `world${n}`,
  }
  await storeOf(db, 'exdb_worker').transaction('test.organization', async (tx) => {
    await tx.query(
      'test.product',
      `INSERT INTO registry.products (product_id, slug, display_name, created_at, created_by_operation_id)
       VALUES ($1, $2, 'P', now(), $3)`,
      [org.productId, org.slug, o],
    )
    await tx.query(
      'test.env',
      `INSERT INTO registry.environments (environment_id, product_id, slug, display_name, tier, created_at, created_by_operation_id)
       VALUES ($1, $2, 'staging', 'Staging', 'nonprod', now(), $3)`,
      [org.nonprodEnvironmentId, org.productId, o],
    )
    await tx.query(
      'test.env',
      `INSERT INTO registry.environments (environment_id, product_id, slug, display_name, tier, evidence_from, created_at, created_by_operation_id)
       VALUES ($1, $2, 'production', 'Production', 'prod', $3, now(), $4)`,
      [org.prodEnvironmentId, org.productId, org.nonprodEnvironmentId, o],
    )
    await tx.query(
      'test.project',
      `INSERT INTO registry.projects (project_id, product_id, slug, display_name, managed_scope, created_at, created_by_operation_id)
       VALUES ($1, $2, 'platform', 'Platform', '{"excludeSchemas": []}', now(), $3)`,
      [org.projectId, org.productId, o],
    )
  })
  return org
}

/**
 * An organization, a server and its agent-managed, confirmed cluster without
 * placed targets (its derived tier is unknown until a target is placed:
 * {@link placeTarget}).
 */
export async function registryWorld(db: MigratedTestDatabase): Promise<World> {
  const org = await organization(db)
  const o = await systemOperation(db)
  const now = Date.now()
  const w: World = {
    ...org,
    serverId: newId('srv', now),
    clusterId: newId('cls', now),
    systemIdentifier: String(7_500_000_000_000_000_000n + BigInt(worlds)),
  }
  await storeOf(db, 'exdb_worker').query(
    'test.server',
    `INSERT INTO registry.servers (server_id, display_name, provider, labels, created_by_operation_id)
     VALUES ($1, 'db host', 'other', '{}', $2)`,
    [w.serverId, o],
  )
  await db.asSuperuser(async (c) => {
    await c.query(
      `INSERT INTO registry.clusters (cluster_id, server_id, management_mode, display_name, state, ca_bundle, created_by_operation_id)
       VALUES ($1, $2, 'agent', 'main', 'pending', $3, $4)`,
      [w.clusterId, w.serverId, TEST_CA, o],
    )
    await c.query(
      `UPDATE registry.clusters SET state = 'active', system_identifier = $2, server_version_num = 170000,
              confirmed_by_operation_id = $3 WHERE cluster_id = $1`,
      [w.clusterId, w.systemIdentifier, o],
    )
  })
  return w
}

/**
 * An organization, a server and its agent-managed cluster pinned to a real
 * PostgreSQL server (its system identifier, its CA bundle and one private
 * endpoint with the certificate's server name): the worker logs in to it.
 */
export async function agentClusterOn(
  db: MigratedTestDatabase,
  real: {
    readonly systemIdentifier: string
    readonly caPem: string
    readonly host: string
    readonly port: number
    readonly serverName: string
  },
): Promise<World & { readonly endpointId: string }> {
  const org = await organization(db)
  const o = await systemOperation(db)
  const now = Date.now()
  const w = {
    ...org,
    serverId: newId('srv', now),
    clusterId: newId('cls', now),
    endpointId: newId('end', now),
    systemIdentifier: real.systemIdentifier,
  }
  await storeOf(db, 'exdb_worker').query(
    'test.server',
    `INSERT INTO registry.servers (server_id, display_name, provider, labels, created_by_operation_id)
     VALUES ($1, 'db host', 'other', '{}', $2)`,
    [w.serverId, o],
  )
  await db.asSuperuser(async (c) => {
    await c.query(
      `INSERT INTO registry.clusters (cluster_id, server_id, management_mode, display_name, state, ca_bundle, created_by_operation_id)
       VALUES ($1, $2, 'agent', 'main', 'pending', $3, $4)`,
      [w.clusterId, w.serverId, real.caPem, o],
    )
    await c.query(
      `UPDATE registry.clusters SET state = 'active', system_identifier = $2, server_version_num = 170000,
              confirmed_by_operation_id = $3 WHERE cluster_id = $1`,
      [w.clusterId, w.systemIdentifier, o],
    )
    await c.query(
      `INSERT INTO registry.endpoints (endpoint_id, cluster_id, kind, host, port, tls_server_name, label, state, created_at,
                                       created_by_operation_id)
       VALUES ($1, $2, 'private', $3, $4, $5, 'test', 'active', clock_timestamp(), $6)`,
      [w.endpointId, w.clusterId, real.host, real.port, real.serverName, o],
    )
  })
  return w
}

/** Places a target of the environment's tier on a new database of the cluster (its derived tier follows). */
export async function placeTarget(
  db: MigratedTestDatabase,
  w: Organization & { readonly clusterId: string },
  environment: 'nonprod' | 'prod',
  /** The registered database's name (a real host needs one that exists there). */
  databaseName?: string,
): Promise<string> {
  const o = await systemOperation(db)
  const now = Date.now()
  const databaseId = newId('dbs', now)
  const targetId = newId('tgt', now)
  const environmentId = environment === 'prod' ? w.prodEnvironmentId : w.nonprodEnvironmentId
  const slug = environment === 'prod' ? 'production' : 'staging'
  await storeOf(db, 'exdb_worker').transaction('test.target', async (tx) => {
    await tx.query(
      'test.database',
      `INSERT INTO registry.databases (database_id, cluster_id, name, state, created_at, created_by_operation_id)
       VALUES ($1, $2, $3, 'registered', now(), $4)`,
      [databaseId, w.clusterId, databaseName ?? `app_${slug}`, o],
    )
    await tx.query(
      'test.target',
      `INSERT INTO registry.targets (target_id, project_id, environment_id, path, tier, generation, state,
                                     created_at, created_by_operation_id, state_changed_at, state_changed_by_operation_id)
       VALUES ($1, $2, $3, $4, $5, 1, 'registered', now(), $6, now(), $6)`,
      [targetId, w.projectId, environmentId, `${w.slug}/platform/${slug}`, environment, o],
    )
    await tx.query(
      'test.placement',
      `INSERT INTO registry.placements (placement_id, target_id, database_id, generation, reason, valid_from, operation_id)
       VALUES ($1, $2, $3, 1, 'initial', now(), $4)`,
      [newId('plc', now), targetId, databaseId, o],
    )
  })
  return targetId
}

/** A placeholder CA bundle (the registry checks only its form; nothing trusts it). */
export const TEST_CA = '-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----\n'

/** What a simulated node knows of the job it answers. */
export interface SimulatedJob {
  readonly jobId: string
  readonly operationId: string
  /** Opens a sealed (`ns1`) argument with the node's encryption key, as the agent does. */
  open(field: string, sealed: unknown): Uint8Array
}

/**
 * What the simulated node answers per capability: a result that passes the
 * capability's schema, or `hold` to stop after the start, as an agent that
 * died before its statement (the job's lease then runs out).
 */
export type NodeAnswers = (
  capability: string,
  args: JsonObject,
  job: SimulatedJob,
) => JsonObject | 'hold' | Promise<JsonObject | 'hold'>

export interface SimulatedNode {
  readonly nodeId: string
  readonly presented: Presented
  /** The jobs the node claimed, in order (capability keys). */
  readonly claimed: string[]
  heartbeat(): Promise<void>
  /** Claims and answers jobs until stopped. */
  start(): void
  stop(): Promise<void>
}

/**
 * Enrolls a simulated node for the world's server (a token revealed to an
 * identity, the gateway's enrollment with the agent's proofs, the worker's
 * binding), says hello with every current capability and the world's
 * cluster, and sends a heartbeat.
 */
export async function simulatedNode(
  db: MigratedTestDatabase,
  keyring: Keyring,
  w: World,
  answers: NodeAnswers,
): Promise<SimulatedNode> {
  const clock = { nowMs: () => Date.now() }
  const worker = storeOf(db, 'exdb_worker')
  const pki = await loadGatewayPki(storeOf(db, 'exdb_gateway'), keyring)
  if (pki === undefined) throw new Error('no PKI')
  const gateway = new AgentGateway({
    store: storeOf(db, 'exdb_gateway'),
    pki,
    clock,
    installationId: db.installationId,
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 50))),
  })
  const tokenId = newId('ent', Date.now())
  const identityId = newId('idn', Date.now())
  const operationId = await systemOperation(db)
  await worker.transaction('test.token', (tx) =>
    createEnrollmentToken(tx, clock, {
      tokenId,
      serverId: w.serverId,
      revealBy: identityId,
      operationId,
    }),
  )
  const revealed = await db.store('exdb_serve').transaction('test.reveal', (tx) =>
    revealEnrollmentToken(tx, keyring, clock, {
      tokenId,
      identityId,
      installationId: db.installationId,
    }),
  )
  const decoded = decodeToken(revealed.token)
  if (!decoded.ok) throw new Error(decoded.reason)
  const t = decoded.token
  const k = tokenKeys(t.secret, t.tokenId)
  const tls = new Uint8Array(randomBytes(32))
  const nsk = new Uint8Array(randomBytes(32))
  const nek = new Uint8Array(randomBytes(32))
  const tlsKey = b64u(rawPublicKey(ed25519PrivateKey(tls)))
  const nodeSigningKey = b64u(rawPublicKey(ed25519PrivateKey(nsk)))
  const nodeEncryptionKey = b64u(rawPublicKey(x25519PrivateKey(nek)))
  const host = {
    hostname: 'db-host-01',
    os: 'ubuntu 24.04',
    kernel: '6.8.0',
    cpus: 8,
    memoryBytes: 1 << 30,
    machineIdHash: `sha256:${'3'.repeat(64)}`,
  }
  const enrolled = await gateway.enroll(
    EnrollRequestSchema.parse({
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
      host,
    }),
  )
  await bindPendingNodes(worker, keyring, clock, db.installationId)
  const nodeId = enrolled.nodeId
  const presented: Presented = {
    nodeId,
    certificate: new Uint8Array(Buffer.from(enrolled.certificateChain[0] ?? '', 'base64url')),
  }
  await gateway.hello(
    presented,
    HelloRequestSchema.parse({
      nodeId,
      agentVersion: '1.0.0',
      protocolMajors: [1],
      capabilities: NODE_CAPABILITY_KEYS.map((key) => {
        const [name, major] = key.split('@')
        return { name, major: Number(major) }
      }),
      clusters: [
        {
          localName: '17/main',
          port: 5432,
          version: '17.6',
          systemIdentifier: w.systemIdentifier,
          dataDirectory: '/var/lib/postgresql/17/main',
          running: true,
        },
      ],
      host,
      clock: { agentTime: new Date().toISOString() },
      journal: { inFlight: [] },
    }),
  )
  const heartbeat = async () => {
    await gateway.heartbeat(
      presented,
      HeartbeatRequestSchema.parse({
        nodeId,
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
        clockSkewMs: 0,
        inFlightJobs: [],
        agent: { queueSize: 0, bufferedResults: 0, lastErrors: [] },
      }),
    )
  }
  await heartbeat()
  const claimed: string[] = []
  let stopped = true
  let loop: Promise<void> = Promise.resolve()
  const answer = async () => {
    const got = await gateway.claim(presented, { nodeId, waitSeconds: 0 })
    const envelope = got.job as JsonObject | null
    if (envelope === null) {
      await new Promise((r) => setTimeout(r, 50))
      return
    }
    const jobId = String(envelope['jobId']) as JobId
    const capability = envelope['capability']
    const key = isJsonObject(capability) ? `${capability['name']}@${capability['major']}` : '?'
    claimed.push(key)
    await gateway.start(presented, jobId, { jobId, nodeId, startedAt: new Date().toISOString() })
    const args = isJsonObject(envelope['args']) ? envelope['args'] : {}
    const operationId = String(envelope['operationId'])
    const [capName = '', capMajor = '0'] = key.split('@')
    const answered = await answers(key, args, {
      jobId,
      operationId,
      open(field, sealed) {
        const parsed = parseNs1(sealed as never)
        const opened =
          parsed === undefined
            ? undefined
            : openNs1(
                nek,
                {
                  installationId: db.installationId,
                  nodeId,
                  jobId,
                  operationId,
                  capability: { name: capName, major: Number(capMajor) },
                  field,
                },
                parsed,
              )
        if (opened === undefined) throw new Error('the sealed value does not open')
        return opened
      },
    })
    if (answered === 'hold') {
      return
    }
    const unsigned = {
      jobId,
      nodeId,
      finishedAt: new Date().toISOString(),
      outcome: 'succeeded' as const,
      rejectionReason: null,
      result: answered,
      steps: [],
      outputExcerpt: null,
    }
    const value = signResult(
      nsk,
      { installationId: db.installationId, nodeId, jobId, argsHash: String(envelope['argsHash']) },
      unsigned,
    )
    await gateway.complete(presented, jobId, {
      ...unsigned,
      nodeSignature: { alg: 'Ed25519' as const, value },
    })
  }
  return {
    nodeId,
    presented,
    claimed,
    heartbeat,
    start() {
      if (!stopped) return
      stopped = false
      loop = (async () => {
        while (!stopped) {
          await answer().catch(() => new Promise((r) => setTimeout(r, 50)))
        }
      })()
    },
    async stop() {
      stopped = true
      await loop
    },
  }
}
