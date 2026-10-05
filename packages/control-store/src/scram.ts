import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto'

/**
 * SCRAM-SHA-256 password verifiers in PostgreSQL's stored form
 * (`SCRAM-SHA-256$<iterations>:<salt>$<StoredKey>:<ServerKey>`, RFC 5802 and
 * RFC 7677). A verifier lets bootstrap SQL set a password without the
 * password ever appearing in SQL, logs or `pg_stat_activity` (secrets.md:
 * "Passwords are set as SCRAM verifiers").
 *
 * Only ASCII printable passwords are accepted: for them SASLprep is the
 * identity, so no normalization code is needed. Generated passwords use the
 * base64url alphabet. Proven against a real PostgreSQL 17 login in the
 * integration tests.
 */
export const SCRAM_ITERATIONS = 4096
export const SCRAM_VERIFIER =
  /^SCRAM-SHA-256\$[1-9][0-9]{0,6}:[A-Za-z0-9+/]+={0,2}\$[A-Za-z0-9+/]+={0,2}:[A-Za-z0-9+/]+={0,2}$/

export function scramSha256Verifier(
  password: string,
  options: { readonly iterations?: number; readonly salt?: Uint8Array } = {},
): string {
  if (!/^[\x21-\x7e]{16,1024}$/.test(password)) {
    throw new Error('SCRAM passwords must be 16 to 1024 printable ASCII characters')
  }
  const iterations = options.iterations ?? SCRAM_ITERATIONS
  if (!Number.isInteger(iterations) || iterations < 4096 || iterations > 1_000_000) {
    throw new Error('SCRAM iterations must be between 4096 and 1000000')
  }
  const salt = options.salt ?? randomBytes(16)
  if (salt.length < 16) {
    throw new Error('SCRAM salt must be at least 16 bytes')
  }
  const salted = pbkdf2Sync(password, salt, iterations, 32, 'sha256')
  const clientKey = createHmac('sha256', salted).update('Client Key').digest()
  const storedKey = createHash('sha256').update(clientKey).digest()
  const serverKey = createHmac('sha256', salted).update('Server Key').digest()
  salted.fill(0)
  clientKey.fill(0)
  const b64 = (b: Uint8Array): string => Buffer.from(b).toString('base64')
  return `SCRAM-SHA-256$${iterations}:${b64(salt)}$${b64(storedKey)}:${b64(serverKey)}`
}

/** A random password from a CSPRNG: 32 bytes as base64url (43 characters). */
export function generatePassword(): string {
  return randomBytes(32).toString('base64url')
}
