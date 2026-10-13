import { randomBytes } from 'node:crypto'
import { createPseudonymizer, type Pseudonymizer } from '@exponetdb/audit'
import { type ControlStore, EXDB_LOCK_NAMESPACE, lockKey2, type Tx } from '@exponetdb/control-store'
import { type Clock, isId } from '@exponetdb/kernel'
import { addSecretVersion, createSecret, type Keyring, readSecret } from '@exponetdb/secrets'
import { appendAudit, MAINTENANCE_ACTOR, SERVE_ACTOR } from './audit.ts'
import { AuthError } from './errors.ts'

/**
 * Installation keys for keyed pseudonyms (audit.md §1, OD-8 Wave 2 design):
 * one for the audit's IP and user-agent pseudonyms, a separate one for
 * rate-limit buckets, so a value in one cannot be correlated with the
 * other; since Wave 7 two more for the MCP endpoint (sealed cursors and
 * request state, ADR-0027 §7). Each is 256 random bits, stored as a secret of the `auth`
 * consumer (readable by serve only) and named in `auth.installation_keys`.
 * Created on first use under a transaction lock, so concurrent serve
 * processes agree on one key; never rotated silently. The two MCP keys are
 * rotatable by an operator ({@link rotateMcpKey}, Wave 7 order §30): a new
 * version of the same secret seals from then on, the version before it
 * still opens, so a rotation cuts no client off mid-round.
 */
export const INSTALLATION_KEY_PURPOSES = [
  'audit.pseudonym_key',
  'auth.rate_limit_key',
  // Wave 7 (ADR-0027 §7): sealed list cursors and the approval round's request state of /mcp.
  'mcp.cursor_key',
  'mcp.request_state_key',
] as const
export type InstallationKeyPurpose = (typeof INSTALLATION_KEY_PURPOSES)[number]

const KEYS_LOCK = { key1: EXDB_LOCK_NAMESPACE, key2: lockKey2('auth/installation-keys') } as const

/** The keys of the MCP endpoint, the only rotatable installation keys. */
export type McpKeyPurpose = 'mcp.cursor_key' | 'mcp.request_state_key'
export const MCP_KEY_PURPOSES: readonly McpKeyPurpose[] = [
  'mcp.cursor_key',
  'mcp.request_state_key',
]

export interface VersionedKey {
  /** The version of the key's secret (`secrets.secret_versions.version`), named in what it seals. */
  readonly version: number
  readonly key: Buffer
}

/** The newest version seals; the one before it still opens. */
export interface McpKeySet {
  readonly current: VersionedKey
  readonly previous?: VersionedKey
}

/** How long a serve process keeps an MCP key set before it reads the versions again. */
export const MCP_KEY_REFRESH_MS = 5 * 60_000

/** The secret of an installation key, created (version 1) under the keys lock when missing. */
async function ensureKey(
  tx: Tx,
  keyring: Keyring,
  clock: Clock,
  purpose: InstallationKeyPurpose,
): Promise<{ readonly secretId: string; readonly created: boolean }> {
  await tx.query('auth.keys.lock', 'SELECT pg_advisory_xact_lock($1::int, $2::int)', [
    KEYS_LOCK.key1,
    KEYS_LOCK.key2,
  ])
  const existing = await tx.query(
    'auth.keys.read',
    'SELECT secret_id FROM auth.installation_keys WHERE purpose = $1',
    [purpose],
  )
  const secretId = existing.rows[0]?.text('secret_id')
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
    return { secretId: ref.secretId, created: true }
  }
  return { secretId, created: false }
}

/** One version of an installation key's secret (the latest when `version` is omitted): 256 bits. */
async function readKey(
  tx: Tx,
  keyring: Keyring,
  secretId: string,
  version?: number,
): Promise<Buffer> {
  if (!isId('sec', secretId)) {
    throw new AuthError('auth_key_unavailable')
  }
  const value = await readSecret(tx, keyring, {
    secretId,
    consumer: 'auth',
    ...(version === undefined ? {} : { version }),
  })
  if (value.length !== 32) {
    value.fill(0)
    throw new AuthError('auth_key_unavailable')
  }
  return value
}

