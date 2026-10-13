import type { GrantRestrictions, Tier, TierSemantics } from '@exponetdb/contracts'
import type { SubjectChain } from './scope.ts'

/**
 * The registry tier of `registry.manage` (OD-22, resolved 2026-10-12 and
 * extended by the owner on 2026-10-13; authorization.md §5.1). Every
 * registry action has one, named by its `tierSemantics`:
 *
 * - `production`: always `prod` (installation-wide subjects, subjects that
 *   span tiers such as products, projects, servers and nodes, an
 *   environment change, and every declaration of a cluster's tier);
 * - `cluster_registry`: a cluster's registry tier: `nonprod` only when the
 *   cluster is declared `nonprod` and hosts no production target, else
 *   `prod` (an undeclared cluster is production: fail closed);
 * - `placement` (`target.register`): the stricter of the environment's
 *   tier and the cluster's declared tier, where an undeclared cluster
 *   counts as `prod`: a database of a cluster declared `prod` needs
 *   production authority whatever environment it is placed in.
 *
 * Production authority is a role binding that covers the subject with that
 * tier (see {@link authorityChain}) and, for a bearer credential, a grant
 * whose tiers include `prod` ({@link outsideTiers}). `undefined`
 * means the tier cannot be known (no cluster facts): the engine denies.
 */
export function isRegistryTierSemantics(semantics: TierSemantics): boolean {
  return semantics === 'production' || semantics === 'cluster_registry' || semantics === 'placement'
}

export function registryTier(semantics: TierSemantics, chain: SubjectChain): Tier | undefined {
  switch (semantics) {
    case 'production':
      return 'prod'
    case 'cluster_registry':
      if (chain.cluster === undefined) return undefined
      return chain.tier === 'prod' || chain.cluster.declaredTier !== 'nonprod' ? 'prod' : 'nonprod'
    case 'placement':
      if (chain.cluster === undefined || chain.tier === undefined) return undefined
      return chain.tier === 'prod' || chain.cluster.declaredTier !== 'nonprod' ? 'prod' : 'nonprod'
    default:
      return chain.tier
  }
}

/**
 * The chain the role bindings must cover for a registry tier: when the
 * registry tier is production and the subject's own tier is not, an
 * environment or a target binding (whose authority is its environment's
 * tier) no longer covers it (`tierRaised`).
 */
export function authorityChain(chain: SubjectChain, tier: Tier): SubjectChain {
  return tier === 'prod' && chain.tier !== 'prod' ? { ...chain, tierRaised: true } : chain
}

/**
 * The chain a delegated grant's restrictions are judged on: a cluster or a
 * placement carries its registry tier; a `production` subject keeps its own
 * chain (an installation-wide one still passes only an unrestricted grant).
 * The caller additionally requires the registry tier among the grant's
 * tiers ({@link outsideTiers}).
 */
export function restrictionChain(semantics: TierSemantics, chain: SubjectChain, tier: Tier) {
  return semantics === 'production' ? chain : { ...chain, tier }
}

/** Whether the grant's tiers leave out the registry tier. */
export function outsideTiers(restrictions: GrantRestrictions, tier: Tier): boolean {
  return !restrictions.tiers.includes(tier)
}
