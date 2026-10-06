import {
  BUILT_IN_ROLE_IDS,
  BUILT_IN_ROLES,
  type BuiltInRoleId,
  type EffectivePermission,
  isBuiltInRoleId,
  type Me,
  type PolicySettingsView,
  type RoleBindingView,
} from '@exponetdb/contracts'
import type { Queryable } from '@exponetdb/control-store'
import { type IdentityId, isId } from '@exponetdb/kernel'
import { readPolicySettings } from '@exponetdb/operations'
import type { RuleRegistry } from '@exponetdb/policy'
import { bindingScope, type Grant, loadGrants } from '../authorization/scope.ts'
import { AuthError } from '../errors.ts'
import { readIdentity } from '../identities.ts'
import { type SessionContext, sessionView } from '../sessions.ts'
import { identityView } from './identities.ts'

/**
 * Read views of the access state (resources.md "Access"). They show
 * information, never authority: authorization always re-reads the live
 * bindings.
 */
export function roleView(roleId: BuiltInRoleId) {
  const role = BUILT_IN_ROLES[roleId]
  return {
    id: roleId,
    title: role.title,
    intendedFor: role.intendedFor,
    builtIn: true as const,
    permissions: [...role.permissions],
  }
}

export function listRoles() {
  return BUILT_IN_ROLE_IDS.map(roleView)
}

export async function listRoleBindings(
  q: Queryable,
  filter: { readonly identityId?: IdentityId; readonly includeRevoked?: boolean } = {},
): Promise<RoleBindingView[]> {
  const { rows } = await q.query(
    'auth.bindings.list',
    `SELECT binding_id, identity_id, role_id, scope_kind, scope_id, state, created_by_operation_id,
            to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
            to_char(revoked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS revoked_at
       FROM auth.role_bindings
      WHERE ($1::text IS NULL OR identity_id = $1) AND ($2 OR state = 'active')
      ORDER BY created_at, binding_id`,
    [filter.identityId ?? null, filter.includeRevoked === true],
  )
  return rows.map((row) => {
    const id = row.text('binding_id')
    const identityId = row.text('identity_id')
    const roleId = row.text('role_id')
    const scope = bindingScope(row.text('scope_kind'), row.textOrNull('scope_id'))
    const state = row.text('state')
    const operation = row.textOrNull('created_by_operation_id')
    if (
      !isId('rlb', id) ||
      !isId('idn', identityId) ||
      !isBuiltInRoleId(roleId) ||
      scope === undefined ||
      (state !== 'active' && state !== 'revoked') ||
      (operation !== null && !isId('op', operation))
    ) {
      throw new AuthError('INTERNAL')
    }
    return {
      id,
      identityId,
      roleId,
      scope,
      state,
      createdAt: row.text('created_at'),
      createdByOperationId: operation,
      revokedAt: row.textOrNull('revoked_at'),
    }
  })
}

/** Which permission holds at which scopes, from the live grants (information only). */
export function effectivePermissions(grants: readonly Grant[]): EffectivePermission[] {
  const byPermission = new Map<string, EffectivePermission>()
  for (const grant of grants) {
    const entry = byPermission.get(grant.permission) ?? { permission: grant.permission, scopes: [] }
    const known = entry.scopes.some((s) => JSON.stringify(s) === JSON.stringify(grant.scope))
    byPermission.set(
      grant.permission,
      known ? entry : { ...entry, scopes: [...entry.scopes, grant.scope] },
    )
  }
  return [...byPermission.values()].sort((a, b) => (a.permission < b.permission ? -1 : 1))
}

export async function me(q: Queryable, session: SessionContext): Promise<Me> {
  const identity = await readIdentity(q, session.identityId)
  if (identity === undefined) {
    throw new AuthError('SESSION_EXPIRED')
  }
  return {
    identity: await identityView(q, identity),
    session: sessionView(session, session.sessionId),
    bindings: await listRoleBindings(q, { identityId: session.identityId }),
    effectivePermissions: effectivePermissions(await loadGrants(q, session.identityId)),
  }
}

export async function policySettingsView(
  q: Queryable,
  registry: RuleRegistry,
  ruleIds: readonly string[],
): Promise<PolicySettingsView> {
  const settings = await readPolicySettings(q, {})
  const { rows } = await q.query(
    'auth.policy_settings.rows',
    `SELECT rule_id, revision, operation_id,
            to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
       FROM policy.rule_settings WHERE scope_kind = 'installation'`,
  )
  const meta = new Map(rows.map((r) => [`${r.text('rule_id')}#${r.int('revision')}`, r] as const))
  return {
    rules: ruleIds.flatMap((id) => {
      const rule = registry.get(id)
      if (rule === undefined) {
        return []
      }
      return [
        {
          id: rule.id,
          version: rule.version,
          description: rule.description,
          appliesTo: [...rule.appliesTo],
          severity: rule.severity,
          defaults: rule.defaults,
          settings: settings
            .filter((s) => s.ruleId === rule.id)
            .map((s) => {
              const row = meta.get(`${s.ruleId}#${s.revision}`)
              const operationId = row?.textOrNull('operation_id') ?? null
              return {
                scopeKind: s.scopeKind,
                scopeId: s.scopeId,
                revision: s.revision,
                params: s.params,
                createdAt: row?.text('created_at') ?? '',
                operationId: isId('op', operationId) ? operationId : null,
              }
            }),
        },
      ]
    }),
  }
}

/**
 * Startup check: the role matrix stored in the Control Store equals the
 * literal matrix of this release. A difference refuses to start, so no
 * process ever authorizes with a matrix that was not reviewed.
 */
export async function checkRoleCatalog(q: Queryable): Promise<void> {
  const { rows } = await q.query(
    'auth.roles.catalog',
    'SELECT role_id, permission FROM auth.role_permissions ORDER BY role_id, permission',
  )
  const stored = rows.map((r) => `${r.text('role_id')}:${r.text('permission')}`).sort()
  const expected = BUILT_IN_ROLE_IDS.flatMap((role) =>
    BUILT_IN_ROLES[role].permissions.map((p) => `${role}:${p}`),
  ).sort()
  if (stored.length !== expected.length || stored.some((v, i) => v !== expected[i])) {
    throw new AuthError('role_catalog_mismatch')
  }
}
