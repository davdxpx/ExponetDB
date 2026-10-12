import * as z from 'zod'
import {
  ClusterIdSchema,
  CredentialIdSchema,
  DatabaseIdSchema,
  EndpointIdSchema,
  EnvironmentIdSchema,
  IdentityIdSchema,
  ProjectIdSchema,
  ServerIdSchema,
  SlugSchema,
  TargetIdSchema,
  TierSchema,
  TimestampSchema,
  untrustedText,
} from '../common.ts'
import { ExecutionRoleAliasSchema, ExtensionNameSchema } from '../manifest/migration.ts'
import { PostgresRoleNameSchema } from '../manifest/project.ts'

/*
 * Registry management (Wave 4, registry.md, resources.md "Registry"):
 * request bodies of the registry plans and the administrative views that
 * only `registry.manage` reads. Requests are closed (unknown members
 * refused). Nothing here ever carries a password, a connection string, a
 * secret reference or a private key in a response (C-20, C-21); the one
 * write-only member (`password` of a credential submission) is marked
 * `writeOnly` and appears in no response.
 */

/** A display name: 1 to 120 characters, no control characters (the Control Store checks the same). */
const DisplayNameSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[^\p{Cc}]+$/u)
  .meta({ untrusted: true, description: 'Display name (no control characters).' })

/** The access roles ExponetDB logs in as (credentials-and-roles.md §2). */
export const ACCESS_ROLES = ['observer', 'reader', 'verifier', 'operator', 'migrator'] as const
export const AccessRoleSchema = z.enum(ACCESS_ROLES).meta({
  id: 'AccessRole',
  description:
    'An ExponetDB login role on a managed cluster; its PostgreSQL role name is exponetdb_<role>.',
})
export type AccessRole = z.infer<typeof AccessRoleSchema>

export const ENDPOINT_KINDS = ['private', 'public', 'local_socket', 'pooler'] as const
export const EndpointKindSchema = z.enum(ENDPOINT_KINDS).meta({ id: 'EndpointKind' })

/**
 * A host name or an IP address, nothing else: no scheme, no user, no
 * password, no path (C-4). The Control Store repeats the check.
 */
export const EndpointHostSchema = z
  .string()
  .min(1)
  .max(253)
  .regex(/^[A-Za-z0-9.:-]+$/)
  .meta({ description: 'DNS name, IPv4 or IPv6 address; never a URL or a connection string.' })

/** The name the server certificate must carry (verify-full); never an IP address. */
export const TlsServerNameSchema = z
  .string()
  .min(1)
  .max(253)
  .regex(/^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/)
  .refine((v) => !/^[0-9.]+$/.test(v), 'an IP address is not a TLS server name')
  .meta({ description: 'DNS name checked against the server certificate (verify-full).' })

const EndpointLabelSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[^\p{Cc}]+$/u)
  .meta({ untrusted: true, description: 'Endpoint label.' })

/** PEM bundle of the CA certificates that sign the cluster's server certificates; never a key. */
export const CaBundleSchema = z
  .string()
  .min(1)
  .max(65_536)
  .refine((v) => v.includes('-----BEGIN CERTIFICATE-----'), 'a PEM certificate bundle')
  .refine((v) => !/PRIVATE KEY/.test(v), 'a CA bundle never contains a private key')
  .meta({ description: 'PEM CA bundle (certificates only).' })

const ReasonSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,63}$/)
  .meta({ description: 'Short machine-readable reason, stored on the target and in the audit.' })

/** UTF-8 length in bytes (PostgreSQL limits names to 63 bytes, not characters). */
function utf8Length(value: string): number {
  let bytes = 0
  for (const ch of value) {
    const cp = ch.codePointAt(0) ?? 0
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4
  }
  return bytes
}

// ----- plan requests (each creates a plan; `POST /plans/{id}/apply` executes it) -----

export const ProductCreateRequestSchema = z
  .strictObject({ slug: SlugSchema, displayName: DisplayNameSchema })
  .meta({ id: 'ProductCreateRequest' })

export const EnvironmentCreateRequestSchema = z
  .strictObject({
    slug: SlugSchema,
    displayName: DisplayNameSchema,
    tier: TierSchema,
    evidenceFrom: SlugSchema.nullable().optional().meta({
      description: 'Slug of the environment of the same product whose results count as evidence.',
    }),
    rank: z.int().min(0).max(1000).optional(),
  })
  .meta({ id: 'EnvironmentCreateRequest' })

export const EnvironmentChangeRequestSchema = z
  .strictObject({
    displayName: DisplayNameSchema.optional(),
    tier: TierSchema.optional(),
    evidenceFrom: SlugSchema.nullable().optional(),
    rank: z.int().min(0).max(1000).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'at least one change')
  .meta({ id: 'EnvironmentChangeRequest' })

const SchemaNameSchema = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[^\p{Cc}]+$/u)
  .meta({ untrusted: true, description: 'Schema name.' })

