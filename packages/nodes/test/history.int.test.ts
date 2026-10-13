import { createHash, X509Certificate } from 'node:crypto'
import type { ControlStore } from '@exponetdb/control-store'
import { type MigratedTestDatabase, migratedTestDatabase } from '@exponetdb/control-store/testing'
import { newId } from '@exponetdb/kernel'
import {
  generateKeyringText,
  type Keyring,
  parseKeyring,
  registerActiveKey,
} from '@exponetdb/secrets'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  agentConnections,
  certificateFingerprint,
  ensurePostgresCa,
  initPki,
  listNodeJobs,
  NodeError,
  PKI_NAMES,
  POSTGRES_CA_NAME,
  readCertificates,
} from '../src/index.ts'

/**
 * The node domain's Wave 8 reads (order §9) on real PostgreSQL 17: a node's
 * job history without its envelope, completion or signatures, the
 * certificates of the agent PKI and the PostgreSQL CA by their facts, and how
 * many enrolled nodes are connected.
 */
let db: MigratedTestDatabase
let worker: ControlStore
let serve: ControlStore
let keyring: Keyring
const clock = { nowMs: () => Date.now() }

beforeAll(async () => {
  db = await migratedTestDatabase('exdb_nodes_history')
  worker = db.store('exdb_worker')
  serve = db.store('exdb_serve')
  const parsed = parseKeyring(generateKeyringText('k1'))
  if (!parsed.ok) throw new Error('test keyring')
  keyring = parsed.value
  await registerActiveKey(worker, keyring)
}, 60_000)

afterAll(async () => {
  await db?.drop()
})

describe('certificates', () => {
  it('lists what is not recorded before the PKI exists, and no node', async () => {
    const read = await readCertificates(serve)
    expect(read.authorities).toEqual([])
    expect(read.notRecorded.map((n) => n.role).sort()).toEqual([
      'gateway_server_ca',
      'issuing_ca',
      'postgres_ca',
      'root_ca',
    ])
    expect(read.nodes).toEqual([])
    expect(read.nodesTruncated).toBe(false)
  })

  it('shows each authority by role, subject, validity and the fingerprint of its DER, and nothing else', async () => {
    await worker.transaction('test.pki', (tx) =>
      initPki(tx, keyring, clock, {
        gatewayUrl: 'https://10.8.2.2:7443',
        serverName: 'gateway.exdb.test',
      }),
    )
    await ensurePostgresCa(worker, keyring, clock)
    const read = await readCertificates(serve)
    expect(read.notRecorded).toEqual([])
    const byRole = new Map(read.authorities.map((a) => [a.role, a]))
    expect([...byRole.keys()].sort()).toEqual([
      'gateway_server_ca',
      'issuing_ca',
      'postgres_ca',
      'root_ca',
    ])
    expect(byRole.get('root_ca')?.subjectCommonName).toBe(PKI_NAMES.root)
    expect(byRole.get('issuing_ca')?.subjectCommonName).toBe(PKI_NAMES.issuingCa)
    expect(byRole.get('gateway_server_ca')?.subjectCommonName).toBe(PKI_NAMES.serverCa)
    expect(byRole.get('postgres_ca')?.subjectCommonName).toBe(POSTGRES_CA_NAME)
    // The fingerprint is the SHA-256 of the stored DER, checked against the store's own bytes.
    const stored = await serve.query(
      'test.pki.der',
      'SELECT root_certificate, issuing_ca_certificate, server_ca_certificate FROM nodes.pki',
    )
    const der = stored.rows[0]?.bytes('root_certificate') ?? new Uint8Array()
    const root = byRole.get('root_ca')
    expect(root?.fingerprint).toBe(`sha256:${createHash('sha256').update(der).digest('hex')}`)
    expect(root?.fingerprint).toBe(certificateFingerprint(der))
    const parsed = new X509Certificate(Buffer.from(der))
    expect(root?.notBefore).toBe(parsed.validFromDate.toISOString())
    expect(root?.notAfter).toBe(parsed.validToDate.toISOString())
    expect(Date.parse(root?.notBefore ?? '')).toBeLessThan(Date.parse(root?.notAfter ?? ''))
    // A root lives ten years, the CAs five (pki.ts); both are far from expiry.
    expect(Date.parse(root?.notAfter ?? '')).toBeGreaterThan(Date.now() + 9 * 365 * 86_400_000)
    // No key material and no certificate: only the facts.
    const text = JSON.stringify(read)
    expect(text).not.toMatch(/PRIVATE|BEGIN|key_secret|sec_[0-7]/)
    expect(Object.keys(root ?? {}).sort()).toEqual([
      'fingerprint',
      'notAfter',
      'notBefore',
      'role',
      'subjectCommonName',
    ])
    // The host the gateway is reached at is not part of it.
    expect(text).not.toContain('10.8.2.2')
    expect(text).not.toContain('gateway.exdb.test')
  })

  it('refuses a stored certificate that does not parse instead of listing less', async () => {
    await db.asSuperuser(async (c) => {
      await c.query('BEGIN')
      await c.query("SET LOCAL session_replication_role = 'replica'")
      await c.query('CREATE SCHEMA scratch')
      await c.query('CREATE TABLE scratch.pki AS SELECT root_certificate FROM nodes.pki')
      await c.query(`UPDATE nodes.pki SET root_certificate = decode(repeat('ab', 100), 'hex')`)
      await c.query('COMMIT')
    })
    try {
      await expect(readCertificates(serve)).rejects.toBeInstanceOf(NodeError)
    } finally {
      await db.asSuperuser(async (c) => {
        await c.query('BEGIN')
        await c.query("SET LOCAL session_replication_role = 'replica'")
        await c.query(
          'UPDATE nodes.pki SET root_certificate = (SELECT root_certificate FROM scratch.pki)',
        )
        await c.query('DROP SCHEMA scratch CASCADE')
        await c.query('COMMIT')
      })
    }
    expect((await readCertificates(serve)).authorities).toHaveLength(4)
  })
})

