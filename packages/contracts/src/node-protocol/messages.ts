import * as z from 'zod'
import {
  EnrollmentTokenIdSchema,
  InstallationIdSchema,
  JobIdSchema,
  JsonValueSchema,
  NodeIdSchema,
  OperationIdSchema,
  ServerIdSchema,
  Sha256DigestSchema,
  TimestampSchema,
} from '../common.ts'
import {
  Base64UrlSchema,
  HostPathSchema,
  KeyIdSchema,
  LocalClusterNameSchema,
  PublicKeySchema,
  SemverSchema,
  SignatureSchema,
  SystemIdentifierSchema,
} from './primitives.ts'

/**
 * Node agent protocol `exponetdb.node/v1` ([protocol.md](../../../../exponetdb-docs/07-node-agent/protocol.md)).
 * Agent → gateway over HTTPS with mutual TLS; JSON bodies; RFC 8785 wherever a
 * hash or signature covers a payload. All messages are closed (unknown fields
 * are refused): within a protocol major both sides know every field, and a job
 * the agent does not fully understand must be rejected, not partly obeyed.
 * The Go types in `agent/node/internal/protocol` are generated from these
 * schemas.
 */
export const NODE_PROTOCOL_ID = 'exponetdb.node/v1'
export const NODE_PROTOCOL_MAJOR = 1
export const NODE_PROTOCOL_HEADER = 'X-Exponetdb-Protocol'
/** Every agent request also carries its semantic version (protocol.md §1). */
export const NODE_AGENT_VERSION_HEADER = 'X-Exponetdb-Agent-Version'

/** Endpoints of the agent API, relative to the gateway origin. */
export const NODE_PROTOCOL_ENDPOINTS = {
  enroll: '/agent/v1/enroll',
  hello: '/agent/v1/hello',
  heartbeat: '/agent/v1/heartbeat',
  claim: '/agent/v1/jobs/claim',
  start: '/agent/v1/jobs/{jobId}/start',
  progress: '/agent/v1/jobs/{jobId}/progress',
  complete: '/agent/v1/jobs/{jobId}/complete',
  renew: '/agent/v1/renew',
} as const

/** Size limits (protocol.md §5). */
export const NODE_PROTOCOL_LIMITS = {
  requestBytes: 1024 * 1024,
  heartbeatBytes: 64 * 1024,
  outputExcerptBytes: 32 * 1024,
  claimWaitSecondsMax: 25,
  heartbeatIntervalSeconds: 15,
  startDeadlineSeconds: 60,
  leaseSeconds: 60,
  progressIntervalSecondsMax: 20,
  clockSkewToleranceSeconds: 30,
  nonceReplayWindowDays: 7,
  /** `expiresAt - notBefore` of a job envelope (ADR-0024 §4). */
  jobWindowSecondsDefault: 15 * 60,
  jobWindowSecondsMax: 60 * 60,
  trustedJobKeysMax: 3,
  enrollmentTokenMinutes: 30,
  certificateHours: 72,
  /** One DER certificate, base64url. */
  certificateChars: 8192,
  certificateChainMax: 3,
} as const

export const NodeCapabilitySchema = z
  .strictObject({
    name: z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/),
    major: z.int().min(1).max(1000),
  })
  .meta({
    id: 'NodeCapability',
    description: 'Capability name and major (postgres.config.apply@1).',
  })

const LocalClusterSchema = z
  .strictObject({
    localName: LocalClusterNameSchema,
    port: z.int().min(1).max(65535),
    version: z.string().regex(/^[1-9][0-9]*\.[0-9]+$/),
    systemIdentifier: SystemIdentifierSchema,
    dataDirectory: HostPathSchema,
    running: z.boolean(),
  })
  .meta({ id: 'NodeLocalCluster' })

const HostFactsSchema = z
  .strictObject({
    hostname: z.string().regex(/^[A-Za-z0-9.-]{1,253}$/),
    os: z.string().min(1).max(128),
    kernel: z.string().min(1).max(256),
    cpus: z.int().min(1),
    memoryBytes: z.int().min(0),
    machineIdHash: Sha256DigestSchema,
  })
  .meta({
    id: 'NodeHostFacts',
    description: 'Reported by the host; shown to the admin, never trusted.',
  })

