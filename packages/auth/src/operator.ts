import { randomBytes } from 'node:crypto'
import { EmailSchema } from '@exponetdb/contracts'
import {
  BOOTSTRAP_OWNER_LOCK,
  type ControlStore,
  EXDB_LOCK_NAMESPACE,
  lockKey2,
  type Tx,
} from '@exponetdb/control-store'
import { type Clock, type IdentityId, newId } from '@exponetdb/kernel'
import { appendAudit, MAINTENANCE_ACTOR } from './audit.ts'
import type { AuthConfig } from './config.ts'
import { AuthError } from './errors.ts'
import {
  findIdentityByEmail,
  IDENTITY_COLUMNS,
  identityFromRow,
  normalizeEmail,
} from './identities.ts'
import { type IssuedLink, invalidateLinks, issueLink } from './links.ts'
import {
  dispatchNotifications,
  type NotificationChannel,
  type PendingDelivery,
  recordNotification,
} from './notifications.ts'
import { revokeIdentitySessions } from './sessions.ts'

/**
 * The two operator commands of Wave 3A (identity.md §6, bootstrap.md §3),
 * run inside the server container with the serve login. They print a
 * one-time link to the operator's terminal and nowhere else; the audit
 * records that a link was issued, never the link. The actor is
 * `system:maintenance`: a shell on the container is the authority here,
 * and the audit says so.
 */
export interface OperatorDeps {
  readonly store: ControlStore
  readonly clock: Clock
  readonly config: AuthConfig
  readonly channel: NotificationChannel | undefined
}

export interface BootstrapResult extends IssuedLink {
  readonly identityId: IdentityId
  readonly reissued: boolean
}

function parseEmail(email: string): string {
  const checked = EmailSchema.safeParse(email.trim())
  if (!checked.success) {
    throw new AuthError('VALIDATION_FAILED')
  }
  return checked.data
}

async function activeOwnerCount(tx: Tx): Promise<number> {
  const { rows } = await tx.query('auth.owner.count', 'SELECT auth.active_owner_count()::int AS n')
  return rows[0]?.int('n') ?? 0
}

async function insertInvitedIdentity(
  tx: Tx,
  clock: Clock,
  input: { readonly email: string; readonly displayName?: string; readonly bootstrap: boolean },
): Promise<IdentityId> {
  const identityId = newId('idn', clock.nowMs())
  await tx.query(
    'auth.identity.insert',
    `INSERT INTO auth.identities (identity_id, kind, state, email, email_normalized, display_name,
                                  webauthn_user_handle, bootstrap)
     VALUES ($1, 'human', 'invited', $2, $3, $4, $5, $6)`,
    [
      identityId,
      input.email,
      normalizeEmail(input.email),
      input.displayName ?? null,
      randomBytes(32),
      input.bootstrap,
    ],
  )
  return identityId
}

export { insertInvitedIdentity }

/**
 * `exponetdb bootstrap owner --email … [--reissue]`. Creates the pending
 * first owner and a 30-minute setup link. Refused once an active owner
 * exists. While a first owner is pending, a new link (for the same or a
 * corrected address) needs `--reissue`; the old link stops working and a
 * corrected address replaces the pending one. Serialized by a
 * transaction lock, so concurrent runs cannot create two first owners.
 */
export async function bootstrapOwner(
  deps: OperatorDeps,
  input: { readonly email: string; readonly displayName?: string; readonly reissue: boolean },
): Promise<BootstrapResult> {
  const email = parseEmail(input.email)
  return deps.store.transaction('auth.bootstrap.owner', async (tx) => {
    await tx.query('auth.bootstrap.lock', 'SELECT pg_advisory_xact_lock($1::int, $2::int)', [
      BOOTSTRAP_OWNER_LOCK.key1,
      BOOTSTRAP_OWNER_LOCK.key2,
    ])
    if ((await activeOwnerCount(tx)) > 0) {
      throw new AuthError('bootstrap_closed')
    }
    const { rows } = await tx.query(
      'auth.bootstrap.pending',
      `SELECT ${IDENTITY_COLUMNS} FROM auth.identities i
        WHERE i.bootstrap AND i.state = 'invited' FOR UPDATE`,
    )
    const pending = rows[0] === undefined ? undefined : identityFromRow(rows[0])
    if (pending !== undefined && !input.reissue) {
      throw new AuthError('bootstrap_pending')
    }
    if (pending !== undefined) {
      // A corrected address is written to the pending identity itself (allowed only
      // while it is `invited`); there is never a second first-owner identity.
      const changed =
        pending.email === null || normalizeEmail(pending.email) !== normalizeEmail(email)
      if (changed) {
        const holder = await findIdentityByEmail(tx, email)
        if (holder !== undefined && holder.identityId !== pending.identityId) {
          throw new AuthError('bootstrap_email_taken')
        }
        await tx.query(
          'auth.bootstrap.readdress',
          `UPDATE auth.identities SET email = $2, email_normalized = $3
            WHERE identity_id = $1 AND state = 'invited'`,
          [pending.identityId, email, normalizeEmail(email)],
        )
      }
      const link = await issueLink(tx, deps.clock, deps.config, {
        kind: 'setup',
        identityId: pending.identityId,
      })
      await appendAudit(
        tx,
        {
          action: 'auth.bootstrap.reissue',
          phase: 'completed',
          actor: MAINTENANCE_ACTOR,
          changes: { identityId: pending.identityId, link: 'setup', addressChanged: changed },
          result: { status: 'succeeded' },
        },
        deps.clock,
      )
      return { ...link, identityId: pending.identityId, reissued: true }
    }
    if ((await findIdentityByEmail(tx, email)) !== undefined) {
      throw new AuthError('bootstrap_email_taken')
    }
    const identityId = await insertInvitedIdentity(tx, deps.clock, {
      email,
      ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
      bootstrap: true,
    })
    const link = await issueLink(tx, deps.clock, deps.config, { kind: 'setup', identityId })
    await appendAudit(
      tx,
      {
        action: 'auth.bootstrap.owner_invited',
        phase: 'completed',
        actor: MAINTENANCE_ACTOR,
        changes: { identityId, link: 'setup' },
        result: { status: 'succeeded' },
      },
      deps.clock,
    )
    return { ...link, identityId, reissued: false }
  })
}

