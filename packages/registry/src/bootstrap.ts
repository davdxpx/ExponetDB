import type { ClusterBootstrapSql } from '@exponetdb/contracts'
import type { Queryable } from '@exponetdb/control-store'
import { bootstrapScript, LEDGER_OWNER_ROLE, ROLE_NAMES } from '@exponetdb/postgres'
import { RegistryError } from './errors.ts'
import { getCluster, listDatabases } from './reads.ts'
import { brand } from './views.ts'

/**
 * The role bootstrap SQL of an external cluster ([credentials-and-roles.md](../../../exponetdb-docs/03-database-model/credentials-and-roles.md)):
 * the product's own statements for the cluster and for each registered
 * database, for a person to run with administrative tools. It contains no
 * password and nothing from a request: role names are fixed, database names
 * come from the registry and are quoted by the statement builders.
 */
export async function clusterBootstrapSql(
  q: Queryable,
  clusterId: string,
): Promise<ClusterBootstrapSql> {
  const cluster = await getCluster(q, clusterId)
  if (cluster === undefined) {
    throw new RegistryError('NOT_FOUND')
  }
  const databases = (await listDatabases(q, clusterId))
    .filter((d) => d.state === 'registered')
    .map((d) => d.name)
  return {
    clusterId: brand('cls', cluster.clusterId),
    script: bootstrapScript(databases),
    roles: [...new Set([...Object.values(ROLE_NAMES), LEDGER_OWNER_ROLE])].sort(),
    databases,
  }
}
