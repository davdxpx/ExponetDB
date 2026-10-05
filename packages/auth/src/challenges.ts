import type { Row, Tx } from '@exponetdb/control-store'
import {
  type CapabilityId,
  type ChallengeId,
  type Clock,
  type IdentityId,
  isId,
  newId,
  type SessionId,
} from '@exponetdb/kernel'
import { AuthError } from './errors.ts'
import { newToken, parseToken, tokenHash } from './tokens.ts'

/**
 * Ceremony state (`auth.challenges`). A WebAuthn challenge lives 5 minutes,
 * an enrollment 30 minutes, both from the database clock; each is consumed
 * once. Pre-session ceremonies are found through the hash of an opaque
 * handle (`exch_`) kept in the HttpOnly ceremony cookie; the handle itself
 * is never stored.
 */
export type ChallengeKind =
  | 'passkey_login'
  | 'second_factor'
  | 'passkey_reauth'
  | 'enrollment'
  | 'passkey_registration'

export interface ChallengeRecord {
  readonly challengeId: ChallengeId
  readonly kind: ChallengeKind
  readonly identityId: IdentityId | null
  readonly sessionId: SessionId | null
  readonly parentChallengeId: ChallengeId | null
  readonly capabilityId: CapabilityId | null
  readonly webauthnChallenge: string | null
  readonly expiresAt: string
  readonly expired: boolean
  readonly consumed: boolean
}

const KINDS: readonly ChallengeKind[] = [
  'passkey_login',
  'second_factor',
  'passkey_reauth',
  'enrollment',
  'passkey_registration',
]

const COLUMNS = `c.challenge_id, c.kind, c.identity_id, c.session_id, c.parent_challenge_id, c.capability_id,
  c.webauthn_challenge, to_char(c.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS expires_at,
  (c.expires_at <= clock_timestamp()) AS expired, (c.consumed_at IS NOT NULL) AS consumed`

function fromRow(row: Row): ChallengeRecord {
  const challengeId = row.text('challenge_id')
  const kind = KINDS.find((k) => k === row.text('kind'))
  const identityId = row.textOrNull('identity_id')
  const sessionId = row.textOrNull('session_id')
  const parent = row.textOrNull('parent_challenge_id')
  const capabilityId = row.textOrNull('capability_id')
  if (
    !isId('chl', challengeId) ||
    kind === undefined ||
    (identityId !== null && !isId('idn', identityId)) ||
    (sessionId !== null && !isId('ses', sessionId)) ||
    (parent !== null && !isId('chl', parent)) ||
    (capabilityId !== null && !isId('cap', capabilityId))
  ) {
    throw new AuthError('INTERNAL')
  }
  return {
    challengeId,
    kind,
    identityId,
    sessionId,
    parentChallengeId: parent,
    capabilityId,
    webauthnChallenge: row.textOrNull('webauthn_challenge'),
    expiresAt: row.text('expires_at'),
    expired: row.bool('expired'),
    consumed: row.bool('consumed'),
  }
}

export interface NewChallenge {
  readonly kind: ChallengeKind
  readonly withHandle: boolean
  readonly identityId?: IdentityId
  readonly sessionId?: SessionId
  readonly parentChallengeId?: ChallengeId
  readonly capabilityId?: CapabilityId
  readonly webauthnChallenge?: string
}

export async function createChallenge(
  tx: Tx,
  clock: Clock,
  input: NewChallenge,
): Promise<{ readonly challenge: ChallengeRecord; readonly handle: string | undefined }> {
  const challengeId = newId('chl', clock.nowMs())
  const handle = input.withHandle ? newToken('ceremony') : undefined
  const { rows } = await tx.query(
    'auth.challenge.insert',
    `INSERT INTO auth.challenges AS c
       (challenge_id, kind, handle_hash, identity_id, session_id, parent_challenge_id, capability_id,
        webauthn_challenge, created_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, clock_timestamp(), clock_timestamp())
     RETURNING ${COLUMNS}`,
    [
      challengeId,
      input.kind,
      handle === undefined ? null : tokenHash('ceremony', handle),
      input.identityId ?? null,
      input.sessionId ?? null,
      input.parentChallengeId ?? null,
      input.capabilityId ?? null,
      input.webauthnChallenge ?? null,
    ],
  )
  const row = rows[0]
  if (row === undefined) {
    throw new AuthError('INTERNAL')
  }
  return { challenge: fromRow(row), handle }
}

/** The challenge behind a ceremony cookie, locked; undefined for an unknown or malformed handle. */
export async function challengeByHandle(
  tx: Tx,
  kinds: readonly ChallengeKind[],
  handle: string | undefined,
): Promise<ChallengeRecord | undefined> {
  const token = parseToken('ceremony', handle)
  if (token === undefined) {
    return undefined
  }
  const { rows } = await tx.query(
    'auth.challenge.by_handle',
    `SELECT ${COLUMNS} FROM auth.challenges c WHERE c.handle_hash = $1 AND c.kind = ANY($2::text[])
      FOR UPDATE`,
    [tokenHash('ceremony', token), [...kinds]],
  )
  const row = rows[0]
  return row === undefined ? undefined : fromRow(row)
}

/** The newest unconsumed challenge of a kind for a session or a parent ceremony, locked. */
export async function latestChallenge(
  tx: Tx,
  kind: ChallengeKind,
  owner: { readonly sessionId: SessionId } | { readonly parentChallengeId: ChallengeId },
): Promise<ChallengeRecord | undefined> {
  const bySession = 'sessionId' in owner
  const { rows } = await tx.query(
    bySession ? 'auth.challenge.latest_for_session' : 'auth.challenge.latest_for_parent',
    `SELECT ${COLUMNS} FROM auth.challenges c
      WHERE c.kind = $1 AND ${bySession ? 'c.session_id' : 'c.parent_challenge_id'} = $2
        AND c.consumed_at IS NULL
      ORDER BY c.created_at DESC, c.challenge_id DESC LIMIT 1 FOR UPDATE`,
    [kind, bySession ? owner.sessionId : owner.parentChallengeId],
  )
  const row = rows[0]
  return row === undefined ? undefined : fromRow(row)
}

/** Consumes a challenge once; false when it was already consumed. */
export async function consumeChallenge(tx: Tx, challengeId: ChallengeId): Promise<boolean> {
  const { rowCount } = await tx.query(
    'auth.challenge.consume',
    `UPDATE auth.challenges SET consumed_at = clock_timestamp()
      WHERE challenge_id = $1 AND consumed_at IS NULL`,
    [challengeId],
  )
  return rowCount === 1
}

/**
 * The usable challenge or the refusal: unknown or consumed is
 * `AUTH_CHALLENGE_INVALID`, expired is `AUTH_CHALLENGE_EXPIRED`.
 */
export function usable(challenge: ChallengeRecord | undefined): ChallengeRecord | AuthError {
  if (challenge === undefined || challenge.consumed) {
    return new AuthError('AUTH_CHALLENGE_INVALID')
  }
  if (challenge.expired) {
    return new AuthError('AUTH_CHALLENGE_EXPIRED')
  }
  return challenge
}
