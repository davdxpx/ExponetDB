import type { IdentityId, OAuthClientId } from '@exponetdb/kernel'

/**
 * Who acts: an identity (or the system) through a client. Established by
 * authentication (Wave 3A) and passed in; never taken from request bodies.
 * The label is the pseudonymous audit label (`human #3`, `system:worker`);
 * the audit writer refuses anything else.
 */
export interface OperationActor {
  readonly kind: 'human' | 'service' | 'system'
  readonly identityId: IdentityId | null
  readonly label: string
  readonly client: 'web' | 'rest' | 'mcp' | 'cli' | 'ci' | 'system'
  readonly clientId: OAuthClientId | null
}

export const WORKER_ACTOR: OperationActor = {
  kind: 'system',
  identityId: null,
  label: 'system:worker',
  client: 'system',
  clientId: null,
}

type Caller = Pick<OperationActor, 'kind' | 'identityId' | 'client' | 'clientId'>

export function sameCaller(a: Caller, b: Caller): boolean {
  return (
    a.kind === b.kind &&
    a.identityId === b.identityId &&
    a.client === b.client &&
    a.clientId === b.clientId
  )
}

export function auditActor(actor: OperationActor): {
  kind: OperationActor['kind']
  identityId: IdentityId | null
  label: string
} {
  return { kind: actor.kind, identityId: actor.identityId, label: actor.label }
}

export function auditClient(actor: OperationActor): {
  clientId: OAuthClientId | null
  kind: OperationActor['client']
} {
  return { clientId: actor.clientId, kind: actor.client }
}
