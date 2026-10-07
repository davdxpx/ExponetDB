import { createPrivateKey, createPublicKey, randomBytes, X509Certificate } from 'node:crypto'
import {
  EnrollRequestSchema,
  HelloRequestSchema,
  JobCompleteRequestSchema,
} from '@exponetdb/contracts'
import type { ControlStore } from '@exponetdb/control-store'
import { type MigratedTestDatabase, migratedTestDatabase } from '@exponetdb/control-store/testing'
import { type JsonObject, newId } from '@exponetdb/kernel'
import {
  b64u,
  bindProof,
  decodeToken,
  ed25519PrivateKey,
  keyFingerprint,
  nodeSigningKeyProofValue,
  openNs1,
  parseNs1,
  rawPublicKey,
  renewSignatureValue,
  renewTlsKeyProofValue,
  signCanonical,
  signResult,
  tlsKeyProofValue,
  tokenKeys,
  verifyJobEnvelope,
  x25519PrivateKey,
} from '@exponetdb/kernel/node'
import {
  generateKeyringText,
  type Keyring,
  parseKeyring,
  registerActiveKey,
} from '@exponetdb/secrets'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  AgentGateway,
  bindPendingNodes,
  createEnrollmentToken,
  createJob,
  type GatewayPki,
  initPki,
  jobEvidence,
  judgeCompletions,
  loadGatewayPki,
  mintGatewayIdentity,
  NodeError,
  type Presented,
  revealEnrollmentToken,
} from '../src/index.ts'

/**
 * The node agent's control plane against real PostgreSQL: the PKI
 * ceremony, a token created by the worker and revealed once by serve, an
 * enrollment with the proofs a real agent computes, binding by the worker,
 * a signed job through the gateway's state machine and the worker's verdict,
 * renewal, and revocation (control-plane.md).
 */

let db: MigratedTestDatabase
let worker: ControlStore
let serve: ControlStore
let gatewayStore: ControlStore
let keyring: Keyring
let pki: GatewayPki
let gateway: AgentGateway
let rootFingerprint: string
const clock = { nowMs: () => Date.now() }
const SERVER_NAME = 'gateway.exdb.internal'

beforeAll(async () => {
  db = await migratedTestDatabase('exdb_nodes')
  worker = db.store('exdb_worker')
  serve = db.store('exdb_serve')
  gatewayStore = db.store('exdb_gateway')
  const parsed = parseKeyring(generateKeyringText('k1'))
  if (!parsed.ok) {
    throw new Error('test keyring')
  }
  keyring = parsed.value
  await registerActiveKey(worker, keyring)
  const init = await worker.transaction('test.pki', (tx) =>
    initPki(tx, keyring, clock, { gatewayUrl: 'https://10.8.2.2:7443', serverName: SERVER_NAME }),
  )
  rootFingerprint = init.rootFingerprint
  // The returned root key is the root certificate's key (PKCS#8, Ed25519).
  const rootKey = createPrivateKey(init.rootPrivateKeyPem)
  expect(rootKey.asymmetricKeyType).toBe('ed25519')
  expect(
    new X509Certificate(Buffer.from(init.rootCertificate)).publicKey.equals(
      createPublicKey(rootKey),
    ),
  ).toBe(true)
  const loaded = await loadGatewayPki(gatewayStore, keyring)
  if (loaded === undefined) {
    throw new Error('no PKI')
  }
  pki = loaded
  gateway = new AgentGateway({
    store: gatewayStore,
    pki,
    clock,
    installationId: db.installationId,
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 50))),
  })
}, 60_000)

afterAll(async () => {
  await db?.drop()
})

async function operation(): Promise<string> {
  const id = newId('op', Date.now())
  await db.asSuperuser((c) =>
    c.query(
      `INSERT INTO operations.operations (operation_id, kind, kind_version, state, apply_outcome, verification_outcome,
                                          actor_kind, client_kind)
       VALUES ($1, 'node.test', 1, 'queued', 'not_started', 'pending', 'system', 'system')`,
      [id],
    ),
  )
  return id
}

async function server(): Promise<string> {
  const id = newId('srv', Date.now())
  const op = await operation()
  await worker.query(
    'test.server',
    `INSERT INTO registry.servers (server_id, display_name, provider, labels, created_by_operation_id)
     VALUES ($1, 'db host', 'other', '{}', $2)`,
    [id, op],
  )
  return id
}

