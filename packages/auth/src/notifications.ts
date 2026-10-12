import type { Tx } from '@exponetdb/control-store'
import type { IdentityId } from '@exponetdb/kernel'

/**
 * Security notifications (identity.md §2, §6): who must be told what, and
 * whether it was delivered. The Control Store keeps the kind, the
 * recipient and the delivery status, never content, a link or an address;
 * the recipient's address is resolved at delivery time.
 *
 * Delivery is truthful: without a configured channel the status is
 * `unavailable` and callers report `not_configured`, never `sent`. A
 * channel is called only after the transaction that recorded the
 * notification committed, because sending is an external side effect.
 * Wave 3A ships no channel implementation (no e-mail provider is decided);
 * the interface lets one be added without touching the services.
 */
export const NOTIFICATION_KINDS = [
  'auth.invitation',
  'auth.lockout',
  'auth.recovery_code_used',
  'auth.factors_changed',
  'auth.out_of_band_recovery',
  'auth.identity_disabled',
  'auth.owner_activated',
  'breakglass.activated',
] as const
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number]

export interface OutboundNotification {
  readonly kind: NotificationKind
  /** Resolved at delivery time from the recipient identity; never stored with the notification. */
  readonly to: string
  /** One-time link for an invitation or recovery; in memory only. */
  readonly link?: string
}

export type DeliveryResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly errorCode: string }

export interface NotificationChannel {
  readonly name: 'email'
  deliver(notification: OutboundNotification): Promise<DeliveryResult>
}

export interface PendingDelivery {
  readonly notificationId: number
  readonly notification: OutboundNotification
}

/**
 * Records a notification in the caller's transaction. With a channel the
 * row is `pending` and the returned delivery is dispatched after commit;
 * without one it is `unavailable` and there is nothing to dispatch.
 */
export async function recordNotification(
  tx: Tx,
  channel: { readonly name: string } | undefined,
  input: {
    readonly kind: NotificationKind
    readonly recipientIdentityId: IdentityId
    readonly subjectIdentityId?: IdentityId
    readonly to: string | null
    readonly link?: string
  },
): Promise<PendingDelivery | undefined> {
  const deliverable = channel !== undefined && input.to !== null
  const { rows } = await tx.query(
    'auth.notification.insert',
    `INSERT INTO auth.notifications (kind, recipient_identity_id, subject_identity_id, status, error_code)
     VALUES ($1, $2, $3, $4, $5) RETURNING notification_id`,
    [
      input.kind,
      input.recipientIdentityId,
      input.subjectIdentityId ?? null,
      deliverable ? 'pending' : 'unavailable',
      channel === undefined ? null : input.to === null ? 'no_address' : null,
    ],
  )
  const id = rows[0]?.int('notification_id')
  if (!deliverable || id === undefined || input.to === null) {
    return undefined
  }
  return {
    notificationId: id,
    notification: {
      kind: input.kind,
      to: input.to,
      ...(input.link === undefined ? {} : { link: input.link }),
    },
  }
}

/** Delivers after commit and records the truthful outcome of each delivery. */
export async function dispatchNotifications(
  store: { transaction<T>(queryClass: string, fn: (tx: Tx) => Promise<T>): Promise<T> },
  channel: NotificationChannel | undefined,
  pending: readonly (PendingDelivery | undefined)[],
): Promise<Map<number, 'sent' | 'failed'>> {
  const outcomes = new Map<number, 'sent' | 'failed'>()
  if (channel === undefined) {
    return outcomes
  }
  for (const item of pending) {
    if (item === undefined) {
      continue
    }
    let result: DeliveryResult
    try {
      result = await channel.deliver(item.notification)
    } catch {
      result = { ok: false, errorCode: 'channel_error' }
    }
    const errorCode = result.ok
      ? null
      : /^[a-z][a-z0-9_]{0,63}$/.test(result.errorCode)
        ? result.errorCode
        : 'channel_error'
    await store.transaction('auth.notification.status', (tx) =>
      tx.query(
        'auth.notification.status',
        `UPDATE auth.notifications SET status = $2, error_code = $3, status_changed_at = clock_timestamp()
          WHERE notification_id = $1 AND status = 'pending'`,
        [item.notificationId, result.ok ? 'sent' : 'failed', errorCode],
      ),
    )
    outcomes.set(item.notificationId, result.ok ? 'sent' : 'failed')
  }
  return outcomes
}
