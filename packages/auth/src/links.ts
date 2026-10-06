import type { Tx } from '@exponetdb/control-store'
import { type CapabilityId, type Clock, type IdentityId, isId, newId } from '@exponetdb/kernel'
import type { AuthConfig } from './config.ts'
import { AuthError } from './errors.ts'
import { newToken, parseToken, TOKEN_PREFIXES, tokenHash } from './tokens.ts'

/**
 * One-time links (identity.md §6, bootstrap.md §3): first-owner setup and
 * out-of-band recovery live exactly 30 minutes, invitations 24 hours, from
 * the database clock. The secret is 256 random bits in the URL fragment
 * (`https://db.exponet.cloud/setup#token=…`), so it never reaches a server
 * log, a proxy or a `Referer`; the Web App posts it in a body. Only its
 * hash is stored. Issuing a link invalidates the identity's live link of
 * the same kind in the same transaction, ends every enrollment ceremony that
 * an older link opened and deletes the factors it left pending; a link is
 * redeemed once, and only the newest link of a kind can complete.
 */
export type LinkKind = 'setup' | 'invitation' | 'recovery'

const PATHS: Readonly<Record<LinkKind, string>> = {
  setup: '/setup',
  invitation: '/invite',
  recovery: '/recover',
}

export interface IssuedLink {
  readonly capabilityId: CapabilityId
  readonly link: string
  readonly expiresAt: string
}

export async function invalidateLinks(
  tx: Tx,
  identityId: IdentityId,
  kinds: readonly LinkKind[] = ['setup', 'invitation', 'recovery'],
): Promise<number> {
  const { rowCount } = await tx.query(
    'auth.link.invalidate',
    `UPDATE auth.capabilities SET invalidated_at = clock_timestamp()
      WHERE identity_id = $1 AND kind = ANY($2::text[]) AND redeemed_at IS NULL AND invalidated_at IS NULL`,
    [identityId, [...kinds]],
  )
  return rowCount
}

/**
 * Ends every open enrollment ceremony of the identity and deletes the
 * factors it left pending: whoever redeemed an older link cannot finish
 * with the factors they registered.
 */
export async function endEnrollments(tx: Tx, identityId: IdentityId): Promise<void> {
  await tx.query(
    'auth.enrollment.end',
    `UPDATE auth.challenges SET consumed_at = clock_timestamp()
      WHERE identity_id = $1 AND kind = 'enrollment' AND consumed_at IS NULL`,
    [identityId],
  )
  await tx.query(
    'auth.enrollment.pending_factors',
    `DELETE FROM auth.factors WHERE identity_id = $1 AND state = 'pending'`,
    [identityId],
  )
}

export async function issueLink(
  tx: Tx,
  clock: Clock,
  config: AuthConfig,
  input: {
    readonly kind: LinkKind
    readonly identityId: IdentityId
    readonly issuedBy?: IdentityId
  },
): Promise<IssuedLink> {
  await invalidateLinks(tx, input.identityId, [input.kind])
  await endEnrollments(tx, input.identityId)
  const capabilityId = newId('cap', clock.nowMs())
  const token = newToken(input.kind)
  const { rows } = await tx.query(
    'auth.link.insert',
    `INSERT INTO auth.capabilities
       (capability_id, kind, identity_id, token_hash, issued_by_identity_id, created_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, clock_timestamp(), clock_timestamp())
     RETURNING to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS expires_at`,
    [
      capabilityId,
      input.kind,
      input.identityId,
      tokenHash(input.kind, token),
      input.issuedBy ?? null,
    ],
  )
  const expiresAt = rows[0]?.text('expires_at')
  if (expiresAt === undefined) {
    throw new AuthError('INTERNAL')
  }
  return {
    capabilityId,
    link: `${config.publicOrigin}${PATHS[input.kind]}#token=${token}`,
    expiresAt,
  }
}

export interface LinkRecord {
  readonly capabilityId: CapabilityId
  readonly kind: LinkKind
  readonly identityId: IdentityId
  readonly issuedBy: IdentityId | null
  readonly expiresAt: string
  readonly live: boolean
}

function kindOfToken(token: string): LinkKind | undefined {
  for (const kind of ['setup', 'invitation', 'recovery'] as const) {
    if (token.startsWith(`${TOKEN_PREFIXES[kind]}_`) && parseToken(kind, token) !== undefined) {
      return kind
    }
  }
  return undefined
}

/** The link behind a token, locked, with whether it can still be redeemed. */
export async function linkByToken(tx: Tx, token: string): Promise<LinkRecord | undefined> {
  const kind = kindOfToken(token)
  if (kind === undefined) {
    return undefined
  }
  const { rows } = await tx.query(
    'auth.link.by_token',
    `SELECT capability_id, kind, identity_id, issued_by_identity_id,
            to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS expires_at,
            (redeemed_at IS NULL AND invalidated_at IS NULL AND expires_at > clock_timestamp()) AS live
       FROM auth.capabilities WHERE token_hash = $1 AND kind = $2 FOR UPDATE`,
    [tokenHash(kind, token), kind],
  )
  const row = rows[0]
  if (row === undefined) {
    return undefined
  }
  const capabilityId = row.text('capability_id')
  const identityId = row.text('identity_id')
  const issuedBy = row.textOrNull('issued_by_identity_id')
  if (
    !isId('cap', capabilityId) ||
    !isId('idn', identityId) ||
    (issuedBy !== null && !isId('idn', issuedBy))
  ) {
    throw new AuthError('INTERNAL')
  }
  return {
    capabilityId,
    kind,
    identityId,
    issuedBy,
    expiresAt: row.text('expires_at'),
    live: row.bool('live'),
  }
}

export async function redeemLink(tx: Tx, capabilityId: CapabilityId): Promise<boolean> {
  const { rowCount } = await tx.query(
    'auth.link.redeem',
    `UPDATE auth.capabilities SET redeemed_at = clock_timestamp()
      WHERE capability_id = $1 AND redeemed_at IS NULL AND invalidated_at IS NULL
        AND expires_at > clock_timestamp()`,
    [capabilityId],
  )
  return rowCount === 1
}
