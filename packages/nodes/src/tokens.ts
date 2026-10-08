import { randomBytes } from 'node:crypto'
import type { Tx } from '@exponetdb/control-store'
import { type Clock, isId } from '@exponetdb/kernel'
import { encodeToken, redeemHash, TOKEN_MAX_JOB_KEYS, tokenKeys } from '@exponetdb/kernel/node'
import { createSecret, type Keyring } from '@exponetdb/secrets'
import { NodeError } from './errors.ts'

/**
 * Enrollment tokens in two steps ([control-plane.md §4](../../../exponetdb-docs/07-node-agent/control-plane.md#4-enrollment-tokens)):
 * the `node.enroll` operation creates the record without a secret (worker);
 * the identity that applied it reveals it once (serve), which is the only
 * moment the secret exists: its redeem hash goes to the gateway, its bind key
 * to the worker (`se1`), and the token string to the caller.
 */

/** How long the applying identity may reveal a created token. */
export const REVEAL_WINDOW_MS = 30 * 60_000

export interface NewToken {
  readonly tokenId: string
  readonly serverId: string
  /** The identity that applied the plan; only it may reveal the token. */
  readonly revealBy: string
  readonly operationId: string
}

/**
 * Creates the token record (worker): the current job keys' fingerprints as
 * anchors (the active key first, then the staged one during a rotation).
 * Refused
 * while the server has a node that is not terminal (I-6).
 */
export async function createEnrollmentToken(tx: Tx, clock: Clock, token: NewToken): Promise<void> {
  const live = await tx.query(
    'nodes.token.live_node',
    `SELECT 1 FROM nodes.nodes WHERE server_id = $1 AND state IN ('pending_binding', 'active', 'degraded')`,
    [token.serverId],
  )
  if (live.rows.length > 0) {
    throw new NodeError('NODE_ALREADY_ENROLLED')
  }
  const keys = await tx.query(
    'nodes.token.job_keys',
    // The active key and, during a rotation, the staged one (control-plane.md §9.8).
    // FOR SHARE: an activation (FOR UPDATE on these rows) waits for this
    // token, then sees it; a token made after it anchors the new key.
    `SELECT key_id, fingerprint FROM nodes.job_keys WHERE state IN ('active', 'staged')
      ORDER BY state = 'active' DESC, created_at DESC LIMIT $1 FOR SHARE`,
    [TOKEN_MAX_JOB_KEYS],
  )
  if (keys.rows.length === 0 || keys.rows[0]?.text('key_id') === undefined) {
    // No PKI yet: node-pki init has not run.
    throw new NodeError('PRECONDITION_FAILED')
  }
  const anchors = keys.rows.map((r) => ({
    keyId: r.text('key_id'),
    fingerprint: r.text('fingerprint'),
  }))
  await tx.query(
    'nodes.token.insert',
    `INSERT INTO nodes.enrollment_tokens (token_id, server_id, job_keys, state, reveal_by, reveal_until,
                                          created_by_operation_id)
     VALUES ($1, $2, $3, 'created', $4, $5, $6)`,
    [
      token.tokenId,
      token.serverId,
      JSON.stringify(anchors),
      token.revealBy,
      new Date(clock.nowMs() + REVEAL_WINDOW_MS),
      token.operationId,
    ],
  )
}

export interface RevealedToken {
  /** `exdbt1.…`: shown once, never stored. */
  readonly token: string
  readonly serverId: string
  readonly expiresAt: string
}

/**
 * Reveals a created token once (serve), for the identity that may reveal it
 * and within its window; every other case is `NOT_FOUND`, so the answer says
 * nothing about tokens of others. The caller has checked re-authentication.
 */
export async function revealEnrollmentToken(
  tx: Tx,
  keyring: Keyring,
  clock: Clock,
  request: {
    readonly tokenId: string
    readonly identityId: string
    readonly installationId: string
  },
): Promise<RevealedToken> {
  if (!isId('ent', request.tokenId)) {
    throw new NodeError('NOT_FOUND')
  }
  const { rows } = await tx.query(
    'nodes.token.for_reveal',
    `SELECT t.server_id, t.job_keys, p.gateway_url, p.gateway_server_name, p.root_fingerprint
       FROM nodes.enrollment_tokens t CROSS JOIN nodes.pki p
      WHERE t.token_id = $1 AND t.state = 'created' AND t.reveal_by = $2
        AND t.reveal_until > clock_timestamp()
      FOR UPDATE OF t`,
    [request.tokenId, request.identityId],
  )
  const row = rows[0]
  if (row === undefined) {
    throw new NodeError('NOT_FOUND')
  }
  const jobKeys = anchorsOf(row.json('job_keys'))
  const secret = new Uint8Array(randomBytes(32))
  const keys = tokenKeys(secret, request.tokenId)
  try {
    const bind = await createSecret(
      tx,
      keyring,
      {
        purpose: 'node.bind_key',
        subjectId: request.tokenId,
        consumer: 'worker',
        plaintext: keys.bind,
      },
      { clock },
    )
    const issued = await tx.query(
      'nodes.token.issue',
      `UPDATE nodes.enrollment_tokens SET state = 'issued', redeem_hash = $2, bind_secret_id = $3
        WHERE token_id = $1 RETURNING expires_at`,
      [request.tokenId, redeemHash(keys.redeem), bind.secretId],
    )
    const expiresAt = issued.rows[0]?.date('expires_at').toISOString()
    if (expiresAt === undefined) {
      throw new NodeError('INTERNAL')
    }
    const serverId = row.text('server_id')
    return {
      token: encodeToken({
        v: 'exdbt1',
        tokenId: request.tokenId,
        installationId: request.installationId,
        serverId,
        gateway: row.text('gateway_url'),
        gatewayServerName: row.text('gateway_server_name'),
        rootFingerprint: row.text('root_fingerprint'),
        jobKeys,
        secret,
        expiresAt,
      }),
      serverId,
      expiresAt,
    }
  } finally {
    secret.fill(0)
    keys.redeem.fill(0)
    keys.bind.fill(0)
  }
}

function anchorsOf(value: unknown): { keyId: string; fingerprint: string }[] {
  if (!Array.isArray(value)) {
    throw new NodeError('INTERNAL')
  }
  return value.map((v: unknown) => {
    if (
      typeof v !== 'object' ||
      v === null ||
      !('keyId' in v) ||
      !('fingerprint' in v) ||
      typeof v.keyId !== 'string' ||
      typeof v.fingerprint !== 'string'
    ) {
      throw new NodeError('INTERNAL')
    }
    return { keyId: v.keyId, fingerprint: v.fingerprint }
  })
}
