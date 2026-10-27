import * as z from 'zod'
import {
  ClusterIdSchema,
  CredentialIdSchema,
  DatabaseIdSchema,
  EndpointIdSchema,
  EnvironmentIdSchema,
  ExecutionRoleExceptionIdSchema,
  IdentityIdSchema,
  NodeIdSchema,
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
import { BackupDependencySchema } from './backups.ts'

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

/**
 * Where a server runs (domain-model.md §3.2). The list grows additively and a value never changes
 * its meaning: the Control Store's CHECK on `registry.servers.provider` repeats it, and the Web
 * App, the CLI and the registry read it from here. The first four values are the Wave 4 list;
 * the others were added with the owner's decision of 2026-10-21 (a long provider list with
 * logos). `hetzner_robot` is a Hetzner dedicated server (managed in Hetzner Robot),
 * `akamai_linode` Akamai Cloud (formerly Linode), `on_premises` hardware of one's own.
 */
export const SERVER_PROVIDERS = [
  'hetzner_cloud',
  'hetzner_robot',
  'other',
  'unknown',
  'aws',
  'google_cloud',
  'azure',
  'oracle_cloud',
  'ibm_cloud',
  'alibaba_cloud',
  'digitalocean',
  'akamai_linode',
  'vultr',
  'upcloud',
  'scaleway',
  'exoscale',
  'stackit',
  'ovhcloud',
  'ionos',
  'netcup',
  'contabo',
  'on_premises',
] as const
export const ServerProviderSchema = z.enum(SERVER_PROVIDERS).meta({
  id: 'ServerProvider',
  description:
    'Where a server runs: a hosting provider, on_premises (own hardware), other, or unknown. Values are only ever added.',
})
export type ServerProvider = z.infer<typeof ServerProviderSchema>

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
    provider: ServerProviderSchema,
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

/**
 * The declared intended tier of a cluster (OD-22, extended 2026-10-13). A
 * registered cluster starts undeclared (`null` in the cluster view), which
 * the registry treats as production for registry authority (fail closed).
 * Declaring or changing it needs `registry.manage:prod`, whichever value.
 */
export const ClusterDeclaredTierRequestSchema = z
  .strictObject({
    declaredTier: TierSchema.meta({
      description:
        'The tier the cluster is meant for: prod (every database registered on it needs production authority) or nonprod (the environment decides).',
    }),
  })
  .meta({ id: 'ClusterDeclaredTierRequest' })

export const EndpointRetireRequestSchema = z
  .strictObject({ reason: ReasonSchema.optional() })
  .meta({ id: 'EndpointRetireRequest' })

export const DatabaseRetireRequestSchema = z
  .strictObject({ reason: ReasonSchema.optional() })
  .meta({ id: 'DatabaseRetireRequest' })

export const ClusterRetireRequestSchema = z
  .strictObject({ reason: ReasonSchema.optional() })
  .meta({ id: 'ClusterRetireRequest' })

/**
 * The adoption of an external cluster by the node agent (OD-54 option (a),
 * registry.md §4.5): one way, never undone. The person acknowledges that;
 * the node is the enrolled, live node of the cluster's server whose last
 * report names the cluster's pinned system identifier exactly once (named
 * here to pin it, or found by the planner).
 */
export const ClusterAgentAdoptionRequestSchema = z
  .strictObject({
    acknowledgeOneWay: z.literal(true).meta({
      description: 'The cluster becomes agent-managed for good: there is no way back to external.',
    }),
    nodeId: NodeIdSchema.optional().meta({
      description:
        "The node to adopt the cluster with; it must serve the cluster's server (or, for a cluster without a server, its own server becomes the cluster's).",
    }),
  })
  .meta({ id: 'ClusterAgentAdoptionRequest' })

export const ServerRetireRequestSchema = z
  .strictObject({ reason: ReasonSchema.optional() })
  .meta({ id: 'ServerRetireRequest' })

// ----- retirement: what blocks it, what goes with it, what stays (registry.md §4.4) -----

export const RetirementDependencyKindSchema = z
  .enum([
    'cluster',
    'node',
    'enrollment_token',
    'node_job',
    'database',
    'endpoint',
    'credential',
    'operation',
  ])
  .meta({
    id: 'RetirementDependencyKind',
    description:
      'A record that depends on the subject: a cluster on a server, a node of a server and its enrollment tokens and jobs, a registered database, an endpoint or a credential of a cluster, an open operation that names the subject.',
  })

export const RetirementDependencySchema = z
  .object({
    kind: RetirementDependencyKindSchema,
    id: z
      .string()
      .regex(/^(cls|nod|ent|job|dbs|end|crd|op)_[0-7][0-9A-HJKMNP-TV-Z]{25}$/)
      .meta({ description: 'The id of the dependent record.' }),
    state: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,63}$/)
      .meta({ description: 'Its lifecycle state (an open set: the state of its own table).' }),
    label: untrustedText(
      128,
      'A name the record carries (a cluster or database name, a role, an operation kind); null when it has none.',
    ).nullable(),
    targetId: TargetIdSchema.nullable().meta({
      description:
        'For a registered database: the target it is the current placement of; null when it is placed nowhere.',
    }),
  })
  .meta({ id: 'RetirementDependency' })