const CertificateChainSchema = z
  .array(
    z
      .string()
      .min(1)
      .max(NODE_PROTOCOL_LIMITS.certificateChars)
      .regex(/^[A-Za-z0-9_-]+$/),
  )
  .min(2)
  .max(NODE_PROTOCOL_LIMITS.certificateChainMax)
  .meta({
    description:
      'DER certificates as base64url: the node certificate first, then the issuing CA certificate; never the root, which the agent pins by fingerprint.',
  })

/**
 * Enrollment (enrollment.md §3, protocol.md §7.4). Sent over TLS that the
 * agent verifies against the token's root fingerprint, without a client
 * certificate. The token secret never travels: the agent presents the redeem
 * key derived from it and a binding proof only the worker can check.
 */
export const EnrollRequestSchema = z
  .strictObject({
    tokenId: EnrollmentTokenIdSchema,
    redeemKey: Base64UrlSchema(32),
    tlsKey: PublicKeySchema,
    tlsKeyProof: SignatureSchema,
    nodeSigningKey: PublicKeySchema,
    nodeSigningKeyProof: SignatureSchema,
    nodeEncryptionKey: PublicKeySchema,
    bindProof: Base64UrlSchema(32).meta({
      description: 'HMAC-SHA-256 under the token bind key; checked by the worker only.',
    }),
    agentVersion: SemverSchema,
    protocolMajors: z.array(z.int().min(1)).min(1).max(8),
    host: HostFactsSchema,
  })
  .meta({ id: 'NodeEnrollRequest' })

export const EnrollResponseSchema = z
  .strictObject({
    nodeId: NodeIdSchema,
    installationId: InstallationIdSchema,
    serverId: ServerIdSchema,
    certificateChain: CertificateChainSchema,
    certificateExpiresAt: TimestampSchema,
    jobKeys: z
      .array(z.strictObject({ keyId: KeyIdSchema, publicKey: PublicKeySchema }))
      .min(1)
      .max(NODE_PROTOCOL_LIMITS.trustedJobKeysMax)
      .meta({
        description:
          "Job-signing public keys; the agent aborts unless each hashes to the token's fingerprint for its key id.",
      }),
    serverTime: TimestampSchema,
  })
  .meta({ id: 'NodeEnrollResponse' })

/** Certificate renewal over the current mTLS session (enrollment.md §4, protocol.md §7.4). */
export const RenewRequestSchema = z
  .strictObject({
    nodeId: NodeIdSchema,
    tlsKey: PublicKeySchema,
    tlsKeyProof: SignatureSchema,
    nodeSignature: SignatureSchema,
  })
  .meta({ id: 'NodeRenewRequest' })

export const RenewResponseSchema = z
  .strictObject({
    certificateChain: CertificateChainSchema,
    certificateExpiresAt: TimestampSchema,
  })
  .meta({ id: 'NodeRenewResponse' })

export const HelloRequestSchema = z
  .strictObject({
    nodeId: NodeIdSchema,
    agentVersion: SemverSchema,
    protocolMajors: z.array(z.int().min(1)).min(1).max(8),
    capabilities: z.array(NodeCapabilitySchema).max(256),
    clusters: z.array(LocalClusterSchema).max(32),
    host: HostFactsSchema,
    clock: z.strictObject({ agentTime: TimestampSchema }),
    journal: z.strictObject({
      inFlight: z
        .array(
          z.strictObject({
            jobId: JobIdSchema,
            state: z.literal('started'),
            lastStep: z.int().min(0),
          }),
        )
        .max(64)
        .meta({
          description:
            'Jobs started but not completed; the control plane reconciles them, the agent never resumes them itself.',
        }),
    }),
  })
  .meta({ id: 'NodeHelloRequest' })

export const HelloResponseSchema = z
  .strictObject({
    protocolMajor: z.int().min(1),
    serverTime: TimestampSchema,
    acceptedCapabilities: z.array(NodeCapabilitySchema).max(256),
    instructions: z.strictObject({ renewCertificate: z.boolean() }),
  })
  .meta({ id: 'NodeHelloResponse' })

