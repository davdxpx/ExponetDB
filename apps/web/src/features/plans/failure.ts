import { ApiError, CLIENT_CODES } from '../../lib/api/errors.ts'
import { t } from '../../lib/i18n/i18n.ts'

/**
 * The error a confirmation dialog of the ladder shows when its action fails:
 * the dialog prints the message and the stable code, so the message must be
 * catalog text or fixed text, never an exception message. A server problem
 * keeps its catalog message; the browser's own failures (network, a canceled
 * re-authentication, an unreadable answer, a closed passkey prompt) and a
 * rate limit with its retry time get the fixed texts of the message catalog.
 */
export function actionError(error: unknown): ApiError {
  if (error instanceof ApiError) {
    switch (error.code) {
      case CLIENT_CODES.NETWORK:
        return new ApiError(error.code, error.status, t('error.network'))
      case CLIENT_CODES.REAUTH_CANCELED:
        return new ApiError(error.code, error.status, t('reauth.canceled'))
      case CLIENT_CODES.RESPONSE_INVALID:
        return new ApiError(error.code, error.status, t('error.responseInvalid'))
      case CLIENT_CODES.UNKNOWN:
        return new ApiError(error.code, error.status, t('error.unknown'))
      case 'RATE_LIMITED':
        if (error.retryAfterSeconds !== undefined) {
          return new ApiError(
            error.code,
            error.status,
            t('error.rateLimited', { seconds: Math.ceil(error.retryAfterSeconds) }),
          )
        }
        return error
      default:
        return error
    }
  }
  if (error instanceof Error && error.name === 'PasskeyCanceled') {
    return new ApiError('PASSKEY_CANCELED', 0, t('passkey.canceled'))
  }
  return new ApiError(CLIENT_CODES.UNKNOWN, 0, t('error.unknown'))
}