export const RetirementGroupSchema = z
  .object({
    kind: RetirementDependencyKindSchema,
    total: z
      .int()
      .min(0)
      .meta({ description: 'How many there are; `items` holds at most 50 of them.' }),
    items: z.array(RetirementDependencySchema).max(50),
  })
  .meta({ id: 'RetirementGroup' })

export const RetirementPreflightSchema = z
  .object({
    subject: z.object({
      kind: z.enum(['server', 'cluster']),
      id: z.string().regex(/^(srv|cls)_[0-7][0-9A-HJKMNP-TV-Z]{25}$/),
      state: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    }),
    verdict: z.enum(['can_plan', 'blocked', 'retired']).meta({
      description:
        'can_plan: nothing blocks the retirement now (the plan and its apply check again); blocked: `blockers` lists what must be retired, decommissioned or finished first, bottom-up; retired: the subject is already retired (final).',
    }),
    blockers: z.array(RetirementGroupSchema).meta({
      description:
        'Only groups with at least one record. Nothing here is removed by the retirement.',
    }),
    retiredWith: z.array(RetirementGroupSchema).meta({
      description:
        "Records the retirement retires in the same operation because they only describe how to reach the subject (a cluster's active endpoints and active credentials); their secrets stay in the secrets store.",
    }),
    kept: z
      .object({
        retiredChildren: z.int().min(0).meta({
          description: 'Retired or decommissioned children that stay as history and do not block.',
        }),
      })
      .meta({
        description: 'History that stays: nothing is deleted, the audit and operations stay whole.',
      }),
    providers: z.array(
      z.object({
        provider: z.literal('backups'),
        state: z.enum(['not_installed', 'none', 'blocking', 'unknown']).meta({
          description:
            'not_installed: no backup engine records anything yet (Wave 9), so no backup binding can exist; none: the engine holds no binding; blocking: it does (listed by the engine); unknown: it could not tell, which blocks.',
        }),
        dependencies: z.array(BackupDependencySchema).max(50).optional().meta({
          description:
            'Wave 9 Part B, additive: what binds the subject (repositories, open runs, restores, drills, lock retention, a WAL chain still needed) or why the engine could not tell; ids and states only, never a bucket, prefix or key.',
        }),
      }),
    ),
    source: z.literal('live'),
    observedAt: TimestampSchema,
  })
  .meta({
    id: 'RetirementPreflight',
    description:
      'What a retirement of a server or cluster would meet now, read live from the Control Store. A comfort view: the plan and its apply check again under the row lock, so a change after this read makes the plan stale or refused.',
  })

const DatabaseNameSchema = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[^\p{Cc}]+$/u)
  .refine((v) => utf8Length(v) <= 63, 'at most 63 bytes')
  .meta({ untrusted: true, description: 'Name of an existing database on the cluster.' })

export const DatabaseRegisterRequestSchema = z
  .strictObject({ name: DatabaseNameSchema })
  .meta({ id: 'DatabaseRegisterRequest' })

/** A legacy ledger kind (legacy-import.md §2), as the import request names it. */
const LegacyLedgerKindSchema = z.enum(['supabase', 'drizzle', 'applied_migrations'])

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

/**
 * `POST /findings/{finding}/accept` (Wave 8, `drift.accept`): the target's
 * current complete schema becomes its expected schema. A reason is required
 * when a covered finding is critical or security-relevant
 * (policy-engine.md, `drift.accept-prod`; drift-detection.md §6).
 */
