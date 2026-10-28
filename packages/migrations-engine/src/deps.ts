import type { ControlStore, Tx } from '@exponetdb/control-store'
import type { Clock } from '@exponetdb/kernel'
import type { Connector, Keyring } from '@exponetdb/registry'
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
  /**
   * The worker's keyring, for the installation's excused-value key (OD-56
   * (a)). Without it a failure of a value is never excused: the analysis
   * stays incomplete and a baseline's verification fails closed.
   */
  readonly keyring?: Keyring
  /**
   * Records the schema a verified migration left as the target's expected
   * state for drift checks (drift-detection.md §7; the worker composes it
   * from diagnostics). Never changes an operation's outcome.
   */
  readonly expected?: ExpectedSchema
}

export interface ExpectedSchema {
  record(input: {
    readonly targetId: string
    readonly generation: number
    readonly operationId: string
    /** The fingerprint the verification saw after the last migration of the operation. */
    readonly fingerprint: string
    /**
     * The fingerprint the operation's plan started from; the baseline is not
     * replaced when the target's was another (the schema had drifted, TC-006).
     */
    readonly preFingerprint?: string
  }): Promise<unknown>
}

/**
 * The project's registry data the engine binds besides execution roles:
 * trusted extensions and the managed scope. Execution roles are resolved per
 * target by `execution-roles.ts` only (ADR-0034 §5).
 */
export async function projectRegistry(
  store: Pick<ControlStore | Tx, 'query'>,
  projectId: string,
): Promise<{
  readonly trustedExtensions: string[]
  readonly scope: ManagedScope
}> {
  const { rows } = await store.query(
    'migrations.project.registry',
    'SELECT trusted_extensions, managed_scope FROM registry.projects WHERE project_id = $1',
    [projectId],
  )
  const row = rows[0]
  const trusted = row?.json('trusted_extensions')
  const scope = row?.json('managed_scope') as
    | { includeSchemas?: unknown; excludeSchemas?: unknown }
    | undefined
  const strings = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  return {
    trustedExtensions: strings(trusted),
    scope: {
      ...(Array.isArray(scope?.includeSchemas)
        ? { includeSchemas: strings(scope?.includeSchemas) }
        : {}),
      excludeSchemas: strings(scope?.excludeSchemas),
    },
  }
}
