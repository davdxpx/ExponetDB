import { sign as cryptoSign, verify as cryptoVerify, timingSafeEqual } from 'node:crypto'
import { sha256Hex } from '../hash/index.ts'
import { canonicalBytes } from '../jcs.ts'
import type { JsonObject, JsonValue } from '../json.ts'
import { isJsonObject } from '../json.ts'
import { b64u, ed25519PrivateKey, ed25519PublicKey, fromB64uOf } from './encoding.ts'

/**
 * Ed25519 signatures over canonical JSON, the job envelope signature v1 and
 * key fingerprints ([protocol.md §7.1, §7.2](../../../../exponetdb-docs/07-node-agent/protocol.md#72-job-signature-v1)).
 */

/** `"sha256:" + hex(SHA-256(raw public key))`. */
export function keyFingerprint(rawPublicKey: Uint8Array): string {
  return `sha256:${sha256Hex(rawPublicKey)}`
}

/** Constant-time equality of two fingerprints (or any two strings of public values). */
export function sameFingerprint(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8')
  const y = Buffer.from(b, 'utf8')
  return x.length === y.length && timingSafeEqual(x, y)
}

function jcsBytes(value: JsonValue): Uint8Array {
  const bytes = canonicalBytes(value)
  if (!bytes.ok) {
    throw new TypeError(`not canonicalizable: ${bytes.error.code}`)
  }
  return bytes.value
}

/** Ed25519 over JCS(value) with the key derived from `seed`, as base64url. */
export function signCanonical(seed: Uint8Array, value: JsonValue): string {
  return b64u(cryptoSign(null, jcsBytes(value), ed25519PrivateKey(seed)))
}

/** Verifies a base64url Ed25519 signature over JCS(value) with a raw public key. */
export function verifyCanonical(
  rawPublicKey: Uint8Array,
  value: JsonValue,
  signature: string,
): boolean {
  const sig = fromB64uOf(signature, 64)
  if (sig === undefined || rawPublicKey.length !== 32) {
    return false
  }
  try {
    return cryptoVerify(null, jcsBytes(value), ed25519PublicKey(rawPublicKey), sig)
  } catch {
    return false
  }
}

/** A trusted job-signing key: its id and raw public key. */
export interface TrustedJobKey {
  readonly keyId: string
  readonly publicKey: Uint8Array
}

/** The members a job envelope signature covers: everything but `signature`. */
export function jobSigningValue(envelope: JsonObject): JsonObject {
  const out: Record<string, JsonValue> = {}
  for (const [name, value] of Object.entries(envelope)) {
    if (name !== 'signature') {
      out[name] = value
    }
  }
  return out
}

/** Signs a job envelope (v1): the returned envelope carries `signature`. */
export function signJobEnvelope(envelope: JsonObject, keyId: string, seed: Uint8Array): JsonObject {
  const unsigned = jobSigningValue(envelope)
  return {
    ...unsigned,
    signature: { alg: 'Ed25519', keyId, value: signCanonical(seed, unsigned) },
  }
}

export type JobSignatureCheck =
  | { readonly ok: true; readonly keyId: string }
  | { readonly ok: false; readonly reason: 'signature_invalid' | 'unknown_signing_key' }

/**
 * Verifies a job envelope's v1 signature against the trusted key that its
 * `keyId` names; any other trusted key is never tried.
 */
export function verifyJobEnvelope(
  envelope: JsonObject,
  trusted: readonly TrustedJobKey[],
): JobSignatureCheck {
  const signature = envelope['signature']
  if (!isJsonObject(signature) || signature['alg'] !== 'Ed25519') {
    return { ok: false, reason: 'signature_invalid' }
  }
  const keyId = signature['keyId']
  const value = signature['value']
  const key = trusted.find((k) => k.keyId === keyId)
  if (typeof keyId !== 'string' || key === undefined) {
    return { ok: false, reason: 'unknown_signing_key' }
  }
  if (
    typeof value !== 'string' ||
    !verifyCanonical(key.publicKey, jobSigningValue(envelope), value)
  ) {
    return { ok: false, reason: 'signature_invalid' }
  }
  return { ok: true, keyId }
}
