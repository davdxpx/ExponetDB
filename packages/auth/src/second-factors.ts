import type { Tx } from '@exponetdb/control-store'
import { type AuthFactorId, type Clock, type IdentityId, newId } from '@exponetdb/kernel'
import { createSecret, type Keyring, readSecret } from '@exponetdb/secrets'
import {
  newRecoveryCodes,
  normalizeRecoveryCode,
  RECOVERY_CODE_COUNT,
  recoveryCodeHash,
} from './credentials/recovery-codes.ts'
import { newTotpSecret, verifyTotp } from './credentials/totp.ts'
import { FACTOR_COLUMNS, type FactorRecord, factorFromRow } from './factors.ts'

/**
 * TOTP and recovery-code factors in the Control Store. The TOTP secret is
 * an `se1` secret of the `auth` consumer (purpose `auth.totp_secret`,
 * subject the factor id); recovery codes are stored as hashes bound to
 * their set.
 */
export const TOTP_SECRET_PURPOSE = 'auth.totp_secret'

export async function totpFactor(
  tx: Tx,
  identityId: IdentityId,
  state: 'pending' | 'active',
): Promise<FactorRecord | undefined> {
  const { rows } = await tx.query(
    `auth.totp.${state}`,
    `SELECT ${FACTOR_COLUMNS} FROM auth.factors f
      WHERE f.identity_id = $1 AND f.kind = 'totp' AND f.state = $2 FOR UPDATE OF f`,
    [identityId, state],
  )
  const row = rows[0]
  return row === undefined ? undefined : factorFromRow(row)
}

/**
 * Checks a code against a (locked) TOTP factor at the database time and
 * records the step, so the same code never works twice, even concurrently.
 */
export async function useTotp(
  tx: Tx,
  keyring: Keyring,
  factor: FactorRecord,
  code: string,
  nowMs: number,
): Promise<boolean> {
  if (factor.totpSecretId === null || factor.totpSecretVersion === null) {
    return false
  }
  const secret = await readSecret(tx, keyring, {
    secretId: factor.totpSecretId,
    consumer: 'auth',
    version: factor.totpSecretVersion,
  })
  const check = verifyTotp(secret, code, nowMs, factor.totpLastStep)
  secret.fill(0)
  if (!check.ok) {
    return false
  }
  const { rowCount } = await tx.query(
    'auth.totp.use',
    `UPDATE auth.factors SET totp_last_step = $2, last_used_at = clock_timestamp()
      WHERE factor_id = $1 AND (totp_last_step IS NULL OR totp_last_step < $2)`,
    [factor.factorId, check.step],
  )
  return rowCount === 1
}

/**
 * The pending TOTP factor of a setup: an open, unconfirmed one is shown
 * again (its secret is reused), so asking for the options repeatedly never
 * stores another secret; otherwise a new secret replaces any confirmed
 * pending one. Stored secrets are append-only (secrets.md), so this bounds
 * them by confirmed setups, each of which needs a valid code.
 */
export async function newPendingTotp(
  tx: Tx,
  keyring: Keyring,
  clock: Clock,
  identityId: IdentityId,
): Promise<{ readonly factorId: AuthFactorId; readonly secret: Uint8Array }> {
  const open = await totpFactor(tx, identityId, 'pending')
  if (
    open !== undefined &&
    open.totpLastStep === null &&
    open.totpSecretId !== null &&
    open.totpSecretVersion !== null
  ) {
    const secret = await readSecret(tx, keyring, {
      secretId: open.totpSecretId,
      consumer: 'auth',
      version: open.totpSecretVersion,
    })
    return { factorId: open.factorId, secret }
  }
  await tx.query(
    'auth.totp.drop_pending',
    `DELETE FROM auth.factors WHERE identity_id = $1 AND kind = 'totp' AND state = 'pending'`,
    [identityId],
  )
  const factorId = newId('fac', clock.nowMs())
  const secret = newTotpSecret()
  const ref = await createSecret(
    tx,
    keyring,
    { purpose: TOTP_SECRET_PURPOSE, subjectId: factorId, consumer: 'auth', plaintext: secret },
    { clock },
  )
  await tx.query(
    'auth.totp.insert',
    `INSERT INTO auth.factors (factor_id, identity_id, kind, state, totp_secret_id, totp_secret_version)
     VALUES ($1, $2, 'totp', 'pending', $3, $4)`,
    [factorId, identityId, ref.secretId, ref.version],
  )
  return { factorId, secret }
}

/** Replaces the recovery-code set of an identity with ten new codes; returns them once. */
export async function newRecoveryCodeSet(
  tx: Tx,
  clock: Clock,
  identityId: IdentityId,
): Promise<string[]> {
  await tx.query(
    'auth.recovery.drop',
    `DELETE FROM auth.factors WHERE identity_id = $1 AND kind = 'recovery_codes'`,
    [identityId],
  )
  const factorId = newId('fac', clock.nowMs())
  await tx.query(
    'auth.recovery.insert_set',
    `INSERT INTO auth.factors (factor_id, identity_id, kind, state) VALUES ($1, $2, 'recovery_codes', 'active')`,
    [factorId, identityId],
  )
  const codes = newRecoveryCodes()
  for (const [index, code] of codes.entries()) {
    await tx.query(
      'auth.recovery.insert_code',
      'INSERT INTO auth.recovery_codes (factor_id, code_index, code_hash) VALUES ($1, $2, $3)',
      [factorId, index + 1, recoveryCodeHash(factorId, code)],
    )
  }
  if (codes.length !== RECOVERY_CODE_COUNT) {
    throw new Error('recovery code set size')
  }
  return codes
}

/** Uses one recovery code of the identity's active set; false when none matches (or it was used). */
export async function useRecoveryCode(
  tx: Tx,
  identityId: IdentityId,
  input: string,
): Promise<AuthFactorId | undefined> {
  const code = normalizeRecoveryCode(input)
  if (code === undefined) {
    return undefined
  }
  const { rows } = await tx.query(
    'auth.recovery.set',
    `SELECT ${FACTOR_COLUMNS} FROM auth.factors f
      WHERE f.identity_id = $1 AND f.kind = 'recovery_codes' AND f.state = 'active' FOR UPDATE OF f`,
    [identityId],
  )
  const row = rows[0]
  if (row === undefined) {
    return undefined
  }
  const set = factorFromRow(row)
  const { rowCount } = await tx.query(
    'auth.recovery.use',
    `UPDATE auth.recovery_codes SET used_at = clock_timestamp()
      WHERE factor_id = $1 AND code_hash = $2 AND used_at IS NULL`,
    [set.factorId, recoveryCodeHash(set.factorId, code)],
  )
  return rowCount === 1 ? set.factorId : undefined
}
