import { ControlStoreError, type Queryable, type Row, type Tx } from '@exponetdb/control-store'
import { type Clock, newId, type SecretId } from '@exponetdb/kernel'
import { checkContext, type SecretContext } from './context.ts'
import { open, type RandomSource, rewrap, seal } from './envelope.ts'
import { SecretError } from './errors.ts'
import type { Keyring } from './keyring.ts'

/**
 * Secrets in the Control Store ([secrets.md §4](../../../exponetdb-docs/08-auth-and-security/secrets.md#4-separation)).
 * Metadata and wrapped data keys are shared; the ciphertext lives in one
 * table per consumer, and the grants on those tables decide which process
 * role can decrypt. Table names come from a fixed map, never from input.
 * Writes take the caller's transaction so that the change and its audit
 * event commit together.
 */
export const CONSUMERS = ['worker', 'observer', 'auth', 'gateway'] as const
export type Consumer = (typeof CONSUMERS)[number]

const BLOB_TABLE: Readonly<Record<Consumer, string>> = {
  worker: 'secrets.secret_blobs_worker',
  observer: 'secrets.secret_blobs_observer',
  auth: 'secrets.secret_blobs_auth',
  gateway: 'secrets.secret_blobs_gateway',
}

export interface SecretRef {
  readonly secretId: SecretId
  readonly version: number
}

function contextOrThrow(context: {
  secretId: unknown
  purpose: unknown
  subjectId: unknown
  version: unknown
}): SecretContext {
  const checked = checkContext(context)
  if (!checked.ok) {
    throw new SecretError('secret_context_invalid', { detail: checked.error })
  }
  return checked.value
}

async function storeFailure<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (error) {
    if (error instanceof SecretError) {
      throw error
    }
    throw new SecretError('secret_store_failed', { cause: error })
  }
}

/**
 * Registers the check value of the active master key (once per key id) and
 * refuses a keyring whose key under that id is not the registered one.
 */
export async function registerActiveKey(q: Queryable, keyring: Keyring): Promise<void> {
  const keyId = keyring.activeKeyId
  const checkValue = keyring.checkValue(keyId)
  await q.query(
    'secrets.master_key.register',
    `INSERT INTO secrets.master_keys (key_id, check_value) VALUES ($1, $2)
     ON CONFLICT (key_id) DO NOTHING`,
    [keyId, checkValue],
  )
  const { rows } = await q.query(
    'secrets.master_key.check',
    'SELECT check_value FROM secrets.master_keys WHERE key_id = $1',
    [keyId],
  )
  if (rows[0]?.text('check_value') !== checkValue) {
    throw new SecretError('secret_key_mismatch', { keyId })
  }
}

