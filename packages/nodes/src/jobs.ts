import { randomBytes } from 'node:crypto'
import {
  JobEnvelopeSchema,
  NODE_CAPABILITIES,
  NODE_PROTOCOL_LIMITS,
  type NodeCapabilityKey,
} from '@exponetdb/contracts'
import type { ControlStore, Tx } from '@exponetdb/control-store'
import {
  type Clock,
  canonicalBytes,
  isId,
  isJsonObject,
  type JobId,
  type JsonObject,
  newId,
  toJsonValue,
} from '@exponetdb/kernel'
import { sha256Hex } from '@exponetdb/kernel/hash'
import { b64u, sealNs1, signJobEnvelope, verifyResult } from '@exponetdb/kernel/node'
import { type Keyring, readSecret } from '@exponetdb/secrets'
import { NodeError } from './errors.ts'

/**
 * Jobs on the worker's side ([control-plane.md §6](../../../exponetdb-docs/07-node-agent/control-plane.md#6-worker),
 * [protocol.md §4](../../../exponetdb-docs/07-node-agent/protocol.md#4-jobs)):
 * the worker builds the envelope, seals every secret argument to the node's
 * bound encryption key (`ns1`), signs it with the active job key, and judges
 * every completion by its `nr1` signature. The gateway only moves jobs.
 */

/** Seals one argument value for the job being built (`{ ns1: … }`). */
export type Sealer = (field: string, plaintext: Uint8Array) => JsonObject

export interface NewJob {
  readonly nodeId: string
  readonly operationId: string
  readonly capability: NodeCapabilityKey
  /** Builds the arguments; secret values go through `seal`, never in clear. */
  readonly args: (seal: Sealer) => JsonObject
  /** Validity window, 15 minutes by default, never more than 60. */
  readonly windowSeconds?: number
}

export interface CreatedJob {
  readonly jobId: JobId
  readonly envelope: JsonObject
}

/** `sha256:` over JCS(args): the job's `argsHash` (protocol.md §4.1). */
export function argsHashOf(args: JsonObject): string {
  const canonical = canonicalBytes(args)
  if (!canonical.ok) {
    throw new NodeError('VALIDATION_FAILED')
  }
  return `sha256:${sha256Hex(canonical.value)}`
}

/** Creates a signed job for a bound node in the caller's (worker) transaction. */
export async function createJob(
  tx: Tx,
  keyring: Keyring,
  clock: Clock,
  installationId: string,
  job: NewJob,
): Promise<CreatedJob> {
  const definition = NODE_CAPABILITIES[job.capability]
  const window = job.windowSeconds ?? NODE_PROTOCOL_LIMITS.jobWindowSecondsDefault
  if (window < 1 || window > NODE_PROTOCOL_LIMITS.jobWindowSecondsMax) {
    throw new NodeError('VALIDATION_FAILED')
  }
  const node = await tx.query(
    'nodes.job.node',
    `SELECT node_encryption_key FROM nodes.nodes WHERE node_id = $1 AND state IN ('active', 'degraded')`,
    [job.nodeId],
  )
  const encryptionKey = node.rows[0]?.bytes('node_encryption_key')
  if (encryptionKey === undefined) {
    throw new NodeError('CONFLICT')
  }
  const key = await tx.query(
    'nodes.job.signing_key',
    `SELECT key_id, secret_id FROM nodes.job_keys WHERE state = 'active'`,
  )
  const keyRow = key.rows[0]
  const secretId = keyRow?.text('secret_id')
  if (keyRow === undefined || secretId === undefined || !isId('sec', secretId)) {
    throw new NodeError('PRECONDITION_FAILED')
  }
  const now = clock.nowMs()
  const jobId = newId('job', now)
  const [name, major] = [definition.name, definition.major]
  const seal: Sealer = (field, plaintext) => {
    const { ns1 } = sealNs1(
      encryptionKey,
      {
        installationId,
        nodeId: job.nodeId,
        jobId,
        operationId: job.operationId,
        capability: { name, major },
        field,
      },
      plaintext,
    )
    return { ns1: { enc: ns1.enc, ct: ns1.ct } }
  }
  const args = job.args(seal)
  if (!definition.args.safeParse(args).success) {
    throw new NodeError('VALIDATION_FAILED')
  }
  const canonical = canonicalBytes(args)
  if (!canonical.ok) {
    throw new NodeError('VALIDATION_FAILED')
  }
  const nonce = b64u(new Uint8Array(randomBytes(16)))
  const issuedAt = new Date(now).toISOString()
  const envelope: JsonObject = {
    jobId,
    operationId: job.operationId,
    nodeId: job.nodeId,
    capability: { name, major },
    args,
    argsHash: `sha256:${sha256Hex(canonical.value)}`,
    notBefore: issuedAt,
    expiresAt: new Date(now + window * 1000).toISOString(),
    nonce,
    issuedAt,
    attempt: 1,
  }
  const seed = await readSecret(tx, keyring, { secretId, consumer: 'worker' })
  let signed: JsonObject
  try {
    signed = signJobEnvelope(envelope, keyRow.text('key_id'), seed)
  } finally {
    seed.fill(0)
  }
  if (!JobEnvelopeSchema.safeParse(signed).success) {
    throw new NodeError('INTERNAL')
  }
  await tx.query(
    'nodes.job.insert',
    `INSERT INTO nodes.jobs (job_id, node_id, operation_id, capability, envelope, args_hash, nonce,
                             not_before, expires_at, state)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending')`,
    [
      jobId,
      job.nodeId,
      job.operationId,
      `${name}@${major}`,
      JSON.stringify(signed),
      envelope['argsHash'],
      nonce,
      new Date(now),
      new Date(now + window * 1000),
    ],
  )
  return { jobId, envelope: signed }
}

