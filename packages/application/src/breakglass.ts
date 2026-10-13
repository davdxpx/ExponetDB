import { createHash } from 'node:crypto'
import { appendAuditEvent } from '@exponetdb/audit'
import {
  AuthError,
  type NotificationChannel,
  type PendingDelivery,
  recordNotification,
} from '@exponetdb/auth'
import {
  type BreakGlassGrantList,
  BreakGlassGrantListSchema,
  type BreakGlassGrantRecord,
  BreakGlassGrantRecordSchema,
  type BreakGlassGrantState,
} from '@exponetdb/contracts'
import type { Tx } from '@exponetdb/control-store'
import { type IdentityId, newId } from '@exponetdb/kernel'
import {
  type BreakGlassGrant,
  decodeCursor,
  encodeCursor,
  findTarget,
  listBreakGlassGrants,
  type PageRequest,
  RegistryError,
  readBreakGlassRecord,
  recordBreakGlassGrant,
  reviewBreakGlassGrant,
} from '@exponetdb/registry'
import type { CallerLike, RegistryHost } from './registry.ts'

/** What activation needs besides the registry host: the notification path and its dispatch. */
export interface BreakGlassNotifier {
  readonly channel: NotificationChannel | undefined
  dispatch(pending: readonly PendingDelivery[]): Promise<ReadonlyMap<number, 'sent' | 'failed'>>
}

export interface BreakGlassActivation {
  readonly rules: readonly string[]
  readonly reason: string
  readonly durationMinutes?: number | undefined
  readonly maxUses?: number | undefined
}

export interface BreakGlassGrantView extends Omit<BreakGlassGrant, 'identityId'> {
  readonly notifications: {
    readonly recorded: number
    readonly sent: number
    readonly failed: number
  }
}

/**
 * Break-glass activation ([operations-engine.md §8](../../../exponetdb-docs/02-control-plane/operations-engine.md#8-break-glass)):
 * a person with `breakglass.activate` on the target, re-authenticated in the
 * Web App within 120 seconds (the central engine enforces both), names the
 * overridable rules, a reason and a duration. The grant, a notification to
 * the person and to every active owner, and the audit event are recorded
 * in one transaction; delivery follows after commit and is reported
 * truthfully. Without a notification channel nobody would be told, so the
 * activation is refused (`BREAK_GLASS_UNAVAILABLE`, OD-21): break-glass is
 * never silent.
 */
export class BreakGlassUseCases {
  readonly #h: RegistryHost
  readonly #notifier: BreakGlassNotifier

  constructor(host: RegistryHost, notifier: BreakGlassNotifier) {
    this.#h = host
    this.#notifier = notifier
  }

