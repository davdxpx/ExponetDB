import { isScramSha256Verifier } from '@exponetdb/contracts'
import type { Queryable, Tx } from '@exponetdb/control-store'
import { type Clock, isId, newId, type SecretId } from '@exponetdb/kernel'
import { type Keyring, open, type SecretContext, SecretError, seal } from '@exponetdb/secrets'
import { NodeError } from './errors.ts'

/**
 * Write-only storage of role verifiers (owner decision S3, 2026-10-13;
 * [credentials-and-roles.md §4](../../../exponetdb-docs/03-database-model/credentials-and-roles.md#4-consumer-roles-as-cluster-desired-state)):
 * the SCRAM-SHA-256 verifier a person submits for one consumer role of a
 * cluster is sealed with `se1` at once (`role_verifiers.verifiers`, bundle
 * `role-verifiers`). `serve` inserts and supersedes rows and never reads a
 * sealed column (the grants forbid it); the worker opens a submitted
 * verifier once, inside the transaction that creates the node job carrying
 * it sealed for the node, and clears it there. Nothing reads it back.
 */

export const ROLE_VERIFIER_PURPOSE = 'pg_role_verifier'

export type RoleVerifierState = 'submitted' | 'consumed' | 'superseded'

/** What anyone with the row may know of a role verifier: never the verifier. */
export interface RoleVerifierRecord {
  readonly verifierId: string
  readonly clusterId: string
  readonly roleName: string
  readonly state: RoleVerifierState
  readonly operationId: string | null
}

function contextOf(secretId: string, clusterId: string, verifierId: string): SecretContext {
  if (!isId('sec', secretId)) {
    throw new NodeError('INTERNAL')
  }
  return {
    secretId: secretId as SecretId,
    purpose: ROLE_VERIFIER_PURPOSE,
    subjectId: `${clusterId}/${verifierId}`,
    version: 1,
  }
}

/**
 * Seals and stores a submitted verifier (serve); a verifier still submitted
 * for the same role of the cluster is superseded and cleared. The verifier
 * text is never logged, returned or kept beyond this call's buffers.
 */
export async function storeRoleVerifier(
  tx: Tx,
  deps: { readonly keyring: Keyring; readonly clock: Clock },
  input: {
    readonly clusterId: string
    readonly roleName: string
    readonly verifier: string
    readonly submittedBy: string
  },
): Promise<{ readonly verifierId: string; readonly superseded: readonly string[] }> {
  if (!isScramSha256Verifier(input.verifier)) {
    throw new NodeError('VALIDATION_FAILED')
  }
  const now = deps.clock.nowMs()
  const verifierId = newId('rvf', now)
  const secretId = newId('sec', now)
  const plaintext = Buffer.from(input.verifier, 'utf8')
  let sealed: ReturnType<typeof seal>
  try {
    sealed = seal(deps.keyring, contextOf(secretId, input.clusterId, verifierId), plaintext)
  } finally {
    plaintext.fill(0)
  }
  const { rows } = await tx.query(
    'nodes.role_verifier.supersede',
    `UPDATE role_verifiers.verifiers
        SET state = 'superseded', key_id = NULL, wrap_nonce = NULL, wrapped_key = NULL, nonce = NULL,
            ciphertext = NULL
      WHERE cluster_id = $1 AND role_name = $2 AND state = 'submitted'
      RETURNING verifier_id`,
    [input.clusterId, input.roleName],
  )
  await tx.query(
    'nodes.role_verifier.insert',
    `INSERT INTO role_verifiers.verifiers (verifier_id, cluster_id, role_name, state, secret_id, key_id,
                                         wrap_nonce, wrapped_key, nonce, ciphertext, submitted_by)
     VALUES ($1, $2, $3, 'submitted', $4, $5, $6, $7, $8, $9, $10)`,
    [
      verifierId,
      input.clusterId,
      input.roleName,
      secretId,
      sealed.keyId,
      Buffer.from(sealed.wrapNonce),
      Buffer.from(sealed.wrappedKey),
      Buffer.from(sealed.nonce),
      Buffer.from(sealed.ciphertext),
      input.submittedBy,
    ],
  )
  return { verifierId, superseded: rows.map((r) => r.text('verifier_id')) }
}

/** The metadata of a role verifier (serve and the worker); undefined when unknown. */
export async function roleVerifierRecord(
  q: Queryable,
  verifierId: string,
): Promise<RoleVerifierRecord | undefined> {
  const { rows } = await q.query(
    'nodes.role_verifier.read',
    `SELECT verifier_id, cluster_id, role_name, state, operation_id
       FROM role_verifiers.verifiers WHERE verifier_id = $1`,
    [verifierId],
  )
  const row = rows[0]
  if (row === undefined) {
    return undefined
  }
  return {
    verifierId: row.text('verifier_id'),
    clusterId: row.text('cluster_id'),
    roleName: row.text('role_name'),
    state: row.text('state') as RoleVerifierState,
    operationId: row.textOrNull('operation_id'),
  }
}

/**
 * The worker takes a submitted verifier for one operation: the row is
 * locked, must still be submitted for exactly this cluster and role, is
 * opened and cleared (`consumed`, naming the operation). Undefined (nothing
 * changed) when it is no longer submitted. The caller overwrites the
 * returned buffer once it sealed it for the node, in the same transaction.
 */
export async function takeRoleVerifier(
  tx: Tx,
  keyring: Keyring,
  ref: {
    readonly verifierId: string
    readonly clusterId: string
    readonly roleName: string
    readonly operationId: string
  },
): Promise<Buffer | undefined> {
  const { rows } = await tx.query(
    'nodes.role_verifier.lock',
    `SELECT verifier_id, cluster_id, role_name, state, secret_id, key_id, wrap_nonce, wrapped_key, nonce,
            ciphertext
       FROM role_verifiers.verifiers WHERE verifier_id = $1 FOR UPDATE`,
    [ref.verifierId],
  )
  const row = rows[0]
  if (
    row === undefined ||
    row.text('state') !== 'submitted' ||
    row.text('cluster_id') !== ref.clusterId ||
    row.text('role_name') !== ref.roleName
  ) {
    return undefined
  }
  let plaintext: Buffer
  try {
    plaintext = open(keyring, contextOf(row.text('secret_id'), ref.clusterId, ref.verifierId), {
      keyId: row.text('key_id'),
      wrapNonce: row.bytes('wrap_nonce'),
      wrappedKey: row.bytes('wrapped_key'),
      nonce: row.bytes('nonce'),
      ciphertext: row.bytes('ciphertext'),
    })
  } catch (error) {
    // A master key no longer in the keyring, or a changed row: nothing is
    // sent and the row stays as it is (a new submission supersedes it).
    if (error instanceof SecretError) {
      throw new NodeError('INTERNAL')
    }
    throw error
  }
  await tx.query(
    'nodes.role_verifier.consume',
    `UPDATE role_verifiers.verifiers
        SET state = 'consumed', operation_id = $2, key_id = NULL, wrap_nonce = NULL, wrapped_key = NULL,
            nonce = NULL, ciphertext = NULL
      WHERE verifier_id = $1`,
    [ref.verifierId, ref.operationId],
  )
  return plaintext
}
