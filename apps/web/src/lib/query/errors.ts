import { ApiError, CLIENT_CODES } from '../api/errors.ts'

/**
 * One classifier for every failed read, so components never inspect codes
 * or messages themselves (no regex in components). The kind decides the
 * named state a page renders; the code and message are shown as they are.
 */
export type FailureKind =
  | 'not_permitted'
  | 'not_found'
  | 'session'
  | 'network'
  | 'unavailable'
  | 'rate_limited'
  | 'invalid'
  | 'failed'

export interface Failure {
  readonly kind: FailureKind
  readonly code: string
  readonly message: string
}

const NOT_PERMITTED = new Set([
  'FORBIDDEN',
  'PERMISSION_DENIED',
  'SCOPE_MISSING',
  'INSUFFICIENT_SCOPE',
])
const SESSION = new Set(['SESSION_EXPIRED', 'UNAUTHENTICATED'])

export function classifyFailure(error: unknown): Failure {
  if (!(error instanceof ApiError)) {
    return { kind: 'failed', code: CLIENT_CODES.UNKNOWN, message: 'The read failed.' }
  }
  const base = { code: error.code, message: error.message }
  if (error.code === CLIENT_CODES.NETWORK) return { kind: 'network', ...base }
  if (SESSION.has(error.code)) return { kind: 'session', ...base }
  if (error.code === 'RATE_LIMITED' || error.status === 429)
    return { kind: 'rate_limited', ...base }
  if (error.status === 403 || NOT_PERMITTED.has(error.code))
    return { kind: 'not_permitted', ...base }
  if (error.status === 404 || error.code.endsWith('_NOT_FOUND') || error.code === 'NOT_FOUND') {
    return { kind: 'not_found', ...base }
  }
  if (error.status === 502 || error.status === 503 || error.status === 504) {
    return { kind: 'unavailable', ...base }
  }
  if (error.status === 400 || error.status === 422) return { kind: 'invalid', ...base }
  return { kind: 'failed', ...base }
}

/** Whether a failed read may be tried again by the query cache (never a 4xx). */
export function isRetryable(error: unknown): boolean {
  const kind = classifyFailure(error).kind
  return kind === 'network' || kind === 'unavailable'
}
