import { SafeError } from '@exponetdb/observability'

/**
 * Error mapping of the adapter ([postgres-adapter.md §7](../../../exponetdb-docs/03-database-model/postgres-adapter.md#7-error-mapping)).
 *
 * Every failure that leaves `packages/postgres` is a {@link TargetError}
 * with an ExponetDB catalog code, a stable `reason` and, for server errors,
 * the SQLSTATE. The server's `MESSAGE`, `HINT`, `POSITION` and object
 * names are kept in separate fields for callers that are allowed to see
 * them (redacted first); PostgreSQL `DETAIL` is dropped here and never
 * stored, because it carries row values. The `Error.message` is a constant.
 */
export type TargetErrorCode =
  | 'TARGET_UNAVAILABLE'
  | 'TARGET_CREDENTIAL_INVALID'
  | 'TARGET_TLS_FAILED'
  | 'TARGET_IDENTITY_MISMATCH'
  | 'CLUSTER_IDENTITY_MISMATCH'
  | 'QUERY_TIMEOUT'
  | 'QUERY_NOT_READ_ONLY'
  | 'QUERY_PARSE_ERROR'
  | 'PERMISSION_DENIED'
  | 'MIGRATION_LOCK_TIMEOUT'
  | 'CAPABILITY_UNAVAILABLE'
  /** Any other server error: SQLSTATE and the kept fields, mapped to INTERNAL at the edge. */
  | 'TARGET_SQL_ERROR'

export type TargetErrorReason =
  | 'connect_refused'
  | 'connect_timeout'
  | 'connection_lost'
  | 'dns_failed'
  | 'server_shutdown'
  | 'too_many_connections'
  | 'auth_failed'
  /** The server asked for the password in cleartext or as MD5; nothing was sent. */
  | 'auth_method'
  | 'superuser_login'
  | 'tls_unavailable'
  | 'tls_unverified'
  | 'tls_hostname'
  | 'tls_expired'
  | 'tls_other'
  | 'circuit_open'
  | 'budget_exhausted'
  | 'session_closed'
  | 'query_timeout'
  | 'statement_timeout'
  | 'lock_timeout'
  | 'read_only'
  | 'syntax'
  | 'insufficient_privilege'
  | 'system_identifier'
  | 'database_name'
  | 'marker_missing'
  | 'marker_mismatch'
  | 'server_error'
  | 'protocol'
  | 'unsupported_version'

const MESSAGES: Readonly<Record<TargetErrorCode, string>> = {
  TARGET_UNAVAILABLE: 'The target did not answer.',
  TARGET_CREDENTIAL_INVALID: 'The target refused the credential.',
  TARGET_TLS_FAILED: 'TLS verification of the target failed.',
  TARGET_IDENTITY_MISMATCH: 'The database is not the registered target.',
  CLUSTER_IDENTITY_MISMATCH: 'The cluster is not the registered cluster.',
  QUERY_TIMEOUT: 'The statement timed out.',
  QUERY_NOT_READ_ONLY: 'The statement tried to write.',
  QUERY_PARSE_ERROR: 'The statement was not understood by the server.',
  PERMISSION_DENIED: 'The database role lacks a privilege.',
  MIGRATION_LOCK_TIMEOUT: 'A lock was not granted in time.',
  CAPABILITY_UNAVAILABLE: 'The server does not offer what this needs.',
  TARGET_SQL_ERROR: 'The target returned an error.',
}

export interface ServerFields {
  readonly message?: string
  readonly hint?: string
  readonly position?: number
  readonly schema?: string
  readonly table?: string
  readonly column?: string
  readonly constraint?: string
}

export class TargetError extends SafeError {
  override readonly name = 'TargetError'
  override readonly code: TargetErrorCode
  readonly reason: TargetErrorReason
  readonly sqlstate: string | undefined
  /** Server fields without DETAIL; untrusted text, redact before display. */
  readonly server: ServerFields
  /** `details.databasePrivilege` for 42501: a database privilege, not an ExponetDB authorization. */
  readonly databasePrivilege: boolean

  constructor(
    code: TargetErrorCode,
    reason: TargetErrorReason,
    options: {
      readonly sqlstate?: string
      readonly server?: ServerFields
      readonly cause?: unknown
    } = {},
  ) {
    // The cause is dropped on purpose: a driver error can carry DETAIL or a connection string.
    super(code, MESSAGES[code])
    this.code = code
    this.reason = reason
    this.sqlstate = options.sqlstate
    this.server = options.server ?? {}
    this.databasePrivilege = code === 'PERMISSION_DENIED'
  }
}

const TLS_CODES: Readonly<Record<string, TargetErrorReason>> = {
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'tls_unverified',
  UNABLE_TO_GET_ISSUER_CERT: 'tls_unverified',
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: 'tls_unverified',
  SELF_SIGNED_CERT_IN_CHAIN: 'tls_unverified',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'tls_unverified',
  CERT_SIGNATURE_FAILURE: 'tls_unverified',
  CERT_UNTRUSTED: 'tls_unverified',
  CERT_REJECTED: 'tls_unverified',
  INVALID_CA: 'tls_unverified',
  ERR_TLS_CERT_ALTNAME_INVALID: 'tls_hostname',
  HOSTNAME_MISMATCH: 'tls_hostname',
  CERT_HAS_EXPIRED: 'tls_expired',
  CERT_NOT_YET_VALID: 'tls_expired',
}

