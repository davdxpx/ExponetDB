import {
  type BindingScope,
  type BuiltInRoleId,
  isBuiltInRoleId,
  rolePermissions,
} from '@exponetdb/contracts'
import type { Queryable } from '@exponetdb/control-store'
import { type IdentityId, isId, type JsonObject, type RoleBindingId } from '@exponetdb/kernel'
import { type FactProvider, lowersSafety } from '@exponetdb/policy'
import { type Grant, loadGrants } from '../authorization/scope.ts'

/**
 * The `access` fact of the policy rules (packages/policy catalog/access.ts),
 * computed from the Control Store for one access change. Nothing here
 * decides; the rules do.
 */
export type AccessChange =
  | {
      readonly kind: 'role_binding.create'
      readonly identityId: IdentityId
      readonly roleId: BuiltInRoleId
      readonly scope: BindingScope
    }
  | { readonly kind: 'role_binding.delete'; readonly bindingId: RoleBindingId }
  | {
      readonly kind: 'identity.disable' | 'identity.enable' | 'identity.erase'
      readonly identityId: IdentityId
    }
  | {
      readonly kind: 'policy_settings.update'
      readonly ruleId: string
      readonly current: JsonObject
      readonly next: JsonObject
    }

async function isOwner(q: Queryable, identityId: IdentityId): Promise<boolean> {
  const { rows } = await q.query(
    'auth.facts.is_owner',
    `SELECT 1 FROM auth.role_bindings b JOIN auth.identities i USING (identity_id)
      WHERE b.identity_id = $1 AND b.role_id = 'owner' AND b.scope_kind = 'global'
        AND b.state = 'active' AND i.state = 'active'`,
    [identityId],
  )
  return rows.length > 0
}

async function holdsOwnerBinding(q: Queryable, identityId: IdentityId): Promise<boolean> {
  const { rows } = await q.query(
    'auth.facts.owner_binding',
    `SELECT 1 FROM auth.role_bindings WHERE identity_id = $1 AND role_id = 'owner' AND state = 'active'`,
    [identityId],
  )
  return rows.length > 0
}

async function activeOwners(q: Queryable): Promise<number> {
  const { rows } = await q.query('auth.facts.owners', 'SELECT auth.active_owner_count()::int AS n')
  return rows[0]?.int('n') ?? 0
}

async function identityState(q: Queryable, identityId: IdentityId): Promise<string | undefined> {
  const { rows } = await q.query(
    'auth.facts.identity_state',
    'SELECT state FROM auth.identities WHERE identity_id = $1',
    [identityId],
  )
  return rows[0]?.text('state')
}

/**
 * Whether one of the actor's grants covers the binding scope for a
 * permission. Without the registry (Wave 4) the structural relations
 * between products, projects and environments are unknown, so a grant
 * covers a binding scope only when it is global or the very same scope:
 * conservative, it can only refuse more.
 */
function coversScope(grant: Grant, scope: BindingScope): boolean {
  if (grant.scope.kind === 'global') {
    return true
  }
  switch (scope.kind) {
    case 'global':
      return false
    case 'product':
      return grant.scope.kind === 'product' && grant.scope.productId === scope.productId
    case 'project':
      return grant.scope.kind === 'project' && grant.scope.projectId === scope.projectId
    case 'environment':
      return grant.scope.kind === 'environment' && grant.scope.environmentId === scope.environmentId
    case 'target':
      return grant.scope.kind === 'target' && grant.scope.targetId === scope.targetId
  }
}

interface AccessFacts extends JsonObject {
  readonly actorIsOwner: boolean
  readonly targetIsSelf: boolean
  readonly targetIsOwner: boolean
  readonly roleId: string | null
  readonly grantsNotHeld: readonly string[]
  readonly activeOwners: number
  readonly removesOwner: boolean
  readonly lowersSafety: boolean | null
}

export async function computeAccessFacts(
  q: Queryable,
  actor: IdentityId,
  change: AccessChange,
): Promise<JsonObject | undefined> {
  const actorIsOwner = await isOwner(q, actor)
  const owners = await activeOwners(q)
  const facts: AccessFacts = {
    actorIsOwner,
    targetIsSelf: false,
    targetIsOwner: false,
    roleId: null,
    grantsNotHeld: [],
    activeOwners: owners,
    removesOwner: false,
    lowersSafety: null,
  }
  switch (change.kind) {
    case 'role_binding.create': {
      const grants = await loadGrants(q, actor)
      return {
        ...facts,
        targetIsSelf: change.identityId === actor,
        targetIsOwner: await holdsOwnerBinding(q, change.identityId),
        roleId: change.roleId,
        grantsNotHeld: rolePermissions(change.roleId).filter(
          (p) => !grants.some((g) => g.permission === p && coversScope(g, change.scope)),
        ),
      }
    }
    case 'role_binding.delete': {
      const { rows } = await q.query(
        'auth.facts.binding',
        `SELECT b.identity_id, b.role_id, b.state, i.state AS identity_state
           FROM auth.role_bindings b JOIN auth.identities i USING (identity_id) WHERE b.binding_id = $1`,
        [change.bindingId],
      )
      const row = rows[0]
      const identityId = row?.text('identity_id')
      const roleId = row?.text('role_id')
      if (
        row === undefined ||
        !isId('idn', identityId) ||
        roleId === undefined ||
        !isBuiltInRoleId(roleId)
      ) {
        return undefined
      }
      return {
        ...facts,
        targetIsSelf: identityId === actor,
        targetIsOwner: await holdsOwnerBinding(q, identityId),
        roleId,
        removesOwner:
          roleId === 'owner' &&
          row.text('state') === 'active' &&
          row.text('identity_state') === 'active',
      }
    }
    case 'identity.disable':
    case 'identity.enable':
    case 'identity.erase': {
      const state = await identityState(q, change.identityId)
      if (state === undefined) {
        return undefined
      }
      const targetIsOwner = await holdsOwnerBinding(q, change.identityId)
      return {
        ...facts,
        targetIsSelf: change.identityId === actor,
        targetIsOwner,
        removesOwner: change.kind !== 'identity.enable' && targetIsOwner && state === 'active',
      }
    }
    case 'policy_settings.update':
      return { ...facts, lowersSafety: lowersSafety(change.ruleId, change.current, change.next) }
  }
}

/** A provider that returns facts computed before the evaluation (unknown when they could not be). */
export function accessFactProvider(facts: JsonObject | undefined): FactProvider {
  return {
    name: 'access',
    load: async () =>
      facts === undefined
        ? { status: 'unknown', reason: 'access_facts_unavailable' }
        : { status: 'known', value: facts },
  }
}
