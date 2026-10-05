import type { IdentityView, InvitationDelivery } from '@exponetdb/contracts'
import { ControlStoreError, type Queryable, type Tx } from '@exponetdb/control-store'
import type { IdentityId } from '@exponetdb/kernel'
import { type AuditRequest, appendAudit, humanActor, webClient } from '../audit.ts'
import type { AuthDeps } from '../deps.ts'
import { AuthError } from '../errors.ts'
import { readFactors, summarizeFactors } from '../factors.ts'
import {
  findIdentityByEmail,
  IDENTITY_COLUMNS,
  type IdentityRecord,
  identityFromRow,
  readIdentity,
} from '../identities.ts'
import { invalidateLinks, issueLink } from '../links.ts'
import { type PendingDelivery, recordNotification } from '../notifications.ts'
import { insertInvitedIdentity } from '../operator.ts'
import { revokeIdentitySessions, type SessionContext } from '../sessions.ts'

/**
 * Identity administration with inline plans (C-6): invite, re-issue an
 * invitation, disable. The central authorization engine decided
 * `access.manage`, the human-only rule and the 5-minute re-authentication
 * before these run, in the same transaction.
 *
 * - An invitation creates an `invited` identity with no role: access is
 *   granted only by a separate, planned role binding.
 * - Disabling ends every session and link of the identity at once (the
 *   session epoch moves) and is refused by the Control Store when it would
 *   leave no active owner. Only an owner may disable an owner.
 */
export async function identityView(q: Queryable, identity: IdentityRecord): Promise<IdentityView> {
  const factors = summarizeFactors(await readFactors(q, identity.identityId))
  return {
    id: identity.identityId,
    kind: identity.kind,
    state: identity.state,
    label: identity.label,
    displayName: identity.displayName,
    email: identity.email,
    createdAt: identity.createdAt,
    activatedAt: identity.activatedAt,
    recoveryRequired: identity.recoveryRequired,
    factors,
  }
}

export async function listIdentities(q: Queryable): Promise<IdentityView[]> {
  const { rows } = await q.query(
    'auth.identity.list',
    `SELECT ${IDENTITY_COLUMNS} FROM auth.identities i ORDER BY i.label_number`,
  )
  const views: IdentityView[] = []
  for (const row of rows) {
    views.push(await identityView(q, identityFromRow(row)))
  }
  return views
}

export async function getIdentity(q: Queryable, identityId: IdentityId): Promise<IdentityView> {
  const identity = await readIdentity(q, identityId)
  if (identity === undefined) {
    throw new AuthError('NOT_FOUND')
  }
  return identityView(q, identity)
}

export interface InvitationResult {
  readonly identity: IdentityView
  readonly link: string
  readonly expiresAt: string
  readonly delivery: PendingDelivery | undefined
}

/** How the inviting person learns what happened to the e-mail (truthful). */
export function deliveryStatus(
  deps: Pick<AuthDeps, 'channel'>,
  outcome: 'sent' | 'failed' | undefined,
): InvitationDelivery {
  if (deps.channel === undefined || outcome === undefined) {
    return { status: 'not_configured', channel: 'none' }
  }
  return { status: outcome, channel: 'email' }
}

async function hasOwnerRole(q: Queryable, identityId: IdentityId): Promise<boolean> {
  const { rows } = await q.query(
    'auth.owner.has',
    `SELECT 1 FROM auth.role_bindings WHERE identity_id = $1 AND role_id = 'owner'
       AND scope_kind = 'global' AND state = 'active'`,
    [identityId],
  )
  return rows.length > 0
}

