import type {
  ExecutionRoleBindingsRequest,
  ExecutionRoleExceptionDeclareRequest,
  ExecutionRoleExceptionRevokeRequest,
  ExecutionRoleExceptionView,
  ProjectExecutionRoles,
} from '@exponetdb/contracts'
import type { Queryable, Tx } from '@exponetdb/control-store'
import { type JsonObject, newId } from '@exponetdb/kernel'
import type { ChangedBinding, ExecutionContext, PlanRecord } from '@exponetdb/operations'
import type { Body } from './content.ts'
import { conflict, RegistryError } from './errors.ts'
import { RegistryKind } from './kind-base.ts'
import { type RegistryPlanContext, storeRegistryPlan } from './plans.ts'
import type { RegistryActor } from './policy.ts'
import { getEnvironment, getProject } from './reads.ts'
import type { EnvironmentRecord } from './records.ts'
import { invalid } from './validate.ts'
import { brand } from './views.ts'

/**
 * Execution roles for adopted schemas ([ADR-0034](../../../exponetdb-docs/01-architecture/adr/0034-execution-roles-for-adopted-schemas.md)):
 *
 * - **Bindings per environment** (§5): an environment of the project's
 *   product binds aliases of the project's map to other roles; the project
 *   map stays the default for every alias an environment does not bind.
 * - **Declared exceptions** (§1, §2, OD-51): a person declares that one
 *   PostgreSQL role may carry `BYPASSRLS` as an execution role of the
 *   project in one environment. Nothing else is ever excused (the Control
 *   Store's CHECK fixes the attributes to `{bypassrls}`); a declaration is
 *   revoked once and never re-activated; after its review date it excuses
 *   nothing.
 *
 * Both are registry changes: planned, applied by the worker, audited, human
 * only, `registry.manage` at the environment's tier. The migration engine
 * resolves them per target (`packages/migrations-engine/src/execution-roles.ts`)
 * and binds what it used into every plan.
 */

const sortedMap = (m: Readonly<Record<string, string>>): Record<string, string> =>
  Object.fromEntries(Object.entries(m).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)))

const protectedRole = (role: string) => role.startsWith('pg_') || role.startsWith('exponetdb_')

/** The project's default alias map (`registry.projects.execution_roles`). */
export async function projectDefaultRoles(
  q: Queryable,
  projectId: string,
): Promise<Record<string, string>> {
  const { rows } = await q.query(
    'registry.execution_roles.defaults',
    'SELECT execution_roles FROM registry.projects WHERE project_id = $1',
    [projectId],
  )
  const roles = rows[0]?.json('execution_roles')
  const out: Record<string, string> = {}
  if (typeof roles === 'object' && roles !== null && !Array.isArray(roles)) {
    for (const [k, v] of Object.entries(roles)) if (typeof v === 'string') out[k] = v
  }
  return sortedMap(out)
}

/** The bindings of one environment of a project, alias → role, sorted. */
export async function environmentRoleBindings(
  q: Queryable,
  projectId: string,
  environmentId: string,
): Promise<Record<string, string>> {
  const { rows } = await q.query(
    'registry.execution_roles.bindings',
    `SELECT alias, role FROM registry.execution_role_bindings
      WHERE project_id = $1 AND environment_id = $2 AND ended_at IS NULL`,
    [projectId, environmentId],
  )
  // Sorted here, never by the Control Store's collation: plans compare these maps as JSON.
  return sortedMap(Object.fromEntries(rows.map((r) => [r.text('alias'), r.text('role')])))
}

/** One declared exception as the registry holds it. */
export interface ExecutionRoleExceptionRecord {
  readonly exceptionId: string
  readonly projectId: string
  readonly environmentId: string
  readonly role: string
  readonly reason: string
  /** `YYYY-MM-DD`, or null. */
  readonly reviewBy: string | null
  readonly state: 'active' | 'revoked'
  /** Active, but its review date passed (by the database's date): it excuses nothing. */
  readonly expired: boolean
  readonly revision: number
  readonly declaredBy: string
  readonly declaredAt: string
  readonly revokedBy: string | null
  readonly revokedAt: string | null
  readonly revokeReason: string | null
}