/** A node row as the gateway leaves it, written past the foreign keys (the enrollment is proven elsewhere). */
async function node(options: {
  state: string
  expiresAt: Date
  lastHeartbeatAt: Date | null
  heartbeat?: object | null
}) {
  const nodeId = newId('nod', Date.now() + Math.floor(Math.random() * 100000))
  const serverId = newId('srv', Date.now())
  await db.asSuperuser(async (c) => {
    await c.query('BEGIN')
    await c.query("SET LOCAL session_replication_role = 'replica'")
    await c.query(
      `INSERT INTO nodes.nodes (node_id, server_id, token_id, state, tls_key, node_signing_key, node_encryption_key,
         bind_proof, bound_at, certificate, certificate_expires_at, host, agent_version, protocol_major,
         capabilities, clusters, in_flight, heartbeat, last_hello_at, last_heartbeat_at, enrolled_at,
         state_changed_at, trusted_job_keys)
       VALUES ($1, $2, $3, $4, decode(repeat('01', 32), 'hex'), $5, $6, NULL, now(), decode(repeat('ab', 100), 'hex'),
               $7, '{}', '1.0.0', 1, '[]', '[]', '[]', $8::jsonb, now(), $9, now(), now(), '["k1"]')`,
      [
        nodeId,
        serverId,
        newId('ent', Date.now() + Math.floor(Math.random() * 100000)),
        options.state,
        Buffer.from(nodeId.slice(4, 36).padEnd(32, '0')),
        Buffer.from(`${nodeId.slice(4, 35)}x`.padEnd(32, '1')),
        options.expiresAt.toISOString(),
        options.heartbeat === undefined || options.heartbeat === null
          ? null
          : JSON.stringify(options.heartbeat),
        options.lastHeartbeatAt?.toISOString() ?? null,
      ],
    )
    await c.query('COMMIT')
  })
  return nodeId
}

