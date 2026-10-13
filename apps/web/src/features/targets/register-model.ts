import type { Cluster, DatabaseView } from '@exponetdb/sdk/operations'
import { isClusterId } from '../credentials/keys.ts'

/**
 * What the registration page infers for display only. The server decides
 * what a registration needs (OD-22: production authority when the database's
 * cluster is declared `prod` or not declared, whatever the environment);
 * this only chooses the cue the page shows, and it fails closed: anything
 * that is not known to be non-production shows the production cue.
 */
export type Tier = 'prod' | 'nonprod'

/** The tier of the cluster's declaration: `undeclared` for none (or a value the page does not know). */
export function declaredTierOf(
  cluster: Pick<Cluster, 'declaredTier'> | undefined,
): Tier | 'undeclared' {
  const declared = cluster?.declaredTier
  return declared === 'prod' || declared === 'nonprod' ? declared : 'undeclared'
}

/** The tier cue of a registration: production unless both the environment and the cluster are non-production. */
export function registrationTier(
  environment: Tier | undefined,
  cluster: Pick<Cluster, 'declaredTier'> | undefined,
): Tier {
  return environment === 'nonprod' && declaredTierOf(cluster) === 'nonprod' ? 'nonprod' : 'prod'
}

/** The databases of a cluster that are free to become a target: registered in the cluster, placed nowhere. */
export function freeDatabases(databases: readonly DatabaseView[]): DatabaseView[] {
  return databases.filter(
    (database) => database.placement === null && database.state === 'registered',
  )
}

/** The credentials hand-off page for a cluster, only for a cluster id (the page reads it from the fragment). */
export function credentialsPath(clusterId: string): string | undefined {
  return isClusterId(clusterId) ? `/credentials#cluster=${clusterId}` : undefined
}