const EXCEPTION_COLUMNS = `exception_id, project_id, environment_id, role_name, reason,
       to_char(review_by, 'YYYY-MM-DD') AS review_by, state, revision, declared_by,
       to_char(declared_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS declared_at,
       revoked_by, to_char(revoked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS revoked_at,
       revoke_reason,
       (state = 'active' AND review_by IS NOT NULL AND review_by < current_date) AS expired`

function exceptionFrom(r: {
  text(c: string): string
  textOrNull(c: string): string | null
  int(c: string): number
  bool(c: string): boolean
}): ExecutionRoleExceptionRecord {
  return {
    exceptionId: r.text('exception_id'),
    projectId: r.text('project_id'),
    environmentId: r.text('environment_id'),
    role: r.text('role_name'),
    reason: r.text('reason'),
    reviewBy: r.textOrNull('review_by'),
    state: r.text('state') as 'active' | 'revoked',
    expired: r.bool('expired'),
    revision: r.int('revision'),
    declaredBy: r.text('declared_by'),
    declaredAt: r.text('declared_at'),
    revokedBy: r.textOrNull('revoked_by'),
    revokedAt: r.textOrNull('revoked_at'),
    revokeReason: r.textOrNull('revoke_reason'),
  }
}

export async function getExecutionRoleException(
  q: Queryable,
  exceptionId: string,
): Promise<ExecutionRoleExceptionRecord | undefined> {
  const { rows } = await q.query(
    'registry.execution_roles.exception',
    `SELECT ${EXCEPTION_COLUMNS} FROM registry.execution_role_exceptions WHERE exception_id = $1`,
    [exceptionId],
  )
  const r = rows[0]
  return r === undefined ? undefined : exceptionFrom(r)
}

/**
 * The exceptions that excuse anything now in one environment of a
 * project: active and not past their review date, role → record.
 */
export async function effectiveExceptions(
  q: Queryable,
  projectId: string,
  environmentId: string,
): Promise<Map<string, ExecutionRoleExceptionRecord>> {
  const { rows } = await q.query(
    'registry.execution_roles.effective_exceptions',
    `SELECT ${EXCEPTION_COLUMNS} FROM registry.execution_role_exceptions
      WHERE project_id = $1 AND environment_id = $2 AND state = 'active'
        AND (review_by IS NULL OR review_by >= current_date)`,
    [projectId, environmentId],
  )
  return new Map(rows.map((r) => [r.text('role_name'), exceptionFrom(r)]))
}

/**
 * Every active declaration of one environment of a project, past its review
 * date or not (the health sampler compares each with the live role).
 */
export async function activeExceptions(
  q: Queryable,
  projectId: string,
  environmentId: string,
): Promise<ExecutionRoleExceptionRecord[]> {
  const { rows } = await q.query(
    'registry.execution_roles.active_exceptions',
    `SELECT ${EXCEPTION_COLUMNS} FROM registry.execution_role_exceptions
      WHERE project_id = $1 AND environment_id = $2 AND state = 'active'
      ORDER BY role_name`,
    [projectId, environmentId],
  )
  return rows.map(exceptionFrom)
}

export function exceptionView(e: ExecutionRoleExceptionRecord): ExecutionRoleExceptionView {
  return {
    id: brand('rxe', e.exceptionId),
    projectId: brand('prj', e.projectId),
    environmentId: brand('env', e.environmentId),
    role: e.role,
    attributes: ['bypassrls'],
    reason: e.reason,
    reviewBy: e.reviewBy,
    state: e.state,
    expired: e.expired,
    revision: e.revision,
    declaredBy: brand('idn', e.declaredBy),
    declaredAt: e.declaredAt,
    revokedBy: e.revokedBy === null ? null : brand('idn', e.revokedBy),
    revokedAt: e.revokedAt,
    revokeReason: e.revokeReason,
  }
}