describe('the nodes in the certificate view and in the connection count', () => {
  it('counts none before a node exists', async () => {
    expect(await agentConnections(serve)).toEqual({
      enrolled: 0,
      connected: 0,
      lastHeartbeatAt: null,
    })
  })

  it('lists nodes that can still connect with their expiries and what the agent reported, and counts the connected ones', async () => {
    const expiresAt = new Date(Date.now() + 30 * 86_400_000)
    const fresh = new Date(Date.now() - 10_000)
    const live = await node({
      state: 'active',
      expiresAt,
      lastHeartbeatAt: fresh,
      heartbeat: {
        clusters: [
          { localName: '17/main', serverCertificateExpiresAt: '2027-01-02T03:04:05Z' },
          { localName: '17/bad', serverCertificateExpiresAt: 'not a time' },
          { localName: 5, serverCertificateExpiresAt: '2027-01-02T03:04:05Z' },
        ],
      },
    })
    const silent = await node({
      state: 'active',
      expiresAt,
      lastHeartbeatAt: new Date(Date.now() - 10 * 60_000),
    })
    await node({ state: 'revoked', expiresAt, lastHeartbeatAt: fresh })
    const read = await readCertificates(serve)
    expect(read.nodes.map((n) => n.nodeId).sort()).toEqual([live, silent].sort())
    const liveRow = read.nodes.find((n) => n.nodeId === live)
    expect(liveRow).toMatchObject({
      state: 'active',
      certificateExpiresAt: expiresAt.toISOString(),
      // Only a well-formed report is listed.
      serverCertificates: [{ localName: '17/main', expiresAt: '2027-01-02T03:04:05.000Z' }],
    })
    expect(read.nodes.find((n) => n.nodeId === silent)?.serverCertificates).toEqual([])
    // Revoked nodes cannot connect: they are no part of either view.
    expect(await agentConnections(serve)).toMatchObject({ enrolled: 2, connected: 1 })
    expect((await agentConnections(serve)).lastHeartbeatAt).toBe(fresh.toISOString())
  })
})