const NETWORK_CODES: Readonly<Record<string, TargetErrorReason>> = {
  ECONNREFUSED: 'connect_refused',
  ECONNRESET: 'connection_lost',
  EPIPE: 'connection_lost',
  ETIMEDOUT: 'connect_timeout',
  EHOSTUNREACH: 'connect_refused',
  ENETUNREACH: 'connect_refused',
  ENOTFOUND: 'dns_failed',
  EAI_AGAIN: 'dns_failed',
}

function text(value: unknown, max = 1024): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, max) : undefined
}

function serverFields(e: Record<string, unknown>): ServerFields {
  const position = typeof e['position'] === 'string' ? Number(e['position']) : undefined
  const fields: Record<string, string | number> = {}
  const add = (key: keyof ServerFields, value: string | number | undefined) => {
    if (value !== undefined) fields[key] = value
  }
  add('message', text(e['message']))
  add('hint', text(e['hint']))
  add('position', position !== undefined && Number.isInteger(position) ? position : undefined)
  add('schema', text(e['schema'], 128))
  add('table', text(e['table'], 128))
  add('column', text(e['column'], 128))
  add('constraint', text(e['constraint'], 128))
  return fields
}

const SQLSTATE = /^[0-9A-Z]{5}$/

/**
 * Maps anything the driver throws to a {@link TargetError}. `phase`
 * distinguishes a failure while connecting (where an unknown error is an
 * unavailable target) from one while querying.
 */
export function mapDriverError(
  error: unknown,
  phase: 'connect' | 'query',
  context: { readonly lockPath?: 'migration' | 'read' } = {},
): TargetError {
  if (error instanceof TargetError) {
    return error
  }
  const e: Record<string, unknown> =
    typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : {}
  const code = typeof e['code'] === 'string' ? e['code'] : undefined
  const message = typeof e['message'] === 'string' ? e['message'] : ''
  if (code !== undefined && SQLSTATE.test(code) && 'severity' in e) {
    return mapSqlstate(code, serverFields(e), context)
  }
  if (code !== undefined && Object.hasOwn(TLS_CODES, code)) {
    return new TargetError('TARGET_TLS_FAILED', TLS_CODES[code] ?? 'tls_other')
  }
  if (code !== undefined && (code.startsWith('ERR_SSL') || code.startsWith('ERR_TLS'))) {
    return new TargetError('TARGET_TLS_FAILED', 'tls_other')
  }
  if (message === 'The server does not support SSL connections') {
    return new TargetError('TARGET_TLS_FAILED', 'tls_unavailable')
  }
  if (code !== undefined && Object.hasOwn(NETWORK_CODES, code)) {
    return new TargetError('TARGET_UNAVAILABLE', NETWORK_CODES[code] ?? 'connection_lost')
  }
  if (/timeout/i.test(message)) {
    return new TargetError(
      phase === 'connect' ? 'TARGET_UNAVAILABLE' : 'QUERY_TIMEOUT',
      phase === 'connect' ? 'connect_timeout' : 'query_timeout',
    )
  }
  if (/terminated|closed|ended|not queryable/i.test(message)) {
    return new TargetError('TARGET_UNAVAILABLE', 'connection_lost')
  }
  return new TargetError('TARGET_UNAVAILABLE', 'protocol')
}

function mapSqlstate(
  sqlstate: string,
  server: ServerFields,
  context: { readonly lockPath?: 'migration' | 'read' },
): TargetError {
  const opts = { sqlstate, server }
  if (sqlstate.startsWith('08') || ['57P01', '57P02', '57P03', '53300'].includes(sqlstate)) {
    return new TargetError(
      'TARGET_UNAVAILABLE',
      sqlstate.startsWith('57P')
        ? 'server_shutdown'
        : sqlstate === '53300'
          ? 'too_many_connections'
          : 'connection_lost',
      opts,
    )
  }
  if (sqlstate === '28P01' || sqlstate === '28000') {
    return new TargetError('TARGET_CREDENTIAL_INVALID', 'auth_failed', opts)
  }
  if (sqlstate === '55P03') {
    return context.lockPath === 'migration'
      ? new TargetError('MIGRATION_LOCK_TIMEOUT', 'lock_timeout', opts)
      : new TargetError('QUERY_TIMEOUT', 'lock_timeout', opts)
  }
  if (sqlstate === '57014') {
    const lock = /lock timeout/i.test(server.message ?? '')
    if (lock && context.lockPath === 'migration') {
      return new TargetError('MIGRATION_LOCK_TIMEOUT', 'lock_timeout', opts)
    }
    return new TargetError('QUERY_TIMEOUT', lock ? 'lock_timeout' : 'statement_timeout', opts)
  }
  if (sqlstate === '25006') {
    return new TargetError('QUERY_NOT_READ_ONLY', 'read_only', opts)
  }
  if (sqlstate === '42501') {
    return new TargetError('PERMISSION_DENIED', 'insufficient_privilege', opts)
  }
  if (sqlstate.startsWith('42')) {
    return new TargetError('QUERY_PARSE_ERROR', 'syntax', opts)
  }
  return new TargetError('TARGET_SQL_ERROR', 'server_error', opts)
}