async function insertVersion(
  tx: Tx,
  keyring: Keyring,
  context: SecretContext,
  consumer: Consumer,
  plaintext: Uint8Array,
  random: RandomSource | undefined,
): Promise<void> {
  await registerActiveKey(tx, keyring)
  const sealed = seal(keyring, context, plaintext, random)
  await tx.query(
    'secrets.version.insert',
    `INSERT INTO secrets.secret_versions (secret_id, version, purpose, subject_id, consumer, created_by)
     VALUES ($1, $2, $3, $4, $5, current_user)`,
    [context.secretId, context.version, context.purpose, context.subjectId, consumer],
  )
  await tx.query(
    'secrets.data_key.insert',
    `INSERT INTO secrets.data_keys (secret_id, version, key_id, wrap_nonce, wrapped_key)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      context.secretId,
      context.version,
      sealed.keyId,
      Buffer.from(sealed.wrapNonce),
      Buffer.from(sealed.wrappedKey),
    ],
  )
  await tx.query(
    `secrets.blob.insert_${consumer}`,
    `INSERT INTO ${BLOB_TABLE[consumer]} (secret_id, version, nonce, ciphertext) VALUES ($1, $2, $3, $4)`,
    [context.secretId, context.version, Buffer.from(sealed.nonce), Buffer.from(sealed.ciphertext)],
  )
}

export interface NewSecret {
  readonly purpose: string
  readonly subjectId: string
  readonly consumer: Consumer
  readonly plaintext: Uint8Array
}

export interface WriteOptions {
  readonly clock: Clock
  /** Test-only injection of the random bytes (golden vectors); defaults to the CSPRNG. */
  readonly random?: RandomSource
}

/** Stores version 1 of a new secret. Returns metadata only, never the value. */
export async function createSecret(
  tx: Tx,
  keyring: Keyring,
  secret: NewSecret,
  options: WriteOptions,
): Promise<SecretRef> {
  const context = contextOrThrow({
    secretId: newId('sec', options.clock.nowMs()),
    purpose: secret.purpose,
    subjectId: secret.subjectId,
    version: 1,
  })
  await storeFailure(() =>
    insertVersion(tx, keyring, context, secret.consumer, secret.plaintext, options.random),
  )
  return { secretId: context.secretId, version: 1 }
}

/** Stores the next version of an existing secret with the same purpose, subject and consumer. */
export async function addSecretVersion(
  tx: Tx,
  keyring: Keyring,
  secretId: SecretId,
  plaintext: Uint8Array,
  options: Omit<WriteOptions, 'clock'> = {},
): Promise<SecretRef> {
  return storeFailure(async () => {
    const { rows } = await tx.query(
      'secrets.version.latest',
      `SELECT version, purpose, subject_id, consumer FROM secrets.secret_versions
        WHERE secret_id = $1 ORDER BY version DESC LIMIT 1`,
      [secretId],
    )
    const latest = rows[0]
    if (latest === undefined) {
      throw new SecretError('secret_not_found')
    }
    const consumer = consumerOf(latest)
    const context = contextOrThrow({
      secretId,
      purpose: latest.text('purpose'),
      subjectId: latest.text('subject_id'),
      version: latest.int('version') + 1,
    })
    await insertVersion(tx, keyring, context, consumer, plaintext, options.random)
    return { secretId, version: context.version }
  })
}

function consumerOf(row: Row): Consumer {
  const value = row.text('consumer')
  const consumer = CONSUMERS.find((c) => c === value)
  if (consumer === undefined) {
    throw new ControlStoreError('control_store_invalid_result')
  }
  return consumer
}

/**
 * Decrypts a secret version (the latest when `version` is omitted) from the
 * consumer's table. The login must be allowed to read that table; the
 * returned buffer is the caller's to overwrite after use.
 */
export async function readSecret(
  q: Queryable,
  keyring: Keyring,
  ref: { readonly secretId: SecretId; readonly consumer: Consumer; readonly version?: number },
): Promise<Buffer> {
  if (!CONSUMERS.includes(ref.consumer)) {
    throw new SecretError('secret_not_found')
  }
  const row = await storeFailure(async () => {
    const { rows } = await q.query(
      `secrets.blob.read_${ref.consumer}`,
      `SELECT v.secret_id, v.version, v.purpose, v.subject_id,
              d.key_id, d.wrap_nonce, d.wrapped_key, b.nonce, b.ciphertext
         FROM secrets.secret_versions v
         JOIN secrets.data_keys d USING (secret_id, version)
         JOIN ${BLOB_TABLE[ref.consumer]} b USING (secret_id, version)
        WHERE v.secret_id = $1 AND v.consumer = $2 AND ($3::int IS NULL OR v.version = $3::int)
        ORDER BY v.version DESC LIMIT 1`,
      [ref.secretId, ref.consumer, ref.version ?? null],
    )
    return rows[0]
  })
  if (row === undefined) {
    throw new SecretError('secret_not_found')
  }
  const context = contextOrThrow({
    secretId: row.text('secret_id'),
    purpose: row.text('purpose'),
    subjectId: row.text('subject_id'),
    version: row.int('version'),
  })
  return open(keyring, context, {
    keyId: row.text('key_id'),
    wrapNonce: row.bytes('wrap_nonce'),
    wrappedKey: row.bytes('wrapped_key'),
    nonce: row.bytes('nonce'),
    ciphertext: row.bytes('ciphertext'),
  })
}

export interface RewrapResult {
  readonly rewrapped: number
  /** Master key ids the re-wrapped data keys moved away from. */
  readonly fromKeyIds: readonly string[]
  /**
   * Data keys that did not unwrap (damaged or substituted rows). They stay
   * on their old key, which therefore stays referenced and is never reported
   * as removable; they are reported, not skipped silently.
   */
  readonly unreadable: readonly SecretRef[]
  /** Cursor for the next batch; `undefined` when this batch was the last. */
  readonly next: SecretRef | undefined
}

/**
 * One batch of the re-wrap job (secrets.md §3), in the caller's transaction
 * (the worker appends the audit event in the same one): data keys wrapped by
 * any key but the active one are unwrapped and wrapped again under the active
 * key; ciphertext is untouched. Batches walk the keys in order from `after`;
 * rows locked by a concurrent run are skipped (that run handles them).
 */
export async function rewrapBatch(
  tx: Tx,
  keyring: Keyring,
  options: {
    readonly limit?: number
    readonly after?: SecretRef
    readonly random?: RandomSource
  } = {},
): Promise<RewrapResult> {
  return storeFailure(async () => {
    await registerActiveKey(tx, keyring)
    const limit = Math.min(Math.max(1, options.limit ?? 500), 1000)
    const { rows } = await tx.query(
      'secrets.rewrap.claim',
      `SELECT d.secret_id, d.version, d.key_id, d.wrap_nonce, d.wrapped_key, v.purpose, v.subject_id
         FROM secrets.data_keys d JOIN secrets.secret_versions v USING (secret_id, version)
        WHERE d.key_id <> $1 AND (d.secret_id, d.version) > ($2, $3)
        ORDER BY d.secret_id, d.version
        LIMIT $4
          FOR UPDATE OF d SKIP LOCKED`,
      [keyring.activeKeyId, options.after?.secretId ?? '', options.after?.version ?? 0, limit],
    )
    const from = new Set<string>()
    const unreadable: SecretRef[] = []
    let rewrapped = 0
    let last: SecretRef | undefined
    for (const row of rows) {
      const context = contextOrThrow({
        secretId: row.text('secret_id'),
        purpose: row.text('purpose'),
        subjectId: row.text('subject_id'),
        version: row.int('version'),
      })
      last = { secretId: context.secretId, version: context.version }
      const keyId = row.text('key_id')
      let next: ReturnType<typeof rewrap>
      try {
        next = rewrap(
          keyring,
          context,
          { keyId, wrapNonce: row.bytes('wrap_nonce'), wrappedKey: row.bytes('wrapped_key') },
          options.random,
        )
      } catch (error) {
        if (error instanceof SecretError && error.code === 'secret_decrypt_failed') {
          unreadable.push(last)
          continue
        }
        throw error
      }
      await tx.query(
        'secrets.rewrap.update',
        `UPDATE secrets.data_keys SET key_id = $3, wrap_nonce = $4, wrapped_key = $5
          WHERE secret_id = $1 AND version = $2`,
        [
          context.secretId,
          context.version,
          next.keyId,
          Buffer.from(next.wrapNonce),
          Buffer.from(next.wrappedKey),
        ],
      )
      rewrapped += 1
      from.add(keyId)
    }
    return {
      rewrapped,
      fromKeyIds: [...from].sort(),
      unreadable,
      next: rows.length === limit ? last : undefined,
    }
  })
}

export interface KeyringStatus {
  /** Data keys per master key id. */
  readonly references: ReadonlyMap<string, number>
  /** Referenced by data keys but absent from this keyring: those secrets cannot be decrypted. */
  readonly missing: readonly string[]
  /** In this keyring under a registered id, but not the registered key. */
  readonly mismatched: readonly string[]
  /** `decrypt_only` keys nothing references any more: safe to remove from the keyring. */
  readonly removable: readonly string[]
}

/**
 * Compares a keyring with the store (readiness and `exponetdb keyring status`).
 * Read-only; the store only ever sees key ids and check values.
 */
export async function keyringStatus(q: Queryable, keyring: Keyring): Promise<KeyringStatus> {
  const [refs, registered] = await storeFailure(() =>
    Promise.all([
      q.query(
        'secrets.keyring.references',
        'SELECT key_id, count(*)::int AS n FROM secrets.data_keys GROUP BY key_id',
      ),
      q.query('secrets.keyring.registered', 'SELECT key_id, check_value FROM secrets.master_keys'),
    ]),
  )
  const references = new Map(refs.rows.map((r) => [r.text('key_id'), r.int('n')]))
  const missing = [...references.keys()].filter((id) => !keyring.has(id)).sort()
  const mismatched = registered.rows
    .filter((r) => keyring.has(r.text('key_id')))
    .filter((r) => keyring.checkValue(r.text('key_id')) !== r.text('check_value'))
    .map((r) => r.text('key_id'))
    .sort()
  const removable = keyring.keys
    .filter((k) => k.status === 'decrypt_only' && (references.get(k.keyId) ?? 0) === 0)
    .map((k) => k.keyId)
    .sort()
  return { references, missing, mismatched, removable }
}
