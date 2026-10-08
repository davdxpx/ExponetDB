import { randomBytes } from 'node:crypto'
import { appendAuditEvent } from '@exponetdb/audit'
import {
  type ClaimRequest,
  type ClaimResponse,
  type EnrollRequest,
  type EnrollResponse,
  type ErrorCode,
  type HeartbeatRequest,
  type HeartbeatResponse,
  type HelloRequest,
  type HelloResponse,
  isNodeCapabilityKey,
  isRetiredNodeCapabilityKey,
  type JobCompleteRequest,
  type JobCompleteResponse,
  type JobEnvelope,
  JobEnvelopeSchema,
  type JobProgressRequest,
  type JobProgressResponse,
  type JobStartRequest,
  type JobStartResponse,
  NODE_PROTOCOL_LIMITS,
  NODE_PROTOCOL_MAJOR,
  type RenewRequest,
  type RenewResponse,
} from '@exponetdb/contracts'
import type { ControlStore, Tx } from '@exponetdb/control-store'
import { type Clock, type InstallationId, isId, type JsonValue, newId } from '@exponetdb/kernel'
import {
  b64u,
  fromB64uOf,
  keyFingerprint,
  nodeSigningKeyProofValue,
  redeemHash,
  renewSignatureValue,
  renewTlsKeyProofValue,
  sameFingerprint,
  tlsKeyProofValue,
  verifyCanonical,
} from '@exponetdb/kernel/node'
import { subjectOf } from './binding.ts'
import { NodeError, refusalOf } from './errors.ts'
import type { GatewayPki } from './pki.ts'
import { issueCertificate } from './x509/certificate.ts'

/**
 * The agent API as the gateway serves it ([control-plane.md §5](../../../exponetdb-docs/07-node-agent/control-plane.md#5-gateway),
 * [protocol.md](../../../exponetdb-docs/07-node-agent/protocol.md)). The
 * transport (HTTP/2, TLS 1.3, the client certificate) and the message
 * schemas are the caller's; this service checks proofs, issues node
 * certificates and moves node and job state only through the nodes schema's
 * functions, which check the presented certificate and every transition
 * again. It never signs a job and never judges a result.
 */

const HOUR = 3_600_000
const CLAIM_POLL_MS = 1_000

export interface AgentGatewayDeps {
  /** The gateway's Control Store login. */
  readonly store: ControlStore
  readonly pki: GatewayPki
  readonly clock: Clock
  readonly installationId: InstallationId
  /** Waits between claim polls; tests shorten it. */
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

/** The presented client certificate: the DER of the leaf, as TLS verified it. */
export interface Presented {
  readonly nodeId: string
  readonly certificate: Uint8Array
}

const sleepFor = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t)
        resolve()
      },
      { once: true },
    )
  })

function proof(
  value: string | undefined,
  key: Uint8Array,
  signed: Parameters<typeof verifyCanonical>[1],
) {
  if (value === undefined || !verifyCanonical(key, signed, value)) {
    throw new NodeError('NODE_PROOF_INVALID')
  }
}

function publicKey(text: string): Uint8Array {
  const raw = fromB64uOf(text, 32)
  if (raw === undefined) {
    throw new NodeError('NODE_PROOF_INVALID')
  }
  return raw
}

export class AgentGateway {
  readonly #d: AgentGatewayDeps
  /** Nodes with a long poll open on this gateway. */
  readonly #claiming = new Set<string>()
  readonly #sleep: (ms: number, signal?: AbortSignal) => Promise<void>

  constructor(deps: AgentGatewayDeps) {
    this.#d = deps
    this.#sleep = deps.sleep ?? sleepFor
  }

  #now(): Date {
    return new Date(this.#d.clock.nowMs())
  }

  /** A node certificate: CN the node id, its one URI, `clientAuth`, 72 hours. */
  #nodeCertificate(nodeId: string, tlsKey: Uint8Array): { der: Uint8Array; expiresAt: Date } {
    const notBefore = new Date(this.#d.clock.nowMs() - 5 * 60_000)
    const notAfter = new Date(notBefore.getTime() + NODE_PROTOCOL_LIMITS.certificateHours * HOUR)
    const der = issueCertificate(
      {
        profile: 'node',
        serial: new Uint8Array(randomBytes(16)),
        commonName: nodeId,
        publicKey: { algorithm: 'ed25519', raw: tlsKey },
        notBefore,
        notAfter,
        uri: `urn:exponet:exponetdb:node:${this.#d.installationId}:${nodeId}`,
      },
      this.#d.pki.issuing,
    )
    return { der, expiresAt: notAfter }
  }

