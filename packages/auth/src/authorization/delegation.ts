import type {
  ActionDefinition,
  GrantRestrictions,
  OAuthResource,
  Scope,
  Tier,
} from '@exponetdb/contracts'
import type { ApiKeyId, GrantId, OAuthClientId } from '@exponetdb/kernel'
import type { SubjectChain } from './scope.ts'

/**
 * Delegated authority (oauth.md, authorization.md §1, Wave 3B): what a
 * bearer credential carries into the central engine. It is a ceiling, never
 * a permission: the engine still requires the identity's live role
 * bindings for every decision, and intersects them with
 *
 * - the resource (audience) the credential is valid for,
 * - the delegated scopes,
 * - the grant's target and tier restrictions.
 *
 * The client kind is the registered kind of the client (or `ci` for an API
 * key of a service account), never a request header or client metadata.
 */
export type DelegatedCredential =
  | {
      readonly type: 'access_token'
      readonly grantId: GrantId
      readonly clientId: OAuthClientId
      readonly grantKind: 'delegated' | 'machine'
    }
  | { readonly type: 'api_key'; readonly keyId: ApiKeyId }

export interface Delegation {
  readonly credential: DelegatedCredential
  readonly resource: OAuthResource
  readonly scopes: ReadonlySet<Scope>
  readonly restrictions: GrantRestrictions
}

/** Why a restriction refuses a subject (mapped to TARGET_NOT_IN_GRANT, TIER_NOT_PERMITTED, PERMISSION_DENIED). */
export type RestrictionDenial = 'target' | 'tier' | 'restricted_scope'

function allTiers(tiers: readonly Tier[]): boolean {
  return tiers.includes('prod') && tiers.includes('nonprod')
}

/** No restriction beyond the identity's live role bindings. */
export function unrestricted(r: GrantRestrictions): boolean {
  return r.targets.kind === 'all' && allTiers(r.tiers)
}

/**
 * Whether a grant's restrictions cover a resolved subject. Fail closed:
 *
 * - a target must be in the target list (when there is one) and its tier
 *   among the grant's tiers; an unknown tier passes only a grant that allows
 *   both tiers;
 * - a plan or operation is judged by the tier it recorded, and a target list
 *   cannot vouch for a plan that names no target;
 * - any other subject below the installation (product, project,
 *   environment) passes only an unrestricted grant: a restricted grant
 *   cannot be widened by addressing a container of its targets;
 * - an installation-wide subject passes only an unrestricted grant, except a
 *   pure read of the installation itself (version and contract information),
 *   which reveals nothing about any target.
 *
 * A restricted grant can therefore never manage access, policy or anything
 * else installation-wide, so a nonprod grant cannot grant itself production.
 */
export function restrictionDenial(
  restrictions: GrantRestrictions,
  definition: Pick<ActionDefinition, 'effect' | 'subject'>,
  chain: SubjectChain,
): RestrictionDenial | undefined {
  const { tiers, targets } = restrictions
  if (chain.targetId !== undefined) {
    if (targets.kind === 'list' && !targets.targetIds.some((id) => id === chain.targetId)) {
      return 'target'
    }
    if (chain.tier === undefined) {
      return allTiers(tiers) ? undefined : 'tier'
    }
    return tiers.includes(chain.tier) ? undefined : 'tier'
  }
  if (
    chain.productId !== undefined ||
    chain.projectId !== undefined ||
    chain.environmentId !== undefined
  ) {
    return unrestricted(restrictions) ? undefined : 'restricted_scope'
  }
  if (chain.tier !== undefined) {
    if (!tiers.includes(chain.tier)) {
      return 'tier'
    }
    return targets.kind === 'all' ? undefined : 'target'
  }
  if (definition.effect === 'read' && definition.subject === 'installation') {
    return undefined
  }
  return unrestricted(restrictions) ? undefined : 'restricted_scope'
}