const RECOVERY_LOCK = {
  key1: EXDB_LOCK_NAMESPACE,
  key2: lockKey2('auth/out-of-band-recovery'),
} as const

/** A written reason: 20 to 1000 characters after trimming, no control characters except line breaks. */
export function parseRecoveryReason(text: string): string {
  const reason = text.trim()
  const length = [...reason].length
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused
  if (length < 20 || length > 1000 || /[\u0000-\u0008\u000b-\u001f\u007f]/u.test(reason)) {
    throw new AuthError('recovery_reason_invalid')
  }
  return reason
}

export interface RecoveryResult extends IssuedLink {
  readonly identityId: IdentityId
  readonly sessionsEnded: number
  readonly ownersNotified: number
  readonly deliveries: number
}

/**
 * `exponetdb auth recover-owner --email … --reason-file …`: the last owner
 * lost every factor. Allowed only for an active identity that holds the
 * global owner role while no other active owner exists (another owner
 * would use the administrative flow). Ends every session of the identity
 * at once, marks it as recovering, issues a 30-minute recovery link (the
 * old factors are replaced when it is redeemed), notifies every owner and
 * writes `auth.out_of_band_recovery_used` with the operator's reason.
 */
export async function recoverOwner(
  deps: OperatorDeps,
  input: { readonly email: string; readonly reason: string },
): Promise<RecoveryResult> {
  const email = parseEmail(input.email)
  const reason = parseRecoveryReason(input.reason)
  const pending: (PendingDelivery | undefined)[] = []
  const result = await deps.store.transaction('auth.recover_owner', async (tx) => {
    await tx.query('auth.recover_owner.lock', 'SELECT pg_advisory_xact_lock($1::int, $2::int)', [
      RECOVERY_LOCK.key1,
      RECOVERY_LOCK.key2,
    ])
    const identity = await findIdentityByEmail(tx, email)
    const owner =
      identity === undefined
        ? false
        : (
            await tx.query(
              'auth.recover_owner.is_owner',
              `SELECT 1 FROM auth.role_bindings WHERE identity_id = $1 AND role_id = 'owner'
                 AND scope_kind = 'global' AND state = 'active'`,
              [identity.identityId],
            )
          ).rows.length > 0
    if (
      identity === undefined ||
      identity.state !== 'active' ||
      identity.kind !== 'human' ||
      !owner
    ) {
      throw new AuthError('recovery_no_owner')
    }
    const others = await tx.query(
      'auth.recover_owner.others',
      `SELECT DISTINCT b.identity_id FROM auth.role_bindings b JOIN auth.identities i USING (identity_id)
        WHERE b.role_id = 'owner' AND b.scope_kind = 'global' AND b.state = 'active'
          AND i.state = 'active' AND b.identity_id <> $1`,
      [identity.identityId],
    )
    if (others.rows.length > 0) {
      throw new AuthError('recovery_other_owner')
    }
    const sessionsEnded = await revokeIdentitySessions(
      tx,
      identity.identityId,
      'out_of_band_recovery',
    )
    await tx.query(
      'auth.recover_owner.mark',
      `UPDATE auth.identities SET recovery_required = true, session_epoch = session_epoch + 1
        WHERE identity_id = $1`,
      [identity.identityId],
    )
    await invalidateLinks(tx, identity.identityId, ['recovery'])
    const link = await issueLink(tx, deps.clock, deps.config, {
      kind: 'recovery',
      identityId: identity.identityId,
    })
    // Every active owner is told; with the last owner that is the person themselves.
    pending.push(
      await recordNotification(tx, deps.channel, {
        kind: 'auth.out_of_band_recovery',
        recipientIdentityId: identity.identityId,
        subjectIdentityId: identity.identityId,
        to: identity.email,
      }),
    )
    await appendAudit(
      tx,
      {
        action: 'auth.out_of_band_recovery_used',
        phase: 'requested',
        actor: MAINTENANCE_ACTOR,
        reason,
        changes: { identityId: identity.identityId, sessionsEnded, link: 'recovery' },
        result: { status: 'succeeded' },
      },
      deps.clock,
    )
    return { ...link, identityId: identity.identityId, sessionsEnded, ownersNotified: 1 }
  })
  const outcomes = await dispatchNotifications(deps.store, deps.channel, pending)
  return { ...result, deliveries: [...outcomes.values()].filter((o) => o === 'sent').length }
}
