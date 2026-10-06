import * as z from 'zod'
import { type Permission, PermissionSchema } from './permissions.ts'

/**
 * Built-in roles of V1 ([authorization.md §3](../../../exponetdb-docs/08-auth-and-security/authorization.md#3-roles)).
 *
 * Every role lists its permissions **explicitly, as literals**. Nothing here
 * is derived from the permission catalog: no wildcard, no prefix, no
 * `<domain>.*`, no "all permissions". A permission added to the catalog is
 * therefore held by no role until a reviewed change adds it to a list here
 * and a Control Store migration adds the matching `role_permissions` row
 * (the database refuses a permission outside the catalog and the server
 * refuses to start when the stored rows differ from this matrix).
 *
 * The documented summaries ("read all", "everything except …") are
 * resolved security-first (Wave 3A, recorded in the G3A gate record):
 *
 * - `owner`: every permission of the catalog at the time of writing, listed.
 * - `admin`: everything except `breakglass.activate` (overriding safety
 *   policy stays an owner power); owner-only changes (granting or removing
 *   the owner role, disabling or erasing an owner, safety-lowering policy
 *   changes) are refused by policy rules, not by a missing permission.
 * - `operator` (on call): metadata reads and `audit.read`, operating
 *   connections and nodes, backups, restore planning, approvals, migrations
 *   except legacy import, and `operations.recover`; no data reads, no
 *   sensitive reads, no access or policy management, no break-glass.
 * - `developer`: metadata reads, `data.read` and migrations read, plan and
 *   apply; production is reached only through the scope of a binding
 *   (typically environment bindings on nonprod environments).
 * - `viewer`: exactly the six documented metadata reads.
 * - `auditor`: `audit.read`, `access.read` and the metadata reads; never
 *   `data.read`.
 */
export const BUILT_IN_ROLE_IDS = [
  'owner',
  'admin',
  'operator',
  'developer',
  'viewer',
  'auditor',
] as const
export type BuiltInRoleId = (typeof BUILT_IN_ROLE_IDS)[number]
export const RoleIdSchema = z.enum(BUILT_IN_ROLE_IDS).meta({ id: 'RoleId' })

export interface BuiltInRole {
  readonly title: string
  readonly intendedFor: string
  readonly permissions: readonly Permission[]
}

export const BUILT_IN_ROLES = {
  owner: {
    title: 'Owner',
    intendedFor: 'the product owner (at least one, at most a few)',
    permissions: [
      'targets.read',
      'schema.read',
      'schema.manage',
      'diagnostics.read',
      'diagnostics.read_sensitive',
      'data.read',
      'data.read_sensitive',
      'migrations.read',
      'migrations.plan',
      'migrations.apply',
      'migrations.import',
      'connections.operate',
      'backups.read',
      'backups.run',
      'restore.plan',
      'restore.execute',
      'nodes.read',
      'nodes.plan',
      'nodes.operate',
      'plans.approve',
      'operations.recover',
      'breakglass.activate',
      'audit.read',
      'registry.manage',
      'access.read',
      'access.manage',
      'policy.manage',
    ],
  },
  admin: {
    title: 'Admin',
    intendedFor: 'trusted platform engineers',
    permissions: [
      'targets.read',
      'schema.read',
      'schema.manage',
      'diagnostics.read',
      'diagnostics.read_sensitive',
      'data.read',
      'data.read_sensitive',
      'migrations.read',
      'migrations.plan',
      'migrations.apply',
      'migrations.import',
      'connections.operate',
      'backups.read',
      'backups.run',
      'restore.plan',
      'restore.execute',
      'nodes.read',
      'nodes.plan',
      'nodes.operate',
      'plans.approve',
      'operations.recover',
      'audit.read',
      'registry.manage',
      'access.read',
      'access.manage',
      'policy.manage',
    ],
  },
  operator: {
    title: 'Operator',
    intendedFor: 'on call',
    permissions: [
      'targets.read',
      'schema.read',
      'diagnostics.read',
      'migrations.read',
      'migrations.plan',
      'migrations.apply',
      'connections.operate',
      'backups.read',
      'backups.run',
      'restore.plan',
      'nodes.read',
      'nodes.plan',
      'nodes.operate',
      'plans.approve',
      'operations.recover',
      'audit.read',
    ],
  },
  developer: {
    title: 'Developer',
    intendedFor: 'engineers, and the identities behind AI agents',
    permissions: [
      'targets.read',
      'schema.read',
      'diagnostics.read',
      'data.read',
      'migrations.read',
      'migrations.plan',
      'migrations.apply',
      'backups.read',
      'nodes.read',
    ],
  },
  viewer: {
    title: 'Viewer',
    intendedFor: 'read-only users',
    permissions: [
      'targets.read',
      'schema.read',
      'diagnostics.read',
      'migrations.read',
      'backups.read',
      'nodes.read',
    ],
  },
  auditor: {
    title: 'Auditor',
    intendedFor: 'reviews',
    permissions: [
      'audit.read',
      'access.read',
      'targets.read',
      'schema.read',
      'diagnostics.read',
      'migrations.read',
      'backups.read',
      'nodes.read',
    ],
  },
} as const satisfies Record<BuiltInRoleId, BuiltInRole>

export function isBuiltInRoleId(value: string): value is BuiltInRoleId {
  return BUILT_IN_ROLE_IDS.some((r) => r === value)
}

/** The permissions of a built-in role: exactly its literal list, never derived. */
export function rolePermissions(role: BuiltInRoleId): readonly Permission[] {
  return BUILT_IN_ROLES[role].permissions
}

/** Binding scope kinds ([authorization.md §3](../../../exponetdb-docs/08-auth-and-security/authorization.md#3-roles)). No text wildcards exist. */
export const BINDING_SCOPE_KINDS = [
  'global',
  'product',
  'project',
  'environment',
  'target',
] as const
export type BindingScopeKind = (typeof BINDING_SCOPE_KINDS)[number]

export const RoleViewSchema = z
  .object({
    id: RoleIdSchema,
    title: z.string().max(64),
    intendedFor: z.string().max(128),
    builtIn: z.literal(true),
    permissions: z.array(PermissionSchema),
  })
  .meta({ id: 'Role' })
