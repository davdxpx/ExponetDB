import type { Queryable, Tx } from '@exponetdb/control-store'
import { canonicalize, type JsonValue, parseJson, toJsonValue } from '@exponetdb/kernel'
import { sha256Hex } from '@exponetdb/kernel/hash'
import { OperationError } from './errors.ts'

/**
 * Idempotency keys ([operations-engine.md §5](../../../exponetdb-docs/02-control-plane/operations-engine.md#5-idempotency), mechanism 3).
 * `Idempotency-Key` is 1 to 255 visible ASCII characters, stored per
 * principal for 24 hours with a hash of the request. In the request's own
 * transaction: `beginIdempotent`, then the mutation, then
 * `completeIdempotent` with the response. The primary key serializes
 * concurrent requests with the same key: the second waits for the first to
 * commit, then replays its response; if the first rolled back, the second
 * proceeds. Same key with a different request: `IDEMPOTENCY_KEY_REUSED`.
 */
export const IDEMPOTENCY_KEY = /^[!-~]{1,255}$/
const PRINCIPAL = /^[a-z]+:[A-Za-z0-9_:#-]{1,96}$/
export const IDEMPOTENCY_TTL_HOURS = 24

export function isIdempotencyKey(value: string): boolean {
  return IDEMPOTENCY_KEY.test(value)
}

/** `sha256:` over the canonical JSON of method, path and body. */
export function requestHash(method: string, path: string, body: JsonValue): string {
  const value = toJsonValue({ method: method.toUpperCase(), path, body })
  const text = value.ok ? canonicalize(value.value) : undefined
  if (text === undefined || !text.ok) {
    throw new OperationError('VALIDATION_FAILED')
  }
  return `sha256:${sha256Hex(text.value)}`
}

export type IdempotencyStart =
  | { readonly status: 'new' }
  | { readonly status: 'replay'; readonly response: JsonValue }

export async function beginIdempotent(
  tx: Tx,
  input: { readonly principal: string; readonly key: string; readonly requestHash: string },
): Promise<IdempotencyStart> {
  if (!IDEMPOTENCY_KEY.test(input.key) || !PRINCIPAL.test(input.principal)) {
    throw new OperationError('VALIDATION_FAILED')
  }
  const fresh = await tx.query(
    'operations.idempotency.begin',
    `INSERT INTO operations.idempotency_keys (principal_key, idem_key, request_hash, created_at, expires_at)
     SELECT $1, $2, $3, n.t, n.t + make_interval(hours => ${IDEMPOTENCY_TTL_HOURS})
       FROM (SELECT clock_timestamp() AS t) AS n
     ON CONFLICT (principal_key, idem_key) DO UPDATE
        SET request_hash = excluded.request_hash, response = NULL, completed_at = NULL,
            created_at = excluded.created_at, expires_at = excluded.expires_at
      WHERE operations.idempotency_keys.expires_at <= excluded.created_at
     RETURNING idem_key`,
    [input.principal, input.key, input.requestHash],
  )
  if (fresh.rows.length === 1) {
    return { status: 'new' }
  }
  const existing = await tx.query(
    'operations.idempotency.existing',
    `SELECT request_hash, response::text AS response, completed_at IS NOT NULL AS completed
       FROM operations.idempotency_keys WHERE principal_key = $1 AND idem_key = $2`,
    [input.principal, input.key],
  )
  const row = existing.rows[0]
  if (row === undefined || row.text('request_hash') !== input.requestHash) {
    throw new OperationError('IDEMPOTENCY_KEY_REUSED')
  }
  const response = row.textOrNull('response')
  if (!row.bool('completed') || response === null) {
    throw new OperationError('idempotency_in_progress')
  }
  const parsed = parseJson(response)
  if (!parsed.ok) {
    throw new OperationError('operation_state_changed')
  }
  return { status: 'replay', response: parsed.value }
}

export async function completeIdempotent(
  tx: Tx,
  input: { readonly principal: string; readonly key: string; readonly response: JsonValue },
): Promise<void> {
  const { rowCount } = await tx.query(
    'operations.idempotency.complete',
    `UPDATE operations.idempotency_keys SET response = $3::jsonb, completed_at = clock_timestamp()
      WHERE principal_key = $1 AND idem_key = $2 AND completed_at IS NULL`,
    [input.principal, input.key, JSON.stringify(input.response)],
  )
  if (rowCount !== 1) {
    throw new OperationError('operation_state_changed')
  }
}

/**
 * Drops a key begun in this transaction without a response: for a request
 * whose transaction commits a refusal (the refused plan is kept), so a retry
 * with the same key is decided again instead of waiting for 24 hours.
 */
export async function releaseIdempotent(
  tx: Tx,
  input: { readonly principal: string; readonly key: string },
): Promise<void> {
  await tx.query(
    'operations.idempotency.release',
    `DELETE FROM operations.idempotency_keys
      WHERE principal_key = $1 AND idem_key = $2 AND completed_at IS NULL`,
    [input.principal, input.key],
  )
}

/** Retention (data-retention.md: 24 h): deletes expired keys, at most `limit` per call. */
export async function pruneIdempotencyKeys(q: Queryable, limit = 10_000): Promise<number> {
  const { rowCount } = await q.query(
    'operations.idempotency.prune',
    `DELETE FROM operations.idempotency_keys
      WHERE ctid IN (SELECT ctid FROM operations.idempotency_keys
                      WHERE expires_at <= clock_timestamp() LIMIT $1)`,
    [Math.min(Math.max(1, limit), 10_000)],
  )
  return rowCount
}
