/**
 * Errors the Web App shows. A server error is an RFC 9457 problem whose
 * `code` is stable and whose `message` comes from the server's error
 * catalog, so it is shown as it is with the code. Errors the browser itself
 * produces carry fixed client codes and fixed text; exception text is never
 * shown.
 */
export const CLIENT_CODES = {
  NETWORK: 'NETWORK',
  UNKNOWN: 'UNKNOWN',
  REAUTH_CANCELED: 'REAUTH_CANCELED',
  RESPONSE_INVALID: 'RESPONSE_INVALID',
} as const

export class ApiError extends Error {
  override readonly name = 'ApiError'
  readonly code: string
  readonly status: number
  readonly retryAfterSeconds: number | undefined
  readonly details: unknown

  constructor(
    code: string,
    status: number,
    message: string,
    retryAfterSeconds?: number,
    details?: unknown,
  ) {
    super(message)
    this.code = code
    this.status = status
    this.retryAfterSeconds = retryAfterSeconds
    this.details = details
  }
}

export const networkError = (): ApiError =>
  new ApiError(CLIENT_CODES.NETWORK, 0, 'The server could not be reached.')

export const canceledError = (): ApiError =>
  new ApiError(CLIENT_CODES.REAUTH_CANCELED, 0, 'Canceled. Nothing was changed.')

/** An RFC 9457 problem body turned into an `ApiError`; anything else is a fixed failure. */
export function problemOf(status: number, body: unknown, retryAfter: string | null): ApiError {
  const record = typeof body === 'object' && body !== null ? body : {}
  const code =
    'code' in record &&
    typeof record.code === 'string' &&
    /^[A-Z][A-Z0-9_]{1,63}$/.test(record.code)
      ? record.code
      : CLIENT_CODES.UNKNOWN
  const message =
    code !== CLIENT_CODES.UNKNOWN && 'message' in record && typeof record.message === 'string'
      ? record.message
      : 'The request failed.'
  const seconds = retryAfter === null ? Number.NaN : Number(retryAfter)
  return new ApiError(
    code,
    status,
    message,
    Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined,
    'details' in record ? record.details : undefined,
  )
}

/** Whether an error means the session is gone and the person must sign in again. */
export function isSessionGone(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.code === 'SESSION_EXPIRED' || error.code === 'UNAUTHENTICATED')
  )
}
