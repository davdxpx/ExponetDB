import type { FactorView } from '@exponetdb/contracts'
import type { Queryable, Row } from '@exponetdb/control-store'
import { type AuthFactorId, type IdentityId, isId, type SecretId } from '@exponetdb/kernel'
import { AuthError } from './errors.ts'

/**
 * Authentication factors of an identity (identity.md §2). A factor's
 * material never changes: a new password, a new TOTP secret or a new
 * passkey is a new factor row; `pending` factors belong to an enrollment
 * or replacement in progress and never authenticate.
 */
export type FactorKind = 'passkey' | 'password' | 'totp' | 'recovery_codes'

export interface FactorRecord {
  readonly factorId: AuthFactorId
  readonly identityId: IdentityId
  readonly kind: FactorKind
  readonly state: 'pending' | 'active'
  readonly label: string | null
  readonly credentialId: Uint8Array | null
  readonly publicKey: Uint8Array | null
  readonly signCount: number | null
  readonly transports: readonly string[]
  readonly backedUp: boolean | null
  readonly deviceType: 'singleDevice' | 'multiDevice' | null
  readonly passwordHash: string | null
  readonly totpSecretId: SecretId | null
  readonly totpSecretVersion: number | null
  readonly totpLastStep: number | null
  readonly createdAt: string
  readonly lastUsedAt: string | null
  readonly recoveryCodesRemaining: number
}

const KINDS: readonly FactorKind[] = ['passkey', 'password', 'totp', 'recovery_codes']

const TS = (column: string) =>
  `to_char(f.${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ${column}`

export const FACTOR_COLUMNS = `f.factor_id, f.identity_id, f.kind, f.state, f.label, f.credential_id,
  f.public_key, f.sign_count, f.transports, f.backed_up, f.device_type, f.password_hash,
  f.totp_secret_id, f.totp_secret_version, f.totp_last_step, ${TS('created_at')}, ${TS('last_used_at')},
  (SELECT count(*)::int FROM auth.recovery_codes r WHERE r.factor_id = f.factor_id AND r.used_at IS NULL)
    AS recovery_codes_remaining`

function bytesOrNull(row: Row, column: string): Uint8Array | null {
  return row.json(column) === null ? null : row.bytes(column)
}

export function factorFromRow(row: Row): FactorRecord {
  const factorId = row.text('factor_id')
  const identityId = row.text('identity_id')
  const kind = KINDS.find((k) => k === row.text('kind'))
  const state = row.text('state')
  const deviceType = row.textOrNull('device_type')
  const totpSecretId = row.textOrNull('totp_secret_id')
  if (
    !isId('fac', factorId) ||
    !isId('idn', identityId) ||
    kind === undefined ||
    (state !== 'pending' && state !== 'active') ||
    (deviceType !== null && deviceType !== 'singleDevice' && deviceType !== 'multiDevice') ||
    (totpSecretId !== null && !isId('sec', totpSecretId))
  ) {
    throw new AuthError('INTERNAL')
  }
  return {
    factorId,
    identityId,
    kind,
    state,
    label: row.textOrNull('label'),
    credentialId: bytesOrNull(row, 'credential_id'),
    publicKey: bytesOrNull(row, 'public_key'),
    signCount: row.intOrNull('sign_count'),
    transports: row.json('transports') === null ? [] : row.textArray('transports'),
    backedUp: row.boolOrNull('backed_up'),
    deviceType,
    passwordHash: row.textOrNull('password_hash'),
    totpSecretId,
    totpSecretVersion: row.intOrNull('totp_secret_version'),
    totpLastStep: row.intOrNull('totp_last_step'),
    createdAt: row.text('created_at'),
    lastUsedAt: row.textOrNull('last_used_at'),
    recoveryCodesRemaining: row.int('recovery_codes_remaining'),
  }
}

export async function readFactors(
  q: Queryable,
  identityId: IdentityId,
  options: { readonly forUpdate?: boolean } = {},
): Promise<FactorRecord[]> {
  const { rows } = await q.query(
    options.forUpdate === true ? 'auth.factor.list_for_update' : 'auth.factor.list',
    `SELECT ${FACTOR_COLUMNS} FROM auth.factors f WHERE f.identity_id = $1
      ORDER BY f.created_at, f.factor_id${options.forUpdate === true ? ' FOR UPDATE OF f' : ''}`,
    [identityId],
  )
  return rows.map(factorFromRow)
}

export interface FactorSummary {
  readonly passkeys: number
  readonly password: boolean
  readonly totp: boolean
  readonly recoveryCodesRemaining: number
}

export function summarizeFactors(factors: readonly FactorRecord[]): FactorSummary {
  const active = factors.filter((f) => f.state === 'active')
  return {
    passkeys: active.filter((f) => f.kind === 'passkey').length,
    password: active.some((f) => f.kind === 'password'),
    totp: active.some((f) => f.kind === 'totp'),
    recoveryCodesRemaining: active
      .filter((f) => f.kind === 'recovery_codes')
      .reduce((sum, f) => sum + f.recoveryCodesRemaining, 0),
  }
}

/** The public view of an active factor: no key material, no hash, no secret reference. */
export function factorView(factor: FactorRecord): FactorView {
  switch (factor.kind) {
    case 'passkey':
      return {
        kind: 'passkey',
        id: factor.factorId,
        label: factor.label ?? 'Passkey',
        createdAt: factor.createdAt,
        lastUsedAt: factor.lastUsedAt,
        backedUp: factor.backedUp ?? false,
        deviceType: factor.deviceType ?? 'singleDevice',
      }
    case 'password':
      return { kind: 'password', id: factor.factorId, createdAt: factor.createdAt }
    case 'totp':
      return {
        kind: 'totp',
        id: factor.factorId,
        createdAt: factor.createdAt,
        lastUsedAt: factor.lastUsedAt,
      }
    case 'recovery_codes':
      return {
        kind: 'recovery_codes',
        id: factor.factorId,
        createdAt: factor.createdAt,
        remaining: factor.recoveryCodesRemaining,
      }
  }
}

/** A passkey label as the person typed it: trimmed, control characters refused by the caller's schema. */
export function passkeyLabel(label: string | undefined, fallback: string): string {
  const trimmed = (label ?? '').trim()
  return trimmed.length === 0 ? fallback.slice(0, 64) : trimmed.slice(0, 64)
}