async function loadOrCreate(
  tx: Tx,
  keyring: Keyring,
  clock: Clock,
  purpose: InstallationKeyPurpose,
): Promise<Buffer> {
  const { secretId } = await ensureKey(tx, keyring, clock, purpose)
  return readKey(tx, keyring, secretId)
}

/** The newest two versions of an MCP key (created when missing). */
async function loadKeySet(
  tx: Tx,
  keyring: Keyring,
  clock: Clock,
  purpose: McpKeyPurpose,
): Promise<McpKeySet> {
  const { secretId } = await ensureKey(tx, keyring, clock, purpose)
  const { rows } = await tx.query(
    'auth.keys.versions',
    `SELECT version FROM secrets.secret_versions
      WHERE secret_id = $1 AND consumer = 'auth' ORDER BY version DESC LIMIT 2`,
    [secretId],
  )
  const [newest, before] = rows.map((r) => r.int('version'))
  if (newest === undefined) {
    throw new AuthError('auth_key_unavailable')
  }
  const current = { version: newest, key: await readKey(tx, keyring, secretId, newest) }
  return before === undefined
    ? { current }
    : { current, previous: { version: before, key: await readKey(tx, keyring, secretId, before) } }
}

/**
 * Rotates an MCP key (`exponetdb keyring rotate-mcp-key`, Wave 7 order §30):
 * a new random version of the same secret, under the keys lock, audited as
 * `auth.installation_key.rotate` with the purpose and the version. Serve
 * processes seal with it within {@link MCP_KEY_REFRESH_MS}; what the version
 * before it sealed still opens. A key that does not exist yet is created
 * (version 1) and not rotated.
 */
export async function rotateMcpKey(
  store: ControlStore,
  keyring: Keyring,
  clock: Clock,
  purpose: McpKeyPurpose,
): Promise<{ readonly purpose: McpKeyPurpose; readonly version: number }> {
  if (!MCP_KEY_PURPOSES.includes(purpose)) {
    throw new AuthError('auth_key_unavailable')
  }
  return store.transaction('auth.keys.rotate', async (tx) => {
    const ensured = await ensureKey(tx, keyring, clock, purpose)
    if (ensured.created) {
      return { purpose, version: 1 }
    }
    if (!isId('sec', ensured.secretId)) {
      throw new AuthError('auth_key_unavailable')
    }
    const key = randomBytes(32)
    const ref = await addSecretVersion(tx, keyring, ensured.secretId, key)
    key.fill(0)
    await appendAudit(
      tx,
      {
        action: 'auth.installation_key.rotate',
        phase: 'completed',
        actor: MAINTENANCE_ACTOR,
        subject: { secretId: ensured.secretId },
        changes: { purpose, version: ref.version },
        result: { status: 'succeeded' },
      },
      clock,
    )
    return { purpose, version: ref.version }
  })
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

  readonly #mcp = new Map<
    McpKeyPurpose,
    { readonly pending: Promise<McpKeySet>; readonly loadedAt: number }
  >()

  /**
   * The newest two versions of an MCP key, read again after
   * {@link MCP_KEY_REFRESH_MS} so a rotation reaches every serve process
   * without a restart (a failed load is retried by the next caller).
   */
  mcpKeys(purpose: McpKeyPurpose): Promise<McpKeySet> {
    const now = this.#clock.nowMs()
    const cached = this.#mcp.get(purpose)
    if (cached !== undefined && now - cached.loadedAt < MCP_KEY_REFRESH_MS) {
      return cached.pending
    }
    const pending = this.#store.transaction('auth.keys', (tx) =>
      loadKeySet(tx, this.#keyring, this.#clock, purpose),
    )
    pending.catch(() => {
      if (this.#mcp.get(purpose)?.pending === pending) this.#mcp.delete(purpose)
    })
    this.#mcp.set(purpose, { pending, loadedAt: now })
    return pending
  }

  /** The newest version of an MCP key: 256 bits. */
  async mcpKey(purpose: McpKeyPurpose): Promise<Buffer> {
    return (await this.mcpKeys(purpose)).current.key
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
