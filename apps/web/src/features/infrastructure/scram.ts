/**
 * A PostgreSQL SCRAM-SHA-256 verifier computed in the browser
 * (credentials-and-roles.md §4.1, RFC 5802, RFC 7677): the person types a
 * password, the page derives the verifier with WebCrypto and sends only the
 * verifier. The password never leaves this module: it is not kept, not
 * logged and not part of any error.
 *
 *   SaltedPassword = PBKDF2-HMAC-SHA-256(password, salt, iterations, 32 bytes)
 *   ClientKey      = HMAC-SHA-256(SaltedPassword, "Client Key")
 *   StoredKey      = SHA-256(ClientKey)
 *   ServerKey      = HMAC-SHA-256(SaltedPassword, "Server Key")
 *   verifier       = SCRAM-SHA-256$<iterations>:<salt>$<StoredKey>:<ServerKey> (base64)
 *
 * PostgreSQL (and every libpq client logging in) first normalizes the
 * password with SASLprep; for printable ASCII that is the identity, so the
 * form accepts printable ASCII only (`isScramSafePassword`) and the browser
 * never has to reproduce SASLprep's tables.
 */

/** The iteration count PostgreSQL and `psql \password` use by default (`scram_iterations`). */
export const SCRAM_ITERATIONS = 4096
/** Salt length in bytes (PostgreSQL's own is 16). */
export const SCRAM_SALT_BYTES = 16

const encoder = new TextEncoder()

/** Printable ASCII only (U+0020 to U+007E): SASLprep leaves such a password unchanged. */
export function isScramSafePassword(password: string): boolean {
  return /^[\x20-\x7e]*$/.test(password)
}

function base64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

export interface ScramOptions {
  readonly iterations?: number
  /** The salt (tests); by default 16 bytes from `crypto.getRandomValues`. */
  readonly salt?: Uint8Array
  /** The WebCrypto implementation (tests); by default `globalThis.crypto`. */
  readonly crypto?: Crypto
}

async function hmac(subtle: SubtleCrypto, key: ArrayBuffer, text: string): Promise<ArrayBuffer> {
  const imported = await subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ])
  return subtle.sign('HMAC', imported, encoder.encode(text))
}

/**
 * The SCRAM-SHA-256 verifier of `password`. Throws a `TypeError` without the
 * password in it when the password is not printable ASCII or the iteration
 * count is below 4096.
 */
export async function scramSha256Verifier(
  password: string,
  options: ScramOptions = {},
): Promise<string> {
  const iterations = options.iterations ?? SCRAM_ITERATIONS
  if (!Number.isInteger(iterations) || iterations < 4096 || iterations > 9_999_999) {
    throw new TypeError('The iteration count must be between 4096 and 9999999.')
  }
  if (!isScramSafePassword(password)) {
    throw new TypeError('The password must be printable ASCII.')
  }
  const webCrypto = options.crypto ?? globalThis.crypto
  const salt = options.salt ?? webCrypto.getRandomValues(new Uint8Array(SCRAM_SALT_BYTES))
  if (salt.length < 16 || salt.length > 64) {
    throw new TypeError('The salt must have 16 to 64 bytes.')
  }
  const subtle = webCrypto.subtle
  const material = await subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ])
  const salted = await subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: new Uint8Array(salt), iterations },
    material,
    256,
  )
  const clientKey = await hmac(subtle, salted, 'Client Key')
  const storedKey = new Uint8Array(await subtle.digest('SHA-256', clientKey))
  const serverKey = new Uint8Array(await hmac(subtle, salted, 'Server Key'))
  return `SCRAM-SHA-256$${iterations}:${base64(salt)}$${base64(storedKey)}:${base64(serverKey)}`
}
