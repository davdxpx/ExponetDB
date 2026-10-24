import type { ClusterBootstrapSql } from '@exponetdb/contracts'
import type { Queryable } from '@exponetdb/control-store'
import {
  type BootstrapExecutionRole,
  bootstrapScript,
  LEDGER_OWNER_ROLE,
  type LegacyLedgerKind,
  ROLE_NAMES,
} from '@exponetdb/postgres'
import { RegistryError } from './errors.ts'
import {
  effectiveExceptions,
  environmentRoleBindings,
  projectDefaultRoles,
} from './execution-roles.ts'
import { getCluster, getEnvironment, getProject, listDatabases } from './reads.ts'
import { invalid } from './validate.ts'
import { brand } from './views.ts'

/** What a person asks the bootstrap SQL to cover besides the registry's own state (Wave 9 order A8). */
export interface BootstrapRequest {
  /** Databases of the cluster not registered yet (the script is run before registration). */
  readonly databases?: readonly string[]
  /** A project whose targets will be placed here: its execution roles are granted too. */
  readonly projectId?: string
  /** Only this environment of the project (else every environment of its product). */
  readonly environmentId?: string
  /** Legacy ledgers the observer reads during an import. */
  readonly ledgers?: readonly LegacyLedgerKind[]
}

/** The (project, environment) pairs whose targets are placed on this cluster now. */
async function placedScopes(
  q: Queryable,
  clusterId: string,
): Promise<{ projectId: string; environmentId: string }[]> {
  const { rows } = await q.query(
    'registry.bootstrap.placed_scopes',
    `SELECT DISTINCT t.project_id, t.environment_id FROM registry.targets t
       JOIN registry.placements pl ON pl.target_id = t.target_id AND pl.valid_to IS NULL
       JOIN registry.databases d ON d.database_id = pl.database_id
      WHERE d.cluster_id = $1
      ORDER BY t.project_id, t.environment_id`,
    [clusterId],
  )
  return rows.map((r) => ({
    projectId: r.text('project_id'),
    environmentId: r.text('environment_id'),
  }))
}

async function productEnvironments(q: Queryable, productId: string): Promise<string[]> {
  const { rows } = await q.query(
    'registry.bootstrap.product_environments',
    `SELECT environment_id FROM registry.environments WHERE product_id = $1 ORDER BY environment_id`,
    [productId],
  )
  return rows.map((r) => r.text('environment_id'))
}

/**
 * Every role a project environment's aliases resolve to, the way the
 * migration engine resolves them (an environment binding refines the
 * project's map, never extends it), and whether a declared exception
 * excuses its `BYPASSRLS` there now.
 */
async function rolesOf(
  q: Queryable,
  scope: { readonly projectId: string; readonly environmentId: string },
): Promise<BootstrapExecutionRole[]> {
  const defaults = await projectDefaultRoles(q, scope.projectId)
  const bindings = await environmentRoleBindings(q, scope.projectId, scope.environmentId)
  const exceptions = await effectiveExceptions(q, scope.projectId, scope.environmentId)
  const names = Object.entries(defaults).map(([alias, role]) =>
    Object.hasOwn(bindings, alias) ? (bindings[alias] ?? role) : role,
  )
  return names.map((name) => ({ name, bypassRlsExcused: exceptions.has(name) }))
}

/**
 * The role bootstrap SQL of an external cluster ([credentials-and-roles.md §8](../../../exponetdb-docs/03-database-model/credentials-and-roles.md#8-bootstrap-sql)):
 * the product's own statements for the cluster, for each registered
 * database and each requested one, the execution roles of the projects
 * placed here (and of a requested project), and the legacy ledger read, for
 * a person to run with psql. It contains no password. Role names are fixed
 * or come from the registry; database names come from the registry or the
 * request (validated by the contract); the statement builders quote them.
 */
export async function clusterBootstrapSql(
  q: Queryable,
  clusterId: string,
  request: BootstrapRequest = {},
): Promise<ClusterBootstrapSql> {
  const cluster = await getCluster(q, clusterId)
  if (cluster === undefined) {
    throw new RegistryError('NOT_FOUND')
  }
  const registered = (await listDatabases(q, clusterId))
    .filter((d) => d.state === 'registered')
    .map((d) => d.name)
  const pending = [...new Set(request.databases ?? [])].filter((d) => !registered.includes(d))
  const databases = [...registered, ...pending.sort()]

  const scopes = await placedScopes(q, clusterId)
  if (request.projectId !== undefined) {
    const project = await getProject(q, request.projectId)
    if (project === undefined) throw new RegistryError('NOT_FOUND')
    let environments: string[]
    if (request.environmentId === undefined) {
      environments = await productEnvironments(q, project.productId)
    } else {
      const environment = await getEnvironment(q, request.environmentId)
      if (environment === undefined || environment.productId !== project.productId) {
        throw new RegistryError('NOT_FOUND')
      }
      environments = [environment.environmentId]
    }
    for (const environmentId of environments) {
      scopes.push({ projectId: project.projectId, environmentId })
    }
  } else if (request.environmentId !== undefined) {
    throw invalid('/environment', 'requires_project', 'An environment needs its project.')
  }
  // A role is excused if a declared exception excuses it in any environment on this cluster;
  // each plan still checks its own environment's exceptions.
  const byName = new Map<string, boolean>()
  for (const scope of scopes) {
    for (const role of await rolesOf(q, scope)) {
      byName.set(role.name, (byName.get(role.name) ?? false) || role.bypassRlsExcused)
    }
  }
  const executionRoles = [...byName.entries()]
    .map(([name, bypassRlsExcused]) => ({ name, bypassRlsExcused }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const legacyLedgers = [...new Set(request.ledgers ?? [])].sort()
  return {
    clusterId: brand('cls', cluster.clusterId),
    script: bootstrapScript(databases, { executionRoles, legacyLedgers }),
    roles: [...new Set([...Object.values(ROLE_NAMES), LEDGER_OWNER_ROLE])].sort(),
    databases,
    pendingDatabases: pending.sort(),
    executionRoles,
    legacyLedgers,
  }
}
