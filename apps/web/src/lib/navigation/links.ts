/**
 * What the page trusts in a URL: where to go after sign-in, which one-time
 * token or handle a page accepts from its fragment, and the fixed texts of
 * the authorization error page. Pure functions, no DOM, unit-tested with
 * hostile inputs (the Wave 3A rules of `safe.ts`, extended for the Wave 8
 * routes without ever becoming a prefix match).
 */
const ULID = '[0-7][0-9A-HJKMNP-TV-Z]{25}'
const SLUG = '[a-z][a-z0-9-]{0,38}'

const OPERATION_FRAGMENT = new RegExp(`^#operation=op_${ULID}$`)
const REQUEST_FRAGMENT = /^#request=exar_[A-Za-z0-9_-]{43}$/
const STEP_UP_FRAGMENT = new RegExp(`^#id=stu_${ULID}$`)
const CREDENTIAL_FRAGMENT = new RegExp(
  `^#cluster=cls_${ULID}(?:&role=(?:observer|reader|verifier|operator|migrator))?$`,
)

/** Where a sign-in returns when the requested target is not a safe one. */
export const DEFAULT_RETURN = '/account'

/** The sections of a target (information-architecture.md §2.2), the only ones a return may name. */
export const TARGET_SECTIONS = [
  'schema',
  'migrations',
  'sql',
  'performance',
  'connections',
  'locks',
  'backups',
  'configuration',
  'advisors',
  'activity',
  'findings',
  'drift',
] as const

/** Kinds of schema objects a return may name below `/schema` (never an object's own name). */
export const SCHEMA_KINDS = [
  'schemas',
  'tables',
  'views',
  'materialized-views',
  'functions',
  'triggers',
  'types',
  'sequences',
  'extensions',
  'indexes',
  'policies',
  'privileges',
  'publications',
  'roles',
  'visualizer',
] as const

const alternatives = (values: readonly string[]): string => values.join('|')

/**
 * Every page a sign-in may return to, as whole-path grammars without a
 * query string or fragment. A path matches one of them completely or it is
 * not a return target; there is no prefix rule.
 */
const RETURN_PATHS: readonly RegExp[] = [
  /^\/$/,
  /^\/account$/,
  /^\/oauth\/device$/,
  /^\/admin\/(?:clients|service-accounts)$/,
  /^\/approvals$/,
  /^\/targets$/,
  /^\/changes(?:\/(?:plans|operations|promotion))?$/,
  new RegExp(`^/changes/plans/pln_${ULID}$`),
  new RegExp(`^/changes/operations/op_${ULID}$`),
  /^\/infrastructure\/(?:servers|clusters|nodes|certificates)$/,
  new RegExp(`^/infrastructure/(?:servers/srv|clusters/cls|nodes/nod)_${ULID}$`),
  /^\/backups$/,
  /^\/access\/(?:people|roles|service-accounts|api-keys|oauth-clients|connected-apps)$/,
  /^\/audit$/,
  /^\/settings\/(?:products|environments|policies|notifications|installation)$/,
  /^\/connect$/,
  new RegExp(
    `^/t/${SLUG}/${SLUG}/${SLUG}(?:/(?:${alternatives(TARGET_SECTIONS)})|/schema/(?:${alternatives(SCHEMA_KINDS)}))?$`,
  ),
]

/**
 * Where to go after sign-in: only the pages of this origin listed above,
 * plus the fragment-bound pages with their exact fragment (a pending
 * authorization request, an approval, a CLI step-up, a credential form).
 * Anything else, including absolute or protocol-relative URLs, backslashes,
 * encoded tricks, query strings and unknown fragments, falls back to the
 * account page (no open redirect). The server never interprets `returnTo`.
 */
export function safeReturnTo(value: string | null | undefined): string {
  if (value === null || value === undefined) {
    return DEFAULT_RETURN
  }
  const hashAt = value.indexOf('#')
  const path = hashAt === -1 ? value : value.slice(0, hashAt)
  const fragment = hashAt === -1 ? '' : value.slice(hashAt)
  if (fragment === '' && RETURN_PATHS.some((grammar) => grammar.test(path))) {
    return path
  }
  // A pending authorization request survives the sign-in (its handle alone is useless without the browser binding).
  if (path === '/oauth/consent' && REQUEST_FRAGMENT.test(fragment)) {
    return path + fragment
  }
  if (path === '/approvals' && OPERATION_FRAGMENT.test(fragment)) {
    return path + fragment
  }
  // A CLI step-up (ADR-0026) survives the sign-in; the id alone proves nothing.
  if (path === '/step-up' && STEP_UP_FRAGMENT.test(fragment)) {
    return path + fragment
  }
  // The credential form a CLI opened (cluster and role only, never a secret).
  if (path === '/credentials' && CREDENTIAL_FRAGMENT.test(fragment)) {
    return path + fragment
  }
  return DEFAULT_RETURN
}

/** The sign-in page that returns to `current` afterwards (when it is a safe target). */
export function loginUrl(current: string): string {
  const target = safeReturnTo(current)
  return target === DEFAULT_RETURN ? '/login' : `/login?returnTo=${encodeURIComponent(target)}`
}

/** The operation id of an approvals link (`#operation=op_…`), or undefined. */
export function operationOf(hash: string): string | undefined {
  return OPERATION_FRAGMENT.test(hash) ? hash.slice('#operation='.length) : undefined
}

/** The step-up id of a CLI step-up link (`#id=stu_…`), or undefined. */
export function stepUpOf(hash: string): string | undefined {
  return STEP_UP_FRAGMENT.test(hash) ? hash.slice('#id='.length) : undefined
}

/** The cluster and (optionally) the role a credentials link names, or undefined. */
export function credentialTarget(
  hash: string,
): { readonly cluster: string; readonly role: string | undefined } | undefined {
  if (!CREDENTIAL_FRAGMENT.test(hash)) return undefined
  const params = new URLSearchParams(hash.slice(1))
  return { cluster: params.get('cluster') ?? '', role: params.get('role') ?? undefined }
}

/** The authorization-request handle of the consent page's fragment, or undefined. */
export function requestHandle(hash: string): string | undefined {
  return REQUEST_FRAGMENT.test(hash) ? hash.slice('#request='.length) : undefined
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

export const AUTHORIZE_ERROR_FALLBACK = 'The sign-in request could not be processed.'

/** The fixed text for the error page's `reason`; the query is never echoed. */
export function authorizeError(search: string): string {
  const reason = new URLSearchParams(search).get('reason')
  const known = Object.entries(AUTHORIZE_ERRORS).find(([key]) => key === reason)
  return known?.[1] ?? AUTHORIZE_ERROR_FALLBACK
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