  #chain(der: Uint8Array): string[] {
    return [b64u(der), b64u(this.#d.pki.issuingCaCertificate)]
  }

  async #run<T>(
    queryClass: string,
    fn: (tx: Tx) => Promise<T>,
    overrides?: Readonly<Record<string, ErrorCode>>,
  ): Promise<T> {
    try {
      return await this.#d.store.transaction(queryClass, fn)
    } catch (error) {
      throw refusalOf(error, overrides) ?? error
    }
  }

  async #audit(tx: Tx, action: string, nodeId: string, serverId: string): Promise<void> {
    await appendAuditEvent(
      tx,
      {
        action,
        phase: 'completed',
        actor: { kind: 'system', identityId: null, label: 'system:gateway' },
        subject: subjectOf(nodeId, serverId),
        result: { status: 'succeeded' },
      },
      { clock: this.#d.clock },
    )
  }

  /**
   * Enrollment (no client certificate): the proofs of possession first, so a
   * request whose proofs fail never consumes the token; then the token and
   * I-6 in the schema; then the certificate. The bind proof is stored for
   * the worker, which alone can check it.
   */
  async enroll(req: EnrollRequest): Promise<EnrollResponse> {
    if (!req.protocolMajors.includes(NODE_PROTOCOL_MAJOR)) {
      throw new NodeError('NODE_PROTOCOL_UNSUPPORTED')
    }
    const tlsKey = publicKey(req.tlsKey)
    const nodeSigningKey = publicKey(req.nodeSigningKey)
    const nodeEncryptionKey = publicKey(req.nodeEncryptionKey)
    proof(req.tlsKeyProof, tlsKey, tlsKeyProofValue(req.tokenId, req.tlsKey))
    proof(
      req.nodeSigningKeyProof,
      nodeSigningKey,
      nodeSigningKeyProofValue(req.tokenId, req.nodeSigningKey),
    )
    const redeemKey = fromB64uOf(req.redeemKey, 32)
    if (redeemKey === undefined) {
      throw new NodeError('NODE_ENROLLMENT_REFUSED')
    }
    const nodeId = newId('nod', this.#d.clock.nowMs())
    const cert = this.#nodeCertificate(nodeId, tlsKey)
    return this.#run(
      'nodes.gateway.enroll',
      async (tx) => {
        const enrolled = await tx.query(
          'nodes.gateway.enroll',
          `SELECT server_id, job_keys FROM nodes.enroll($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            nodeId,
            req.tokenId,
            redeemHash(redeemKey),
            Buffer.from(tlsKey),
            Buffer.from(nodeSigningKey),
            Buffer.from(nodeEncryptionKey),
            req.bindProof,
            Buffer.from(cert.der),
            cert.expiresAt,
            JSON.stringify(req.host),
            req.agentVersion,
          ],
        )
        const row = enrolled.rows[0]
        if (row === undefined) {
          throw new NodeError('NODE_ENROLLMENT_REFUSED')
        }
        const serverId = row.text('server_id')
        if (!isId('srv', serverId)) {
          throw new NodeError('INTERNAL')
        }
        const anchors = row.json('job_keys')
        if (!Array.isArray(anchors)) {
          throw new NodeError('INTERNAL')
        }
        const keys = await tx.query(
          'nodes.gateway.job_keys',
          `SELECT key_id, public_key, fingerprint FROM nodes.job_keys WHERE key_id = ANY($1::text[])`,
          [anchors.map((a: { keyId?: unknown }) => String(a.keyId))],
        )
        const jobKeys = anchors.map((a: { keyId?: unknown; fingerprint?: unknown }) => {
          const key = keys.rows.find((k) => k.text('key_id') === a.keyId)
          const pub = key?.bytes('public_key')
          // The agent checks the same against its token; refusing here keeps
          // a damaged record from enrolling a node that would abort anyway.
          if (
            pub === undefined ||
            typeof a.fingerprint !== 'string' ||
            !sameFingerprint(keyFingerprint(pub), a.fingerprint)
          ) {
            throw new NodeError('INTERNAL')
          }
          return { keyId: String(a.keyId), publicKey: b64u(pub) }
        })
        await this.#audit(tx, 'node.enrolled', nodeId, serverId)
        return {
          nodeId,
          installationId: this.#d.installationId,
          serverId,
          certificateChain: this.#chain(cert.der),
          certificateExpiresAt: cert.expiresAt.toISOString(),
          jobKeys,
          serverTime: this.#now().toISOString(),
        }
        // Two tokens for one server enrolling at once: the loser meets I-6.
      },
      { '23505': 'NODE_ALREADY_ENROLLED' },
    )
  }

  #same(presented: Presented, bodyNodeId: string): void {
    if (presented.nodeId !== bodyNodeId) {
      throw new NodeError('NODE_CERTIFICATE_REFUSED')
    }
  }

  async #expiresAt(nodeId: string): Promise<Date | undefined> {
    const { rows } = await this.#d.store.query(
      'nodes.gateway.expiry',
      'SELECT certificate_expires_at FROM nodes.nodes WHERE node_id = $1',
      [nodeId],
    )
    return rows[0]?.date('certificate_expires_at')
  }

  /** Renewal is due when a third of the lifetime or less remains. */
  #renewDue(expiresAt: Date | undefined): boolean {
    return (
      expiresAt !== undefined &&
      expiresAt.getTime() - this.#d.clock.nowMs() <=
        (NODE_PROTOCOL_LIMITS.certificateHours * HOUR) / 3
    )
  }

  async hello(presented: Presented, req: HelloRequest): Promise<HelloResponse> {
    this.#same(presented, req.nodeId)
    if (!req.protocolMajors.includes(NODE_PROTOCOL_MAJOR)) {
      throw new NodeError('NODE_PROTOCOL_UNSUPPORTED')
    }
    const accepted = req.capabilities.filter((c) => isNodeCapabilityKey(`${c.name}@${c.major}`))
    await this.#run('nodes.gateway.hello', (tx) =>
      tx.query('nodes.gateway.hello', 'SELECT nodes.hello($1, $2, $3, $4, $5, $6, $7, $8)', [
        presented.nodeId,
        Buffer.from(presented.certificate),
        JSON.stringify(req.host),
        req.agentVersion,
        NODE_PROTOCOL_MAJOR,
        JSON.stringify(accepted),
        JSON.stringify(req.journal.inFlight),
        JSON.stringify(req.clusters),
      ]),
    )
    return {
      protocolMajor: NODE_PROTOCOL_MAJOR,
      serverTime: this.#now().toISOString(),
      acceptedCapabilities: accepted,
      instructions: { renewCertificate: this.#renewDue(await this.#expiresAt(presented.nodeId)) },
    }
  }

  async heartbeat(presented: Presented, req: HeartbeatRequest): Promise<HeartbeatResponse> {
    this.#same(presented, req.nodeId)
    const expiresAt = await this.#run('nodes.gateway.heartbeat', async (tx) => {
      const { rows } = await tx.query(
        'nodes.gateway.heartbeat',
        'SELECT nodes.heartbeat($1, $2, $3) AS expires_at',
        [presented.nodeId, Buffer.from(presented.certificate), JSON.stringify(req)],
      )
      return rows[0]?.date('expires_at')
    })
    return {
      serverTime: this.#now().toISOString(),
      instructions: { renewCertificate: this.#renewDue(expiresAt) },
    }
  }

  /** Long poll: at most one job, or `null` when the wait ends. */
  async claim(
    presented: Presented,
    req: ClaimRequest,
    signal?: AbortSignal,
  ): Promise<ClaimResponse> {
    this.#same(presented, req.nodeId)
    // One long poll per node: a node's further polls would only hold
    // transactions on its row and starve other nodes (Phase 3 review).
    if (this.#claiming.has(presented.nodeId)) {
      throw new NodeError('RATE_LIMITED')
    }
    this.#claiming.add(presented.nodeId)
    try {
      return await this.#claim(presented, req, signal)
    } finally {
      this.#claiming.delete(presented.nodeId)
    }
  }

  async #claim(
    presented: Presented,
    req: ClaimRequest,
    signal: AbortSignal | undefined,
  ): Promise<ClaimResponse> {
    const until = this.#d.clock.nowMs() + req.waitSeconds * 1000
    for (;;) {
      // A stream that went away gets no job dispatched into it.
      if (signal?.aborted) {
        return { job: null }
      }
      const job = await this.#run('nodes.gateway.claim', async (tx) => {
        const { rows } = await tx.query(
          'nodes.gateway.claim',
          'SELECT nodes.claim($1, $2) AS job',
          [presented.nodeId, Buffer.from(presented.certificate)],
        )
        return rows[0]?.json('job') ?? null
      })
      if (job !== null) {
        // The envelope as the worker stored and signed it, not a schema's
        // output: the agent verifies the signature over its members.
        if (!JobEnvelopeSchema.safeParse(job).success) {
          throw new NodeError('INTERNAL')
        }
        return { job: job as JobEnvelope }
      }
      if (signal?.aborted || this.#d.clock.nowMs() + CLAIM_POLL_MS > until) {
        return { job: null }
      }
      await this.#sleep(CLAIM_POLL_MS, signal)
    }
  }

  async start(
    presented: Presented,
    jobId: string,
    req: JobStartRequest,
  ): Promise<JobStartResponse> {
    this.#same(presented, req.nodeId)
    if (req.jobId !== jobId) {
      throw new NodeError('VALIDATION_FAILED')
    }
    const lease = await this.#run('nodes.gateway.start', async (tx) => {
      const { rows } = await tx.query(
        'nodes.gateway.start',
        'SELECT nodes.start($1, $2, $3) AS lease',
        [presented.nodeId, Buffer.from(presented.certificate), jobId],
      )
      return rows[0]?.date('lease')
    })
    if (lease === undefined) {
      throw new NodeError('INTERNAL')
    }
    return { leaseExpiresAt: lease.toISOString() }
  }

  async progress(
    presented: Presented,
    jobId: string,
    req: JobProgressRequest,
  ): Promise<JobProgressResponse> {
    this.#same(presented, req.nodeId)
    if (req.jobId !== jobId) {
      throw new NodeError('VALIDATION_FAILED')
    }
    const row = await this.#run('nodes.gateway.progress', async (tx) => {
      const { rows } = await tx.query(
        'nodes.gateway.progress',
        'SELECT lease_expires_at, cancel_requested FROM nodes.progress($1, $2, $3, $4)',
        [presented.nodeId, Buffer.from(presented.certificate), jobId, JSON.stringify(req.steps)],
      )
      return rows[0]
    })
    if (row === undefined) {
      throw new NodeError('INTERNAL')
    }
    return {
      leaseExpiresAt: row.date('lease_expires_at').toISOString(),
      cancelRequested: row.bool('cancel_requested'),
    }
  }

  /**
   * Stores the completion as received, signature included; the worker judges
   * it. A completion for a job that already has one is a duplicate.
   */
  async complete(
    presented: Presented,
    jobId: string,
    req: JobCompleteRequest,
    received?: JsonValue,
  ): Promise<JobCompleteResponse> {
    this.#same(presented, req.nodeId)
    if (req.jobId !== jobId) {
      throw new NodeError('VALIDATION_FAILED')
    }
    // A statement of a major the Wave 5 correction retired (F1) is never
    // stored: an agent of an earlier release can still finish a job handed
    // out before the update, and its result can carry host values it did
    // not classify. Refused for good (the agent parks it); the job proves
    // nothing and its operation is reconciled from the host.
    const capability = await this.#run('nodes.gateway.job_capability', async (tx) => {
      const { rows } = await tx.query(
        'nodes.gateway.job_capability',
        'SELECT node_admission.job_capability($1, $2, $3) AS c',
        [presented.nodeId, Buffer.from(presented.certificate), jobId],
      )
      return rows[0]?.textOrNull('c') ?? null
    })
    if (capability !== null && isRetiredNodeCapabilityKey(capability)) {
      throw new NodeError('CONFLICT')
    }
    const result = await this.#run('nodes.gateway.complete', async (tx) => {
      const { rows } = await tx.query(
        'nodes.gateway.complete',
        'SELECT nodes.complete($1, $2, $3, $4) AS r',
        [
          presented.nodeId,
          Buffer.from(presented.certificate),
          jobId,
          JSON.stringify(received ?? req),
        ],
      )
      return rows[0]?.text('r')
    })
    return {
      accepted: result === 'accepted' || result === 'late',
      duplicate: result === 'duplicate',
    }
  }

  /**
   * Renewal over the current session: the new key's proof of possession and
   * the node signing key's signature over it, then a new certificate that
   * replaces the current one.
   */
  async renew(presented: Presented, req: RenewRequest): Promise<RenewResponse> {
    this.#same(presented, req.nodeId)
    const tlsKey = publicKey(req.tlsKey)
    proof(req.tlsKeyProof, tlsKey, renewTlsKeyProofValue(req.nodeId, req.tlsKey))
    const { rows } = await this.#d.store.query(
      'nodes.gateway.signing_key',
      'SELECT node_signing_key, server_id FROM nodes.nodes WHERE node_id = $1',
      [req.nodeId],
    )
    const node = rows[0]
    if (node === undefined) {
      throw new NodeError('NODE_CERTIFICATE_REFUSED')
    }
    proof(
      req.nodeSignature,
      node.bytes('node_signing_key'),
      renewSignatureValue(req.nodeId, req.tlsKey),
    )
    const cert = this.#nodeCertificate(req.nodeId, tlsKey)
    await this.#run('nodes.gateway.renew', async (tx) => {
      await tx.query('nodes.gateway.renew', 'SELECT nodes.renew($1, $2, $3, $4, $5)', [
        presented.nodeId,
        Buffer.from(presented.certificate),
        Buffer.from(tlsKey),
        Buffer.from(cert.der),
        cert.expiresAt,
      ])
      await this.#audit(tx, 'node.certificate_renewed', req.nodeId, node.text('server_id'))
    })
    return {
      certificateChain: this.#chain(cert.der),
      certificateExpiresAt: cert.expiresAt.toISOString(),
    }
  }
}
