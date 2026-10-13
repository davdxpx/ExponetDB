import type { Actor, AuditEvent } from '@exponetdb/sdk/operations'
import type { EventOutcome } from '@exponetdb/ui-patterns'

/**
 * Who acted, as text for untrusted-name rendering. Actors are pseudonyms
 * (an identity id and a kind), never a name or an e-mail address; the `via`
 * is the interface the request came through.
 */
export function actorText(actor: Actor | AuditEvent['actor']): string {
  if ('via' in actor) {
    return actor.identityId === null
      ? `${actor.kind} via ${actor.via}`
      : `${actor.kind} ${actor.identityId} via ${actor.via}`
  }
  return actor.label
}

/**
 * The client of an audit event as the event names it (a kind and an id). The
 * client's own name is not part of the audit read, so the text is the
 * declared kind and id, shown as "name not verified" by the event row.
 */
export function auditClientText(event: AuditEvent): string | undefined {
  const { client } = event
  if (client === null) return undefined
  return client.clientId === null ? client.kind : `${client.kind} ${client.clientId}`
}

/** The outcome of an event; a status this build does not know is passed through and shown by name. */
export function auditOutcome(status: AuditEvent['result']['status']): EventOutcome {
  return status
}
