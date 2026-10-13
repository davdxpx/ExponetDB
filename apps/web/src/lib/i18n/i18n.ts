import { ApiError, CLIENT_CODES } from '../api/errors.ts'
import { type Catalog, en, type MessageKey } from './en.ts'

export type { MessageKey } from './en.ts'

export type MessageParams = Readonly<Record<string, string | number>>

let catalog: Catalog = en

/** Replaces the active catalog (a later German catalog; tests). */
export function useCatalog(next: Catalog): void {
  catalog = next
}

/**
 * The text of a message key with `{name}` placeholders filled. Placeholders
 * without a value stay visible (a missing parameter is a bug that shows,
 * never a silent blank). The result is plain text; React renders it as text.
 */
export function t(key: MessageKey, params: MessageParams = {}): string {
  return catalog[key].replace(/\{([A-Za-z]+)\}/g, (whole, name: string) => {
    const value = params[name]
    return value === undefined ? whole : String(value)
  })
}

/**
 * What the page shows for an error: the server's catalog message with its
 * stable code, a fixed text for network and unknown failures and for a
 * canceled confirmation, and the retry time for rate limits. Exception text
 * is never shown.
 */
export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case CLIENT_CODES.NETWORK:
        return t('error.network')
      case CLIENT_CODES.REAUTH_CANCELED:
        return t('reauth.canceled')
      case CLIENT_CODES.RESPONSE_INVALID:
        return t('error.responseInvalid')
      case CLIENT_CODES.UNKNOWN:
        return t('error.unknown')
      case 'RATE_LIMITED':
        if (error.retryAfterSeconds !== undefined) {
          return t('error.rateLimited', { seconds: Math.ceil(error.retryAfterSeconds) })
        }
        break
    }
    return t('error.withCode', { message: error.message, code: error.code })
  }
  if (error instanceof Error && error.name === 'PasskeyCanceled') {
    return t('passkey.canceled')
  }
  return t('error.unknown')
}