/** A token as the applying identity reveals it. */
async function revealedToken(serverId: string) {
  const tokenId = newId('ent', Date.now())
  const identityId = newId('idn', Date.now())
  const operationId = await operation()
  await worker.transaction('test.token', (tx) =>
    createEnrollmentToken(tx, clock, { tokenId, serverId, revealBy: identityId, operationId }),
  )
  const reveal = () =>
    serve.transaction('test.reveal', (tx) =>
      revealEnrollmentToken(tx, keyring, clock, {
        tokenId,
        identityId,
        installationId: db.installationId,
      }),
    )
  return { tokenId, identityId, reveal }
}

/** The keys and proofs a host computes from a token (agent/node/internal/enroll). */
function agentKeys() {
  const tls = new Uint8Array(randomBytes(32))
  const nsk = new Uint8Array(randomBytes(32))
  const nek = new Uint8Array(randomBytes(32))
  return {
    tls,
    nsk,
    nek,
    tlsKey: b64u(rawPublicKey(ed25519PrivateKey(tls))),
    nodeSigningKey: b64u(rawPublicKey(ed25519PrivateKey(nsk))),
    nodeEncryptionKey: b64u(rawPublicKey(x25519PrivateKey(nek))),
  }
}

const HOST = {
  hostname: 'db-host-01',
  os: 'ubuntu 24.04',
  kernel: '6.8.0',
  cpus: 8,
  memoryBytes: 1 << 30,
  machineIdHash: `sha256:${'3'.repeat(64)}`,
}

function enrollRequest(token: string, keys: ReturnType<typeof agentKeys>, bindOverride?: string) {
  const decoded = decodeToken(token)
  if (!decoded.ok) {
    throw new Error(decoded.reason)
  }
  const t = decoded.token
  const k = tokenKeys(t.secret, t.tokenId)
  return EnrollRequestSchema.parse({
    tokenId: t.tokenId,
    redeemKey: b64u(k.redeem),
    tlsKey: keys.tlsKey,
    tlsKeyProof: signCanonical(keys.tls, tlsKeyProofValue(t.tokenId, keys.tlsKey)),
    nodeSigningKey: keys.nodeSigningKey,
    nodeSigningKeyProof: signCanonical(
      keys.nsk,
      nodeSigningKeyProofValue(t.tokenId, keys.nodeSigningKey),
    ),
    nodeEncryptionKey: keys.nodeEncryptionKey,
    bindProof:
      bindOverride ??
      bindProof(k.bind, {
        installationId: t.installationId,
        serverId: t.serverId,
        tokenId: t.tokenId,
        nodeSigningKey: keys.nodeSigningKey,
        nodeEncryptionKey: keys.nodeEncryptionKey,
      }),
    agentVersion: '1.0.0',
    protocolMajors: [1],
    host: HOST,
  })
}

const refused = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p
    return 'resolved'
  } catch (error) {
    return error instanceof NodeError ? error.code : String(error)
  }
}

function hello(presented: Presented) {
  return gateway.hello(
    presented,
    HelloRequestSchema.parse({
      nodeId: presented.nodeId,
      agentVersion: '1.0.0',
      protocolMajors: [1],
      capabilities: [{ name: 'agent.diagnostics', major: 1 }],
      clusters: [],
      host: HOST,
      clock: { agentTime: new Date().toISOString() },
      journal: { inFlight: [] },
    }),
  )
}

