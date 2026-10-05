/**
 * Secret errors carry a stable code and, where useful, a key id or an entry
 * index. Never key material, plaintext, ciphertext or the input text.
 */
export type SecretErrorCode =
  | 'keyring_missing'
  | 'keyring_ambiguous'
  | 'keyring_unreadable'
  | 'keyring_file_permissions'
  | 'keyring_invalid'
  | 'secret_context_invalid'
  | 'secret_plaintext_invalid'
  | 'secret_key_unavailable'
  | 'secret_key_mismatch'
  | 'secret_decrypt_failed'
  | 'secret_not_found'
  | 'secret_store_failed'

const MESSAGES: Readonly<Record<SecretErrorCode, string>> = {
  keyring_missing: 'No keyring is configured.',
  keyring_ambiguous: 'Configure the keyring either inline or as a file, not both.',
  keyring_unreadable: 'The keyring file cannot be read.',
  keyring_file_permissions: 'The keyring file must not be readable by group or others.',
  keyring_invalid: 'The keyring is not valid.',
  secret_context_invalid: 'The secret context is not valid.',
  secret_plaintext_invalid: 'The secret value is empty or too large.',
  secret_key_unavailable: 'The master key that wraps this secret is not in the keyring.',
  secret_key_mismatch:
    'A master key in the keyring does not match the key registered under its id.',
  secret_decrypt_failed: 'The secret could not be decrypted.',
  secret_not_found: 'The secret does not exist for this consumer.',
  secret_store_failed: 'The secret could not be stored or read.',
}

export class SecretError extends Error {
  override readonly name = 'SecretError'
  readonly code: SecretErrorCode
  /** Detail code (keyring refusal or context refusal); never input text. */
  readonly detail: string | undefined
  /** Master key id or keyring entry index; ids are not secret. */
  readonly keyId: string | undefined
  readonly entry: number | undefined

  constructor(
    code: SecretErrorCode,
    options: { detail?: string; keyId?: string; entry?: number; cause?: unknown } = {},
  ) {
    super(MESSAGES[code], options.cause === undefined ? undefined : { cause: options.cause })
    this.code = code
    this.detail = options.detail
    this.keyId = options.keyId
    this.entry = options.entry
  }
}
