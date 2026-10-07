import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto'
import { sha256Hex } from '../hash/index.ts'
import { isId } from '../ids.ts'
import { canonicalBytes, canonicalize } from '../jcs.ts'
import type { JsonObject, JsonValue } from '../json.ts'
import { isJsonArray, isJsonObject, parseJson } from '../json.ts'
import { decodeUtf8, encodeUtf8 } from '../utf8.ts'
import { b64u, fromB64u, fromB64uOf } from './encoding.ts'
import { signCanonical, verifyCanonical } from './sign.ts'

/**
 * The enrollment token `exdbt1` and the enrollment and renewal proofs
 * ([protocol.md §7.3, §7.4](../../../../exponetdb-docs/07-node-agent/protocol.md#73-enrollment-token-exdbt1)).
 */

export const TOKEN_PREFIX = 'exdbt1.'
export const TOKEN_SECRET_BYTES = 32
export const TOKEN_MAX_JOB_KEYS = 3

const FINGERPRINT = /^sha256:[0-9a-f]{64}$/
const KEY_ID = /^[a-z][a-z0-9_]{0,63}$/
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/
const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?'
const HOST = `${LABEL}(?:\\.${LABEL})*`
const DNS_NAME = new RegExp(`^(?=.{1,253}$)${HOST}$`)
const GATEWAY = new RegExp(`^https://(${HOST})(?::([1-9][0-9]{0,4}))?$`)
const MEMBERS = [
  'expiresAt',
  'gateway',
  'gatewayServerName',
  'installationId',
  'jobKeys',
  'rootFingerprint',
  'secret',
  'serverId',
  'tokenId',
  'v',
]

export interface TokenJobKey {
  readonly keyId: string
  readonly fingerprint: string
}

export interface EnrollmentToken {
  readonly v: 'exdbt1'
  readonly tokenId: string
  readonly installationId: string
  readonly serverId: string
  readonly gateway: string
  readonly gatewayServerName: string
  readonly rootFingerprint: string
  readonly jobKeys: readonly TokenJobKey[]
  /** The 32-byte secret; never stored, shown once inside the token string. */
  readonly secret: Uint8Array
  readonly expiresAt: string
}

export type TokenRefusal = 'invalid_format' | 'not_canonical' | 'invalid_payload'

export type TokenDecoding =
  | { readonly ok: true; readonly token: EnrollmentToken }
  | { readonly ok: false; readonly reason: TokenRefusal }

function tokenPayload(token: EnrollmentToken): JsonObject {
  return {
    v: token.v,
    tokenId: token.tokenId,
    installationId: token.installationId,
    serverId: token.serverId,
    gateway: token.gateway,
    gatewayServerName: token.gatewayServerName,
    rootFingerprint: token.rootFingerprint,
    jobKeys: token.jobKeys.map((k) => ({ keyId: k.keyId, fingerprint: k.fingerprint })),
    secret: b64u(token.secret),
    expiresAt: token.expiresAt,
  }
}

/** The token string: `exdbt1.` + base64url(JCS(payload)). Refuses an invalid token. */
export function encodeToken(token: EnrollmentToken): string {
  const payload = tokenPayload(token)
  if (validPayload(payload) === undefined) {
    throw new TypeError('not a valid enrollment token')
  }
  const bytes = canonicalBytes(payload)
  if (!bytes.ok) {
    throw new TypeError(`not canonicalizable: ${bytes.error.code}`)
  }
  return TOKEN_PREFIX + b64u(bytes.value)
}

/** `https://host[:port]`: a lowercase DNS name or IPv4 address; port 1 to 65535, never written as 443. */
function isGateway(value: JsonValue | undefined): boolean {
  if (typeof value !== 'string' || value.length > 270) {
    return false
  }
  const m = GATEWAY.exec(value)
  const host = m?.[1]
  const port = m?.[2]
  return (
    m !== null &&
    host !== undefined &&
    host.length <= 253 &&
    (port === undefined || (Number(port) <= 65535 && port !== '443'))
  )
}

const DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

/** RFC 3339 UTC with a real calendar date and time (no leap seconds), the same in every implementation. */
export function isTimestamp(value: JsonValue | undefined): value is string {
  if (typeof value !== 'string' || !TIMESTAMP.test(value)) {
    return false
  }
  const year = Number(value.slice(0, 4))
  const month = Number(value.slice(5, 7))
  const day = Number(value.slice(8, 10))
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
  const days = month === 2 && leap ? 29 : (DAYS[month - 1] ?? 0)
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= days &&
    Number(value.slice(11, 13)) <= 23 &&
    Number(value.slice(14, 16)) <= 59 &&
    Number(value.slice(17, 19)) <= 59
  )
}

function validPayload(doc: JsonValue): EnrollmentToken | undefined {
  if (!isJsonObject(doc)) {
    return undefined
  }
  const names = Object.keys(doc).sort()
  if (names.length !== MEMBERS.length || names.some((n, i) => n !== MEMBERS[i])) {
    return undefined
  }
  const keys = doc['jobKeys']
  const secret =
    typeof doc['secret'] === 'string' ? fromB64uOf(doc['secret'], TOKEN_SECRET_BYTES) : undefined
  const expiresAt = doc['expiresAt']
  if (
    doc['v'] !== 'exdbt1' ||
    !isId('ent', doc['tokenId']) ||
    !isId('ins', doc['installationId']) ||
    !isId('srv', doc['serverId']) ||
    !isGateway(doc['gateway']) ||
    typeof doc['gatewayServerName'] !== 'string' ||
    !DNS_NAME.test(doc['gatewayServerName']) ||
    typeof doc['rootFingerprint'] !== 'string' ||
    !FINGERPRINT.test(doc['rootFingerprint']) ||
    secret === undefined ||
    !isTimestamp(expiresAt) ||
    !isJsonArray(keys) ||
    keys.length < 1 ||
    keys.length > TOKEN_MAX_JOB_KEYS
  ) {
    return undefined
  }
  const jobKeys: TokenJobKey[] = []
  for (const k of keys) {
    if (
      !isJsonObject(k) ||
      Object.keys(k).length !== 2 ||
      typeof k['keyId'] !== 'string' ||
      !KEY_ID.test(k['keyId']) ||
      typeof k['fingerprint'] !== 'string' ||
      !FINGERPRINT.test(k['fingerprint']) ||
      jobKeys.some((j) => j.keyId === k['keyId'])
    ) {
      return undefined
    }
    jobKeys.push({ keyId: k['keyId'], fingerprint: k['fingerprint'] })
  }
  return {
    v: 'exdbt1',
    tokenId: doc['tokenId'],
    installationId: doc['installationId'],
    serverId: doc['serverId'],
    gateway: doc['gateway'] as string,
    gatewayServerName: doc['gatewayServerName'],
    rootFingerprint: doc['rootFingerprint'],
    jobKeys,
    secret,
    expiresAt,
  }
}

/**
 * Decodes a token string strictly: the prefix, canonical base64url, UTF-8,
 * strict JSON whose bytes are exactly its own JCS form, and exactly the
 * documented members.
 */
export function decodeToken(text: string): TokenDecoding {
  if (!text.startsWith(TOKEN_PREFIX) || text.length > 4096) {
    return { ok: false, reason: 'invalid_format' }
  }
  const bytes = fromB64u(text.slice(TOKEN_PREFIX.length))
  const decoded = bytes === undefined ? undefined : decodeUtf8(bytes)
  const json = decoded?.ok ? decoded.value : undefined
  const parsed = json === undefined ? undefined : parseJson(json)
  if (parsed === undefined || !parsed.ok) {
    return { ok: false, reason: 'invalid_format' }
  }
  const canonical = canonicalize(parsed.value)
  if (!canonical.ok || canonical.value !== json) {
    return { ok: false, reason: 'not_canonical' }
  }
  const token = validPayload(parsed.value)
  return token === undefined ? { ok: false, reason: 'invalid_payload' } : { ok: true, token }
}

