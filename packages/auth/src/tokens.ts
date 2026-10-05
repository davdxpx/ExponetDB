import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * Opaque bearer-style secrets (session cookies, CSRF tokens, one-time
 * links, ceremony handles): a recognizable prefix (for leak detection and
 * log redaction) and 256 random bits from the CSPRNG. Only a hash is ever
 * stored: SHA-256 with domain separation by kind, which is sufficient for
 * high-entropy values (no password hashing needed) and makes a hash of one
 * kind useless as another.
 */
export const TOKEN_PREFIXES = {
  session: 'exst',
  csrf: 'exck',
  setup: 'exsu',
  invitation: 'exiv',
  recovery: 'exrc',
  ceremony: 'exch',
} as const
export type TokenKind = keyof typeof TOKEN_PREFIXES

const TOKEN_BODY = /^[A-Za-z0-9_-]{43}$/

export function newToken(kind: TokenKind): string {
  return `${TOKEN_PREFIXES[kind]}_${randomBytes(32).toString('base64url')}`
}

/** `sha256:<hex>` of the token under its kind (never stored in plaintext). */
export function tokenHash(kind: TokenKind | 'recovery_code', token: string): string {
  const digest = createHash('sha256')
    .update(`exponetdb/auth-token/v1\n${kind}\n${token}`, 'utf8')
    .digest('hex')
  return `sha256:${digest}`
}

/** The token when `value` has exactly the shape of a token of `kind`, else undefined. */
export function parseToken(kind: TokenKind, value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length !== TOKEN_PREFIXES[kind].length + 44) {
    return undefined
  }
  const prefix = `${TOKEN_PREFIXES[kind]}_`
  return value.startsWith(prefix) && TOKEN_BODY.test(value.slice(prefix.length)) ? value : undefined
}

/** Constant-time comparison of two strings (false for different lengths). */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  return left.length === right.length && timingSafeEqual(left, right)
}
