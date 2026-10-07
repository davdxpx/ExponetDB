import { createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto'

/**
 * Encodings of the node protocol constructions
 * ([protocol.md §7.1](../../../../exponetdb-docs/07-node-agent/protocol.md#71-notation)).
 */

const B64U = /^[A-Za-z0-9_-]*$/

/** base64url without padding (RFC 4648 §5). */
export function b64u(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url')
}

/**
 * Strict base64url decoding: no padding, no other alphabet, and the canonical
 * encoding only (non-zero trailing bits are refused), so a value has exactly
 * one spelling. Returns `undefined` when the text is not such an encoding.
 */
export function fromB64u(text: string): Uint8Array | undefined {
  if (!B64U.test(text) || text.length % 4 === 1) {
    return undefined
  }
  const bytes = new Uint8Array(Buffer.from(text, 'base64url'))
  return b64u(bytes) === text ? bytes : undefined
}

/** {@link fromB64u} that also requires an exact length. */
export function fromB64uOf(text: string, length: number): Uint8Array | undefined {
  const bytes = fromB64u(text)
  return bytes?.length === length ? bytes : undefined
}

const ED25519_PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex')
const ED25519_SPKI = Buffer.from('302a300506032b6570032100', 'hex')
const X25519_PKCS8 = Buffer.from('302e020100300506032b656e04220420', 'hex')
const X25519_SPKI = Buffer.from('302a300506032b656e032100', 'hex')

function exact(bytes: Uint8Array, length: number, what: string): Buffer {
  if (bytes.length !== length) {
    throw new RangeError(`${what} must be ${length} bytes`)
  }
  return Buffer.from(bytes)
}

/** An Ed25519 private key from its 32-byte seed. */
export function ed25519PrivateKey(seed: Uint8Array): KeyObject {
  return createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8, exact(seed, 32, 'an Ed25519 seed')]),
    format: 'der',
    type: 'pkcs8',
  })
}

/** An Ed25519 public key from its raw 32 bytes. */
export function ed25519PublicKey(raw: Uint8Array): KeyObject {
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI, exact(raw, 32, 'an Ed25519 public key')]),
    format: 'der',
    type: 'spki',
  })
}

/** An X25519 private key from its raw 32 bytes. */
export function x25519PrivateKey(raw: Uint8Array): KeyObject {
  return createPrivateKey({
    key: Buffer.concat([X25519_PKCS8, exact(raw, 32, 'an X25519 private key')]),
    format: 'der',
    type: 'pkcs8',
  })
}

/** An X25519 public key from its raw 32 bytes. */
export function x25519PublicKey(raw: Uint8Array): KeyObject {
  return createPublicKey({
    key: Buffer.concat([X25519_SPKI, exact(raw, 32, 'an X25519 public key')]),
    format: 'der',
    type: 'spki',
  })
}

/** The raw 32 bytes of an Ed25519 or X25519 public key (or of a private key's public half). */
export function rawPublicKey(key: KeyObject): Uint8Array {
  const pub = key.type === 'private' ? createPublicKey(key) : key
  const der = pub.export({ format: 'der', type: 'spki' })
  return new Uint8Array(der.subarray(der.length - 32))
}