export const DriftAcceptRequestSchema = z
  .strictObject({
    reason: z
      .string()
      .min(10)
      .max(1000)
      .meta({
        untrusted: true,
        description:
          'Why the actual schema is adopted as expected: stored verbatim in the plan, untrusted, never interpreted (10 to 1000 characters). Required when a covered finding is critical or security-relevant.',
      })
      .optional(),
  })
  .meta({ id: 'DriftAcceptRequest' })

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
    // At most 1 032 databases (registered and requested) with three ledgers and 1 024
    // execution roles fit (Wave 9 A8: guarded statements are longer).
    script: untrustedText(
      8_388_608,
      'SQL for a person to run with psql; contains no password (set each one with psql \\password).',
    ),
    roles: z.array(z.string().regex(/^exponetdb_[a-z_]+$/)),
    databases: z.array(untrustedText(63, 'Database name.')),
    // Wave 9 order A8 (additive).
    pendingDatabases: z
      .array(untrustedText(63, 'Database name.'))
      .meta({ description: 'Requested databases not registered yet (covered by the script).' }),
    executionRoles: z
      .array(
        z.object({
          name: untrustedText(63, 'PostgreSQL role name.'),
          bypassRlsExcused: z.boolean().meta({
            description:
              'A declared exception (ADR-0034) excuses its BYPASSRLS in an environment on this cluster.',
          }),
        }),
      )
      .meta({
        description:
          'Execution roles granted to the migrator WITH INHERIT FALSE, SET TRUE where they exist and are fit.',
      }),
    legacyLedgers: z
      .array(LegacyLedgerKindSchema)
      .meta({ description: 'Legacy ledgers the observer is granted to read, where they exist.' }),
  })
  .meta({ id: 'ClusterBootstrapSql' })

/** The query of the bootstrap SQL (Wave 9 order A8). */
export const ClusterBootstrapSqlQuerySchema = z.strictObject({
  database: z.array(DatabaseNameSchema).max(32).optional().meta({
    description:
      'Databases of the cluster to cover before they are registered (repeatable); registered ones are always covered.',
  }),
  project: ProjectIdSchema.optional().meta({
    description:
      'A project whose targets will be placed on this cluster: its execution roles are granted too.',
  }),
  environment: EnvironmentIdSchema.optional().meta({
    description:
      "Only this environment of the project (else every environment of the project's product).",
  }),
  ledgers: z
    .array(LegacyLedgerKindSchema)
    .max(3)
    .optional()
    .meta({ description: 'Legacy ledgers the observer may read during an import.' }),
})

// ----- execution roles for adopted schemas (ADR-0034, Wave 9 Part A) -----

/** A reason a person writes: 20 to 1000 characters, line breaks and tabs allowed, no other control character. */
const DeclarationReasonSchema = z
  .string()
  .min(20)
  .max(1000)
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are refused on purpose
  .regex(/^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+$/u)
  .meta({
    untrusted: true,
    description: 'Why, in the words of the person declaring (20 to 1000 characters).',
  })

/**
 * The execution roles of one environment of a project (ADR-0034 §5, D-A2):
 * aliases of the project's map bound to other roles for this environment
 * only; an alias the request leaves out takes the project's role. An empty
 * map removes every binding of the environment. Planned like every
 * registry change; `registry.manage` at the environment's tier.
 */
export const ExecutionRoleBindingsRequestSchema = z
  .strictObject({
    roles: z
      .record(ExecutionRoleAliasSchema, PostgresRoleNameSchema)
      .refine((roles) => Object.keys(roles).length <= 32, { message: 'At most 32 aliases.' })
      .meta({
        description:
          'Alias → PostgreSQL role for this environment; every alias must exist in the project map; never a pg_ or exponetdb_ role.',
      }),
  })
  .meta({ id: 'ExecutionRoleBindingsRequest' })

/**
 * Declares that one PostgreSQL role may serve as an execution role of the
 * project in this environment although it has `BYPASSRLS` (ADR-0034 §1,
 * OD-51). Nothing but `BYPASSRLS` is ever excused. Human only; production
 * needs an approval and a re-authentication.
 */
export const ExecutionRoleExceptionDeclareRequestSchema = z
  .strictObject({
    role: PostgresRoleNameSchema.meta({
      description: 'The PostgreSQL role (never pg_ or exponetdb_).',
    }),
    reason: DeclarationReasonSchema,
    reviewBy: z.iso.date().optional().meta({
      description:
        'A date by which a person reviews the exception; after it the exception excuses nothing (fail closed).',
    }),
  })
  .meta({ id: 'ExecutionRoleExceptionDeclareRequest' })

export const ExecutionRoleExceptionRevokeRequestSchema = z
  .strictObject({
    reason: z
      .string()
      .min(1)
      .max(1000)
      // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are refused on purpose
      .regex(/^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+$/u)
      .meta({ untrusted: true, description: 'Why the exception ends.' }),
  })
  .meta({ id: 'ExecutionRoleExceptionRevokeRequest' })

