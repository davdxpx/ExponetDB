import type { ControlStore, Tx } from '@exponetdb/control-store'
import type { Clock } from '@exponetdb/kernel'
import type { Connector } from '@exponetdb/registry'
import type { ManagedScope } from './target.ts'

/** What the migration kinds need from the worker. */
export interface MigrationKindDeps {
  /** The worker's Control Store login. */
  readonly store: ControlStore
  readonly clock: Clock
  /** The worker's connector (migrator, verifier, observer). */
  readonly connector: Connector
  readonly installationId: string
  /** `<package version>+<commit>`, recorded in each ledger row. */
  readonly engineVersion: string
}

/** The project's registry data the engine binds: execution roles, trusted extensions, managed scope. */
export async function projectRegistry(
  store: Pick<ControlStore | Tx, 'query'>,
  projectId: string,
): Promise<{
  readonly executionRoles: Record<string, string>
  readonly trustedExtensions: string[]
  readonly scope: ManagedScope
}> {
  const { rows } = await store.query(
    'migrations.project.registry',
    'SELECT execution_roles, trusted_extensions, managed_scope FROM registry.projects WHERE project_id = $1',
    [projectId],
  )
  const row = rows[0]
  const roles = row?.json('execution_roles')
  const trusted = row?.json('trusted_extensions')
  const scope = row?.json('managed_scope') as
    | { includeSchemas?: unknown; excludeSchemas?: unknown }
    | undefined
  const executionRoles: Record<string, string> = {}
  if (typeof roles === 'object' && roles !== null && !Array.isArray(roles)) {
    for (const [k, v] of Object.entries(roles)) if (typeof v === 'string') executionRoles[k] = v
  }
  const strings = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  return {
    executionRoles,
    trustedExtensions: strings(trusted),
    scope: {
      ...(Array.isArray(scope?.includeSchemas)
        ? { includeSchemas: strings(scope?.includeSchemas) }
        : {}),
      excludeSchemas: strings(scope?.excludeSchemas),
    },
  }
}