export async function inviteIdentity(
  tx: Tx,
  deps: AuthDeps,
  actor: SessionContext,
  request: AuditRequest,
  input: { readonly email: string; readonly displayName?: string | undefined },
): Promise<InvitationResult> {
  if ((await findIdentityByEmail(tx, input.email)) !== undefined) {
    throw new AuthError('IDENTITY_EXISTS')
  }
  const identityId = await insertInvitedIdentity(tx, deps.clock, {
    email: input.email.trim(),
    ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
    bootstrap: false,
  })
  const link = await issueLink(tx, deps.clock, deps.config, {
    kind: 'invitation',
    identityId,
    issuedBy: actor.identityId,
  })
  const delivery = await recordNotification(tx, deps.channel, {
    kind: 'auth.invitation',
    recipientIdentityId: identityId,
    to: input.email.trim(),
    link: link.link,
  })
  await appendAudit(
    tx,
    {
      action: 'access.identity.invite',
      phase: 'completed',
      actor: humanActor(actor, actor.reauthAt),
      client: webClient(actor.sessionId),
      request,
      changes: { identityId, roles: 0 },
      result: { status: 'succeeded' },
    },
    deps.clock,
  )
  const identity = await readIdentity(tx, identityId)
  if (identity === undefined) {
    throw new AuthError('INTERNAL')
  }
  return {
    identity: await identityView(tx, identity),
    link: link.link,
    expiresAt: link.expiresAt,
    delivery,
  }
}

export async function reissueInvitation(
  tx: Tx,
  deps: AuthDeps,
  actor: SessionContext,
  request: AuditRequest,
  identityId: IdentityId,
): Promise<InvitationResult> {
  const identity = await readIdentity(tx, identityId, { forUpdate: true })
  if (identity === undefined) {
    throw new AuthError('NOT_FOUND')
  }
  if (identity.state !== 'invited' || identity.bootstrap || identity.email === null) {
    throw new AuthError('IDENTITY_STATE_INVALID')
  }
  const link = await issueLink(tx, deps.clock, deps.config, {
    kind: 'invitation',
    identityId,
    issuedBy: actor.identityId,
  })
  const delivery = await recordNotification(tx, deps.channel, {
    kind: 'auth.invitation',
    recipientIdentityId: identityId,
    to: identity.email,
    link: link.link,
  })
  await appendAudit(
    tx,
    {
      action: 'access.invitation.reissue',
      phase: 'completed',
      actor: humanActor(actor, actor.reauthAt),
      client: webClient(actor.sessionId),
      request,
      changes: { identityId },
      result: { status: 'succeeded' },
    },
    deps.clock,
  )
  return {
    identity: await identityView(tx, identity),
    link: link.link,
    expiresAt: link.expiresAt,
    delivery,
  }
}

export async function disableIdentity(
  tx: Tx,
  deps: AuthDeps,
  actor: SessionContext,
  request: AuditRequest,
  identityId: IdentityId,
  reason: string | undefined,
): Promise<{ readonly identity: IdentityView; readonly delivery: PendingDelivery | undefined }> {
  const identity = await readIdentity(tx, identityId, { forUpdate: true })
  if (identity === undefined) {
    throw new AuthError('NOT_FOUND')
  }
  if (identity.state !== 'invited' && identity.state !== 'active') {
    throw new AuthError('IDENTITY_STATE_INVALID')
  }
  if ((await hasOwnerRole(tx, identityId)) && !(await hasOwnerRole(tx, actor.identityId))) {
    throw new AuthError('PERMISSION_DENIED')
  }
  try {
    await tx.savepoint((sp) =>
      sp.query(
        'auth.identity.disable',
        `UPDATE auth.identities SET state = 'disabled', session_epoch = session_epoch + 1
          WHERE identity_id = $1`,
        [identityId],
      ),
    )
  } catch (error) {
    if (error instanceof ControlStoreError && error.sqlstate === 'EXU06') {
      throw new AuthError('OWNER_INVARIANT')
    }
    throw error
  }
  const sessionsEnded = await revokeIdentitySessions(tx, identityId, 'identity_disabled')
  const linksEnded = await invalidateLinks(tx, identityId)
  const delivery = await recordNotification(tx, deps.channel, {
    kind: 'auth.identity_disabled',
    recipientIdentityId: identityId,
    to: identity.email,
  })
  await appendAudit(
    tx,
    {
      action: 'access.identity.disable',
      phase: 'completed',
      actor: humanActor(actor, actor.reauthAt),
      client: webClient(actor.sessionId),
      request,
      ...(reason === undefined || reason.length === 0 ? {} : { reason }),
      changes: { identityId, from: identity.state, to: 'disabled', sessionsEnded, linksEnded },
      result: { status: 'succeeded' },
    },
    deps.clock,
  )
  const after = await readIdentity(tx, identityId)
  if (after === undefined) {
    throw new AuthError('INTERNAL')
  }
  return { identity: await identityView(tx, after), delivery }
}