export const ExecutionRoleExceptionViewSchema = z
  .object({
    id: ExecutionRoleExceptionIdSchema,
    projectId: ProjectIdSchema,
    environmentId: EnvironmentIdSchema,
    role: z.string().max(63).meta({ untrusted: true }),
    attributes: z.array(z.literal('bypassrls')).length(1),
    reason: untrustedText(1000, 'The declaring person’s reason.'),
    reviewBy: z.iso.date().nullable(),
    state: z.enum(['active', 'revoked']),
    /** Active, but its review date passed: it excuses nothing until a person declares it again. */
    expired: z.boolean(),
    revision: z.int().min(1),
    declaredBy: IdentityIdSchema,
    declaredAt: TimestampSchema,
    revokedBy: IdentityIdSchema.nullable(),
    revokedAt: TimestampSchema.nullable(),
    revokeReason: untrustedText(1000, 'Why it was revoked.').nullable(),
  })
  .meta({ id: 'ExecutionRoleException' })

/** The execution roles of a project: the default map, each environment's bindings and effective map, the exceptions. */
export const ProjectExecutionRolesSchema = z
  .object({
    projectId: ProjectIdSchema,
    defaults: z.record(z.string().max(63), z.string().max(63)),
    environments: z.array(
      z.object({
        environmentId: EnvironmentIdSchema,
        slug: SlugSchema,
        tier: TierSchema,
        bindings: z.record(z.string().max(63), z.string().max(63)),
        effective: z.record(z.string().max(63), z.string().max(63)),
      }),
    ),
    exceptions: z.array(ExecutionRoleExceptionViewSchema).max(500),
  })
  .meta({ id: 'ProjectExecutionRoles' })

export type ProductCreateRequest = z.infer<typeof ProductCreateRequestSchema>
export type EnvironmentCreateRequest = z.infer<typeof EnvironmentCreateRequestSchema>
export type EnvironmentChangeRequest = z.infer<typeof EnvironmentChangeRequestSchema>
export type ProjectCreateRequest = z.infer<typeof ProjectCreateRequestSchema>
export type ProjectChangeRequest = z.infer<typeof ProjectChangeRequestSchema>
export type ServerCreateRequest = z.infer<typeof ServerCreateRequestSchema>
export type EndpointRequest = z.infer<typeof EndpointRequestSchema>
export type ClusterRegisterRequest = z.infer<typeof ClusterRegisterRequestSchema>
export type ClusterConfirmRequest = z.infer<typeof ClusterConfirmRequestSchema>
export type ClusterDeclaredTierRequest = z.infer<typeof ClusterDeclaredTierRequestSchema>
export type DatabaseRegisterRequest = z.infer<typeof DatabaseRegisterRequestSchema>
export type DatabaseRetireRequest = z.infer<typeof DatabaseRetireRequestSchema>
export type ClusterRetireRequest = z.infer<typeof ClusterRetireRequestSchema>
export type ClusterAgentAdoptionRequest = z.infer<typeof ClusterAgentAdoptionRequestSchema>
export type ServerRetireRequest = z.infer<typeof ServerRetireRequestSchema>
export type RetirementPreflight = z.infer<typeof RetirementPreflightSchema>
export type RetirementGroup = z.infer<typeof RetirementGroupSchema>
export type RetirementDependency = z.infer<typeof RetirementDependencySchema>
export type TargetRegisterRequest = z.infer<typeof TargetRegisterRequestSchema>
export type TargetStateChangeRequest = z.infer<typeof TargetStateChangeRequestSchema>
export type DriftAcceptRequest = z.infer<typeof DriftAcceptRequestSchema>
export type EndpointView = z.infer<typeof EndpointViewSchema>
export type DatabaseView = z.infer<typeof DatabaseViewSchema>
export type CredentialView = z.infer<typeof CredentialViewSchema>
export type ClusterBootstrapSql = z.infer<typeof ClusterBootstrapSqlSchema>
export type ExecutionRoleBindingsRequest = z.infer<typeof ExecutionRoleBindingsRequestSchema>
export type ExecutionRoleExceptionDeclareRequest = z.infer<
  typeof ExecutionRoleExceptionDeclareRequestSchema
>
export type ExecutionRoleExceptionRevokeRequest = z.infer<
  typeof ExecutionRoleExceptionRevokeRequestSchema
>
export type ExecutionRoleExceptionView = z.infer<typeof ExecutionRoleExceptionViewSchema>
export type ProjectExecutionRoles = z.infer<typeof ProjectExecutionRolesSchema>
