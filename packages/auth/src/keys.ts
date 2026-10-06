import { randomBytes } from 'node:crypto'
import { createPseudonymizer, type Pseudonymizer } from '@exponetdb/audit'
import { type ControlStore, EXDB_LOCK_NAMESPACE, lockKey2, type Tx } from '@exponetdb/control-store'
import { type Clock, isId } from '@exponetdb/kernel'
import { createSecret, type Keyring, readSecret } from '@exponetdb/secrets'
import { appendAudit, SERVE_ACTOR } from './audit.ts'
import { AuthError } from './errors.ts'

/**
 * Installation keys for keyed pseudonyms (audit.md §1, OD-8 Wave 2 design):
 * one for the audit's IP and user-agent pseudonyms, a separate one for
 * rate-limit buckets, so a value in one cannot be correlated with the
 * other. Each is 256 random bits, stored as a secret of the `auth`
 * consumer (readable by serve only) and named in `auth.installation_keys`.
 * Created on first use under a transaction lock, so concurrent serve
 * processes agree on one key; never rotated silently.
 */
export const INSTALLATION_KEY_PURPOSES = ['audit.pseudonym_key', 'auth.rate_limit_key'] as const
export type InstallationKeyPurpose = (typeof INSTALLATION_KEY_PURPOSES)[number]

const KEYS_LOCK = { key1: EXDB_LOCK_NAMESPACE, key2: lockKey2('auth/installation-keys') } as const

async function loadOrCreate(
  tx: Tx,
  keyring: Keyring,
  clock: Clock,
  purpose: InstallationKeyPurpose,
): Promise<Buffer> {
  await tx.query('auth.keys.lock', 'SELECT pg_advisory_xact_lock($1::int, $2::int)', [
    KEYS_LOCK.key1,
    KEYS_LOCK.key2,
  ])
  const existing = await tx.query(
    'auth.keys.read',
    'SELECT secret_id FROM auth.installation_keys WHERE purpose = $1',
    [purpose],
  )
  let secretId = existing.rows[0]?.text('secret_id')
  if (secretId === undefined) {
    const installation = await tx.query(
      'auth.keys.installation',
      'SELECT installation_id FROM control.installation',
    )
    const installationId = installation.rows[0]?.text('installation_id')
    if (installationId === undefined) {
      throw new AuthError('auth_key_unavailable')
    }
    const key = randomBytes(32)
    const ref = await createSecret(
      tx,
      keyring,
      { purpose, subjectId: installationId, consumer: 'auth', plaintext: key },
      { clock },
    )
    key.fill(0)
    await tx.query(
      'auth.keys.insert',
      'INSERT INTO auth.installation_keys (purpose, secret_id) VALUES ($1, $2)',
      [purpose, ref.secretId],
    )
    await appendAudit(
      tx,
      {
        action: 'auth.installation_key.create',
        phase: 'completed',
        actor: SERVE_ACTOR,
        subject: { secretId: ref.secretId },
        changes: { purpose },
        result: { status: 'succeeded' },
      },
      clock,
    )
    secretId = ref.secretId
  }
  if (!isId('sec', secretId)) {
    throw new AuthError('auth_key_unavailable')
  }
  const value = await readSecret(tx, keyring, { secretId, consumer: 'auth' })
  if (value.length !== 32) {
    value.fill(0)
    throw new AuthError('auth_key_unavailable')
  }
  return value
}

/** Lazily loaded, process-wide installation keys of one serve process. */
export class InstallationKeys {
  readonly #store: ControlStore
  readonly #keyring: Keyring
  readonly #clock: Clock
  #pseudonymizer: Promise<Pseudonymizer> | undefined
  #rateLimitKey: Promise<Buffer> | undefined

  constructor(store: ControlStore, keyring: Keyring, clock: Clock) {
    this.#store = store
    this.#keyring = keyring
    this.#clock = clock
  }

  #load(purpose: InstallationKeyPurpose): Promise<Buffer> {
    return this.#store.transaction('auth.keys', (tx) =>
      loadOrCreate(tx, this.#keyring, this.#clock, purpose),
    )
  }

  pseudonymizer(): Promise<Pseudonymizer> {
    if (this.#pseudonymizer === undefined) {
      const pending = this.#load('audit.pseudonym_key').then((key) => {
        const pseudonymizer = createPseudonymizer(key)
        key.fill(0)
        return pseudonymizer
      })
      // A failed load is retried by the next caller instead of being cached.
      pending.catch(() => {
        this.#pseudonymizer = undefined
      })
      this.#pseudonymizer = pending
    }
    return this.#pseudonymizer
  }

  rateLimitKey(): Promise<Buffer> {
    if (this.#rateLimitKey === undefined) {
      const pending = this.#load('auth.rate_limit_key')
      pending.catch(() => {
        this.#rateLimitKey = undefined
      })
      this.#rateLimitKey = pending
    }
    return this.#rateLimitKey
  }
}
