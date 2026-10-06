import type { Tx } from '@exponetdb/control-store'
import { type IdentityId, isId } from '@exponetdb/kernel'
import { type AuditRequest, appendAudit, SERVE_ACTOR } from './audit.ts'
import type { AuthDeps } from './deps.ts'
import { type PendingDelivery, recordNotification } from './notifications.ts'
import { type Bucket, RATE_LIMITS, recordFailure } from './ratelimit.ts'

/**
 * Counts a failed authentication in every bucket it belongs to and writes
 * the aggregated audit events (identity.md §2: "all failures audited in
 * aggregated form"): one event when a bucket reaches 5 failures, then each
 * time the count doubles, and one when it locks. A lock of an identity's
 * bucket notifies that person. The audit names the bucket kind and count
 * and, for an identity bucket, the identity; never the typed address.
 */
export async function countFailure(
  tx: Tx,
  deps: AuthDeps,
  request: AuditRequest,
  action: 'auth.login' | 'auth.reauth' | 'auth.enrollment',
  buckets: readonly Bucket[],
  identity?: { readonly identityId: IdentityId; readonly email: string | null },
): Promise<PendingDelivery[]> {
  const deliveries: PendingDelivery[] = []
  for (const bucket of buckets) {
    const record = await recordFailure(tx, bucket)
    if (record.auditDue) {
      await appendAudit(
        tx,
        {
          action: `${action}.failures`,
          phase: 'denied',
          actor: SERVE_ACTOR,
          request,
          changes: {
            bucket: bucket.kind,
            failures: record.failures,
            locked: record.lockedNow,
            lockSeconds: record.lockedNow ? RATE_LIMITS[bucket.kind].lockSeconds : 0,
            ...(bucket.identityId === undefined ? {} : { identityId: bucket.identityId }),
          },
          result: { status: 'denied', errorCode: 'AUTHENTICATION_FAILED' },
        },
        deps.clock,
      )
    }
    if (record.lockedNow && bucket.identityId !== undefined && identity !== undefined) {
      const recipients = [
        { identityId: identity.identityId, email: identity.email },
        ...(await otherOwners(tx, identity.identityId)),
      ]
      for (const recipient of recipients) {
        const pending = await recordNotification(tx, deps.channel, {
          kind: 'auth.lockout',
          recipientIdentityId: recipient.identityId,
          subjectIdentityId: identity.identityId,
          to: recipient.email,
        })
        if (pending !== undefined) {
          deliveries.push(pending)
        }
      }
    }
  }
  return deliveries
}

async function otherOwners(
  tx: Tx,
  identityId: IdentityId,
): Promise<{ identityId: IdentityId; email: string | null }[]> {
  const { rows } = await tx.query(
    'auth.lockout.owners',
    `SELECT DISTINCT i.identity_id, i.email
       FROM auth.role_bindings b JOIN auth.identities i ON i.identity_id = b.identity_id
      WHERE b.role_id = 'owner' AND b.scope_kind = 'global' AND b.state = 'active'
        AND i.state = 'active' AND i.identity_id <> $1
      ORDER BY i.identity_id`,
    [identityId],
  )
  return rows.flatMap((row) => {
    const id = row.text('identity_id')
    return isId('idn', id) ? [{ identityId: id, email: row.textOrNull('email') }] : []
  })
}