/** `project.execution_roles.get`: defaults, each environment's bindings and effective map, the exceptions. */
export async function projectExecutionRoles(
  q: Queryable,
  projectId: string,
): Promise<ProjectExecutionRoles> {
  const project = await getProject(q, projectId)
  if (project === undefined) throw new RegistryError('NOT_FOUND')
  const defaults = await projectDefaultRoles(q, projectId)
  const envs = await q.query(
    'registry.execution_roles.environments',
    `SELECT environment_id, slug, tier FROM registry.environments
      WHERE product_id = $1 ORDER BY rank, slug`,
    [project.productId],
  )
  const environments = []
  for (const e of envs.rows) {
    const environmentId = e.text('environment_id')
    const bindings = await environmentRoleBindings(q, projectId, environmentId)
    environments.push({
      environmentId: brand('env', environmentId),
      slug: e.text('slug'),
      tier: e.text('tier') === 'prod' ? ('prod' as const) : ('nonprod' as const),
      bindings,
      // A binding of an alias the project map no longer has binds nothing.
      effective: sortedMap({
        ...defaults,
        ...Object.fromEntries(Object.entries(bindings).filter(([a]) => Object.hasOwn(defaults, a))),
      }),
    })
  }
  const { rows } = await q.query(
    'registry.execution_roles.exceptions',
    `SELECT ${EXCEPTION_COLUMNS} FROM registry.execution_role_exceptions
      WHERE project_id = $1 ORDER BY declared_at DESC, exception_id DESC LIMIT 500`,
    [projectId],
  )
  return {
    projectId: brand('prj', projectId),
    defaults,
    environments,
    exceptions: rows.map((r) => exceptionView(exceptionFrom(r))),
  }
}

// ----- planning -----

/** The project and an environment of its product, or NOT_FOUND (never another product's environment). */
async function projectEnvironment(
  tx: Tx,
  projectId: string,
  environmentId: string,
): Promise<{ productId: string; environment: EnvironmentRecord }> {
  const project = await getProject(tx, projectId)
  const environment = await getEnvironment(tx, environmentId)
  if (
    project === undefined ||
    environment === undefined ||
    environment.productId !== project.productId
  ) {
    throw new RegistryError('NOT_FOUND')
  }
  return { productId: project.productId, environment }
}

/** `registry.execution_role_binding.set.plan`: one environment's bindings, replaced as a whole. */
export async function planExecutionRoleBindings(
  tx: Tx,
  context: RegistryPlanContext,
  actor: RegistryActor,
  projectId: string,
  environmentId: string,
  input: ExecutionRoleBindingsRequest,
): Promise<PlanRecord> {
  const { productId, environment } = await projectEnvironment(tx, projectId, environmentId)
  const defaults = await projectDefaultRoles(tx, projectId)
  const next = sortedMap(input.roles)
  for (const [alias, role] of Object.entries(next)) {
    if (!Object.hasOwn(defaults, alias)) {
      throw invalid(
        `/roles/${alias}`,
        'unknown_alias',
        'An environment binds only aliases of the project map.',
      )
    }
    if (protectedRole(role)) {
      throw invalid(
        `/roles/${alias}`,
        'protected_role',
        'A predefined or ExponetDB role is never an execution role.',
      )
    }
  }
  const current = await environmentRoleBindings(tx, projectId, environmentId)
  if (JSON.stringify(next) === JSON.stringify(current)) {
    throw invalid('/roles', 'no_change', 'The environment already binds these roles.')
  }
  return storeRegistryPlan(tx, context, actor, {
    kind: 'registry.execution_role_binding.set',
    actionClass: 'high',
    subject: { productId, projectId, environmentId, tier: environment.tier },
    content: { projectId, environmentId, roles: next },
    expectedState: { roles: current },
    analysis: {
      environment: environment.slug,
      tier: environment.tier,
      before: current,
      after: next,
      effective: sortedMap({ ...defaults, ...next }),
      authority: `registry.manage at the ${environment.tier} tier`,
    },
  })
}

