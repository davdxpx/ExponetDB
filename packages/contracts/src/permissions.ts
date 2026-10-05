import * as z from 'zod'

/**
 * RBAC permissions ([authorization.md §2](../../../exponetdb-docs/08-auth-and-security/authorization.md#2-permissions)).
 * Closed catalog of `<domain>.<verb>` names. There are no wildcards: roles list
 * permissions explicitly, and a new permission is never granted implicitly.
 */
export const PERMISSIONS = {
  'targets.read': { covers: 'list and get targets, environments, projects', humanOnly: false },
  'schema.read': { covers: 'inspect schema, fingerprints, diffs, drift checks', humanOnly: false },
  'schema.manage': { covers: 'accept drift (drift.accept)', humanOnly: false },
  'diagnostics.read': {
    covers: 'health, sessions (redacted), locks, statistics, advisors',
    humanOnly: false,
  },
  'diagnostics.read_sensitive': { covers: 'raw statements, error details', humanOnly: true },
  'data.read': { covers: 'read-only queries', humanOnly: false },
  'data.read_sensitive': { covers: 'unmasked sensitive columns', humanOnly: false },
  'migrations.read': { covers: 'ledger, status, lint', humanOnly: false },
  'migrations.plan': { covers: 'create migration plans, rollback plans', humanOnly: false },
  'migrations.apply': { covers: 'apply migration plans, re-verify', humanOnly: false },
  'migrations.import': {
    covers: 'legacy import analysis, review, baseline, ledger reconcile',
    humanOnly: false,
  },
  'connections.operate': { covers: 'cancel and terminate backends', humanOnly: false },
  'backups.read': { covers: 'backup catalog, drills', humanOnly: false },
  'backups.run': { covers: 'run and verify backups', humanOnly: false },
  'restore.plan': { covers: 'plan restores and drills', humanOnly: false },
  'restore.execute': { covers: 'apply restore plans', humanOnly: true },
  'nodes.read': { covers: 'nodes, clusters, host metrics', humanOnly: false },
  'nodes.plan': { covers: 'plan node and cluster operations', humanOnly: false },
  'nodes.operate': { covers: 'apply node and cluster plans', humanOnly: false },
  'plans.approve': { covers: 'approve plans (Web App)', humanOnly: true },
  'operations.recover': {
    covers:
      "force recovery of the Operations Engine's own state: release a lock domain held by a lost worker (operation.force_release)",
    humanOnly: true,
  },
  'breakglass.activate': { covers: 'activate break-glass', humanOnly: true },
  'audit.read': { covers: 'audit events', humanOnly: false },
  'registry.manage': {
    covers: 'registry writes, enrollment tokens, credential submission',
    humanOnly: false,
  },
  'access.read': { covers: 'view identities, roles, clients, grants', humanOnly: false },
  'access.manage': {
    covers: 'manage identities, role bindings, clients, API keys',
    humanOnly: false,
  },
  'policy.manage': { covers: 'change policy configuration', humanOnly: false },
} as const satisfies Record<string, { covers: string; humanOnly: boolean }>

export type Permission = keyof typeof PERMISSIONS

export function isPermission(value: string): value is Permission {
  return Object.hasOwn(PERMISSIONS, value)
}

export const PERMISSION_IDS: readonly Permission[] = Object.keys(PERMISSIONS).filter(isPermission)

export const PermissionSchema = z
  .enum(PERMISSION_IDS)
  .meta({ description: 'RBAC permission <domain>.<verb>; closed catalog, no wildcards.' })
