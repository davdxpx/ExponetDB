import { SafeError } from '@exponetdb/observability'

/**
 * Every failure that leaves `@exponetdb/control-store` is a
 * {@link ControlStoreError}: a constant message, a stable code and, when
 * PostgreSQL reported one, the SQLSTATE. The driver error (which can carry
 * row values in `detail`, input values in `message`, or a connection string)
 * stays as `cause` for code extraction only; callers and loggers never see
 * its text (`describeError` reads codes only).
 */
export type ControlStoreErrorCode =
  | 'control_store_unavailable'
  | 'control_store_permission_denied'
  | 'control_store_conflict'
  | 'control_store_serialization_failure'
  | 'control_store_timeout'
  | 'control_store_query_failed'
  | 'control_store_append_only'
  | 'control_store_wrong_role'
  | 'control_store_invalid_result'

const MESSAGES: Record<ControlStoreErrorCode, string> = {
  control_store_unavailable: 'The Control Store is unreachable.',
  control_store_permission_denied: 'The Control Store refused the statement for this role.',
  control_store_conflict: 'The Control Store reported a conflicting row.',
  control_store_serialization_failure:
    'The Control Store aborted the transaction to keep it serializable.',
  control_store_timeout: 'A Control Store statement or lock wait timed out.',
  control_store_query_failed: 'A Control Store statement failed.',
  control_store_append_only: 'The Control Store refused a change to append-only data.',
  control_store_wrong_role: 'The Control Store login is not the role this process expects.',
  control_store_invalid_result: 'The Control Store returned a value of an unexpected type.',
}

export class ControlStoreError extends SafeError {
  override readonly name = 'ControlStoreError'
  declare readonly code: ControlStoreErrorCode
  /** SQLSTATE reported by PostgreSQL, when there was one. */
  readonly sqlstate: string | undefined

  constructor(code: ControlStoreErrorCode, options?: { cause?: unknown; sqlstate?: string }) {
    super(code, MESSAGES[code], options?.cause === undefined ? undefined : { cause: options.cause })
    this.sqlstate = options?.sqlstate
  }
}

const SQLSTATE = /^[0-9A-Z]{5}$/
const CONNECTION_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
])

function field(error: unknown, name: string): unknown {
  return typeof error === 'object' && error !== null ? Reflect.get(error, name) : undefined
}

/** Maps anything the driver throws to a {@link ControlStoreError}. */
export function toControlStoreError(error: unknown): ControlStoreError {
  if (error instanceof ControlStoreError) {
    return error
  }
  const code = field(error, 'code')
  const sqlstate = typeof code === 'string' && SQLSTATE.test(code) ? code : undefined
  const options = sqlstate === undefined ? { cause: error } : { cause: error, sqlstate }
  if (sqlstate === undefined) {
    if (typeof code === 'string' && CONNECTION_CODES.has(code)) {
      return new ControlStoreError('control_store_unavailable', options)
    }
    const message = error instanceof Error ? error.message : ''
    // node-postgres reports a lost or refused connection without a SQLSTATE.
    if (/Connection terminated|connect|timeout exceeded when trying to connect/i.test(message)) {
      return new ControlStoreError('control_store_unavailable', options)
    }
    return new ControlStoreError('control_store_query_failed', options)
  }
  if (
    sqlstate.startsWith('08') ||
    sqlstate === '57P01' ||
    sqlstate === '57P02' ||
    sqlstate === '57P03' ||
    sqlstate === '53300'
  ) {
    return new ControlStoreError('control_store_unavailable', options)
  }
  if (sqlstate === '42501' || sqlstate === '28000' || sqlstate === '28P01') {
    return new ControlStoreError(
      sqlstate === '42501' ? 'control_store_permission_denied' : 'control_store_unavailable',
      options,
    )
  }
  if (sqlstate === '23505' || sqlstate === '23P01') {
    return new ControlStoreError('control_store_conflict', options)
  }
  if (sqlstate === '40001' || sqlstate === '40P01') {
    return new ControlStoreError('control_store_serialization_failure', options)
  }
  if (sqlstate === '57014' || sqlstate === '55P03' || sqlstate === '25P03') {
    return new ControlStoreError('control_store_timeout', options)
  }
  if (sqlstate === 'EXA01') {
    return new ControlStoreError('control_store_append_only', options)
  }
  return new ControlStoreError('control_store_query_failed', options)
}
