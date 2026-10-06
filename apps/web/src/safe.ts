/**
 * Pure helpers that decide what the page trusts: where to go after sign-in,
 * which link token a page accepts, and the CSRF token. No DOM access here,
 * so the rules are unit-tested.
 */

/** The pages of the single page app (the server answers each with the page itself). */
export const PAGES = [
  '/',
  '/login',
  '/setup',
  '/invite',
  '/recover',
  '/account',
  '/approvals',
  '/oauth/consent',
  '/oauth/device',
  '/oauth/error',
  '/admin/clients',
  '/admin/service-accounts',
] as const
export type Page = (typeof PAGES)[number]

export function pageOf(pathname: string): Page | undefined {
  return PAGES.find((p) => p === pathname)
}

const DEFAULT_RETURN = '/account'
const OPERATION_FRAGMENT = /^#operation=op_[0-9A-HJKMNP-TV-Z]{26}$/
const REQUEST_FRAGMENT = /^#request=exar_[A-Za-z0-9_-]{43}$/

/** The authorization-request handle of the consent page's fragment, or undefined. */
export function requestHandle(hash: string): string | undefined {
  return REQUEST_FRAGMENT.test(hash) ? hash.slice('#request='.length) : undefined
}

/** Why the authorization endpoint sent the browser to the error page (fixed reasons only). */
export const AUTHORIZE_ERRORS = {
  request_invalid: 'The sign-in request of the application is not valid.',
  client_unknown: 'The application is not registered with this ExponetDB installation.',
  client_not_approved:
    'The application is registered but not approved by an administrator, or its metadata changed since the approval.',
  client_unsupported: 'This application cannot sign in this way.',
  redirect_uri_invalid:
    'The application asked to return to an address it did not register. Nothing was sent to it.',
  rate_limited: 'Too many sign-in requests. Try again in a minute.',
  unavailable: 'ExponetDB cannot process sign-in requests right now. Try again later.',
} as const

export function authorizeError(search: string): string {
  const reason = new URLSearchParams(search).get('reason')
  const known = Object.entries(AUTHORIZE_ERRORS).find(([key]) => key === reason)
  return known?.[1] ?? 'The sign-in request could not be processed.'
}

/**
 * Where to go after sign-in: only fixed pages of this origin (account,
 * approvals optionally with an operation fragment, the OAuth consent page
 * with a request handle, device verification, the administration pages).
 * Anything else, including absolute or protocol-relative URLs, backslashes
 * and encoded tricks, falls back to the account page (no open redirect).
 */
export function safeReturnTo(value: string | null | undefined): string {
  if (value === null || value === undefined) {
    return DEFAULT_RETURN
  }
  const hashAt = value.indexOf('#')
  const path = hashAt === -1 ? value : value.slice(0, hashAt)
  const fragment = hashAt === -1 ? '' : value.slice(hashAt)
  if (
    (path === '/account' ||
      path === '/oauth/device' ||
      path === '/admin/clients' ||
      path === '/admin/service-accounts') &&
    fragment === ''
  ) {
    return path
  }
  // A pending authorization request survives the sign-in (its handle alone is useless without the browser binding).
  if (path === '/oauth/consent' && REQUEST_FRAGMENT.test(fragment)) {
    return path + fragment
  }
  if (path === '/approvals' && (fragment === '' || OPERATION_FRAGMENT.test(fragment))) {
    return path + fragment
  }
  return DEFAULT_RETURN
}

/** The login page that returns to `current` afterwards (when it is a safe target). */
export function loginUrl(current: string): string {
  const target = safeReturnTo(current)
  return target === DEFAULT_RETURN ? '/login' : `/login?returnTo=${encodeURIComponent(target)}`
}

export type LinkPage = '/setup' | '/invite' | '/recover'

const LINK_PREFIX: Readonly<Record<LinkPage, string>> = {
  '/setup': 'exsu_',
  '/invite': 'exiv_',
  '/recover': 'exrc_',
}

/**
 * The one-time token of a setup, invitation or recovery link. It travels in
 * the fragment (never sent to a server in a URL) and must carry the prefix
 * of the page it was opened on.
 */
export function linkToken(page: LinkPage, hash: string): string | undefined {
  const m = /^#token=(ex(?:su|iv|rc)_[A-Za-z0-9_-]{43})$/.exec(hash)
  const token = m?.[1]
  return token?.startsWith(LINK_PREFIX[page]) === true ? token : undefined
}

export const CSRF_COOKIE = '__Host-exdb_csrf'
export const CSRF_HEADER = 'x-csrf-token'

/** The CSRF token from `document.cookie` (the CSRF cookie is readable on purpose; the session cookie is not). */
export function csrfToken(cookies: string): string | undefined {
  for (const part of cookies.split(';')) {
    const eq = part.indexOf('=')
    if (eq !== -1 && part.slice(0, eq).trim() === CSRF_COOKIE) {
      const value = part.slice(eq + 1).trim()
      return /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : undefined
    }
  }
  return undefined
}

/** SVG path data of a QR matrix (rows of `0`/`1`), one unit per module, offset by the quiet zone. */
export function qrPath(rows: readonly string[], quiet = 4): string {
  const parts: string[] = []
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (row[x] === '1') {
        parts.push(`M${x + quiet} ${y + quiet}h1v1h-1z`)
      }
    }
  })
  return parts.join('')
}

/** A base32 secret in groups of four for reading aloud or typing. */
export function groupSecret(secret: string): string {
  return (secret.match(/.{1,4}/g) ?? []).join(' ')
}
