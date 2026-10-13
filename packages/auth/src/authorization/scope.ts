import type { BindingScope, Permission } from '@exponetdb/contracts'
import { isPermission } from '@exponetdb/contracts'
import type { Queryable } from '@exponetdb/control-store'
import { type IdentityId, isId, type RoleBindingId } from '@exponetdb/kernel'
import { AuthError } from '../errors.ts'

/**
 * Role bindings and structural scope coverage (authorization.md §3).
 *
 * A subject is described by its scope chain, resolved by the server from
 * the registry or the plan, never from the request: product, project,
 * environment, target and tier. Coverage is structural and exact:
 *
 * - `global` covers every subject;
 * - `product:P` covers a subject whose product is P;
 * - `project:J` covers a subject whose project is J;
 * - `environment:E` covers a subject whose environment is E (that is how
 *   "developer on the nonprod environments" is expressed);
 * - `target:T` covers exactly the target T.
 *
 * An environment or target binding carries the authority of its
 * environment's tier: it does not cover a subject whose registry tier the
 * engine raised to production above the subject's own (`tierRaised`,
 * OD-22, authorization.md §5.1).
 *
 * There are no text patterns. Installation-wide subjects (identities,
 * roles, policy settings, the approval queue) have an empty chain and are
 * covered by `global` bindings only, so an `access.manage` binding on a
 * product never manages identities.
 */
export interface SubjectChain {
  readonly productId?: string
  readonly projectId?: string
  readonly environmentId?: string
  readonly targetId?: string
  /** Known tier of the subject; required when the action's tier matters. */
  readonly tier?: 'prod' | 'nonprod'
  /**
   * Registry facts of the cluster the subject is, or is placed on: its
   * declared intended tier (OD-22; null while undeclared). Read by the
   * registry tiers of `registry.manage` only (authorization.md §5.1).
   */
  readonly cluster?: { readonly declaredTier: 'prod' | 'nonprod' | null }
  /**
   * Set by the engine, never by a resolver: the action's registry tier is
   * production while the subject's own tier is not (a nonprod environment's
   * database on a cluster declared prod, say). A binding at an environment or
   * a target carries the authority of that environment's tier only, so it
   * does not cover such a subject; global, product and project bindings do.
   */
  readonly tierRaised?: boolean
}

/** The empty chain of installation-wide subjects. */
export const INSTALLATION_SUBJECT: SubjectChain = {}

export function covers(scope: BindingScope, subject: SubjectChain): boolean {
  switch (scope.kind) {
    case 'global':
      return true
    case 'product':
      return subject.productId !== undefined && subject.productId === scope.productId
    case 'project':
      return subject.projectId !== undefined && subject.projectId === scope.projectId
    case 'environment':
      return (
        subject.tierRaised !== true &&
        subject.environmentId !== undefined &&
        subject.environmentId === scope.environmentId
      )
    case 'target':
      return (
        subject.tierRaised !== true &&
        subject.targetId !== undefined &&
        subject.targetId === scope.targetId
      )
  }
}

export interface Grant {
  readonly bindingId: RoleBindingId
  readonly roleId: string
  readonly permission: Permission
  readonly scope: BindingScope
}

export function bindingScope(kind: string, id: string | null): BindingScope | undefined {
  switch (kind) {
    case 'global':
      return id === null ? { kind: 'global' } : undefined
    case 'product':
      return isId('prd', id) ? { kind: 'product', productId: id } : undefined
    case 'project':
      return isId('prj', id) ? { kind: 'project', projectId: id } : undefined
    case 'environment':
      return isId('env', id) ? { kind: 'environment', environmentId: id } : undefined
    case 'target':
      return isId('tgt', id) ? { kind: 'target', targetId: id } : undefined
    default:
      return undefined
  }
}

export function scopeColumns(scope: BindingScope): { kind: string; id: string | null } {
  switch (scope.kind) {
    case 'global':
      return { kind: 'global', id: null }
    case 'product':
      return { kind: 'product', id: scope.productId }
    case 'project':
      return { kind: 'project', id: scope.projectId }
    case 'environment':
      return { kind: 'environment', id: scope.environmentId }
    case 'target':
      return { kind: 'target', id: scope.targetId }
  }
}

/**
 * The live grants of an identity: its active bindings joined with the
 * stored role matrix, read fresh for every decision (nothing is cached in
 * a session). An inactive identity has none.
 */
export async function loadGrants(q: Queryable, identityId: IdentityId): Promise<Grant[]> {
  const { rows } = await q.query(
    'auth.grants.load',
    `SELECT b.binding_id, b.role_id, b.scope_kind, b.scope_id, rp.permission
       FROM auth.role_bindings b
       JOIN auth.role_permissions rp ON rp.role_id = b.role_id
       JOIN auth.identities i ON i.identity_id = b.identity_id
      WHERE b.identity_id = $1 AND b.state = 'active' AND i.state = 'active'
      ORDER BY b.binding_id, rp.permission`,
    [identityId],
  )
  return rows.map((row) => {
    const bindingId = row.text('binding_id')
    const permission = row.text('permission')
    const scope = bindingScope(row.text('scope_kind'), row.textOrNull('scope_id'))
    if (!isId('rlb', bindingId) || !isPermission(permission) || scope === undefined) {
      // A row the code cannot interpret never grants anything: refuse the decision.
      throw new AuthError('INTERNAL')
    }
    return { bindingId, roleId: row.text('role_id'), permission, scope }
  })
}

export function holds(
  grants: readonly Grant[],
  permission: Permission,
  subject?: SubjectChain,
): boolean {
  return grants.some(
    (g) => g.permission === permission && (subject === undefined || covers(g.scope, subject)),
  )
}