/** `registry.execution_role_exception.declare.plan` (OD-51): BYPASSRLS, and nothing else, for one role. */
export async function planExecutionRoleExceptionDeclare(
  tx: Tx,
  context: RegistryPlanContext,
  actor: RegistryActor,
  projectId: string,
  environmentId: string,
  input: ExecutionRoleExceptionDeclareRequest,
): Promise<PlanRecord> {
  const { productId, environment } = await projectEnvironment(tx, projectId, environmentId)
  if (protectedRole(input.role)) {
    throw invalid(
      '/role',
      'protected_role',
      'A predefined or ExponetDB role is never an execution role.',
    )
  }
  if (input.reviewBy !== undefined) {
    const { rows } = await tx.query(
      'registry.execution_roles.today',
      `SELECT $1::date >= current_date AS ok`,
      [input.reviewBy],
    )
    if (rows[0]?.bool('ok') !== true) {
      throw invalid('/reviewBy', 'in_the_past', 'A review date is today or later.')
    }
  }
  const active = await activeException(tx, projectId, environmentId, input.role)
  if (active !== undefined) throw conflict('exception_active')
  const exceptionId = newId('rxe', context.policy.clock.nowMs())
  return storeRegistryPlan(tx, context, actor, {
    kind: 'registry.execution_role_exception.declare',
    actionClass: 'high',
    subject: { productId, projectId, environmentId, tier: environment.tier },
    content: {
      exceptionId,
      projectId,
      environmentId,
      role: input.role,
      reason: input.reason,
      reviewBy: input.reviewBy ?? null,
      declaredBy: actor.identityId,
    },
    expectedState: { active: null },
    analysis: {
      environment: environment.slug,
      tier: environment.tier,
      role: input.role,
      excuses: ['bypassrls'],
      neverExcused: [
        'superuser',
        'createrole',
        'createdb',
        'replication',
        'login',
        'reach into pg_* or exponetdb_* roles',
      ],
      reviewBy: input.reviewBy ?? null,
      authority: `registry.manage at the ${environment.tier} tier`,
    },
  })
}

/** `registry.execution_role_exception.revoke.plan`: ends an active exception; plans that bound it go stale. */
export async function planExecutionRoleExceptionRevoke(
  tx: Tx,
  context: RegistryPlanContext,
  actor: RegistryActor,
  projectId: string,
  exceptionId: string,
  input: ExecutionRoleExceptionRevokeRequest,
): Promise<PlanRecord> {
  const exception = await getExecutionRoleException(tx, exceptionId)
  if (exception === undefined || exception.projectId !== projectId) {
    throw new RegistryError('NOT_FOUND')
  }
  if (exception.state !== 'active') throw conflict('exception_not_active')
  const { productId, environment } = await projectEnvironment(
    tx,
    projectId,
    exception.environmentId,
  )
  return storeRegistryPlan(tx, context, actor, {
    kind: 'registry.execution_role_exception.revoke',
    actionClass: 'high',
    subject: {
      productId,
      projectId,
      environmentId: environment.environmentId,
      tier: environment.tier,
    },
    content: {
      exceptionId,
      projectId,
      environmentId: environment.environmentId,
      revision: exception.revision + 1,
      revokedBy: actor.identityId,
      reason: input.reason,
    },
    expectedState: { revision: exception.revision, state: 'active' },
    analysis: {
      environment: environment.slug,
      tier: environment.tier,
      role: exception.role,
      declaredAt: exception.declaredAt,
      effect:
        'Every plan that bound this exception becomes stale; the role must lose BYPASSRLS before the next migration.',
    },
  })
}

