import type { Queryable, Row } from '@exponetdb/control-store'
import { type IdentityId, isId } from '@exponetdb/kernel'
import { identityLabel } from './audit.ts'
import { AuthError } from './errors.ts'

/**
 * Identity rows as serve reads them (identity.md §1). E-mail addresses are
 * contact data: compared only in their normalized form (lower case), never
 * used as an identifier, never written to audit events or logs.
 */
export type IdentityState = 'invited' | 'active' | 'disabled' | 'erased'

export interface IdentityRecord {
  readonly identityId: IdentityId
  readonly kind: 'human' | 'service'
  readonly labelNumber: number
  readonly label: string
  readonly state: IdentityState
  readonly email: string | null
  readonly displayName: string | null
  readonly webauthnUserHandle: Uint8Array | null
  readonly bootstrap: boolean
  readonly recoveryRequired: boolean
  readonly sessionEpoch: number
  readonly authzRevision: number
  readonly createdAt: string
  readonly activatedAt: string | null
}

const STATES: readonly IdentityState[] = ['invited', 'active', 'disabled', 'erased']

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

/** Columns and formatting shared by every identity read (UTC, microseconds). */
export const IDENTITY_COLUMNS = `i.identity_id, i.kind, i.label_number, i.state, i.email, i.display_name,
  i.webauthn_user_handle, i.bootstrap, i.recovery_required, i.session_epoch, i.authz_revision,
  to_char(i.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
  to_char(i.activated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS activated_at`

export function identityFromRow(row: Row): IdentityRecord {
  const identityId = row.text('identity_id')
  const kind = row.text('kind')
  const state = STATES.find((s) => s === row.text('state'))
  if (!isId('idn', identityId) || (kind !== 'human' && kind !== 'service') || state === undefined) {
    throw new AuthError('INTERNAL')
  }
  const handle = row.has('webauthn_user_handle')
    ? row.json('webauthn_user_handle') === null
      ? null
      : row.bytes('webauthn_user_handle')
    : null
  const labelNumber = row.int('label_number')
  return {
    identityId,
    kind,
    labelNumber,
    label: identityLabel(labelNumber),
    state,
    email: row.textOrNull('email'),
    displayName: row.textOrNull('display_name'),
    webauthnUserHandle: handle,
    bootstrap: row.bool('bootstrap'),
    recoveryRequired: row.bool('recovery_required'),
    sessionEpoch: row.int('session_epoch'),
    authzRevision: row.int('authz_revision'),
    createdAt: row.text('created_at'),
    activatedAt: row.textOrNull('activated_at'),
  }
}

export async function readIdentity(
  q: Queryable,
  identityId: IdentityId,
  options: { readonly forUpdate?: boolean } = {},
): Promise<IdentityRecord | undefined> {
  const { rows } = await q.query(
    options.forUpdate === true ? 'auth.identity.read_for_update' : 'auth.identity.read',
    `SELECT ${IDENTITY_COLUMNS} FROM auth.identities i WHERE i.identity_id = $1${
      options.forUpdate === true ? ' FOR UPDATE' : ''
    }`,
    [identityId],
  )
  const row = rows[0]
  return row === undefined ? undefined : identityFromRow(row)
}

export async function findIdentityByEmail(
  q: Queryable,
  email: string,
): Promise<IdentityRecord | undefined> {
  const { rows } = await q.query(
    'auth.identity.by_email',
    `SELECT ${IDENTITY_COLUMNS} FROM auth.identities i WHERE i.email_normalized = $1`,
    [normalizeEmail(email)],
  )
  const row = rows[0]
  return row === undefined ? undefined : identityFromRow(row)
}
