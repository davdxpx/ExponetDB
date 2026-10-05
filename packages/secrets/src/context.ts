import { err, isId, ok, type Result, type SecretId } from '@exponetdb/kernel'

/**
 * The context a secret is bound to, and the associated data built from it
 * ([secrets.md §2.1](../../../exponetdb-docs/08-auth-and-security/secrets.md#21-envelope-format-se1)).
 *
 *   secret AAD   = "exponetdb/secret/v1|"   secret_id "|" purpose "|" subject_id "|" version
 *   data key AAD = "exponetdb/data-key/v1|" secret_id "|" version "|" master key id
 *
 * The encoding is unambiguous because no field may contain `|` and the number
 * of fields is fixed: secret ids are `sec_` ids, purposes are dotted
 * lower-case names, subjects use `[A-Za-z0-9_.:/@-]`, versions are decimal
 * integers without leading zeros, key ids are lower-case tokens. A ciphertext
 * or a wrapped data key copied to another row, version or key fails to
 * decrypt.
 */
export interface SecretContext {
  readonly secretId: SecretId
  /** What the secret is for, e.g. `pg_credential`, `job_signing.key`. */
  readonly purpose: string
  /** What it belongs to, e.g. `cls_…/exponetdb_observer`; never secret itself. */
  readonly subjectId: string
  readonly version: number
}

export type ContextRefusal =
  | 'invalid_secret_id'
  | 'invalid_purpose'
  | 'invalid_subject'
  | 'invalid_version'
  | 'invalid_key_id'

const PURPOSE = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/
const SUBJECT = /^[A-Za-z0-9_.:/@-]{1,256}$/
export const KEY_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/
export const MAX_VERSION = 2_147_483_647

export function isPurpose(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && PURPOSE.test(value)
}

export function isSubjectId(value: unknown): value is string {
  return typeof value === 'string' && SUBJECT.test(value)
}

export function isKeyId(value: unknown): value is string {
  return typeof value === 'string' && KEY_ID.test(value)
}

function isVersion(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_VERSION
}

/** Checks a context in the documented order (secret id, purpose, subject, version). */
export function checkContext(context: {
  readonly secretId: unknown
  readonly purpose: unknown
  readonly subjectId: unknown
  readonly version: unknown
}): Result<SecretContext, ContextRefusal> {
  const { secretId, purpose, subjectId, version } = context
  if (!isId('sec', secretId)) {
    return err('invalid_secret_id')
  }
  if (!isPurpose(purpose)) {
    return err('invalid_purpose')
  }
  if (!isSubjectId(subjectId)) {
    return err('invalid_subject')
  }
  if (!isVersion(version)) {
    return err('invalid_version')
  }
  return ok({ secretId, purpose, subjectId, version })
}

export function secretAad(context: SecretContext): string {
  return `exponetdb/secret/v1|${context.secretId}|${context.purpose}|${context.subjectId}|${context.version}`
}

export function dataKeyAad(context: SecretContext, keyId: string): string {
  return `exponetdb/data-key/v1|${context.secretId}|${context.version}|${keyId}`
}
