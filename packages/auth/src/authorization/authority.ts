import { actionDefinition, isActionId, type Scope, tieredScope } from '@exponetdb/contracts'
import type { Queryable } from '@exponetdb/control-store'
import { type IdentityId, isId } from '@exponetdb/kernel'
import { holds, loadGrants, type SubjectChain } from './scope.ts'

/**
 * Whether the person or service account that applied a plan still holds
 * the authority for it while the operation runs (operations-engine.md §10,
 * failure case E27): the plan kind's permission at a scope covering the
 * plan's subject, from the live role bindings of an active identity, and,
 * when the plan came through a delegated client, a live grant of that
 * client that still carries the kind's scope at the plan's tier. Read
 * fresh for every check; anything unknown does not hold.
 *
 * A system plan (the worker's own) has no identity and is not re-checked
 * here: its kind decides who may start it.
 */
export interface PlanAuthority {
  readonly kind: string
  readonly actor: {
    readonly kind: 'human' | 'service' | 'system'
    readonly identityId: string | null
    readonly clientId: string | null
  }
  readonly subject: SubjectChain
}

export async function planAuthorityHolds(q: Queryable, plan: PlanAuthority): Promise<boolean> {
  if (plan.actor.kind === 'system') return true
  const identityId = plan.actor.identityId
  if (identityId === null || !isId('idn', identityId) || !isActionId(plan.kind)) return false
  const definition = actionDefinition(plan.kind)
  if (definition.permission.kind !== 'fixed') return false
  const permission = definition.permission.permission
  const grants = await loadGrants(q, identityId as IdentityId)
  if (!holds(grants, permission, plan.subject)) return false
  const clientId = plan.actor.clientId
  if (clientId === null) return true
  const scope = scopeFor(definition.scope, plan.subject.tier)
  if (scope === undefined) return false
  const { rows } = await q.query(
    'auth.authority.client_grant',
    `SELECT 1 FROM oauth.grants
      WHERE identity_id = $1 AND client_id = $2 AND state = 'active'
        AND expires_at > clock_timestamp() AND $3 = ANY (scopes)
        AND ($4::text IS NULL OR cardinality(tiers) = 0 OR $4 = ANY (tiers))
        AND ($5::text IS NULL OR target_ids IS NULL OR $5 = ANY (target_ids))
      LIMIT 1`,
    [identityId, clientId, scope, plan.subject.tier ?? null, plan.subject.targetId ?? null],
  )
  return rows.length > 0
}

function scopeFor(
  rule: ReturnType<typeof actionDefinition>['scope'],
  tier: 'prod' | 'nonprod' | undefined,
): Scope | undefined {
  switch (rule.kind) {
    case 'fixed':
      return rule.scope
    case 'tiered':
      return tier === undefined ? undefined : tieredScope(rule.permission, tier)
    default:
      return undefined
  }
}
