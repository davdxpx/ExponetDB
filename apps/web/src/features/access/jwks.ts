import type { Body } from '../../lib/api/client.ts'

/**
 * The public keys a person pastes for a service account's client
 * (identity.md §5: EC P-256/P-384, Ed25519, RSA; public members only). The
 * page accepts a JWKS (`{"keys": [...]}`), a bare array of keys or one key.
 * A key with a private member (`d`, `p`, `q`, …), a symmetric key (`k`) or a
 * PEM private key block is refused here, before anything is sent: a private
 * key never leaves the browser, and the field holding it is cleared by the
 * caller. The server
 * validates every key again (sizes, unique `kid`, at most four).
 */
export type PublicJwks = Body<'registerServiceAccountClient'>['jwks']
export type PublicJwk = PublicJwks['keys'][number]

export type JwksParse =
  | { readonly ok: true; readonly jwks: PublicJwks }
  | { readonly ok: false; readonly reason: 'json' | 'shape' | 'private' }

/** Members that only a private or symmetric key has (RFC 7517, RFC 7518 §6). */
const PRIVATE_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'] as const

const ALGORITHMS = ['ES256', 'ES384', 'EdDSA', 'PS256', 'RS256'] as const
const COMMON = ['kty', 'kid', 'alg', 'use'] as const
const MEMBERS = {
  EC: ['crv', 'x', 'y'],
  OKP: ['crv', 'x'],
  RSA: ['n', 'e'],
} as const

type JsonObject = Readonly<Record<string, unknown>>

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function hasPrivateMember(key: unknown): boolean {
  return isObject(key) && PRIVATE_MEMBERS.some((member) => Object.hasOwn(key, member))
}

/**
 * Whether a value has the shape of a public signing key the server accepts:
 * a known key type with its public members, a `kid`, an allowed `alg` and
 * `use: "sig"` when given, and no other member.
 */
export function isPublicJwk(value: unknown): value is PublicJwk {
  if (!isObject(value) || !isText(value['kid'])) return false
  const kty = value['kty']
  if (kty !== 'EC' && kty !== 'OKP' && kty !== 'RSA') return false
  const own: readonly string[] = MEMBERS[kty]
  const allowed = new Set<string>([...COMMON, ...own])
  if (Object.keys(value).some((member) => !allowed.has(member))) return false
  if (!own.every((member) => isText(value[member]))) return false
  const alg = value['alg']
  if (alg !== undefined && !ALGORITHMS.some((known) => known === alg)) return false
  if (value['use'] !== undefined && value['use'] !== 'sig') return false
  const crv = value['crv']
  if (kty === 'EC') return crv === 'P-256' || crv === 'P-384'
  if (kty === 'OKP') return crv === 'Ed25519'
  return true
}

/** A PEM block of a private key (`-----BEGIN PRIVATE KEY-----`, `EC`, `RSA`, `OPENSSH`, `ENCRYPTED`). */
const PEM_PRIVATE = /-----BEGIN [A-Z ]*PRIVATE KEY-----/

export function parseJwks(text: string): JwksParse {
  if (PEM_PRIVATE.test(text)) {
    return { ok: false, reason: 'private' }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, reason: 'json' }
  }
  const container = isObject(parsed) && Object.hasOwn(parsed, 'keys') ? parsed['keys'] : parsed
  const keys: readonly unknown[] | undefined = Array.isArray(container)
    ? container
    : isObject(container) && Object.hasOwn(container, 'kty')
      ? [container]
      : undefined
  if (keys === undefined || keys.length === 0) {
    return { ok: false, reason: 'shape' }
  }
  // Checked first and on its own: a private key is named as such, whatever else is wrong.
  if (keys.some(hasPrivateMember)) {
    return { ok: false, reason: 'private' }
  }
  const valid = keys.filter(isPublicJwk)
  if (valid.length !== keys.length) {
    return { ok: false, reason: 'shape' }
  }
  return { ok: true, jwks: { keys: valid } }
}