export const ManagedScopeRequestSchema = z
  .strictObject({
    includeSchemas: z.array(SchemaNameSchema).max(256).optional(),
    excludeSchemas: z.array(SchemaNameSchema).max(256).default([]),
  })
  .meta({ id: 'ManagedScopeRequest' })

export const ProjectCreateRequestSchema = z
  .strictObject({
    product: SlugSchema.meta({ description: 'Slug of the product the project belongs to.' }),
    slug: SlugSchema,
    displayName: DisplayNameSchema,
    managedScope: ManagedScopeRequestSchema.optional(),
    evidenceOverride: z.record(SlugSchema, z.literal('none')).optional(),
  })
  .meta({ id: 'ProjectCreateRequest' })

export const ProjectChangeRequestSchema = z
  .strictObject({
    displayName: DisplayNameSchema.optional(),
    managedScope: ManagedScopeRequestSchema.optional(),
    evidenceOverride: z.record(SlugSchema, z.literal('none')).optional(),
    executionRoles: z
      .record(ExecutionRoleAliasSchema, PostgresRoleNameSchema)
      .refine((roles) => Object.keys(roles).length <= 32, { message: 'At most 32 aliases.' })
      .optional()
      .meta({
        description:
          'Execution role aliases of the project and the PostgreSQL role each names (Wave 6): the only map the migration engine uses; a project file only names aliases.',
      }),
    trustedExtensions: z.array(ExtensionNameSchema).max(64).optional().meta({
      description:
        'Extensions this project may create in up.sql (they must also be trusted in PostgreSQL and creatable by the execution role).',
    }),
  })
  .refine((v) => Object.keys(v).length > 0, 'at least one change')
  .meta({ id: 'ProjectChangeRequest' })

export const ServerCreateRequestSchema = z
  .strictObject({
    displayName: DisplayNameSchema,
    provider: z.enum(['hetzner_cloud', 'hetzner_robot', 'other', 'unknown']),
    providerRef: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[^\p{Cc}]+$/u)
      .optional(),
    location: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[^\p{Cc}]+$/u)
      .optional(),
  })
  .meta({ id: 'ServerCreateRequest' })

export const EndpointRequestSchema = z
  .strictObject({
    kind: EndpointKindSchema,
    poolerMode: z.enum(['session', 'transaction']).optional(),
    host: EndpointHostSchema,
    port: z.int().min(1).max(65_535),
    tlsServerName: TlsServerNameSchema.optional().meta({
      description: 'Required for an IP host; for a DNS host it is the host itself.',
    }),
    label: EndpointLabelSchema,
  })
  .refine((v) => (v.kind === 'pooler') === (v.poolerMode !== undefined), {
    message: 'a pooler endpoint names its pooling mode, and only a pooler does',
  })
  .meta({ id: 'EndpointRequest' })

export const ClusterRegisterRequestSchema = z
  .strictObject({
    displayName: DisplayNameSchema,
    serverId: ServerIdSchema.optional(),
    caBundle: CaBundleSchema,
    endpoints: z.array(EndpointRequestSchema).min(1).max(8),
  })
  .meta({
    id: 'ClusterRegisterRequest',
    description:
      'An external cluster (no node agent): pending until confirmed; its CA bundle and endpoints are registered with it.',
  })

export const ClusterConfirmRequestSchema = z
  .strictObject({
    systemIdentifier: z
      .string()
      .regex(/^[0-9]{1,20}$/)
      .optional()
      .meta({
        description:
          'The system_identifier the person expects (pg_controldata); when given, confirmation refuses any other.',
      }),
  })
  .meta({ id: 'ClusterConfirmRequest' })

export const EndpointRetireRequestSchema = z
  .strictObject({ reason: ReasonSchema.optional() })
  .meta({ id: 'EndpointRetireRequest' })

export const DatabaseRegisterRequestSchema = z
  .strictObject({
    name: z
      .string()
      .min(1)
      .max(63)
      .regex(/^[^\p{Cc}]+$/u)
      .refine((v) => utf8Length(v) <= 63, 'at most 63 bytes')
      .meta({ untrusted: true, description: 'Name of an existing database on the cluster.' }),
  })
  .meta({ id: 'DatabaseRegisterRequest' })

export const TargetRegisterRequestSchema = z
  .strictObject({
    projectId: ProjectIdSchema,
    environmentId: EnvironmentIdSchema,
    databaseId: DatabaseIdSchema,
  })
  .meta({
    id: 'TargetRegisterRequest',
    description:
      'Registers the target <product>/<project>/<environment> on a registered database: stamps the identity marker and creates the empty ledger, the only data-plane write of Wave 4.',
  })

export const TargetStateChangeRequestSchema = z
  .strictObject({ reason: ReasonSchema })
  .meta({ id: 'TargetStateChangeRequest' })

// ----- write-only credential submission (inline, never readable) -----

