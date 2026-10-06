/**
 * Every SDK call returns a `Result` (sdk.md §3): a failed call is an error
 * with a stable code, never an empty list or a missing value, mirroring the
 * server's truthfulness rules (C-28).
 */
export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ApiError }

/**
 * Codes from the server's error catalog (`code` of the problem document),
 * plus the SDK's own:
 *
 * - `TRANSPORT_FAILED`: no answer (network, DNS, TLS, timeout); the request
 *   may or may not have reached the server;
 * - `RESPONSE_INVALID`: an answer the SDK could not read as the contract's;
 * - `CLIENT_AUTHENTICATION_FAILED`: the token endpoint refused the service
 *   account's assertion (its OAuth error code is in `details.error`).
 */
export interface ApiError {
  readonly code: string
  /** HTTP status, or null when no answer arrived. */
  readonly status: number | null
  /** The server's request id, when it answered. */
  readonly requestId: string | null
  /**
   * Whether the same request may succeed when sent again unchanged: the
   * catalog's flag for a server answer; for `TRANSPORT_FAILED` only on a
   * `GET` (a mutation that did not answer may have run).
   */
  readonly retryable: boolean
  readonly title?: string
  /** The catalog's message for the code (English, never database text). */
  readonly message?: string
  /** Structured details of the catalog entry (never free text from a database). */
  readonly details?: unknown
  readonly remediation?: string
  readonly operationId?: string
  readonly planId?: string
  /** From `Retry-After` on 429 and 503. */
  readonly retryAfterSeconds?: number
}

export const ok = <T>(value: T): Result<T> => ({ ok: true, value })
export const err = <T = never>(error: ApiError): Result<T> => ({ ok: false, error })