export const HeartbeatRequestSchema = z
  .strictObject({
    nodeId: NodeIdSchema,
    sentAt: TimestampSchema,
    host: z.strictObject({
      cpuPercent: z.number().min(0).max(100),
      memoryUsedBytes: z.int().min(0),
      load1: z.number().min(0),
      load5: z.number().min(0),
      load15: z.number().min(0),
      mounts: z
        .array(
          z.strictObject({
            path: HostPathSchema,
            usedBytes: z.int().min(0),
            totalBytes: z.int().min(0),
            inodesUsedPercent: z.number().min(0).max(100),
          }),
        )
        .max(64),
    }),
    clusters: z
      .array(
        z.strictObject({
          localName: LocalClusterNameSchema,
          serviceState: z.enum(['running', 'stopped', 'starting', 'stopping', 'failed', 'unknown']),
          pendingRestart: z.boolean(),
          walDirectoryBytes: z.int().min(0),
          archiver: z.strictObject({
            failedCount: z.int().min(0),
            lastArchivedAt: TimestampSchema.nullable(),
            lastFailedAt: TimestampSchema.nullable(),
          }),
          serverCertificateExpiresAt: TimestampSchema.nullable(),
        }),
      )
      .max(32),
    nodeCertificateExpiresAt: TimestampSchema,
    clockSkewMs: z.int(),
    inFlightJobs: z.array(JobIdSchema).max(64),
    agent: z.strictObject({
      queueSize: z.int().min(0),
      bufferedResults: z.int().min(0),
      lastErrors: z
        .array(z.string().max(512))
        .max(16)
        .meta({ description: 'Redacted on the host.' }),
    }),
  })
  .meta({
    id: 'NodeHeartbeatRequest',
    description: 'Idempotent snapshot; a missed heartbeat loses nothing important.',
  })

export const HeartbeatResponseSchema = z
  .strictObject({
    serverTime: TimestampSchema,
    instructions: z.strictObject({ renewCertificate: z.boolean() }),
  })
  .meta({ id: 'NodeHeartbeatResponse' })

export const ClaimRequestSchema = z
  .strictObject({
    nodeId: NodeIdSchema,
    waitSeconds: z.int().min(0).max(NODE_PROTOCOL_LIMITS.claimWaitSecondsMax),
  })
  .meta({ id: 'NodeClaimRequest' })

/**
 * The signed job envelope (protocol.md §4.1). `signature.value` signs
 * JCS(envelope without `signature`) with Ed25519; `argsHash` is
 * sha256 over JCS(args). `args` is capability-specific: its schema is chosen by
 * `capability` and validated by both sides; capability schemas are registered
 * with the capabilities in Wave 5.
 */
export const JobEnvelopeSchema = z
  .strictObject({
    jobId: JobIdSchema,
    operationId: OperationIdSchema,
    nodeId: NodeIdSchema,
    capability: NodeCapabilitySchema,
    args: z.record(z.string(), JsonValueSchema).meta({
      'x-exponetdb-raw-json': true,
      description: 'Capability-specific arguments; never plaintext secrets.',
    }),
    argsHash: Sha256DigestSchema,
    notBefore: TimestampSchema,
    expiresAt: TimestampSchema,
    nonce: Base64UrlSchema(16),
    issuedAt: TimestampSchema,
    attempt: z.int().min(1).max(100),
    signature: z.strictObject({
      alg: z.literal('Ed25519'),
      keyId: KeyIdSchema,
      value: SignatureSchema,
    }),
  })
  .meta({ id: 'NodeJobEnvelope' })

export const ClaimResponseSchema = z
  .strictObject({
    job: JobEnvelopeSchema.nullable().meta({
      description: 'null when the long poll ended without a job.',
    }),
  })
  .meta({ id: 'NodeClaimResponse' })

export const JobStartRequestSchema = z
  .strictObject({ jobId: JobIdSchema, nodeId: NodeIdSchema, startedAt: TimestampSchema })
  .meta({
    id: 'NodeJobStartRequest',
    description: 'Sent after the journal records the start and before execution.',
  })

export const JobStartResponseSchema = z
  .strictObject({ leaseExpiresAt: TimestampSchema })
  .meta({ id: 'NodeJobStartResponse' })

const JobStepSchema = z
  .strictObject({
    index: z.int().min(0),
    name: z.string().regex(/^[a-z][a-z0-9_.]{0,63}$/),
    state: z.enum(['running', 'succeeded', 'failed', 'skipped']),
    at: TimestampSchema,
    message: z.string().max(1024).nullable().meta({ description: 'Redacted on the host.' }),
  })
  .meta({ id: 'NodeJobStep' })