/**
 * Rejection reasons that describe one delivery, not the job (protocol.md
 * §4.2): never evidence that the job did not run.
 */
export const DELIVERY_REJECTIONS: ReadonlySet<string> = new Set([
  'signature_invalid',
  'unknown_signing_key',
  'journal_corrupt',
  'job_replayed',
])

/**
 * What a judged completion proves about the job on its node: it ran (and
 * may have changed the host, also when it failed), it did not run (a
 * rejection of the job itself, or canceled before the effect point), or
 * nothing (no valid node signature, or a delivery rejection).
 */
export type JobEvidence = 'ran' | 'did_not_run' | 'unproven'

export function jobEvidence(
  completion: { readonly outcome: string; readonly rejectionReason: string | null },
  signatureValid: boolean,
): JobEvidence {
  if (!signatureValid) {
    return 'unproven'
  }
  switch (completion.outcome) {
    case 'succeeded':
    case 'failed':
      return 'ran'
    case 'canceled':
      return 'did_not_run'
    case 'rejected':
      return completion.rejectionReason === null ||
        DELIVERY_REJECTIONS.has(completion.rejectionReason)
        ? 'unproven'
        : 'did_not_run'
    default:
      return 'unproven'
  }
}

/** Whether a stored completion's `nr1` signature verifies against the node's bound signing key. */
function signatureValid(
  installationId: string,
  row: { readonly nodeId: string; readonly jobId: string; readonly argsHash: string },
  stored: unknown,
  signingKey: Uint8Array,
): boolean {
  const parsed = toJsonValue(stored)
  const completion = parsed.ok && isJsonObject(parsed.value) ? parsed.value : undefined
  const signature = completion?.['nodeSignature']
  const value = isJsonObject(signature) ? signature['value'] : undefined
  return (
    completion !== undefined &&
    typeof value === 'string' &&
    verifyResult(
      signingKey,
      { installationId, nodeId: row.nodeId, jobId: row.jobId, argsHash: row.argsHash },
      completion,
      value,
    )
  )
}

/**
 * Judges one stored completion, once: its verdict is recorded the first time
 * and read back after, so a capability operation and the judging task never
 * disagree. Undefined while the job has no completion.
 */
export async function judgeJob(
  store: ControlStore,
  installationId: string,
  jobId: string,
): Promise<boolean | undefined> {
  const { rows } = await store.query(
    'nodes.jobs.judge_one',
    `SELECT j.job_id, j.node_id, j.args_hash, j.completion, j.node_signature_valid, n.node_signing_key
       FROM nodes.jobs j JOIN nodes.nodes n USING (node_id)
      WHERE j.job_id = $1 AND j.completion IS NOT NULL`,
    [jobId],
  )
  const row = rows[0]
  if (row === undefined) {
    return undefined
  }
  const recorded = row.boolOrNull('node_signature_valid')
  if (recorded !== null) {
    return recorded
  }
  const valid = signatureValid(
    installationId,
    { nodeId: row.text('node_id'), jobId, argsHash: row.text('args_hash') },
    row.json('completion'),
    row.bytes('node_signing_key'),
  )
  await store.query(
    'nodes.jobs.judge',
    `UPDATE nodes.jobs SET node_signature_valid = $2, judged_at = clock_timestamp()
      WHERE job_id = $1 AND judged_at IS NULL`,
    [jobId, valid],
  )
  const after = await store.query(
    'nodes.jobs.verdict',
    'SELECT node_signature_valid FROM nodes.jobs WHERE job_id = $1',
    [jobId],
  )
  return after.rows[0]?.boolOrNull('node_signature_valid') ?? valid
}

/**
 * Judges stored completions (worker): a completion is node evidence only if
 * its `nr1` signature verifies against the node's bound signing key, over
 * the job's own `argsHash`. Each verdict is recorded once.
 */
export async function judgeCompletions(
  store: ControlStore,
  installationId: string,
): Promise<number> {
  const { rows } = await store.query(
    'nodes.jobs.unjudged',
    `SELECT j.job_id FROM nodes.jobs j
      WHERE j.completion IS NOT NULL AND j.judged_at IS NULL
      ORDER BY j.completed_at LIMIT 100`,
  )
  let judged = 0
  for (const row of rows) {
    if ((await judgeJob(store, installationId, row.text('job_id'))) !== undefined) {
      judged += 1
    }
  }
  return judged
}

/** Moves lapsed jobs on (worker): a running job without a lease is `outcome_unknown`, nothing pending outlives its window. */
export async function sweepJobs(store: ControlStore): Promise<number> {
  const { rows } = await store.query('nodes.jobs.sweep', 'SELECT nodes.sweep_jobs() AS n')
  return rows[0]?.int('n') ?? 0
}
