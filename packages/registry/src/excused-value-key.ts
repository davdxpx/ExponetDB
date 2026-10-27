import { createHmac, randomBytes } from 'node:crypto'
import { appendAuditEvent } from '@exponetdb/audit'
import type { ControlStore } from '@exponetdb/control-store'
import { type Clock, isId } from '@exponetdb/kernel'
import { createSecret, type Keyring, readSecret, SecretError } from '@exponetdb/secrets'

/**
 * The installation's excused-value key (OD-56 (a),
 * [legacy-import.md §2 step 7](../../../exponetdb-docs/04-migrations/legacy-import.md#step-7-verify)):
 * 256 random bits, a worker secret of purpose `migrations.excused_value_key`
 * (envelope-encrypted under the keyring, readable by the worker only),
 * named in `migrations.excused_value_key`. A review decision that excuses a
 * failing expectation of a value is bound to the value the analysis
 * observed by an HMAC-SHA-256 under this key, never a plain hash (a setting
 * or a comment can be guessed from a small domain).
 *
 *   digest = "hmac-sha256:" + hex(HMAC-SHA-256(key, "exponetdb/excused-value/v1" LF input))
 *
 * `keyRef` (`<secret id>:<version>`) names the version that made a digest;
 * a digest is compared only under the same version, so a rotated key (a new
 * version of the secret) or a key that cannot be read fails closed: a
 * person reviews again. Created on first use by the analysis, under a
 * transaction lock, audited; never rotated silently. Neither the key nor
 * an input ever leaves this module except into `node:crypto`.
 */
export const EXCUSED_VALUE_KEY_PURPOSE = 'migrations.excused_value_key'
const DOMAIN = 'exponetdb/excused-value/v1'
/** `pg_advisory_xact_lock` key of the key's creation: ASCII `EXEV`. */
const KEY_LOCK = 1163413846

export interface ExcusedValueKey {
  /** `<secret id>:<version>` of the key that makes these digests. */
  readonly keyRef: string
  /** The keyed digest of an input (the failure's identity and the observed value). */
  digest(input: string): string
}

/**
 * The current excused-value key, created when `create` is set and none
 * exists; `undefined` when there is none or it cannot be read (no keyring,
 * a master key the keyring lacks, a secret of the wrong length). The caller
 * fails closed on `undefined`.
 */
export async function excusedValueKey(
  store: Pick<ControlStore, 'transaction'>,
  keyring: Keyring | undefined,
  clock: Clock,
  options: { readonly create: boolean },
): Promise<ExcusedValueKey | undefined> {
  if (keyring === undefined) return undefined
  try {
    return await store.transaction('migrations.excused_value_key', async (tx) => {
      if (options.create) {
        await tx.query('migrations.excused_value_key.lock', 'SELECT pg_advisory_xact_lock($1)', [
          KEY_LOCK,
        ])
      }
      const existing = await tx.query(
        'migrations.excused_value_key.read',
        'SELECT secret_id FROM migrations.excused_value_key',
      )
      let secretId = existing.rows[0]?.text('secret_id')
      if (secretId === undefined) {
        if (!options.create) return undefined
        const installation = await tx.query(
          'migrations.excused_value_key.installation',
          'SELECT installation_id FROM control.installation',
        )
        const installationId = installation.rows[0]?.text('installation_id')
        if (installationId === undefined) return undefined
        const fresh = randomBytes(32)
        const ref = await createSecret(
          tx,
          keyring,
          {
            purpose: EXCUSED_VALUE_KEY_PURPOSE,
            subjectId: installationId,
            consumer: 'worker',
            plaintext: fresh,
          },
          { clock },
        )
        fresh.fill(0)
        await tx.query(
          'migrations.excused_value_key.insert',
          'INSERT INTO migrations.excused_value_key (secret_id) VALUES ($1)',
          [ref.secretId],
        )
        await appendAuditEvent(
          tx,
          {
            action: 'migrations.excused_value_key.create',
            phase: 'completed',
            actor: { kind: 'system', identityId: null, label: 'system:worker' },
            subject: { secretId: ref.secretId },
            changes: { purpose: EXCUSED_VALUE_KEY_PURPOSE, version: ref.version },
            result: { status: 'succeeded' },
          },
          { clock },
        )
        secretId = ref.secretId
      }
      if (!isId('sec', secretId)) return undefined
      const latest = await tx.query(
        'migrations.excused_value_key.version',
        `SELECT max(version) AS version FROM secrets.secret_versions
          WHERE secret_id = $1 AND consumer = 'worker'`,
        [secretId],
      )
      const version = latest.rows[0]?.intOrNull('version') ?? null
      if (version === null) return undefined
      const key = await readSecret(tx, keyring, { secretId, consumer: 'worker', version })
      if (key.length !== 32) {
        key.fill(0)
        return undefined
      }
      const keyRef = `${secretId}:${version}`
      return {
        keyRef,
        digest(input: string): string {
          const mac = createHmac('sha256', key).update(`${DOMAIN}\n${input}`, 'utf8').digest('hex')
          return `hmac-sha256:${mac}`
        },
      }
    })
  } catch (error) {
    // Unreadable (a master key the keyring lacks, a broken envelope): fail closed.
    if (error instanceof SecretError) return undefined
    throw error
  }
}
