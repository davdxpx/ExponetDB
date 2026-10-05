import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { dataKeyAad, type SecretContext, secretAad } from './context.ts'
import { SecretError } from './errors.ts'
import { type Keyring, keyFor } from './keyring.ts'

/**
 * Envelope format `se1` ([secrets.md §2.1](../../../exponetdb-docs/08-auth-and-security/secrets.md#21-envelope-format-se1)):
 *
 * - a fresh random 256-bit data key per secret version;
 * - `ciphertext = AES-256-GCM(dataKey, nonce, plaintext, AAD = secret AAD)`;
 * - `wrappedKey = AES-256-GCM(masterKey, wrapNonce, dataKey, AAD = data key AAD)`;
 * - nonces are 96-bit random values; GCM output is ciphertext followed by the
 *   16-byte tag.
 *
 * Randomness is drawn in a fixed order (data key, wrap nonce, nonce) from an
 * injectable source so that golden vectors can pin the format; production
 * uses the CSPRNG. The data key is overwritten after use.
 */
export const MAX_PLAINTEXT_BYTES = 65_536
const TAG_BYTES = 16
const NONCE_BYTES = 12
const KEY_BYTES = 32

export type RandomSource = (bytes: number) => Uint8Array

export interface WrappedDataKey {
  readonly keyId: string
  readonly wrapNonce: Uint8Array
  readonly wrappedKey: Uint8Array
}

export interface SealedSecret extends WrappedDataKey {
  readonly nonce: Uint8Array
  readonly ciphertext: Uint8Array
}

function gcmEncrypt(key: Uint8Array, nonce: Uint8Array, data: Uint8Array, aad: string): Buffer {
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES })
  cipher.setAAD(Buffer.from(aad, 'utf8'))
  return Buffer.concat([cipher.update(data), cipher.final(), cipher.getAuthTag()])
}

function gcmDecrypt(key: Uint8Array, nonce: Uint8Array, sealed: Uint8Array, aad: string): Buffer {
  if (nonce.length !== NONCE_BYTES || sealed.length < TAG_BYTES) {
    throw new SecretError('secret_decrypt_failed')
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES })
    decipher.setAAD(Buffer.from(aad, 'utf8'))
    decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES))
    return Buffer.concat([
      decipher.update(sealed.subarray(0, sealed.length - TAG_BYTES)),
      decipher.final(),
    ])
  } catch {
    throw new SecretError('secret_decrypt_failed')
  }
}

function draw(random: RandomSource, bytes: number): Buffer {
  const value = Buffer.from(random(bytes))
  if (value.length !== bytes) {
    throw new SecretError('secret_store_failed')
  }
  return value
}

const csprng: RandomSource = (bytes) => randomBytes(bytes)

/** Encrypts one secret version under a new data key wrapped by the active master key. */
export function seal(
  keyring: Keyring,
  context: SecretContext,
  plaintext: Uint8Array,
  random: RandomSource = csprng,
): SealedSecret {
  if (plaintext.length === 0 || plaintext.length > MAX_PLAINTEXT_BYTES) {
    throw new SecretError('secret_plaintext_invalid')
  }
  const keyId = keyring.activeKeyId
  const dataKey = draw(random, KEY_BYTES)
  try {
    const wrapNonce = draw(random, NONCE_BYTES)
    const nonce = draw(random, NONCE_BYTES)
    return {
      keyId,
      wrapNonce,
      wrappedKey: gcmEncrypt(
        keyFor(keyring, keyId),
        wrapNonce,
        dataKey,
        dataKeyAad(context, keyId),
      ),
      nonce,
      ciphertext: gcmEncrypt(dataKey, nonce, plaintext, secretAad(context)),
    }
  } finally {
    dataKey.fill(0)
  }
}

function unwrap(keyring: Keyring, context: SecretContext, wrapped: WrappedDataKey): Buffer {
  if (!keyring.has(wrapped.keyId)) {
    throw new SecretError('secret_key_unavailable', { keyId: wrapped.keyId })
  }
  const dataKey = gcmDecrypt(
    keyFor(keyring, wrapped.keyId),
    wrapped.wrapNonce,
    wrapped.wrappedKey,
    dataKeyAad(context, wrapped.keyId),
  )
  if (dataKey.length !== KEY_BYTES) {
    dataKey.fill(0)
    throw new SecretError('secret_decrypt_failed')
  }
  return dataKey
}

/**
 * Decrypts a secret version. Every failure (wrong key, wrong context, a
 * changed byte, a row copied from elsewhere) is `secret_decrypt_failed`
 * without detail; a missing master key is `secret_key_unavailable`. The
 * caller overwrites the returned buffer when it no longer needs it.
 */
export function open(keyring: Keyring, context: SecretContext, sealed: SealedSecret): Buffer {
  const dataKey = unwrap(keyring, context, sealed)
  try {
    return gcmDecrypt(dataKey, sealed.nonce, sealed.ciphertext, secretAad(context))
  } finally {
    dataKey.fill(0)
  }
}

/** Re-wraps a data key under the active master key; the ciphertext stays as it is. */
export function rewrap(
  keyring: Keyring,
  context: SecretContext,
  wrapped: WrappedDataKey,
  random: RandomSource = csprng,
): WrappedDataKey {
  const dataKey = unwrap(keyring, context, wrapped)
  try {
    const keyId = keyring.activeKeyId
    const wrapNonce = draw(random, NONCE_BYTES)
    return {
      keyId,
      wrapNonce,
      wrappedKey: gcmEncrypt(
        keyFor(keyring, keyId),
        wrapNonce,
        dataKey,
        dataKeyAad(context, keyId),
      ),
    }
  } finally {
    dataKey.fill(0)
  }
}