describe('node agent control plane (control-plane.md)', () => {
  it('mints the gateway its own short-lived TLS identity from the server CA', () => {
    const identity = mintGatewayIdentity(pki, clock)
    const chain = identity.certificateChainPem
      .split(/(?<=-----END CERTIFICATE-----\n)/)
      .filter((p) => p.length > 0)
      .map((p) => new X509Certificate(p))
    expect(chain).toHaveLength(3)
    const [leaf, serverCa, root] = chain
    expect(leaf?.verify(serverCa?.publicKey ?? (undefined as never))).toBe(true)
    expect(serverCa?.verify(root?.publicKey ?? (undefined as never))).toBe(true)
    expect(leaf?.checkHost(SERVER_NAME)).toBe(SERVER_NAME)
    expect(keyFingerprint(new Uint8Array(root?.raw ?? []))).toBe(rootFingerprint)
    expect(identity.notAfter.getTime() - Date.now()).toBeLessThanOrEqual(72 * 3_600_000)
  })

  it('reveals a token once, to its identity only, and enrolls a node whose proofs hold', async () => {
    const srv = await server()
    const { tokenId, identityId, reveal } = await revealedToken(srv)
    expect(
      await refused(
        serve.transaction('test.reveal', (tx) =>
          revealEnrollmentToken(tx, keyring, clock, {
            tokenId,
            identityId: newId('idn', Date.now()),
            installationId: db.installationId,
          }),
        ),
      ),
    ).toBe('NOT_FOUND')
    const revealed = await reveal()
    expect(revealed.token).toMatch(/^exdbt1\./)
    expect(await refused(reveal())).toBe('NOT_FOUND')
    const stored = await db.asSuperuser((c) =>
      c.query(
        'SELECT state, redeem_hash, reveal_by FROM nodes.enrollment_tokens WHERE token_id = $1',
        [tokenId],
      ),
    )
    expect(stored.rows[0]).toMatchObject({ state: 'issued', reveal_by: identityId })
    expect(JSON.stringify(stored.rows)).not.toContain(revealed.token.slice(7, 40))

    const keys = agentKeys()
    const request = enrollRequest(revealed.token, keys)
    // A failed proof never consumes the token.
    expect(
      await refused(gateway.enroll({ ...request, tlsKeyProof: request.nodeSigningKeyProof })),
    ).toBe('NODE_PROOF_INVALID')
    expect(await refused(gateway.enroll({ ...request, redeemKey: b64u(new Uint8Array(32)) }))).toBe(
      'NODE_ENROLLMENT_REFUSED',
    )
    const enrolled = await gateway.enroll(request)
    expect(enrolled.serverId).toBe(srv)
    expect(enrolled.installationId).toBe(db.installationId)
    // The job keys the gateway returns are the token's anchors.
    const decoded = decodeToken(revealed.token)
    if (!decoded.ok) {
      throw new Error('token')
    }
    expect(
      enrolled.jobKeys.map((k) => ({
        keyId: k.keyId,
        fingerprint: keyFingerprint(Buffer.from(k.publicKey, 'base64url')),
      })),
    ).toEqual(decoded.token.jobKeys)
    // The certificate: the host's TLS key, issued by the issuing CA, 72 hours.
    const leaf = new X509Certificate(Buffer.from(enrolled.certificateChain[0] ?? '', 'base64url'))
    const issuing = new X509Certificate(
      Buffer.from(enrolled.certificateChain[1] ?? '', 'base64url'),
    )
    expect(leaf.verify(issuing.publicKey)).toBe(true)
    expect(leaf.subject).toBe(`CN=${enrolled.nodeId}`)
    expect(leaf.subjectAltName).toBe(
      `URI:urn:exponet:exponetdb:node:${db.installationId}:${enrolled.nodeId}`,
    )
    expect(b64u(rawPublicKey(leaf.publicKey))).toBe(keys.tlsKey)
    // Redeemed once; one live node per server.
    expect(await refused(gateway.enroll(request))).toBe('NODE_ENROLLMENT_REFUSED')
    expect(await refused(revealedToken(srv))).toBe('NODE_ALREADY_ENROLLED')
  })

  it('binds a node with a valid bind proof, fails one without, and serves only bound nodes', async () => {
    const good = await server()
    const bad = await server()
    const goodKeys = agentKeys()
    const badKeys = agentKeys()
    const a = await gateway.enroll(
      enrollRequest((await (await revealedToken(good)).reveal()).token, goodKeys),
    )
    const b = await gateway.enroll(
      enrollRequest((await (await revealedToken(bad)).reveal()).token, badKeys, 'A'.repeat(43)),
    )
    const presented = (e: { nodeId: string; certificateChain: string[] }): Presented => ({
      nodeId: e.nodeId,
      certificate: Buffer.from(e.certificateChain[0] ?? '', 'base64url'),
    })
    // Pending binding: hello yes, jobs no.
    expect((await hello(presented(a))).protocolMajor).toBe(1)
    expect(await refused(gateway.claim(presented(a), { nodeId: a.nodeId, waitSeconds: 0 }))).toBe(
      'NODE_CERTIFICATE_REFUSED',
    )
    const report = await bindPendingNodes(worker, keyring, clock, db.installationId)
    expect(report.bound).toBeGreaterThanOrEqual(1)
    expect(report.failed).toBeGreaterThanOrEqual(1)
    const states = await db.asSuperuser((c) =>
      c.query('SELECT node_id, state FROM nodes.nodes WHERE node_id = ANY($1)', [
        [a.nodeId, b.nodeId],
      ]),
    )
    expect(Object.fromEntries(states.rows.map((r) => [r.node_id, r.state]))).toEqual({
      [a.nodeId]: 'active',
      [b.nodeId]: 'binding_failed',
    })
    expect(await refused(hello(presented(b)))).toBe('NODE_CERTIFICATE_REFUSED')
    const audit = await db.asSuperuser((c) =>
      c.query(
        `SELECT action FROM audit.audit_events WHERE event::jsonb->'subject'->>'nodeId' = ANY($1) ORDER BY seq`,
        [[a.nodeId, b.nodeId]],
      ),
    )
    expect(audit.rows.map((r) => r.action)).toEqual(
      expect.arrayContaining(['node.enrolled', 'node.bound', 'node.binding_failed']),
    )
  })

  it('signs and seals a job, moves it through the gateway, and judges the completion', async () => {
    const srv = await server()
    const keys = agentKeys()
    const e = await gateway.enroll(
      enrollRequest((await (await revealedToken(srv)).reveal()).token, keys),
    )
    await bindPendingNodes(worker, keyring, clock, db.installationId)
    const presented: Presented = {
      nodeId: e.nodeId,
      certificate: Buffer.from(e.certificateChain[0] ?? '', 'base64url'),
    }
    const operationId = await operation()
    // A sealed verifier: only the node's encryption key opens it.
    const verifier = new TextEncoder().encode(
      `SCRAM-SHA-256$4096:${'A'.repeat(24)}$${'B'.repeat(44)}:${'C'.repeat(44)}`,
    )
    const created = await worker.transaction('test.job', (tx) =>
      createJob(tx, keyring, clock, db.installationId, {
        nodeId: e.nodeId,
        operationId,
        capability: 'postgres.roles.apply@1',
        args: (seal) => ({
          cluster: { localName: '17/main', systemIdentifier: '7291234567890123456' },
          expectedRolesDigest: `sha256:${'9'.repeat(64)}`,
          steps: [
            {
              op: 'set_password',
              role: 'app_user',
              attributes: null,
              verifier: seal('verifier', verifier),
              member: null,
              admin: null,
              inherit: null,
              set: null,
              database: null,
              setting: null,
              value: null,
            },
          ],
        }),
      }),
    )
    const claimed = await gateway.claim(presented, { nodeId: e.nodeId, waitSeconds: 1 })
    const envelope = claimed.job as unknown as JsonObject
    expect(envelope['jobId']).toBe(created.jobId)
    const trusted = e.jobKeys.map((k) => ({
      keyId: k.keyId,
      publicKey: new Uint8Array(Buffer.from(k.publicKey, 'base64url')),
    }))
    expect(verifyJobEnvelope(envelope, trusted).ok).toBe(true)
    const args = envelope['args'] as { steps: { verifier: unknown }[] }
    const sealed = parseNs1((args.steps[0]?.verifier ?? null) as never)
    if (sealed === undefined) {
      throw new Error('not sealed')
    }
    const opened = openNs1(
      keys.nek,
      {
        installationId: db.installationId,
        nodeId: e.nodeId,
        jobId: created.jobId,
        operationId,
        capability: { name: 'postgres.roles.apply', major: 1 },
        field: 'verifier',
      },
      sealed,
    )
    expect(opened && new TextDecoder().decode(opened)).toBe(new TextDecoder().decode(verifier))
    expect(JSON.stringify(envelope)).not.toContain('SCRAM-SHA-256')
    // One job at a time.
    expect((await gateway.claim(presented, { nodeId: e.nodeId, waitSeconds: 0 })).job).toBeNull()

    const now = () => new Date().toISOString()
    await gateway.start(presented, created.jobId, {
      jobId: created.jobId,
      nodeId: e.nodeId,
      startedAt: now(),
    })
    const progress = await gateway.progress(presented, created.jobId, {
      jobId: created.jobId,
      nodeId: e.nodeId,
      sentAt: now(),
      steps: [],
    })
    expect(progress.cancelRequested).toBe(false)
    const unsigned = {
      jobId: created.jobId,
      nodeId: e.nodeId,
      finishedAt: now(),
      outcome: 'succeeded' as const,
      rejectionReason: null,
      result: { applied: 1 },
      steps: [],
      outputExcerpt: null,
    }
    const nodeSignature = signResult(
      keys.nsk,
      {
        installationId: db.installationId,
        nodeId: e.nodeId,
        jobId: created.jobId,
        argsHash: String(envelope['argsHash']),
      },
      unsigned,
    )
    const complete = {
      ...unsigned,
      nodeSignature: { alg: 'Ed25519' as const, value: nodeSignature },
    }
    expect(await gateway.complete(presented, created.jobId, complete)).toEqual({
      accepted: true,
      duplicate: false,
    })
    expect(await gateway.complete(presented, created.jobId, complete)).toEqual({
      accepted: false,
      duplicate: true,
    })

    // A second job whose completion the gateway altered: the verdict is false.
    const second = await worker.transaction('test.job', (tx) =>
      createJob(tx, keyring, clock, db.installationId, {
        nodeId: e.nodeId,
        operationId,
        capability: 'agent.diagnostics@1',
        args: () => ({}),
      }),
    )
    await gateway.claim(presented, { nodeId: e.nodeId, waitSeconds: 0 })
    await gateway.start(presented, second.jobId, {
      jobId: second.jobId,
      nodeId: e.nodeId,
      startedAt: now(),
    })
    await gateway.complete(
      presented,
      second.jobId,
      JobCompleteRequestSchema.parse({ ...complete, jobId: second.jobId, outcome: 'failed' }),
    )
    expect(await judgeCompletions(worker, db.installationId)).toBeGreaterThanOrEqual(2)
    const verdicts = await db.asSuperuser((c) =>
      c.query('SELECT job_id, node_signature_valid FROM nodes.jobs WHERE job_id = ANY($1)', [
        [created.jobId, second.jobId],
      ]),
    )
    expect(
      Object.fromEntries(verdicts.rows.map((r) => [r.job_id, r.node_signature_valid])),
    ).toEqual({
      [created.jobId]: true,
      [second.jobId]: false,
    })
    expect(jobEvidence({ outcome: 'succeeded', rejectionReason: null }, true)).toBe('ran')
    expect(jobEvidence({ outcome: 'rejected', rejectionReason: 'signature_invalid' }, true)).toBe(
      'unproven',
    )
    expect(jobEvidence({ outcome: 'rejected', rejectionReason: 'expired' }, true)).toBe(
      'did_not_run',
    )
    expect(jobEvidence({ outcome: 'succeeded', rejectionReason: null }, false)).toBe('unproven')
  })

  it('renews over the current certificate, keeps the old one until the new one is used, and refuses a revoked node', async () => {
    const srv = await server()
    const keys = agentKeys()
    const e = await gateway.enroll(
      enrollRequest((await (await revealedToken(srv)).reveal()).token, keys),
    )
    await bindPendingNodes(worker, keyring, clock, db.installationId)
    const old: Presented = {
      nodeId: e.nodeId,
      certificate: Buffer.from(e.certificateChain[0] ?? '', 'base64url'),
    }
    const tls = new Uint8Array(randomBytes(32))
    const tlsKey = b64u(rawPublicKey(ed25519PrivateKey(tls)))
    const renewal = {
      nodeId: e.nodeId,
      tlsKey,
      tlsKeyProof: signCanonical(tls, renewTlsKeyProofValue(e.nodeId, tlsKey)),
      nodeSignature: signCanonical(keys.nsk, renewSignatureValue(e.nodeId, tlsKey)),
    }
    expect(
      await refused(gateway.renew(old, { ...renewal, nodeSignature: renewal.tlsKeyProof })),
    ).toBe('NODE_PROOF_INVALID')
    const renewed = await gateway.renew(old, renewal)
    const next: Presented = {
      nodeId: e.nodeId,
      certificate: Buffer.from(renewed.certificateChain[0] ?? '', 'base64url'),
    }
    expect((await hello(old)).protocolMajor).toBe(1)
    expect((await hello(next)).protocolMajor).toBe(1)
    expect(await refused(hello(old))).toBe('NODE_CERTIFICATE_REFUSED')

    const revoke = await operation()
    await worker.query(
      'test.revoke',
      `UPDATE nodes.nodes SET state = 'revoked', state_changed_by_operation_id = $2, state_reason = 'test' WHERE node_id = $1`,
      [e.nodeId, revoke],
    )
    expect(await refused(hello(next))).toBe('NODE_CERTIFICATE_REFUSED')
    expect(
      await refused(
        gateway.heartbeat(next, {
          nodeId: e.nodeId,
          sentAt: new Date().toISOString(),
          host: { cpuPercent: 1, memoryUsedBytes: 1, load1: 0, load5: 0, load15: 0, mounts: [] },
          clusters: [],
          nodeCertificateExpiresAt: renewed.certificateExpiresAt,
          clockSkewMs: 0,
          inFlightJobs: [],
          agent: { queueSize: 0, bufferedResults: 0, lastErrors: [] },
        }),
      ),
    ).toBe('NODE_CERTIFICATE_REFUSED')
  })
})
