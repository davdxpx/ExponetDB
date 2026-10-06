import type { Tx } from '@exponetdb/control-store'
import type { IdentityId } from '@exponetdb/kernel'
import type { StoredPasskey, VerifiedAssertion } from './credentials/webauthn.ts'
import { FACTOR_COLUMNS, type FactorRecord, factorFromRow } from './factors.ts'

/** Decodes a credential id as sent by the browser; undefined unless it is 16 to 1023 bytes of base64url. */
export function credentialIdBytes(id: string): Buffer | undefined {
  if (!/^[A-Za-z0-9_-]{22,1364}$/.test(id)) {
    return undefined
  }
  const bytes = Buffer.from(id, 'base64url')
  return bytes.length >= 16 && bytes.length <= 1023 && bytes.toString('base64url') === id
    ? bytes
    : undefined
}

/** The active passkey with this credential id, locked, optionally only of one identity. */
export async function activePasskey(
  tx: Tx,
  credentialId: string,
  identityId?: IdentityId,
): Promise<FactorRecord | undefined> {
  const bytes = credentialIdBytes(credentialId)
  if (bytes === undefined) {
    return undefined
  }
  const { rows } = await tx.query(
    'auth.passkey.by_credential',
    `SELECT ${FACTOR_COLUMNS} FROM auth.factors f
      WHERE f.credential_id = $1 AND f.kind = 'passkey' AND f.state = 'active'
        AND ($2::text IS NULL OR f.identity_id = $2)
      FOR UPDATE OF f`,
    [bytes, identityId ?? null],
  )
  const row = rows[0]
  return row === undefined ? undefined : factorFromRow(row)
}

export function storedPasskey(factor: FactorRecord): StoredPasskey | undefined {
  if (factor.credentialId === null || factor.publicKey === null || factor.signCount === null) {
    return undefined
  }
  return {
    id: Buffer.from(factor.credentialId).toString('base64url'),
    publicKey: factor.publicKey,
    counter: factor.signCount,
    transports: factor.transports,
  }
}

/** Stores the verified counter (never lower) and backup state, and the time of use. */
export async function recordPasskeyUse(
  tx: Tx,
  factor: FactorRecord,
  verified: VerifiedAssertion,
): Promise<void> {
  await tx.query(
    'auth.passkey.used',
    `UPDATE auth.factors SET sign_count = greatest(sign_count, $2), backed_up = $3, last_used_at = clock_timestamp()
      WHERE factor_id = $1`,
    [factor.factorId, verified.newCounter, verified.backedUp],
  )
}

/** Active passkeys of an identity as credential descriptors (re-authentication, exclusion lists). */
export function descriptors(
  factors: readonly FactorRecord[],
): { readonly id: string; readonly transports: readonly string[] }[] {
  return factors
    .filter((f) => f.kind === 'passkey' && f.credentialId !== null)
    .map((f) => ({
      id: Buffer.from(f.credentialId ?? new Uint8Array()).toString('base64url'),
      transports: f.transports,
    }))
}