export const CredentialSubmissionSchema = z
  .strictObject({
    password: z
      .string()
      .min(16)
      .max(256)
      .regex(/^[^\p{Cc}]+$/u)
      .meta({
        writeOnly: true,
        description:
          'The password a person set with psql \\password; encrypted at once, never readable again, never logged.',
      }),
  })
  .meta({ id: 'CredentialSubmission' })

// ----- administrative views (registry.manage) -----

export const EndpointViewSchema = z
  .object({
    id: EndpointIdSchema,
    clusterId: ClusterIdSchema,
    kind: EndpointKindSchema,
    poolerMode: z.enum(['session', 'transaction']).nullable(),
    host: untrustedText(253, 'Host name or address (administrative view only).'),
    port: z.int().min(1).max(65_535),
    tlsServerName: untrustedText(253, 'Name the server certificate must carry.'),
    label: untrustedText(64, 'Endpoint label.'),
    state: z.enum(['active', 'retired']),
    createdAt: TimestampSchema,
    retiredAt: TimestampSchema.nullable(),
  })
  .meta({
    id: 'EndpointView',
    description: 'An endpoint with its address: visible to registry.manage only (resources.md).',
  })

export const DatabaseViewSchema = z
  .object({
    id: DatabaseIdSchema,
    clusterId: ClusterIdSchema,
    name: untrustedText(63, 'Database name.'),
    state: z.enum(['registered', 'retired']),
    observed: z
      .object({
        owner: untrustedText(63, 'Owning role.'),
        encoding: untrustedText(64, 'Encoding.'),
        collation: untrustedText(128, 'Default collation.'),
        observedAt: TimestampSchema,
      })
      .nullable(),
    placement: z
      .object({ targetId: TargetIdSchema, generation: z.int().min(1) })
      .nullable()
      .meta({ description: 'The target placed on this database now, if any.' }),
    createdAt: TimestampSchema,
  })
  .meta({ id: 'DatabaseView' })

export const CredentialViewSchema = z
  .object({
    id: CredentialIdSchema,
    clusterId: ClusterIdSchema,
    accessRole: AccessRoleSchema,
    roleName: z.string().regex(/^exponetdb_[a-z]+$/),
    state: z.enum(['pending', 'active', 'retired', 'failed']).meta({
      description:
        'pending until the worker logged in with it over verified TLS and checked the role; never readable in any state.',
    }),
    version: z.int().min(1).meta({ description: 'Submission count of this role on this cluster.' }),
    submittedAt: TimestampSchema,
    submittedBy: IdentityIdSchema,
    verifiedAt: TimestampSchema.nullable(),
    failureCode: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,63}$/)
      .nullable()
      .meta({
        'x-extensible-enum': [
          'superseded',
          'authentication_failed',
          'authentication_method',
          'tls_failed',
          'unreachable',
          'role_attributes',
          'cluster_identity_mismatch',
          'not_verified',
          'not_applied',
        ],
      }),
    stateChangedAt: TimestampSchema,
  })
  .meta({
    id: 'CredentialView',
    description: 'Credential metadata only: no password, no secret reference, no ciphertext.',
  })

export const ClusterBootstrapSqlSchema = z
  .object({
    clusterId: ClusterIdSchema,
    script: untrustedText(
      65_536,
      'SQL for a person to run with administrative tools; contains no password (set each one with psql \\password).',
    ),
    roles: z.array(z.string().regex(/^exponetdb_[a-z_]+$/)),
    databases: z.array(untrustedText(63, 'Database name.')),
  })
  .meta({ id: 'ClusterBootstrapSql' })

export type ProductCreateRequest = z.infer<typeof ProductCreateRequestSchema>
export type EnvironmentCreateRequest = z.infer<typeof EnvironmentCreateRequestSchema>
export type EnvironmentChangeRequest = z.infer<typeof EnvironmentChangeRequestSchema>
export type ProjectCreateRequest = z.infer<typeof ProjectCreateRequestSchema>
export type ProjectChangeRequest = z.infer<typeof ProjectChangeRequestSchema>
export type ServerCreateRequest = z.infer<typeof ServerCreateRequestSchema>
export type EndpointRequest = z.infer<typeof EndpointRequestSchema>
export type ClusterRegisterRequest = z.infer<typeof ClusterRegisterRequestSchema>
export type ClusterConfirmRequest = z.infer<typeof ClusterConfirmRequestSchema>
export type DatabaseRegisterRequest = z.infer<typeof DatabaseRegisterRequestSchema>
export type TargetRegisterRequest = z.infer<typeof TargetRegisterRequestSchema>
export type TargetStateChangeRequest = z.infer<typeof TargetStateChangeRequestSchema>
export type EndpointView = z.infer<typeof EndpointViewSchema>
export type DatabaseView = z.infer<typeof DatabaseViewSchema>
export type CredentialView = z.infer<typeof CredentialViewSchema>
export type ClusterBootstrapSql = z.infer<typeof ClusterBootstrapSqlSchema>
