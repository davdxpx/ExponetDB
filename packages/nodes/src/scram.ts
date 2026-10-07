import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto'

/**
 * A SCRAM-SHA-256 verifier as PostgreSQL stores it (RFC 5802, RFC 7677):
 * `SCRAM-SHA-256$<iterations>:<salt>$<StoredKey>:<ServerKey>`, base64. The
 * password is ASCII (base64url), so SASLprep leaves it unchanged.
 */
export function scramVerifier(
  password: string,
  salt: Uint8Array = randomBytes(16),
  iterations = 4096,
): string {
  if (!/^[\x21-\x7e]+$/.test(password)) {
    throw new RangeError('a generated password is printable ASCII')
  }
  const salted = pbkdf2Sync(password, salt, iterations, 32, 'sha256')
  try {
    const clientKey = createHmac('sha256', salted).update('Client Key').digest()
    const storedKey = createHash('sha256').update(clientKey).digest()
    const serverKey = createHmac('sha256', salted).update('Server Key').digest()
    const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64')
    return `SCRAM-SHA-256$${iterations}:${b64(salt)}$${b64(storedKey)}:${b64(serverKey)}`
  } finally {
    salted.fill(0)
  }
}

/** A new password for one of ExponetDB's roles: 32 random bytes, base64url. */
export function generatedPassword(): string {
  const bytes = randomBytes(32)
  try {
    return bytes.toString('base64url')
  } finally {
    bytes.fill(0)
  }
}
