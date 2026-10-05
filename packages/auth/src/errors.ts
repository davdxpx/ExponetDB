import { type ErrorCode, errorDefinition } from '@exponetdb/contracts'

/**
 * Auth errors carry a stable code of the error catalog
 * ([error-model.md](../../../exponetdb-docs/02-control-plane/error-model.md));
 * the message is the catalog's fixed text, never library or request text.
 * Refusals that no interface shows (configuration, operator commands) have
 * their own lower-case codes. A cause is kept for logs that print only its
 * class, never its message.
 */
export type InternalAuthCode =
  | 'auth_configuration_invalid'
  | 'auth_key_unavailable'
  | 'role_catalog_mismatch'
  | 'bootstrap_closed'
  | 'bootstrap_pending'
  | 'bootstrap_email_taken'
  | 'recovery_no_owner'
  | 'recovery_other_owner'
  | 'recovery_reason_invalid'

const INTERNAL_MESSAGES: Readonly<Record<InternalAuthCode, string>> = {
  auth_configuration_invalid: 'The authentication configuration is invalid.',
  auth_key_unavailable: 'An installation key of the auth consumer is unavailable.',
  role_catalog_mismatch: 'The stored role matrix differs from the matrix of this release.',
  bootstrap_closed: 'An active owner exists; the first-owner bootstrap is closed.',
  bootstrap_pending:
    'A first owner is waiting for setup. Issue a new link explicitly with --reissue.',
  bootstrap_email_taken: 'Another identity already uses this e-mail address.',
  recovery_no_owner: 'The e-mail address does not belong to an active owner.',
  recovery_other_owner:
    'Another active owner exists. Use the administrative flow in the Web App instead.',
  recovery_reason_invalid: 'A written reason of 20 to 1000 characters is required.',
}

function isInternal(code: string): code is InternalAuthCode {
  return Object.hasOwn(INTERNAL_MESSAGES, code)
}

export interface AuthErrorDetails {
  readonly [key: string]: string | number | boolean | null | readonly string[]
}

export class AuthError extends Error {
  override readonly name = 'AuthError'
  readonly code: ErrorCode | InternalAuthCode
  readonly details: AuthErrorDetails | undefined

  constructor(
    code: ErrorCode | InternalAuthCode,
    options: { details?: AuthErrorDetails; cause?: unknown } = {},
  ) {
    super(
      isInternal(code) ? INTERNAL_MESSAGES[code] : errorDefinition(code).message,
      options.cause === undefined ? undefined : { cause: options.cause },
    )
    this.code = code
    this.details = options.details
  }
}

export function isAuthError(error: unknown, code?: AuthError['code']): error is AuthError {
  return error instanceof AuthError && (code === undefined || error.code === code)
}