  async activate(
    caller: CallerLike,
    ref: string,
    request: BreakGlassActivation,
  ): Promise<BreakGlassGrantView> {
    await this.#h.admit(this.#h.store, 'breakglass.activate', caller)
    const target = await findTarget(this.#h.store, ref)
    if (target === undefined) {
      throw new RegistryError('TARGET_NOT_FOUND')
    }
    const subject = { kind: 'target', targetId: target.targetId } as const
    await this.#h.authorize(this.#h.store, 'breakglass.activate', caller, subject)
    const rules = [...new Set(request.rules)].sort()
    const registry = this.#h.services?.plans.policy.registry
    if (
      registry === undefined ||
      rules.some((id) => registry.get(id)?.overridableByBreakGlass !== true)
    ) {
      throw new RegistryError('BREAK_GLASS_UNAVAILABLE', { reason: 'rule_not_overridable' })
    }
    if (this.#notifier.channel === undefined) {
      throw new RegistryError('BREAK_GLASS_UNAVAILABLE', {
        reason: 'notification_channel_not_configured',
      })
    }
    const channel = this.#notifier.channel
    const actor = this.#h.planActor(caller)
    const identityId = this.#h.identityOf(caller)
    const { grant, pending } = await this.#h.store.transaction(
      'application.breakglass.activate',
      async (tx) => {
        await this.#h.authorize(tx, 'breakglass.activate', caller, subject)
        const grant = await recordBreakGlassGrant(tx, {
          grantId: newId('bgl', this.#h.clock.nowMs()),
          identityId,
          targetId: target.targetId,
          rules,
          reason: request.reason,
          durationMinutes: request.durationMinutes ?? 30,
          maxUses: request.maxUses ?? null,
        })
        const pending: PendingDelivery[] = []
        for (const recipient of await recipients(tx, identityId)) {
          const delivery = await recordNotification(tx, channel, {
            kind: 'breakglass.activated',
            recipientIdentityId: recipient.identityId,
            subjectIdentityId: identityId,
            to: recipient.email,
          })
          if (delivery !== undefined) pending.push(delivery)
        }
        await appendAuditEvent(
          tx,
          {
            action: 'breakglass.activated',
            phase: 'completed',
            actor: {
              kind: 'human',
              identityId,
              label: actor.label as never,
              reauthAt: actor.reauthAt,
            },
            client: { clientId: actor.clientId ?? null, kind: actor.client ?? 'web' },
            subject: {
              targetId: target.targetId,
              targetPath: target.path,
              tier: target.tier,
            } as never,
            changes: {
              grantId: grant.grantId,
              rules: [...grant.rules],
              reason: grant.reason,
              expiresAt: grant.expiresAt,
              maxUses: grant.maxUses,
            },
            result: { status: 'succeeded' },
          },
          { clock: this.#h.clock },
        )
        return { grant, pending }
      },
    )
    const outcomes = await this.#notifier.dispatch(pending)
    const sent = [...outcomes.values()].filter((o) => o === 'sent').length
    const { identityId: _owner, ...view } = grant
    return {
      ...view,
      notifications: { recorded: pending.length, sent, failed: outcomes.size - sent },
    }
  }

  /**
   * `breakglass.list` (Wave 8): every grant of the installation, newest
   * first, for an owner or admin (`policy.manage` at the installation, a
   * human session). The state of each is derived at one database clock
   * reading (`observedAt`); the reason and the review note are untrusted
   * data. A target filter that names no target is `TARGET_NOT_FOUND`.
   */
  async list(
    caller: CallerLike,
    query: {
      readonly state?: BreakGlassGrantState | undefined
      readonly review?: 'open' | 'done' | undefined
      readonly target?: string | undefined
    } & PageRequest,
  ): Promise<BreakGlassGrantList> {
    await this.#h.authorize(this.#h.store, 'breakglass.list', caller, { kind: 'installation' })
    let targetId: string | undefined
    if (query.target !== undefined) {
      const target = await findTarget(this.#h.store, query.target)
      if (target === undefined) throw new RegistryError('TARGET_NOT_FOUND')
      targetId = target.targetId
    }
    const page = await listBreakGlassGrants(this.#h.store, {
      state: query.state,
      review: query.review,
      targetId,
      after: decodeCursor(query.cursor),
      limit: query.limit,
    })
    return BreakGlassGrantListSchema.parse({
      items: page.items,
      nextCursor: page.more && page.last !== null ? encodeCursor(page.last) : null,
      source: 'live',
      observedAt: page.observedAt,
    })
  }

  /**
   * `breakglass.review` (Wave 8): the post-incident review of a grant that
   * is no longer active, by an owner or admin re-authenticated within 300
   * seconds in the Web App (the central engine enforces both). Written once
   * into the review columns of the frozen bundle (a second review, also a
   * concurrent one, is `CONFLICT`; so is a review of a grant that can still
   * be used), with the audit event `breakglass.reviewed` in the same
   * transaction. The audit event binds the note by its SHA-256 and length
   * and does not copy its text: the note is free text kept with the grant,
   * and the audit export must not carry it a second time. Activation is not
   * touched: it stays refused while OD-21 is open.
   */
  async review(
    caller: CallerLike,
    grantId: string,
    request: { readonly note: string },
  ): Promise<BreakGlassGrantRecord> {
    const subject = { kind: 'installation' } as const
    await this.#h.authorize(this.#h.store, 'breakglass.review', caller, subject)
    const actor = this.#h.planActor(caller)
    const reviewerId = this.#h.identityOf(caller)
    return this.#h.store.transaction('application.breakglass.review', async (tx) => {
      await this.#h.authorize(tx, 'breakglass.review', caller, subject)
      const outcome = await reviewBreakGlassGrant(tx, {
        grantId,
        reviewerId,
        note: request.note,
      })
      if (outcome === 'not_found') throw new AuthError('NOT_FOUND')
      if (outcome !== 'reviewed') throw new AuthError('CONFLICT')
      const record = await readBreakGlassRecord(tx, grantId)
      if (record === undefined) throw new AuthError('NOT_FOUND')
      await appendAuditEvent(
        tx,
        {
          action: 'breakglass.reviewed',
          phase: 'completed',
          actor: {
            kind: 'human',
            identityId: reviewerId,
            label: actor.label as never,
            reauthAt: actor.reauthAt,
          },
          client: { clientId: actor.clientId ?? null, kind: actor.client ?? 'web' },
          subject: {
            targetId: record.target.targetId,
            targetPath: record.target.path,
            tier: record.target.tier,
          } as never,
          changes: {
            grantId,
            grantState: record.state,
            activatedBy: record.activatedBy.identityId,
            noteLength: [...request.note].length,
            noteSha256: `sha256:${createHash('sha256').update(request.note, 'utf8').digest('hex')}`,
          },
          result: { status: 'succeeded' },
        },
        { clock: this.#h.clock },
      )
      return BreakGlassGrantRecordSchema.parse(record)
    })
  }
}

/** The person and every other active owner (the installation's owners are told of every activation). */
async function recipients(
  tx: Tx,
  identityId: IdentityId,
): Promise<{ identityId: IdentityId; email: string | null }[]> {
  const { rows } = await tx.query(
    'application.breakglass.recipients',
    `SELECT DISTINCT i.identity_id, i.email
       FROM auth.identities i
      WHERE i.state = 'active'
        AND (i.identity_id = $1 OR EXISTS (
              SELECT 1 FROM auth.role_bindings b
               WHERE b.identity_id = i.identity_id AND b.role_id = 'owner'
                 AND b.scope_kind = 'global' AND b.state = 'active'))
      ORDER BY i.identity_id`,
    [identityId],
  )
  return rows.map((r) => ({
    identityId: r.text('identity_id') as IdentityId,
    email: r.textOrNull('email'),
  }))
}
