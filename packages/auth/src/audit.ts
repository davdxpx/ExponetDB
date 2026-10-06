import { appendAuditEvent, type Pseudonymizer } from '@exponetdb/audit'
import type { AuditEventInput } from '@exponetdb/contracts'
import type { Tx } from '@exponetdb/control-store'
import type { Clock, IdentityId, SessionId } from '@exponetdb/kernel'
import type { RequestMeta } from './request.ts'

/**
 * Audit records of authentication and access changes (audit.md §2, §6).
 * They use the existing `exponetdb.audit/v1` members only: the actor's
 * pseudonymous label, `client.sessionId`, keyed request pseudonyms and a
 * bounded `changes` object. Never an e-mail address, a name, a secret, a
 * token, a code, a raw IP address or a raw user agent.
 */
export type AuditActor = AuditEventInput['actor']
export type AuditRequest = NonNullable<AuditEventInput['request']>

export const SERVE_ACTOR: AuditActor = { kind: 'system', identityId: null, label: 'system:serve' }
export const MAINTENANCE_ACTOR: AuditActor = {
  kind: 'system',
  identityId: null,
  label: 'system:maintenance',
}

export function identityLabel(labelNumber: number): string {
  return `human #${labelNumber}`
}

/** The pseudonymous label of an identity of either kind (`human #3`, `service #4`). */
export function labelOf(kind: 'human' | 'service', labelNumber: number): string {
  return `${kind} #${labelNumber}`
}

export function humanActor(
  identity: { readonly identityId: IdentityId; readonly labelNumber: number },
  reauthAt?: string | null,
): AuditActor {
  return {
    kind: 'human',
    identityId: identity.identityId,
    label: identityLabel(identity.labelNumber),
    ...(reauthAt === undefined ? {} : { reauthAt }),
  }
}

export function webClient(sessionId: SessionId | null): NonNullable<AuditEventInput['client']> {
  return { clientId: null, kind: 'web', sessionId }
}

/** The request id and keyed pseudonyms of the client address and user agent. */
export async function auditRequest(
  keys: { pseudonymizer(): Promise<Pseudonymizer> },
  meta: RequestMeta,
): Promise<AuditRequest> {
  const pseudonymizer = await keys.pseudonymizer()
  return {
    requestId: meta.requestId,
    ...(meta.clientIp === undefined
      ? {}
      : { ipHash: pseudonymizer.pseudonym('ip', meta.clientIp) }),
    ...(meta.userAgent === undefined
      ? {}
      : { userAgentHash: pseudonymizer.pseudonym('user_agent', meta.userAgent) }),
  }
}

export async function appendAudit(tx: Tx, event: AuditEventInput, clock: Clock): Promise<void> {
  await appendAuditEvent(tx, event, { clock })
}