function hkdf32(secret: Uint8Array, label: string): Uint8Array {
  return new Uint8Array(hkdfSync('sha256', secret, new Uint8Array(0), encodeUtf8(label), 32))
}

/** `k_redeem` and `k_bind` of a token secret (HKDF-SHA-256, empty salt). */
export function tokenKeys(
  secret: Uint8Array,
  tokenId: string,
): { readonly redeem: Uint8Array; readonly bind: Uint8Array } {
  if (secret.length !== TOKEN_SECRET_BYTES) {
    throw new RangeError('a token secret is 32 bytes')
  }
  return {
    redeem: hkdf32(secret, `exponetdb/enroll/redeem/v1:${tokenId}`),
    bind: hkdf32(secret, `exponetdb/enroll/bind/v1:${tokenId}`),
  }
}

/** `"sha256:" + hex(SHA-256(k_redeem))`, the only thing the gateway keeps of a token. */
export function redeemHash(redeemKey: Uint8Array): string {
  return `sha256:${sha256Hex(redeemKey)}`
}

/** Constant-time check of a presented redeem key against the stored hash. */
export function redeemKeyMatches(presented: string, storedHash: string): boolean {
  const key = fromB64uOf(presented, 32)
  if (key === undefined) {
    return false
  }
  const a = Buffer.from(redeemHash(key), 'utf8')
  const b = Buffer.from(storedHash, 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}

export function tlsKeyProofValue(tokenId: string, tlsKey: string): JsonObject {
  return { purpose: 'exponetdb/enroll/tls-pop/v1', tokenId, tlsKey }
}

export function nodeSigningKeyProofValue(tokenId: string, nodeSigningKey: string): JsonObject {
  return { purpose: 'exponetdb/enroll/nsk-pop/v1', tokenId, nodeSigningKey }
}

export interface BindStatement {
  readonly installationId: string
  readonly serverId: string
  readonly tokenId: string
  readonly nodeSigningKey: string
  readonly nodeEncryptionKey: string
}

export function bindValue(s: BindStatement): JsonObject {
  return {
    purpose: 'exponetdb/enroll/bind/v1',
    installationId: s.installationId,
    serverId: s.serverId,
    tokenId: s.tokenId,
    nodeSigningKey: s.nodeSigningKey,
    nodeEncryptionKey: s.nodeEncryptionKey,
  }
}

function hmacB64u(key: Uint8Array, value: JsonObject): string {
  const bytes = canonicalBytes(value)
  if (!bytes.ok) {
    throw new TypeError(`not canonicalizable: ${bytes.error.code}`)
  }
  return b64u(createHmac('sha256', key).update(bytes.value).digest())
}

/** The binding proof a host computes with `k_bind`. */
export function bindProof(bindKey: Uint8Array, statement: BindStatement): string {
  return hmacB64u(bindKey, bindValue(statement))
}

/** The worker's constant-time check of a binding proof. */
export function bindProofMatches(
  bindKey: Uint8Array,
  statement: BindStatement,
  proof: string,
): boolean {
  const expected = Buffer.from(bindProof(bindKey, statement), 'utf8')
  const given = Buffer.from(proof, 'utf8')
  return expected.length === given.length && timingSafeEqual(expected, given)
}

export function renewTlsKeyProofValue(nodeId: string, tlsKey: string): JsonObject {
  return { purpose: 'exponetdb/renew/tls-pop/v1', nodeId, tlsKey }
}

export function renewSignatureValue(nodeId: string, tlsKey: string): JsonObject {
  return { purpose: 'exponetdb/renew/v1', nodeId, tlsKey }
}

export { signCanonical, verifyCanonical }
