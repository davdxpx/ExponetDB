import { hash, parseOptions, verify } from '@node-rs/argon2'
import { isCommonPassword } from './breached.ts'

/**
 * The password fallback (identity.md §2): never the primary factor, always
 * with TOTP. Argon2id through `@node-rs/argon2` (the RustCrypto `argon2`
 * crate; hashing runs on the libuv thread pool, not on the event loop).
 *
 * - Parameters: memory 64 MiB, 3 passes, parallelism 1, 16-byte random salt
 *   per hash, 32-byte output; the PHC string carries them, so a later
 *   stronger setting can rehash after a successful sign-in.
 * - Policy: 14 to 256 Unicode code points, no control characters, not a
 *   common password (offline list), not the e-mail address or its local
 *   part. No composition rules. The password is hashed exactly as given:
 *   no Unicode normalization, no trimming.
 * - The password never enters a log, an error, an audit event or a
 *   response.
 */
export const ARGON2_PARAMS = {
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 1,
  outputLen: 32,
} as const

export const PASSWORD_MIN_LENGTH = 14
export const PASSWORD_MAX_LENGTH = 256

export type PasswordRefusal =
  | 'too_short'
  | 'too_long'
  | 'control_characters'
  | 'common'
  | 'contains_email'

export function checkPasswordPolicy(
  password: string,
  email?: string,
): { ok: true } | { ok: false; reason: PasswordRefusal } {
  const length = [...password].length
  if (length < PASSWORD_MIN_LENGTH) {
    return { ok: false, reason: 'too_short' }
  }
  if (length > PASSWORD_MAX_LENGTH) {
    return { ok: false, reason: 'too_long' }
  }
  if (/\p{Cc}/u.test(password)) {
    return { ok: false, reason: 'control_characters' }
  }
  if (email !== undefined) {
    const lower = password.toLowerCase()
    const address = email.toLowerCase()
    const local = address.split('@')[0] ?? ''
    if (lower.includes(address) || (local.length >= 4 && lower.includes(local))) {
      return { ok: false, reason: 'contains_email' }
    }
  }
  if (isCommonPassword(password)) {
    return { ok: false, reason: 'common' }
  }
  return { ok: true }
}

const ARGON2ID = 2 // Algorithm.Argon2id (a const enum of the binding)

export async function hashPassword(password: string): Promise<string> {
  return hash(password, { ...ARGON2_PARAMS, algorithm: ARGON2ID })
}

/** True when the stored hash was made with weaker parameters than the current ones. */
export function needsRehash(stored: string): boolean {
  try {
    const p = parseOptions(stored)
    return (
      p.algorithm !== ARGON2ID ||
      p.memoryCost < ARGON2_PARAMS.memoryCost ||
      p.timeCost < ARGON2_PARAMS.timeCost ||
      p.outputLen < ARGON2_PARAMS.outputLen
    )
  } catch {
    return true
  }
}

export async function verifyPassword(stored: string, password: string): Promise<boolean> {
  try {
    return await verify(stored, password)
  } catch {
    return false
  }
}

let dummy: Promise<string> | undefined

/**
 * Spends the same Argon2id work as a real verification when there is no
 * stored hash (unknown address, identity without a password), so that the
 * time of a refusal does not trivially reveal whether the account exists.
 * Network latency and database lookups still differ slightly; no constant
 * time is claimed.
 */
export async function dummyVerify(password: string): Promise<false> {
  dummy ??= hashPassword('exponetdb: no account behind this attempt')
  await verifyPassword(await dummy, password)
  return false
}