describe('job history', () => {
  let nodeId = ''
  const ids: string[] = []

  async function job(
    state: string,
    extra: { outcome?: string; valid?: boolean | null; startedAt?: Date; completedAt?: Date } = {},
  ) {
    const jobId = newId('job', Date.now() + ids.length * 5)
    ids.push(jobId)
    const completion =
      extra.outcome === undefined ? null : JSON.stringify({ secret: ['completion', 'body'].join('-') })
    await db.asSuperuser(async (c) => {
      await c.query('BEGIN')
      await c.query("SET LOCAL session_replication_role = 'replica'")
      await c.query(
        `INSERT INTO nodes.jobs (job_id, node_id, operation_id, capability, envelope, args_hash, nonce, not_before,
           expires_at, state, run_seconds, started_at, completion, outcome, completed_at, node_signature_valid,
           judged_at, created_at, state_changed_at)
         VALUES ($1, $2, $3, 'postgres.status@1', '{"args":"ENVELOPE-SECRET"}', $4, $5, now(), now() + interval '10 minutes',
                 $6, 60, $7::timestamptz, $8::jsonb, $9, $10::timestamptz, $11, CASE WHEN $11::boolean IS NULL THEN NULL ELSE now() END,
                 now(), now())`,
        [
          jobId,
          nodeId,
          newId('op', Date.now()),
          `sha256:${'a'.repeat(64)}`,
          jobId.slice(4, 26),
          state,
          extra.startedAt?.toISOString() ?? null,
          completion,
          extra.outcome ?? null,
          extra.completedAt?.toISOString() ?? null,
          extra.valid ?? null,
        ],
      )
      await c.query('COMMIT')
    })
    return jobId
  }

  beforeAll(async () => {
    nodeId = await node({
      state: 'active',
      expiresAt: new Date(Date.now() + 86_400_000),
      lastHeartbeatAt: new Date(),
    })
    const t = Date.now()
    await job('pending')
    await job('running', { startedAt: new Date(t - 1000) })
    await job('completed', {
      outcome: 'succeeded',
      valid: true,
      startedAt: new Date(t - 5000),
      completedAt: new Date(t - 3000),
    })
    await job('completed', {
      outcome: 'succeeded',
      valid: false,
      startedAt: new Date(t - 5000),
      completedAt: new Date(t - 3000),
    })
    await job('completed', {
      outcome: 'failed',
      valid: null,
      startedAt: new Date(t - 5000),
      completedAt: new Date(t - 3000),
    })
    await job('expired')
    await job('outcome_unknown', { startedAt: new Date(t - 9000) })
  })

  it('lists a node jobs newest first with state, times and the reported outcome', async () => {
    const page = await listNodeJobs(serve, nodeId, { after: null, limit: 50 })
    expect(page.items.map((j) => j.id)).toEqual([...ids].reverse())
    expect(page.more).toBe(false)
    const states = page.items.map((j) => j.state)
    expect(states).toEqual([
      'outcome_unknown',
      'expired',
      'completed',
      'completed',
      'completed',
      'running',
      'pending',
    ])
    const [unknown, expired, failed, invalid, verified, running, pending] = page.items
    expect(pending).toMatchObject({
      startedAt: null,
      finishedAt: null,
      outcome: null,
      resultVerified: null,
    })
    expect(running).toMatchObject({ finishedAt: null })
    expect(running?.startedAt).not.toBeNull()
    // A result the worker verified, one it found invalid, one it has not judged: never conflated.
    expect(verified).toMatchObject({ outcome: 'succeeded', resultVerified: true })
    expect(invalid).toMatchObject({ outcome: 'succeeded', resultVerified: false })
    expect(failed).toMatchObject({ outcome: 'failed', resultVerified: null })
    expect(verified?.finishedAt).not.toBeNull()
    // A job that ended without a result is finished when its state last changed.
    expect(expired?.finishedAt).not.toBeNull()
    expect(unknown?.finishedAt).not.toBeNull()
    expect(expired).toMatchObject({ outcome: null, startedAt: null })
    expect(verified).toMatchObject({
      capability: 'postgres.status',
      capabilityMajor: 1,
      nodeId,
    })
  })

  it('never returns the envelope, the completion, the arguments or a signature', async () => {
    const page = await listNodeJobs(serve, nodeId, { after: null, limit: 50 })
    const text = JSON.stringify(page)
    expect(text).not.toMatch(/ENVELOPE-SECRET|completion-body|sha256:a{64}|nonce|signature/i)
    expect(Object.keys(page.items[0] ?? {}).sort()).toEqual([
      'capability',
      'capabilityMajor',
      'createdAt',
      'finishedAt',
      'id',
      'nodeId',
      'operationId',
      'outcome',
      'resultVerified',
      'startedAt',
      'state',
    ])
  })

  it('pages by the id and stops at the end', async () => {
    const first = await listNodeJobs(serve, nodeId, { after: null, limit: 3 })
    expect(first.items).toHaveLength(3)
    expect(first.more).toBe(true)
    const second = await listNodeJobs(serve, nodeId, { after: first.last, limit: 3 })
    const third = await listNodeJobs(serve, nodeId, { after: second.last, limit: 3 })
    expect([...first.items, ...second.items, ...third.items].map((j) => j.id)).toEqual(
      [...ids].reverse(),
    )
    expect(third.more).toBe(false)
  })

  it('shows another node nothing of this one', async () => {
    const other = await node({
      state: 'active',
      expiresAt: new Date(Date.now() + 86_400_000),
      lastHeartbeatAt: new Date(),
    })
    expect((await listNodeJobs(serve, other, { after: null, limit: 50 })).items).toEqual([])
  })
})
