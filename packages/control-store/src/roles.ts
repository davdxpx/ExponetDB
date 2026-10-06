/**
 * Control Store roles ([control-database.md §4](../../../exponetdb-docs/02-control-plane/control-database.md#4-roles-inside-the-control-store)).
 * Each process role logs in with its own PostgreSQL role (P-7); none is a
 * superuser or holds CREATEROLE, CREATEDB, REPLICATION or BYPASSRLS, and none
 * is a member of another role. `exdb_migrate` owns the ExponetDB schemas; the
 * database itself stays owned by the bootstrap superuser, so no ExponetDB
 * login can drop it.
 */
export const CONTROL_STORE_ROLES = [
  'exdb_migrate',
  'exdb_serve',
  'exdb_worker',
  'exdb_gateway',
  'exdb_audit_maint',
] as const
export type ControlStoreRole = (typeof CONTROL_STORE_ROLES)[number]

/** The roles that long-running processes use. */
export const RUNTIME_ROLES = ['exdb_serve', 'exdb_worker', 'exdb_gateway'] as const
export type RuntimeRole = (typeof RUNTIME_ROLES)[number]

export type ProcessRoleName = 'serve' | 'worker' | 'gateway'

export const PROCESS_ROLE_LOGIN: Readonly<Record<ProcessRoleName, RuntimeRole>> = {
  serve: 'exdb_serve',
  worker: 'exdb_worker',
  gateway: 'exdb_gateway',
}

export function isControlStoreRole(value: string): value is ControlStoreRole {
  return CONTROL_STORE_ROLES.some((r) => r === value)
}

/** Connection limits per role (defense in depth; pools stay well below them). */
export const ROLE_CONNECTION_LIMITS: Readonly<Record<ControlStoreRole, number>> = {
  exdb_migrate: 10,
  exdb_serve: 50,
  exdb_worker: 50,
  exdb_gateway: 25,
  exdb_audit_maint: 10,
}

/** The production Control Store database name. */
export const CONTROL_STORE_DATABASE = 'exponetdb_control'

/** Schemas the Control Store bundles create, all owned by `exdb_migrate`. */
export const CONTROL_STORE_SCHEMAS = [
  'control',
  'audit',
  'secrets',
  'policy',
  'operations',
  'auth',
  'approvals',
] as const