async function activeException(
  q: Queryable,
  projectId: string,
  environmentId: string,
  role: string,
): Promise<ExecutionRoleExceptionRecord | undefined> {
  const { rows } = await q.query(
    'registry.execution_roles.active',
    `SELECT ${EXCEPTION_COLUMNS} FROM registry.execution_role_exceptions
      WHERE project_id = $1 AND environment_id = $2 AND role_name = $3 AND state = 'active'`,
    [projectId, environmentId, role],
  )
  const r = rows[0]
  return r === undefined ? undefined : exceptionFrom(r)
}

// ----- kinds -----

/** `registry.execution_role_binding.set`: replaces one environment's bindings in one transaction. */
export class ExecutionRoleBindingSetKind extends RegistryKind {
  readonly kind = 'registry.execution_role_binding.set'
  readonly actionClass = 'high'

  async bindings(_plan: PlanRecord, c: Body, expected: Body): Promise<ChangedBinding[]> {
    const current = await environmentRoleBindings(
      this.deps.store,
      c.text('projectId'),
      c.text('environmentId'),
    )
    const before = expected.object('roles').json()
    return JSON.stringify(current) === JSON.stringify(sortedMap(before as Record<string, string>))
      ? []
      : [{ binding: 'bindings', actual: 'changed' }]
  }

  async run(ctx: ExecutionContext, c: Body) {
    const projectId = c.id('prj', 'projectId')
    const environmentId = c.id('env', 'environmentId')
    const roles = c.object('roles').json() as JsonObject
    // Every value is checked before anything is written (a refusal never leaves a half set).
    if (Object.values(roles).some((role) => typeof role !== 'string')) {
      throw new RegistryError('INTERNAL')
    }
    return this.effect(async (tx) => {
      const current = await environmentRoleBindings(tx, projectId, environmentId)
      // Nothing is deleted: a binding that is dropped or changes ends; a new or changed one is inserted.
      for (const [alias, role] of Object.entries(current)) {
        if (roles[alias] === role) continue
        await tx.query(
          'registry.kind.execution_role_binding.end',
          `UPDATE registry.execution_role_bindings SET ended_at = clock_timestamp(), ended_by_operation_id = $4
            WHERE project_id = $1 AND environment_id = $2 AND alias = $3 AND ended_at IS NULL`,
          [projectId, environmentId, alias, ctx.operationId],
        )
      }
      for (const [alias, role] of Object.entries(roles)) {
        if (current[alias] === role) continue
        await tx.query(
          'registry.kind.execution_role_binding.insert',
          `INSERT INTO registry.execution_role_bindings (project_id, environment_id, alias, role, set_by_operation_id)
           VALUES ($1, $2, $3, $4, $5)`,
          [projectId, environmentId, alias, role, ctx.operationId],
        )
      }
      await this.audit(tx, ctx, {
        projectId,
        environmentId,
        roles: sortedMap(roles as Record<string, string>),
      })
      return true
    })
  }

  async check(ctx: ExecutionContext, c: Body) {
    const projectId = c.text('projectId')
    const environmentId = c.text('environmentId')
    const want = sortedMap(c.object('roles').json() as Record<string, string>)
    const have = await environmentRoleBindings(this.deps.store, projectId, environmentId)
    if (JSON.stringify(have) !== JSON.stringify(want)) return false
    // The current set is the planned one; this operation's audit event proves it ran (an
    // unchanged alias keeps its earlier row, a cleared set leaves none).
    return this.exists(
      'registry.kind.execution_role_binding.audited',
      `SELECT 1 FROM audit.audit_events WHERE operation_id = $1 AND action = $2`,
      [ctx.operationId, this.kind],
    )
  }

  applied(ctx: ExecutionContext, c: Body) {
    return this.check(ctx, c)
  }
}

/** `registry.execution_role_exception.declare`: one active declaration, revision 1. */
export class ExecutionRoleExceptionDeclareKind extends RegistryKind {
  readonly kind = 'registry.execution_role_exception.declare'
  readonly actionClass = 'high'

  async bindings(_plan: PlanRecord, c: Body): Promise<ChangedBinding[]> {
    const active = await activeException(
      this.deps.store,
      c.text('projectId'),
      c.text('environmentId'),
      c.text('role'),
    )
    return active === undefined ? [] : [{ binding: 'exception', actual: 'already_active' }]
  }

