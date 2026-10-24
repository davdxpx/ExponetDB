import type { Queryable } from '@exponetdb/control-store'
import {
  blocksExecution,
  type ExcusableAttribute,
  type ExecutionRoleFacts,
  type ExecutionRoleProblem,
  executionRoleProblem,
} from '@exponetdb/postgres'
import {
  type ExecutionRoleExceptionRecord,
  effectiveExceptions,
  environmentRoleBindings,
  projectDefaultRoles,
} from '@exponetdb/registry'

/**
 * The one resolver of execution roles in the migration engine
 * ([ADR-0034](../../../exponetdb-docs/01-architecture/adr/0034-execution-roles-for-adopted-schemas.md)).
 * No other module of the engine reads the project's alias map or the
 * registry's bindings and exceptions (a test enforces it):
 *
 * - the roles a target's migrations run as: per alias the binding of the
 *   target's environment, else the project's map (§5);
 * - the declared exceptions that excuse `BYPASSRLS` there now: active and
 *   not past their review date (§3).
 *
 * `c1` hashes only the alias, a plan binds the resolved names and the
 * exceptions it relied on, and apply resolves again: a change in between is
 * `PLAN_STALE`.
 */

/** What a plan binds per role that runs under a declared exception. */
export interface ExceptionBinding {
  readonly exceptionId: string
  readonly revision: number
}

export interface ResolvedExecutionRoles {
  /** Alias → PostgreSQL role, effective for the environment. */
  readonly roles: Readonly<Record<string, string>>
  /** Role → the exception that excuses its `BYPASSRLS` now. */
  readonly exceptions: ReadonlyMap<string, ExecutionRoleExceptionRecord>
}

/** The execution roles and the effective exceptions of a target's (or any) project environment. */
export async function executionRolesFor(
  q: Queryable,
  scope: { readonly projectId: string; readonly environmentId: string },
): Promise<ResolvedExecutionRoles> {
  const defaults = await projectDefaultRoles(q, scope.projectId)
  const bindings = await environmentRoleBindings(q, scope.projectId, scope.environmentId)
  // An environment refines the map, never extends it: a binding of an alias the map no
  // longer has (removed by a project change) binds nothing.
  const refined = Object.entries(bindings).filter(([alias]) => Object.hasOwn(defaults, alias))
  const roles = Object.fromEntries(
    Object.entries({ ...defaults, ...Object.fromEntries(refined) }).sort(([x], [y]) =>
      x < y ? -1 : x > y ? 1 : 0,
    ),
  )
  return {
    roles,
    exceptions: await effectiveExceptions(q, scope.projectId, scope.environmentId),
  }
}

/**
 * The project's aliases without a target (project-level lint): the
 * project's map, which every environment binding refines but never extends.
 */
export function projectAliases(q: Queryable, projectId: string): Promise<Record<string, string>> {
  return projectDefaultRoles(q, projectId)
}

const BYPASSRLS: ReadonlySet<ExcusableAttribute> = new Set(['bypassrls'])
const NOTHING: ReadonlySet<ExcusableAttribute> = new Set()

/** What may be excused for a role: `BYPASSRLS` where an exception names it, nothing else ever. */
export function excusedFor(
  role: string,
  exceptions: ReadonlyMap<string, unknown>,
): ReadonlySet<ExcusableAttribute> {
  return exceptions.has(role) ? BYPASSRLS : NOTHING
}

/** A role's problem under the given exceptions, and the binding when an exception is what makes it usable. */
export function roleUnder(
  facts: ExecutionRoleFacts,
  exceptions: ReadonlyMap<string, ExecutionRoleExceptionRecord>,
): { readonly problem: ExecutionRoleProblem | null; readonly binding: ExceptionBinding | null } {
  const problem = executionRoleProblem(facts, excusedFor(facts.role, exceptions))
  const e = exceptions.get(facts.role)
  return {
    problem,
    binding:
      problem === 'declared_exception' && e !== undefined
        ? { exceptionId: e.exceptionId, revision: e.revision }
        : null,
  }
}

/**
 * Whether the exceptions a plan bound still hold exactly (same id and
 * revision, active, not past review) in the registry now.
 */
export function boundExceptionsHold(
  bound: Readonly<Record<string, ExceptionBinding>> | undefined,
  current: ReadonlyMap<string, ExecutionRoleExceptionRecord>,
): boolean {
  for (const [role, b] of Object.entries(bound ?? {})) {
    const e = current.get(role)
    if (e === undefined || e.exceptionId !== b.exceptionId || e.revision !== b.revision) {
      return false
    }
  }
  return true
}

/**
 * The roles' facts under the lock against what the plan bound: every role
 * usable, and `BYPASSRLS` excused only where the plan bound an exception
 * (the executor never widens what the plan relied on).
 */
export function rolesStillUsable(
  facts: readonly ExecutionRoleFacts[],
  bound: Readonly<Record<string, ExceptionBinding>> | undefined,
): boolean {
  const excused = new Map(Object.keys(bound ?? {}).map((role) => [role, true] as const))
  return facts.every((f) => !blocksExecution(executionRoleProblem(f, excusedFor(f.role, excused))))
}
