import type { OAuthErrorCode } from '@exponetdb/contracts'

/**
 * A normative OAuth error of a protocol endpoint (RFC 6749 §5.2, RFC 7009
 * §2.2.1, RFC 7591 §3.2.2, RFC 8628 §3.5, RFC 8707 §2): an `error` code and
 * a fixed description written here, never request text. The protocol
 * endpoints answer with `{ "error": … }`, never an RFC 9457 problem.
 */
export class OAuthError extends Error {
  override readonly name = 'OAuthError'
  readonly error: OAuthErrorCode
  readonly status: number
  readonly description: string | undefined
  readonly retryAfterSeconds: number | undefined

  constructor(
    error: OAuthErrorCode,
    options: {
      readonly description?: string
      readonly status?: number
      readonly retryAfterSeconds?: number
    } = {},
  ) {
    super(error)
    this.error = error
    this.description = options.description
    this.retryAfterSeconds = options.retryAfterSeconds
    this.status =
      options.status ??
      (error === 'invalid_client'
        ? 401
        : error === 'server_error'
          ? 500
          : error === 'temporarily_unavailable'
            ? 503
            : 400)
  }
}

/** Too many protocol requests from one source: 429 with `Retry-After`. */
export function rateLimited(retryAfterSeconds: number): OAuthError {
  return new OAuthError('temporarily_unavailable', {
    status: 429,
    description: 'Too many requests. Retry later.',
    retryAfterSeconds: Math.max(1, Math.ceil(retryAfterSeconds)),
  })
}

/**
 * Why an authorization request is answered with a local error page instead
 * of a redirect: the client or its redirect URI could not be established,
 * so redirecting would make ExponetDB an open redirector (RFC 6749 §4.1.2.1).
 */
export type AuthorizeLocalError =
  | 'request_invalid'
  | 'client_unknown'
  | 'client_not_approved'
  | 'client_unsupported'
  | 'redirect_uri_invalid'
  | 'rate_limited'
  | 'unavailable'