  async run(ctx: ExecutionContext, c: Body) {
    return this.effect(async (tx) => {
      await tx.query(
        'registry.kind.execution_role_exception.insert',
        `INSERT INTO registry.execution_role_exceptions
           (exception_id, project_id, environment_id, role_name, attributes, reason, review_by,
            state, revision, declared_by, declared_at, declared_by_operation_id)
         VALUES ($1, $2, $3, $4, ARRAY['bypassrls'], $5, $6::date, 'active', 1, $7, clock_timestamp(), $8)`,
        [
          c.id('rxe', 'exceptionId'),
          c.id('prj', 'projectId'),
          c.id('env', 'environmentId'),
          c.text('role'),
          c.text('reason'),
          c.textOrNull('reviewBy'),
          c.id('idn', 'declaredBy'),
          ctx.operationId,
        ],
      )
      await this.audit(tx, ctx, {
        exceptionId: c.text('exceptionId'),
        projectId: c.text('projectId'),
        environmentId: c.text('environmentId'),
        role: c.text('role'),
        attributes: ['bypassrls'],
        reviewBy: c.textOrNull('reviewBy'),
        revision: 1,
      })
      return true
    })
  }

  check(ctx: ExecutionContext, c: Body) {
    return this.exists(
      'registry.kind.execution_role_exception.verify',
      `SELECT 1 FROM registry.execution_role_exceptions
        WHERE exception_id = $1 AND declared_by_operation_id = $2 AND attributes = ARRAY['bypassrls']`,
      [c.text('exceptionId'), ctx.operationId],
    )
  }

  applied(ctx: ExecutionContext, c: Body) {
    return this.check(ctx, c)
  }
}

/** `registry.execution_role_exception.revoke`: active → revoked once, the revision raised. */
export class ExecutionRoleExceptionRevokeKind extends RegistryKind {
  readonly kind = 'registry.execution_role_exception.revoke'
  readonly actionClass = 'high'

  async bindings(_plan: PlanRecord, c: Body, expected: Body): Promise<ChangedBinding[]> {
    const e = await getExecutionRoleException(this.deps.store, c.text('exceptionId'))
    return e !== undefined && e.state === 'active' && e.revision === expected.int('revision')
      ? []
      : [
          {
            binding: 'revision',
            expected: expected.int('revision'),
            actual: e?.revision ?? null,
          },
        ]
  }

  async run(ctx: ExecutionContext, c: Body) {
    return this.effect(async (tx) => {
      const { rowCount } = await tx.query(
        'registry.kind.execution_role_exception.revoke',
        `UPDATE registry.execution_role_exceptions
            SET state = 'revoked', revision = $2, revoked_by = $3, revoked_at = clock_timestamp(),
                revoked_by_operation_id = $4, revoke_reason = $5
          WHERE exception_id = $1 AND state = 'active' AND revision = $2 - 1`,
        [
          c.id('rxe', 'exceptionId'),
          c.int('revision'),
          c.id('idn', 'revokedBy'),
          ctx.operationId,
          c.text('reason'),
        ],
      )
      if (rowCount !== 1) return false
      await this.audit(tx, ctx, {
        exceptionId: c.text('exceptionId'),
        projectId: c.text('projectId'),
        environmentId: c.text('environmentId'),
        revision: c.int('revision'),
      })
      return true
    })
  }

  check(ctx: ExecutionContext, c: Body) {
    return this.exists(
      'registry.kind.execution_role_exception.revoke_verify',
      `SELECT 1 FROM registry.execution_role_exceptions
        WHERE exception_id = $1 AND state = 'revoked' AND revoked_by_operation_id = $2`,
      [c.text('exceptionId'), ctx.operationId],
    )
  }

  applied(ctx: ExecutionContext, c: Body) {
    return this.check(ctx, c)
  }
}
