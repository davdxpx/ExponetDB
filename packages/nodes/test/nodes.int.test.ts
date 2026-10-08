import { createPrivateKey, createPublicKey, randomBytes, X509Certificate } from 'node:crypto'
import {
  EnrollRequestSchema,
  HelloRequestSchema,
  JobCompleteRequestSchema,
  JobStartRequestSchema,
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
  activateJobKey,
  awaitJob,
  bindPendingNodes,
  createEnrollmentToken,
  createJob,
  type GatewayPki,
  initPki,
  jobEvidence,
  judgeCompletions,
  listJobKeys,
  loadGatewayPki,
  mintGatewayIdentity,
  NodeError,
  type Presented,
  retireJobKey,
  revealEnrollmentToken,
  settleJob,
  stageJobKey,
  startJob,
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

  it('bounds the gateway: no completion before binding, one undecidable binding holds up no other, one long poll per node, no U+0000', async () => {
    const presentedOf = (e: { nodeId: string; certificateChain: string[] }): Presented => ({
      nodeId: e.nodeId,
      certificate: Buffer.from(e.certificateChain[0] ?? '', 'base64url'),
    })
    const stuck = await gateway.enroll(
      enrollRequest((await (await revealedToken(await server())).reveal()).token, agentKeys()),
    )
    const keys = agentKeys()
    const e = await gateway.enroll(
      enrollRequest((await (await revealedToken(await server())).reveal()).token, keys),
    )
    // A node pending binding completes nothing.
    expect(
      await refused(
        gateway.complete(presentedOf(e), 'job_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z', {
          jobId: 'job_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z',
          nodeId: e.nodeId,
          finishedAt: new Date().toISOString(),
          outcome: 'failed',
          rejectionReason: null,
          result: null,
          steps: [],
          outputExcerpt: null,
          nodeSignature: { alg: 'Ed25519', value: 'A'.repeat(86) },
        } as never),
      ),
    ).toBe('NODE_CERTIFICATE_REFUSED')
    // The first pending node's bind key cannot be opened (as in a keyring
    // rotation out of step): it stays pending, the next one is bound.
    await db.asSuperuser(async (c) => {
      await c.query('SET session_replication_role = replica')
      await c.query(
        `UPDATE nodes.enrollment_tokens SET bind_secret_id = 'sec_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z'
          WHERE token_id = (SELECT token_id FROM nodes.nodes WHERE node_id = $1)`,
        [stuck.nodeId],
      )
      await c.query('SET session_replication_role = origin')
    })
    const report = await bindPendingNodes(worker, keyring, clock, db.installationId)
    expect(report.undecided).toBeGreaterThanOrEqual(1)
    const states = await db.asSuperuser((c) =>
      c.query('SELECT node_id, state FROM nodes.nodes WHERE node_id = ANY($1)', [
        [stuck.nodeId, e.nodeId],
      ]),
    )
    expect(Object.fromEntries(states.rows.map((r) => [r.node_id, r.state]))).toEqual({
      [stuck.nodeId]: 'pending_binding',
      [e.nodeId]: 'active',
    })
    const bound = await db.asSuperuser((c) =>
      c.query(
        `SELECT event::jsonb->'changes'->>'tokenId' AS token FROM audit.audit_events
          WHERE action = 'node.bound' AND event::jsonb->'subject'->>'nodeId' = $1`,
        [e.nodeId],
      ),
    )
    expect(bound.rows[0]?.token).toMatch(/^ent_/)

    // One long poll per node.
    const presented = presentedOf(e)
    const first = gateway.claim(presented, { nodeId: e.nodeId, waitSeconds: 2 })
    expect(await refused(gateway.claim(presented, { nodeId: e.nodeId, waitSeconds: 0 }))).toBe(
      'RATE_LIMITED',
    )
    expect((await first).job).toBeNull()
    expect((await gateway.claim(presented, { nodeId: e.nodeId, waitSeconds: 0 })).job).toBeNull()

    // U+0000, which jsonb cannot store, is refused and not retried.
    const job = await worker.transaction('test.job', async (tx) =>
      createJob(tx, keyring, clock, db.installationId, {
        nodeId: e.nodeId,
        operationId: await operation(),
        capability: 'agent.diagnostics@2',
        args: () => ({}),
      }),
    )
    await gateway.claim(presented, { nodeId: e.nodeId, waitSeconds: 1 })
    await gateway.start(presented, job.jobId, {
      jobId: job.jobId,
      nodeId: e.nodeId,
      startedAt: new Date().toISOString(),
    })
    const withNul = {
      jobId: job.jobId,
      nodeId: e.nodeId,
      finishedAt: new Date().toISOString(),
      outcome: 'failed' as const,
      rejectionReason: null,
      result: null,
      steps: [],
      outputExcerpt: 'host said \u0000',
      nodeSignature: { alg: 'Ed25519' as const, value: 'A'.repeat(86) },
    }
    expect(await refused(gateway.complete(presented, job.jobId, withNul as never))).toBe(
      'VALIDATION_FAILED',
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
        capability: 'postgres.roles.apply@2',
        args: (seal) => ({
          cluster: { localName: '17/main', systemIdentifier: '7291234567890123456' },
          expectedRolesDigest: `kd1:${'9'.repeat(64)}`,
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
        capability: { name: 'postgres.roles.apply', major: 2 },
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
        capability: 'agent.diagnostics@2',
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

  it('takes a job state the gateway wrote as proof only before the hand-out, and settles a job before its host is judged', async () => {
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
    const deps = { store: worker, keyring, clock, installationId: db.installationId, pollMs: 20 }
    const operationId = await operation()
    const job = (
      capability: 'agent.diagnostics@2' | 'config.update@1' = 'agent.diagnostics@2',
      windowSeconds = 900,
    ) =>
      startJob(deps, {
        nodeId: e.nodeId,
        operationId,
        capability,
        windowSeconds,
        args: () =>
          capability === 'agent.diagnostics@2'
            ? {}
            : { gateway: null, addJobKeys: [], retireJobKeys: [] },
      })
    // A job's window never changes: a short one runs out.
    const expire = () => new Promise((r) => setTimeout(r, 1100))
    const live = new AbortController().signal

    // Never handed out and expired: it did not run.
    const quiet = (await job()) ?? ''
    await worker.query(
      'test.cancel_others',
      `UPDATE nodes.jobs SET state = 'canceled' WHERE job_id = $1`,
      [quiet],
    )
    const pending = (await job('agent.diagnostics@2', 1)) ?? ''
    await expire()
    expect(await awaitJob(deps, pending, 'agent.diagnostics@2', live)).toMatchObject({
      end: 'expired',
    })

    // Handed out, then expired without a statement: nothing is proven.
    const handed = (await job('agent.diagnostics@2', 1)) ?? ''
    expect(
      (await gateway.claim(presented, { nodeId: e.nodeId, waitSeconds: 0 })).job,
    ).not.toBeNull()
    await expire()
    expect(await awaitJob(deps, handed, 'agent.diagnostics@2', live)).toMatchObject({
      end: 'unproven',
      why: 'handed_out',
    })
    // A node statement that arrives late is judged over the job's state.
    const unsigned = {
      jobId: handed,
      nodeId: e.nodeId,
      finishedAt: new Date().toISOString(),
      outcome: 'succeeded' as const,
      rejectionReason: null,
      result: {
        agentVersion: '1.0.0',
        journal: { entries: 0, bytes: 0, oldestAt: null },
        nonceCache: { entries: 0, bytes: 0 },
        bufferedResults: 0,
        lastErrors: [],
        jobKeys: ['jobkey_2026_10_test01'],
        helperJobKeys: ['jobkey_2026_10_test01'],
        gatewayUrl: 'https://10.8.2.2:7443',
      },
      steps: [],
      outputExcerpt: null,
    }
    const argsHash = (
      await db.asSuperuser((c) =>
        c.query('SELECT args_hash FROM nodes.jobs WHERE job_id = $1', [handed]),
      )
    ).rows[0].args_hash as string
    const late = {
      ...unsigned,
      nodeSignature: {
        alg: 'Ed25519' as const,
        value: signResult(
          keys.nsk,
          { installationId: db.installationId, nodeId: e.nodeId, jobId: handed, argsHash },
          unsigned,
        ),
      },
    }
    expect(await gateway.complete(presented, handed, JobCompleteRequestSchema.parse(late))).toEqual(
      {
        accepted: true,
        duplicate: false,
      },
    )
    expect(await awaitJob(deps, handed, 'agent.diagnostics@2', live)).toMatchObject({
      end: 'succeeded',
    })

    // Settling cancels a job nobody has claimed.
    const unclaimed = (await job()) ?? ''
    expect(await settleJob(deps, unclaimed, 'agent.diagnostics@2', live)).toMatchObject({
      end: 'canceled',
    })
    // A job whose node went silent: settled only after its run limit and settle time.
    const silent = (await job('config.update@1')) ?? ''
    await gateway.claim(presented, { nodeId: e.nodeId, waitSeconds: 0 })
    await gateway.start(
      presented,
      silent,
      JobStartRequestSchema.parse({
        jobId: silent,
        nodeId: e.nodeId,
        startedAt: new Date().toISOString(),
      }),
    )
    await db.asSuperuser((c) =>
      c.query(
        `UPDATE nodes.jobs SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE job_id = $1`,
        [silent],
      ),
    )
    const waiting = new AbortController()
    const settling = settleJob(deps, silent, 'config.update@1', waiting.signal)
    await new Promise((r) => setTimeout(r, 1500))
    const state = await db.asSuperuser((c) =>
      c.query('SELECT state, cancel_requested FROM nodes.jobs WHERE job_id = $1', [silent]),
    )
    expect(state.rows[0]).toMatchObject({ state: 'outcome_unknown', cancel_requested: true })
    waiting.abort()
    expect(await settling).toMatchObject({ end: 'unproven', why: 'lease_lost' })
    await db.asSuperuser((c) =>
      c.query(
        `UPDATE nodes.jobs SET started_at = started_at - interval '10 minutes',
                state_changed_at = state_changed_at - interval '10 minutes' WHERE job_id = $1`,
        [silent],
      ),
    )
    expect(await settleJob(deps, silent, 'config.update@1', live)).toMatchObject({
      end: 'unproven',
      why: 'outcome_unknown',
    })

    // An executor that lost the operation's lease creates no job.
    await db.asSuperuser((c) =>
      c.query(
        `UPDATE operations.operations SET lease_owner = $2, lease_expires_at = clock_timestamp() + interval '1 minute'
          WHERE operation_id = $1`,
        [operationId, newId('prc', Date.now())],
      ),
    )
    expect(
      await startJob(
        deps,
        { nodeId: e.nodeId, operationId, capability: 'agent.diagnostics@2', args: () => ({}) },
        newId('prc', Date.now() + 1),
      ),
    ).toBeUndefined()
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

  it('redeems a token once under concurrency, enrolls one node per server, and refuses an expired token at redemption', async () => {
    const outcome = async (p: Promise<unknown>) => {
      try {
        await p
        return 'enrolled'
      } catch (error) {
        return error instanceof NodeError ? error.code : String(error)
      }
    }
    // One token, two hosts at once: one enrollment, the other refused.
    const one = (await (await revealedToken(await server())).reveal()).token
    const raced = await Promise.all([
      outcome(gateway.enroll(enrollRequest(one, agentKeys()))),
      outcome(gateway.enroll(enrollRequest(one, agentKeys()))),
    ])
    expect(raced.sort()).toEqual(['NODE_ENROLLMENT_REFUSED', 'enrolled'])
    // Two tokens of one server at once: one live node (I-6).
    const shared = await server()
    const first = (await (await revealedToken(shared)).reveal()).token
    const second = (await (await revealedToken(shared)).reveal()).token
    const both = await Promise.all([
      outcome(gateway.enroll(enrollRequest(first, agentKeys()))),
      outcome(gateway.enroll(enrollRequest(second, agentKeys()))),
    ])
    expect(both.sort()).toEqual(['NODE_ALREADY_ENROLLED', 'enrolled'])
    const live = await db.asSuperuser((c) =>
      c.query(
        `SELECT count(*)::int AS n FROM nodes.nodes
          WHERE server_id = $1 AND state IN ('pending_binding', 'active', 'degraded')`,
        [shared],
      ),
    )
    expect(live.rows[0]?.n).toBe(1)
    // A token past its expiry is refused by the Control Plane itself, whatever the agent checked.
    const late = await revealedToken(await server())
    const token = (await late.reveal()).token
    await db.asSuperuser(async (c) => {
      await c.query('BEGIN')
      await c.query('SET LOCAL session_replication_role = replica')
      await c.query(
        `UPDATE nodes.enrollment_tokens SET expires_at = clock_timestamp() - interval '1 second' WHERE token_id = $1`,
        [late.tokenId],
      )
      await c.query('COMMIT')
    })
    expect(await outcome(gateway.enroll(enrollRequest(token, agentKeys())))).toBe(
      'NODE_ENROLLMENT_REFUSED',
    )
  })

  it('rotates job keys: anchored while staged, signing switches once every live node trusts the new key, retired once none trusts the old', async () => {
    // The rotation concerns every live node and open token: other tests' leave first.
    const cleanup = await operation()
    await db.asSuperuser(async (c) => {
      await c.query(
        `UPDATE nodes.nodes SET state = 'revoked', state_changed_by_operation_id = $1, state_reason = 'test'
          WHERE state IN ('pending_binding', 'active', 'degraded')`,
        [cleanup],
      )
      await c.query(
        `UPDATE nodes.enrollment_tokens SET state = 'expired' WHERE state IN ('created', 'issued')`,
      )
    })
    const reason = async (p: Promise<unknown>): Promise<string> => {
      try {
        await p
        return 'resolved'
      } catch (error) {
        if (error instanceof NodeError) {
          const r = error.details?.['reason']
          return typeof r === 'string' ? r : error.code
        }
        return String(error)
      }
    }
    const trusted = async (nodeId: string): Promise<string[]> =>
      (
        await db.asSuperuser((c) =>
          c.query('SELECT trusted_job_keys FROM nodes.nodes WHERE node_id = $1', [nodeId]),
        )
      ).rows[0]?.trusted_job_keys
    const old = (await listJobKeys(worker)).find((k) => k.state === 'active')
    if (old === undefined) {
      throw new Error('no active key')
    }
    // A node enrolled before the rotation trusts the active key only.
    const first = await gateway.enroll(
      enrollRequest((await (await revealedToken(await server())).reveal()).token, agentKeys()),
    )
    await bindPendingNodes(worker, keyring, clock, db.installationId)
    expect(await trusted(first.nodeId)).toEqual([old.keyId])

    expect(await reason(worker.transaction('t.activate', (tx) => activateJobKey(tx, clock)))).toBe(
      'job_key_not_staged',
    )
    const staged = await worker.transaction('t.stage', (tx) => stageJobKey(tx, keyring, clock))
    expect(staged.state).toBe('staged')
    expect(
      await reason(worker.transaction('t.stage', (tx) => stageJobKey(tx, keyring, clock))),
    ).toBe('job_key_already_staged')
    // A key starts staged; only the first key of an installation starts active.
    await expect(
      worker.query(
        't.insert',
        `INSERT INTO nodes.job_keys (key_id, public_key, fingerprint, secret_id, state)
         SELECT 'jobkey_forged', public_key, fingerprint, secret_id, 'active' FROM nodes.job_keys LIMIT 1`,
      ),
    ).rejects.toThrow()

    // A token made during the rotation anchors both keys.
    const second = await gateway.enroll(
      enrollRequest((await (await revealedToken(await server())).reveal()).token, agentKeys()),
    )
    expect(second.jobKeys.map((k) => k.keyId).sort()).toEqual([old.keyId, staged.keyId].sort())
    await bindPendingNodes(worker, keyring, clock, db.installationId)
    expect((await trusted(second.nodeId)).sort()).toEqual([old.keyId, staged.keyId].sort())
    // A token revealed now and not yet redeemed anchors both keys too.
    const open = await revealedToken(await server())
    await open.reveal()

    // The staged key signs the probe that verifies a node.config.update.
    const stagedPublic = second.jobKeys.find((k) => k.keyId === staged.keyId)?.publicKey ?? ''
    const probe = await worker.transaction('t.probe', async (tx) =>
      createJob(tx, keyring, clock, db.installationId, {
        nodeId: second.nodeId,
        operationId: await operation(),
        capability: 'agent.diagnostics@2',
        args: () => ({}),
        signingKeyId: staged.keyId,
      }),
    )
    expect(
      verifyJobEnvelope(probe.envelope, [
        { keyId: staged.keyId, publicKey: new Uint8Array(Buffer.from(stagedPublic, 'base64url')) },
      ]),
    ).toEqual({ ok: true, keyId: staged.keyId })

    // Signing switches only when every live node trusts the new key; the
    // guard refuses the same to any writer.
    expect(await reason(worker.transaction('t.activate', (tx) => activateJobKey(tx, clock)))).toBe(
      'job_key_not_trusted',
    )
    await expect(
      worker.transaction('t.activate_raw', async (tx) => {
        await tx.query('t.a', `UPDATE nodes.job_keys SET state = 'retiring' WHERE state = 'active'`)
        await tx.query('t.b', `UPDATE nodes.job_keys SET state = 'active' WHERE state = 'staged'`)
      }),
    ).rejects.toThrow()
    // A node trusts only distinct keys that exist and are not retired.
    await expect(
      worker.query(
        't.unknown',
        `UPDATE nodes.nodes SET trusted_job_keys = '["jobkey_unknown"]' WHERE node_id = $1`,
        [first.nodeId],
      ),
    ).rejects.toThrow()
    await expect(
      worker.query(
        't.duplicate',
        'UPDATE nodes.nodes SET trusted_job_keys = $2::jsonb WHERE node_id = $1',
        [first.nodeId, JSON.stringify([old.keyId, old.keyId])],
      ),
    ).rejects.toThrow()
    // What a verified node.config.update records: the node's statement.
    await worker.query(
      't.trust',
      'UPDATE nodes.nodes SET trusted_job_keys = $2::jsonb WHERE node_id = $1',
      [first.nodeId, JSON.stringify([old.keyId, staged.keyId])],
    )
    expect(await worker.transaction('t.activate', (tx) => activateJobKey(tx, clock))).toEqual({
      keyId: staged.keyId,
      retiringKeyId: old.keyId,
    })
    const job = await worker.transaction('t.job', async (tx) =>
      createJob(tx, keyring, clock, db.installationId, {
        nodeId: first.nodeId,
        operationId: await operation(),
        capability: 'agent.diagnostics@2',
        args: () => ({}),
      }),
    )
    expect((job.envelope['signature'] as { keyId: string }).keyId).toBe(staged.keyId)
    // A retiring key never signs again.
    expect(
      await refused(
        worker.transaction('t.old', async (tx) =>
          createJob(tx, keyring, clock, db.installationId, {
            nodeId: first.nodeId,
            operationId: await operation(),
            capability: 'agent.diagnostics@2',
            args: () => ({}),
            signingKeyId: old.keyId,
          }),
        ),
      ),
    ).toBe('PRECONDITION_FAILED')

    // Retired only once no live node trusts it.
    expect(
      await reason(worker.transaction('t.retire', (tx) => retireJobKey(tx, clock, old.keyId))),
    ).toBe('job_key_still_trusted')
    for (const n of [first, second]) {
      await worker.query(
        't.trust',
        'UPDATE nodes.nodes SET trusted_job_keys = $2::jsonb WHERE node_id = $1',
        [n.nodeId, JSON.stringify([staged.keyId])],
      )
    }
    expect(
      await reason(worker.transaction('t.retire', (tx) => retireJobKey(tx, clock, staged.keyId))),
    ).toBe('job_key_not_retiring')
    // Still anchored by a token that can be redeemed: a new node would trust it.
    expect(
      await reason(worker.transaction('t.retire', (tx) => retireJobKey(tx, clock, old.keyId))),
    ).toBe('job_key_still_trusted')
    await expect(
      worker.query(
        't.retire_raw',
        `UPDATE nodes.job_keys SET state = 'retired' WHERE key_id = $1`,
        [old.keyId],
      ),
    ).rejects.toThrow()
    await worker.query(
      't.expire',
      `UPDATE nodes.enrollment_tokens SET state = 'expired' WHERE token_id = $1`,
      [open.tokenId],
    )
    await worker.transaction('t.retire', (tx) => retireJobKey(tx, clock, old.keyId))
    const states = Object.fromEntries((await listJobKeys(worker)).map((k) => [k.keyId, k.state]))
    expect(states).toMatchObject({ [old.keyId]: 'retired', [staged.keyId]: 'active' })
    const audit = await db.asSuperuser((c) =>
      c.query(`SELECT action FROM audit.audit_events WHERE action LIKE 'node_pki.job_key_%'`),
    )
    expect(audit.rows.map((r) => r.action)).toEqual(
      expect.arrayContaining([
        'node_pki.job_key_staged',
        'node_pki.job_key_activated',
        'node_pki.job_key_retired',
      ]),
    )
  })
})