export const JobProgressRequestSchema = z
  .strictObject({
    jobId: JobIdSchema,
    nodeId: NodeIdSchema,
    sentAt: TimestampSchema,
    steps: z.array(JobStepSchema).max(64),
  })
  .meta({
    id: 'NodeJobProgressRequest',
    description: 'Renews the lease; sent at least every 20 s while running.',
  })

export const JobProgressResponseSchema = z
  .strictObject({ leaseExpiresAt: TimestampSchema, cancelRequested: z.boolean() })
  .meta({ id: 'NodeJobProgressResponse' })

/**
 * Reasons an agent rejects a job before executing anything (protocol.md
 * §4.2, §4.3). `start_unacknowledged`: the job was accepted, its start was
 * never acknowledged, and it was abandoned without running. A rejection for
 * `signature_invalid`, `unknown_signing_key` or `journal_corrupt` describes
 * one delivery only and is never evidence that the job did not run.
 */
export const JOB_REJECTION_REASONS = [
  'signature_invalid',
  'unknown_signing_key',
  'envelope_invalid',
  'node_mismatch',
  'not_yet_valid',
  'expired',
  'clock_untrusted',
  'journal_corrupt',
  'job_replayed',
  'nonce_replayed',
  'capability_unsupported',
  'capability_disabled',
  'args_invalid',
  'args_hash_mismatch',
  'precondition_failed',
  'start_unacknowledged',
] as const

export const JobCompleteRequestSchema = z
  .strictObject({
    jobId: JobIdSchema,
    nodeId: NodeIdSchema,
    finishedAt: TimestampSchema,
    outcome: z.enum(['succeeded', 'failed', 'rejected', 'canceled']).meta({
      description:
        'canceled only when a cancel request arrived before the capability effect point (protocol.md §4.4).',
    }),
    rejectionReason: z.enum(JOB_REJECTION_REASONS).nullable(),
    result: z.record(z.string(), JsonValueSchema).nullable().meta({
      'x-exponetdb-raw-json': true,
      description: 'Capability-specific result, schema chosen by the capability.',
    }),
    steps: z.array(JobStepSchema).max(256),
    outputExcerpt: z
      .string()
      .max(NODE_PROTOCOL_LIMITS.outputExcerptBytes)
      .nullable()
      .meta({ description: 'Redacted on the host; at most 32 KiB.' }),
    nodeSignature: z.strictObject({ alg: z.literal('Ed25519'), value: SignatureSchema }).meta({
      description:
        'nr1 by the node signing key over this request without nodeSignature (protocol.md §7.5).',
    }),
  })
  .meta({ id: 'NodeJobCompleteRequest' })

export const JobCompleteResponseSchema = z
  .strictObject({
    accepted: z.boolean(),
    duplicate: z
      .boolean()
      .meta({ description: 'true when a buffered result arrives again; idempotent by job id.' }),
  })
  .meta({ id: 'NodeJobCompleteResponse' })

/** Error body of the agent API. Codes come from the error catalog. */
export const NodeProtocolErrorSchema = z
  .strictObject({
    code: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/),
    message: z.string().max(1024),
    retryable: z.boolean(),
  })
  .meta({ id: 'NodeProtocolError' })

/** Every message of the protocol, keyed by a stable name used for generated files. */
export const NODE_PROTOCOL_MESSAGES = {
  EnrollRequest: EnrollRequestSchema,
  EnrollResponse: EnrollResponseSchema,
  RenewRequest: RenewRequestSchema,
  RenewResponse: RenewResponseSchema,
  HelloRequest: HelloRequestSchema,
  HelloResponse: HelloResponseSchema,
  HeartbeatRequest: HeartbeatRequestSchema,
  HeartbeatResponse: HeartbeatResponseSchema,
  ClaimRequest: ClaimRequestSchema,
  ClaimResponse: ClaimResponseSchema,
  JobEnvelope: JobEnvelopeSchema,
  JobStartRequest: JobStartRequestSchema,
  JobStartResponse: JobStartResponseSchema,
  JobProgressRequest: JobProgressRequestSchema,
  JobProgressResponse: JobProgressResponseSchema,
  JobCompleteRequest: JobCompleteRequestSchema,
  JobCompleteResponse: JobCompleteResponseSchema,
  ProtocolError: NodeProtocolErrorSchema,
} as const
