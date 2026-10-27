import * as z from 'zod'
import { ActionClassSchema, ActionIdSchema } from '../actions.ts'
import { StoredAuditEventSchema } from '../audit.ts'
import {
  AdvisorRunIdSchema,
  ApplyChecksumSchema,
  AuditEventIdSchema,
  ClusterIdSchema,
  CursorSchema,
  EndpointIdSchema,
  EnrollmentTokenIdSchema,
  EnvironmentIdSchema,
  FindingIdSchema,
  GrantIdSchema,
  IdentityIdSchema,
  InstallationIdSchema,
  JobIdSchema,
  JsonValueSchema,
  LedgerStateHashSchema,
  limitSchema,
  MigrationIdSchema,
  NodeIdSchema,
  OAuthClientIdSchema,
  ObservationSourceSchema,
  OperationIdSchema,
  openEnum,
  PlanIdSchema,
  PostgresVersionSchema,
  ProductIdSchema,
  ProjectIdSchema,
  QueryIdSchema,
  SavedQueryIdSchema,
  SchemaFingerprintSchema,
  ServerIdSchema,
  SessionIdSchema,
  Sha256DigestSchema,
  SlugSchema,
  SnapshotIdSchema,
  TargetIdSchema,
  TargetPathSchema,
  TargetRefSchema,
  TierSchema,
  TimestampSchema,
  untrustedJson,
  untrustedText,
} from '../common.ts'
import { PolicyRuleResultSchema } from '../errors.ts'
import {
  BaselineRefSchema,
  BundleSubmissionSchema,
  ProjectDefaultsSchema,
} from '../manifest/index.ts'
import {
  BackupEntrySchema,
  BackupProtectionSchema,
  BackupRepositorySummarySchema,
  WalCoverageSchema,
} from './backups.ts'
import { LintCodeSchema, MigrationProgressSchema, VerificationRunSchema } from './migrations.ts'
import { ServerProviderSchema } from './registry.ts'

/*
 * REST v1 read resources (resources.md). Shapes of a group are refined in the
 * wave that implements it; /api/v1 becomes stable at the end of Wave 7, and
 * after that only additive changes are allowed (versioning.md). Response
 * objects are open (clients ignore unknown fields); request objects are strict.
 * Every observed state carries `source` and `observedAt` (C-28); a failed live
 * read is an error, never an empty list.
 */

const name = (max: number, description: string) => untrustedText(max, description)

// ----- organization -----

export const ProductSchema = z
  .object({ id: ProductIdSchema, slug: SlugSchema, displayName: name(128, 'Display name.') })
  .meta({ id: 'Product' })

export const EnvironmentSchema = z
  .object({
    id: EnvironmentIdSchema,
    productId: ProductIdSchema,
    slug: SlugSchema,
    displayName: name(128, 'Display name.'),
    tier: TierSchema,
    evidenceFrom: SlugSchema.nullable().meta({
      description: 'Environment whose verified results count as evidence for this one.',
    }),
    rank: z.int().min(0),
    revision: z.int().min(1).meta({
      description: 'Advances by one with every change; a change plan binds it (Wave 4).',
    }),
  })
  .meta({ id: 'Environment' })

export const ProjectSchema = z
  .object({
    id: ProjectIdSchema,
    productId: ProductIdSchema,
    slug: SlugSchema,
    path: z.string().regex(/^[a-z][a-z0-9-]{0,38}\/[a-z][a-z0-9-]{0,38}$/),
    displayName: name(128, 'Display name.'),
    evidenceOverride: z.record(SlugSchema, z.literal('none')).meta({
      description:
        'Per environment slug: an explicit, audited opt-out of the evidence chain (I-9); empty when none.',
    }),
    managedScope: z
      .object({
        includeSchemas: z.array(name(63, 'Schema name.')).nullable().meta({
          description: 'Schemas the fingerprint covers; null means every non-system schema.',
        }),
        excludeSchemas: z.array(name(63, 'Schema name.')),
      })
      .meta({
        id: 'ManagedScope',
        description:
          'The schema scope of fingerprints and drift (schema-fingerprints.md §2); pg_catalog, information_schema and exponetdb are always excluded.',
      }),
    revision: z.int().min(1),
  })
  .meta({ id: 'Project' })

// ----- targets: lifecycle (registry.md) -----

export const TargetStateSchema = z
  .enum(['registered', 'active', 'suspended', 'decommissioned'])
  .meta({
    id: 'TargetState',
    description:
      'Registry lifecycle, separate from health: registered → active ⇄ suspended → decommissioned.',
  })

// ----- health (health.md) -----

export const TargetHealthStateSchema = z
  .enum(['healthy', 'degraded', 'unhealthy', 'unreachable', 'unknown', 'suspended'])
  .meta({ id: 'TargetHealthState' })
export const NodeHealthStateSchema = z
  .enum([
    'active',
    'degraded',
    'offline',
    'revoked',
    'unknown',
    'pending_enrollment',
    'decommissioned',
    'binding_failed',
  ])
  .meta({
    id: 'NodeHealthState',
    description:
      'pending_enrollment: enrolled, not yet bound by the worker; binding_failed: its bind proof did not hold (refused for good); offline: no heartbeat within 60 s (control-plane.md §2).',
  })
export const BackupHealthStateSchema = z
  .enum(['protected', 'at_risk', 'unprotected', 'unproven', 'unknown'])
  .meta({ id: 'BackupHealthState' })
export const ControlPlaneHealthStateSchema = z
  .enum(['operational', 'degraded', 'down'])
  .meta({ id: 'ControlPlaneHealthState' })

export const HealthConditionNameSchema = openEnum(
  [
    'probe_simple_failed',
    'extended_protocol_failing',
    'identity_mismatch',
    'connections_high',
    'connections_critical',
    'stalled_sessions',
    'idle_in_transaction',
    'long_running',
    'lock_waits',
    'xid_age_high',
    'replication_lag',
    'wal_archive_failing',
    'disk_high',
    'pending_restart',
    'tls_expiring',
    'plaintext_connections',
    'control_plane_degraded',
    'node_offline',
    'identity_unverified',
    'settings_unreadable',
    'activity_unreadable',
  ],
  'Named health condition (health.md §3).',
)

export const HealthConditionSchema = z
  .object({
    condition: HealthConditionNameSchema,
    severity: z.enum(['info', 'warning', 'critical']),
    count: z
      .int()
      .min(0)
      .nullable()
      .meta({ description: 'How many sessions or objects meet the condition, when countable.' }),
    endpointId: EndpointIdSchema.nullable().optional().meta({
      description: 'The client path the condition was observed on, when it is path-specific.',
    }),
    values: z
      .record(
        z.string().regex(/^[a-zA-Z][a-zA-Z0-9]{0,63}$/),
        z.union([z.number(), z.boolean(), z.null()]),
      )
      .optional()
      .meta({
        description:
          'The observed values behind the condition (for example usedSlots, usableSlots, maxAgeSeconds); numbers and flags only, never text from the database.',
      }),
    observedAt: TimestampSchema,
  })
  .meta({ id: 'HealthCondition' })

export const HealthSummarySchema = z
  .object({
    state: TargetHealthStateSchema,
    source: ObservationSourceSchema,
    observedAt: TimestampSchema,
  })
  .meta({ id: 'HealthSummary' })

export const ProbeResultSchema = z
  .object({
    probe: z.enum(['simple', 'extended', 'identity', 'activity', 'settings']),
    endpoint: z.object({
      id: EndpointIdSchema.nullable().meta({
        description: 'The registered endpoint (Wave 4); never its address.',
      }),
      kind: z.enum(['private', 'public', 'local_socket', 'pooler']),
      label: name(128, 'Endpoint label; never host credentials.'),
      verified: z.boolean().meta({
        description:
          'false when the consumer path is declared but not verified (shown as unverified, never as healthy).',
      }),
    }),
    outcome: z.enum(['ok', 'failed', 'timeout']),
    durationMs: z
      .int()
      .min(0)
      .nullable()
      .meta({ description: 'null on timeout: a timeout is not a duration.' }),
    errorClass: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,63}$/)
      .nullable(),
    tls: z.enum(['verified', 'failed', 'not_reached']).meta({
      description:
        'verified: verify-full against the registered CA and server name; not_reached: the connection failed before TLS.',
    }),
    observedAt: TimestampSchema,
  })
  .meta({ id: 'ProbeResult' })

export const TargetHealthSchema = z
  .object({
    targetId: TargetIdSchema,
    lifecycle: TargetStateSchema.meta({
      description:
        'The registry state, reported beside health: a suspended target that answers is suspended and reachable, never unreachable.',
    }),
    state: TargetHealthStateSchema,
    source: ObservationSourceSchema,
    observedAt: TimestampSchema,
    conditions: z.array(HealthConditionSchema),
    unknownBecause: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,63}$/)
      .nullable()
      .meta({
        'x-extensible-enum': [
          'control_plane_degraded',
          'never_sampled',
          'sampler_lagging',
          'no_endpoint',
          'no_placement',
          'observer_credential_missing',
          'no_active_endpoint',
        ],
        description:
          'Set when state is unknown: ExponetDB could not observe (the database may be fine).',
      }),
    probes: z.array(ProbeResultSchema),
    node: z
      .object({
        nodeId: NodeIdSchema,
        state: NodeHealthStateSchema,
        source: ObservationSourceSchema,
        observedAt: TimestampSchema,
      })
      .nullable()
      .meta({
        description:
          'Host agent state, separate from the database state (C-29); null for external clusters.',
      }),
    backups: z
      .object({
        state: BackupHealthStateSchema,
        source: ObservationSourceSchema,
        observedAt: TimestampSchema,
      })
      .nullable(),
  })
  .meta({ id: 'TargetHealth' })

/**
 * The connection capacity of a target as the latest health sample measured it
 * (Wave 8 completion, additive, REST only). Both numbers come from one sample
 * (the activity summary and the capacity settings); a sample that could not
 * read either of them has no capacity, and a missing one is never zero.
 */
export const TargetCapacitySchema = z
  .object({
    clientBackends: z.int().min(0).meta({
      description:
        'Client backends connected when the sample was taken (`pg_stat_activity` rows of backend type `client backend`, other than the session that read them).',
    }),
    usableSlots: z.int().min(0).meta({
      description:
        '`max_connections` minus `superuser_reserved_connections` and `reserved_connections`, never below 0: the connections ordinary roles can use. 0 is a measured value.',
    }),
    source: ObservationSourceSchema,
    observedAt: TimestampSchema.meta({
      description: 'When the sample that measured both numbers was taken.',
    }),
  })
  .meta({ id: 'TargetCapacity' })

/**
 * `GET /targets/{target}/health` (REST): the `TargetHealth` and, beside it,
 * the optional `capacity`. An intersection, so that `TargetHealth` stays one
 * schema with one definition: the MCP tool `target_health` keeps answering
 * with {@link TargetHealthSchema} (its catalog is frozen for this change, and
 * the extra member is stripped from its output by that schema), and the
 * OpenAPI document keeps its `TargetHealth` component unchanged.
 */
export const TargetHealthViewSchema = z
  .intersection(
    TargetHealthSchema,
    z.object({
      capacity: TargetCapacitySchema.optional().meta({
        description:
          'Wave 8 completion, additive: the connections in use and the usable slots from the latest sample, with that sample’s source and time. Absent when the latest sample did not measure them (never sampled, unreachable, a read that failed, or a sample taken before this member existed), never 0 as a stand-in. The database size is not sampled today and is not part of it.',
      }),
    }),
  )
  .meta({ id: 'TargetHealthView' })

// ----- targets -----

export const TargetSummarySchema = z
  .object({
    id: TargetIdSchema,
    path: TargetPathSchema,
    productId: ProductIdSchema,
    projectId: ProjectIdSchema,
    environmentId: EnvironmentIdSchema,
    tier: TierSchema,
    state: TargetStateSchema,
    generation: z.int().min(1),
    health: HealthSummarySchema.nullable().meta({
      description: 'null until the first sample; never shown as healthy.',
    }),
  })
  .meta({ id: 'TargetSummary' })

export const TargetSchema = TargetSummarySchema.extend({
  environment: z.object({ slug: SlugSchema, tier: TierSchema }),
  placement: z
    .object({
      clusterId: ClusterIdSchema,
      generation: z.int().min(1),
      since: TimestampSchema,
      serverName: name(128, 'Server display name (no address).').nullable(),
      clusterName: name(128, 'Cluster display name.'),
      managementMode: z.enum(['agent', 'external']),
      postgresVersion: PostgresVersionSchema.nullable(),
    })
    .nullable()
    .meta({
      description: 'Placement summary; addresses and credentials are never part of it (C-4, C-20).',
    }),
  ledger: z
    .object({
      ledgerStateHash: LedgerStateHashSchema.nullable(),
      appliedCount: z.int().min(0),
      lastAppliedAt: TimestampSchema.nullable(),
      source: ObservationSourceSchema,
      observedAt: TimestampSchema,
    })
    .nullable(),
  openFindingCount: z.int().min(0),
}).meta({ id: 'Target' })

// ----- findings -----

export const FindingSchema = z
  .object({
    id: FindingIdSchema,
    kind: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,63}$/)
      .meta({
        'x-extensible-enum': ['drift', 'advisor', 'health', 'lint', 'certificate', 'backup'],
      }),
    code: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,63}$/)
      .meta({ description: 'Rule or condition that produced the finding.' }),
    severity: z.enum(['info', 'warning', 'critical']),
    subject: z.object({
      targetId: TargetIdSchema.nullable(),
      clusterId: ClusterIdSchema.nullable(),
      nodeId: NodeIdSchema.nullable(),
    }),
    summary: name(1024, 'Finding summary; may quote database object names.'),
    state: z.enum(['open', 'resolved']),
    occurrences: z.int().min(1).meta({
      description:
        'How often the same finding was detected while open (deduplicated, never repeated).',
    }),
    object: name(512, 'Affected object (class and qualified name), when there is one.').nullable(),
    securityRelevant: z.boolean(),
    resolution: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,63}$/)
      .nullable()
      .meta({ 'x-extensible-enum': ['cleared', 'accepted', 'superseded'] }),
    firstSeenAt: TimestampSchema,
    lastSeenAt: TimestampSchema,
    resolvedAt: TimestampSchema.nullable(),
  })
  .meta({ id: 'Finding' })

export const DriftFindingSchema = z
  .object({
    id: FindingIdSchema,
    driftKind: z.enum(['A', 'B', 'C', 'D', 'E', 'F']),
    bucket: z.enum(['drifted', 'matched', 'unmanaged']),
    code: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    severity: z.enum(['info', 'warning', 'critical']),
    object: name(512, 'Affected object, qualified name.').nullable(),
    expected: name(4096, 'Expected value, redacted.').nullable(),
    actual: name(4096, 'Actual value, redacted.').nullable(),
    explainedByOperationId: OperationIdSchema.nullable(),
  })
  .meta({ id: 'DriftFinding' })

export const DriftCheckSchema = z
  .object({
    id: SnapshotIdSchema,
    targetId: TargetIdSchema,
    checkedAt: TimestampSchema,
    status: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,63}$/)
      .meta({
        'x-extensible-enum': [
          'clean',
          'drifted',
          'incomplete',
          'no_baseline',
          'not_comparable',
          'failed',
        ],
        description:
          'incomplete: the snapshot had a visibility gap, so nothing was compared (an incomplete fingerprint is never authoritative); not_comparable: the baseline and the current schema differ in canonicalizer or PostgreSQL major; failed: the read failed (errorCode), never shown as clean. None of these changes a finding.',
      }),
    baselineFingerprint: SchemaFingerprintSchema.nullable(),
    currentFingerprint: SchemaFingerprintSchema.nullable(),
    counts: z.object({
      drifted: z.int().min(0),
      matched: z.int().min(0),
      unmanaged: z.int().min(0),
      opened: z.int().min(0),
      updated: z.int().min(0),
      resolved: z.int().min(0),
    }),
    errorCode: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{1,63}$/)
      .nullable(),
    findings: z.array(DriftFindingSchema),
    truncated: z.boolean(),
  })
  .meta({ id: 'DriftCheck' })

/**
 * One past drift check as the history lists it (Wave 8 completion, additive,
 * REST only). The status, fingerprints, counts and error code are the
 * `DriftCheck` members of the same names; the findings a check recorded are
 * not stored per check (a finding keeps the checks that opened and resolved
 * it, and the findings reads list them), so a history entry has none.
 */
export const DriftCheckSummarySchema = DriftCheckSchema.pick({
  id: true,
  targetId: true,
  status: true,
  baselineFingerprint: true,
  currentFingerprint: true,
  counts: true,
  errorCode: true,
})
  .extend({
    generation: z.int().min(1).meta({
      description:
        'The target generation the check ran against; a check of an earlier generation is history of another identity stamp.',
    }),
    requestedBy: z
      .discriminatedUnion('kind', [
        z.object({ kind: z.literal('schedule') }),
        z.object({ kind: z.literal('identity'), identityId: IdentityIdSchema }),
      ])
      .meta({
        description:
          'Who asked: the worker’s schedule, or the identity that ran the check on demand (a person or a service account; a delegated client acts as the identity that delegated). The client the call came through is not recorded with the check, and a drift check is not an audit event today (OD-34).',
      }),
    startedAt: TimestampSchema,
    finishedAt: TimestampSchema,
  })
  .meta({ id: 'DriftCheckSummary' })

// ----- schema -----

export const SchemaObjectKindSchema = openEnum(
  [
    'schema',
    'table',
    'view',
    'materialized_view',
    'function',
    'procedure',
    'sequence',
    'type',
    'index',
    'policy',
    'trigger',
    'extension',
  ],
  'Kind of a database object.',
)

export const SchemaObjectRefSchema = z
  .object({
    kind: SchemaObjectKindSchema,
    schema: name(63, 'Schema name.'),
    name: name(63, 'Object name.'),
    signature: name(1024, 'Identity arguments of a function or procedure.').nullable(),
    parent: name(
      63,
      'Owning table, view or type of a column, constraint, index, trigger, policy or rule.',
    ).nullable(),
    key: z
      .array(name(2048, 'Canonical key element.'))
      .max(8)
      .meta({ description: 'The canonical fp1 key of the object (schema-fingerprints.md §3).' }),
  })
  .meta({ id: 'SchemaObjectRef' })

/**
 * `GET /targets/{target}/schema/objects` (Wave 8 completion, additive, REST
 * only; the MCP tool `schema_search` keeps its own input). Every filter is
 * optional and they combine with AND; a request without any lists every
 * object of the snapshot.
 */
export const SchemaObjectListQuerySchema = z.strictObject({
  kinds: z.array(SchemaObjectKindSchema).max(16).optional().meta({
    description:
      'Only objects of these kinds (repeat the parameter); the kinds `SchemaObjectRef.kind` shows.',
  }),
  schema: z.string().min(1).max(63).optional().meta({
    description: 'Only objects of this schema, by exact name (`SchemaObjectRef.schema`).',
  }),
  parent: z.string().min(1).max(63).optional().meta({
    description:
      'Only children of this relation, by the exact name `SchemaObjectRef.parent` shows (a column, constraint, index, trigger, policy or rule of that table, view or type). Combine with `schema` to name one relation.',
  }),
  q: z.string().min(1).max(128).optional().meta({
    description:
      'Only objects whose name contains this text, case-insensitively (the rule of `GET /targets/{target}/schema/search`).',
  }),
  limit: limitSchema(200, 100).optional(),
  cursor: CursorSchema.optional().meta({
    description:
      'The `nextCursor` of the previous page. Bound to the snapshot fingerprint and the filters: a cursor from another snapshot is refused with `SCHEMA_FINGERPRINT_MISMATCH`, one from other filters with `VALIDATION_FAILED`.',
  }),
})

export const SchemaObjectListSchema = z
  .object({
    items: z.array(SchemaObjectRefSchema),
    nextCursor: CursorSchema.nullable().meta({
      description: 'Cursor for the next page, null on the last page.',
    }),
    total: z.int().min(0).meta({
      description:
        'How many objects of the snapshot match the filters, before paging (exact, not a lower bound).',
    }),
    fingerprint: SchemaFingerprintSchema.meta({
      description:
        'The fingerprint of the snapshot every page of this list is read from. Order is deterministic within a snapshot: schema, kind, name, signature.',
    }),
    complete: z.boolean().meta({
      description:
        'false when anything in the managed scope could not be read: the list may then miss objects (an incomplete fingerprint is never authoritative); `GET /targets/{target}/schema` says what.',
    }),
    source: ObservationSourceSchema,
    observedAt: TimestampSchema.meta({ description: 'When the snapshot was taken.' }),
  })
  .meta({ id: 'SchemaObjectList' })

export const VisibilityReportSchema = z
  .object({
    complete: z.boolean().meta({
      description:
        'false when anything in scope could not be read; an incomplete fingerprint is never used for plans, evidence or as a drift baseline.',
    }),
    gaps: z
      .array(
        z.object({
          objectClass: SchemaObjectKindSchema,
          key: z.array(name(2048, 'Canonical key element.')).max(8),
          attribute: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.]{0,63}$/),
          reason: z
            .string()
            .regex(/^[a-z][a-z0-9_]{0,63}$/)
            .meta({ 'x-extensible-enum': ['unreadable', 'missing_schema'] }),
        }),
      )
      .max(200),
    gapCount: z.int().min(0),
    missingSchemas: z.array(name(63, 'Configured schema that does not exist (informational).')),
  })
  .meta({ id: 'VisibilityReport' })

export const SchemaOverviewSchema = z
  .object({
    targetId: TargetIdSchema,
    fingerprint: SchemaFingerprintSchema.nullable(),
    schemas: z.array(
      z.object({
        name: name(63, 'Schema name.'),
        managed: z.boolean().meta({ description: 'Inside the project managed scope.' }),
        objectCounts: z.record(z.string().regex(/^[a-z_]+$/), z.int().min(0)),
      }),
    ),
    complete: z.boolean(),
    visibility: VisibilityReportSchema,
    pgMajor: z.int().min(1).nullable(),
    source: ObservationSourceSchema,
    observedAt: TimestampSchema,
  })
  .meta({ id: 'SchemaOverview' })

export const SchemaObjectSchema = z
  .object({
    ref: SchemaObjectRefSchema,
    owner: name(63, 'Owning role.'),
    comment: name(8192, 'Object comment.').nullable(),
    definition: name(
      262144,
      'Deparsed definition (views, functions, policies, indexes).',
    ).nullable(),
    columns: z
      .array(
        z.object({
          name: name(63, 'Column name.'),
          type: name(256, 'Canonical type including typmod.'),
          nullable: z.boolean(),
          default: name(4096, 'Default expression.').nullable(),
          identity: z.enum(['always', 'by_default']).nullable(),
          generated: name(4096, 'Generation expression.').nullable(),
        }),
      )
      .nullable(),
    constraints: z
      .array(
        z.object({
          name: name(63, 'Constraint name.'),
          type: z.enum(['primary_key', 'foreign_key', 'unique', 'check', 'exclusion', 'not_null']),
          definition: name(8192, 'Definition.'),
          validated: z.boolean(),
        }),
      )
      .nullable(),
    indexes: z
      .array(
        z.object({
          name: name(63, 'Index name.'),
          definition: name(8192, 'Definition.'),
          unique: z.boolean(),
          valid: z.boolean(),
        }),
      )
      .nullable(),
    policies: z
      .array(
        z.object({
          name: name(63, 'Policy name.'),
          command: z.enum(['all', 'select', 'insert', 'update', 'delete']),
          permissive: z.boolean(),
          roles: z.array(name(63, 'Role.')),
          using: name(8192, 'USING expression.').nullable(),
          withCheck: name(8192, 'WITH CHECK expression.').nullable(),
        }),
      )
      .nullable(),
    rowLevelSecurity: z.object({ enabled: z.boolean(), forced: z.boolean() }).nullable(),
    grants: z
      .array(
        z.object({
          grantee: name(63, 'Grantee role.'),
          privileges: z.array(z.string().regex(/^[A-Z ]{3,32}$/)),
        }),
      )
      .nullable(),
    sizeBytes: z.int().min(0).nullable(),
    source: ObservationSourceSchema,
    observedAt: TimestampSchema,
  })
  .meta({ id: 'SchemaObject' })

export const SchemaFingerprintDocumentSchema = z
  .object({
    targetId: TargetIdSchema,
    fingerprint: SchemaFingerprintSchema,
    pgMajor: z.int().min(1),
    canonicalizer: z.string().regex(/^fp[1-9][0-9]*$/),
    complete: z.boolean().meta({
      description: 'An incomplete fingerprint is never authoritative (schema-fingerprints.md §8).',
    }),
    entries: z.int().min(0),
    documentDigest: Sha256DigestSchema,
    snapshotId: SnapshotIdSchema,
    visibility: VisibilityReportSchema,
    source: ObservationSourceSchema,
    observedAt: TimestampSchema,
  })
  .meta({ id: 'SchemaFingerprintResult' })

export const SchemaSideSchema = z
  .union([
    z.strictObject({ target: z.union([TargetIdSchema, TargetPathSchema]) }),
    z.strictObject({ fingerprint: SchemaFingerprintSchema }),
  ])
  .meta({ id: 'SchemaSide' })

export const SchemaDiffRequestSchema = z
  .strictObject({ left: SchemaSideSchema, right: SchemaSideSchema })
  .meta({ id: 'SchemaDiffRequest' })

export const SchemaDiffSchema = z
  .object({
    comparable: z.boolean().meta({
      description: 'false when the fingerprints use different canonicalizers or PostgreSQL majors.',
    }),
    left: z.object({ fingerprint: SchemaFingerprintSchema }),
    right: z.object({ fingerprint: SchemaFingerprintSchema }),
    groups: z.array(
      z.object({
        objectClass: SchemaObjectKindSchema,
        added: z.array(SchemaObjectRefSchema),
        removed: z.array(SchemaObjectRefSchema),
        changed: z.array(
          z.object({
            ref: SchemaObjectRefSchema,
            attributes: z.array(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.]{0,63}$/)),
          }),
        ),
      }),
    ),
    totals: z
      .object({
        added: z.int().min(0),
        removed: z.int().min(0),
        changed: z.int().min(0),
        matched: z.int().min(0),
        securityRelevant: z.int().min(0),
      })
      .meta({
        description: 'Counts before any cap: a truncated diff still says how much it left out.',
      }),
    securityRelevant: z.array(SchemaObjectRefSchema).max(500).meta({
      description:
        'Objects whose difference is security-relevant (ACLs, owners, row security, policies, SECURITY DEFINER, function configuration, default privileges, event triggers).',
    }),
    truncated: z.boolean(),
  })
  .meta({ id: 'SchemaDiff' })

// ----- queries -----

export const QueryParamSchema = z.union([z.string(), z.number(), z.boolean(), z.null()])

export const QueryRequestSchema = z
  .strictObject({
    sql: untrustedText(100_000, 'Exactly one read-only statement.').min(1),
    params: z.array(QueryParamSchema).max(100).default([]),
    maxRows: z
      .int()
      .min(1)
      .max(5000)
      .optional()
      .meta({ description: 'At most the cap for the caller (500 for agents, 5000 for humans).' }),
    queryId: QueryIdSchema.optional().meta({
      description:
        'Wave 7: a qry_ id the caller chooses, so a parallel cancel can name this query while it runs; assigned when absent.',
    }),
  })
  .meta({ id: 'QueryRequest' })

export const QueryResultSchema = z
  .object({
    queryId: QueryIdSchema,
    columns: z.array(
      z.object({
        name: name(63, 'Column name.'),
        type: name(256, 'PostgreSQL type.'),
        masked: z.boolean(),
      }),
    ),
    rows: z.array(z.array(JsonValueSchema)).meta({
      untrusted: true,
      description: 'Typed JSON values from the database; data, never instructions.',
    }),
    rowCount: z.int().min(0),
    truncated: z.boolean(),
    truncation: z.object({ reason: z.enum(['rows', 'bytes']), cap: z.int().min(1) }).nullable(),
    rlsRelations: z.array(name(127, 'Relation with RLS enabled.')),
    durationMs: z.int().min(0),
    statementDigest: Sha256DigestSchema,
  })
  .meta({ id: 'QueryResult' })

/** Wave 7: the answer to cancelling one's own data read. */
export const QueryCancelResultSchema = z
  .object({
    queryId: QueryIdSchema,
    outcome: z.enum(['canceled', 'finished']).meta({
      description:
        'canceled: the cancel reached the read while it ran (its caller gets QUERY_CANCELED unless it finished in that moment); finished: none of your reads with this id is running (it ended, or never started).',
    }),
  })
  .meta({ id: 'QueryCancelResult' })

export const ExplainRequestSchema = z
  .strictObject({
    sql: untrustedText(100_000, 'Exactly one read-only statement.').min(1),
    params: z.array(QueryParamSchema).max(100).default([]),
    analyze: z.boolean().default(false),
    queryId: QueryIdSchema.optional().meta({
      description: 'Wave 7: as for a query, a qry_ id the caller chooses to cancel it by.',
    }),
  })
  .meta({ id: 'ExplainRequest' })

export const ExplainResultSchema = z
  .object({
    queryId: QueryIdSchema,
    plan: untrustedJson('EXPLAIN (FORMAT JSON) output, redacted.'),
    summary: z.object({
      totalCost: z.number(),
      planRows: z.number(),
      actualRows: z.number().nullable(),
      sequentialScans: z.array(name(127, 'Relation scanned sequentially.')),
      misestimates: z.array(
        z.object({ node: name(127, 'Plan node.'), estimated: z.number(), actual: z.number() }),
      ),
    }),
    durationMs: z.int().min(0),
  })
  .meta({ id: 'ExplainResult' })

// ----- query history and saved queries (Wave 8, order §9) -----

const ERROR_CODE_TEXT = /^[A-Z][A-Z0-9_]{1,63}$/

/**
 * Wave 8: one of the caller's own data reads, as the audit's `data.read`
 * event holds it. Nothing here is read from anywhere else, and nothing the
 * audit does not hold is reconstructed: such a field is null.
 */
export const QueryHistoryEntrySchema = z
  .object({
    queryId: QueryIdSchema,
    kind: z.enum(['query', 'explain']),
    occurredAt: TimestampSchema.meta({
      description: 'When the audit recorded the read (after it ended).',
    }),
    statement: untrustedText(
      256,
      'The redacted statement exactly as the audit holds it: constants replaced by placeholders, at most its first 256 characters; never the text the caller sent.',
    ),
    statementDigest: Sha256DigestSchema.meta({
      description: 'sha256 of the whole redacted statement before the 256-character cut.',
    }),
    rows: z.int().min(0).nullable().meta({
      description:
        'Rows returned. Null for an EXPLAIN and for a read that failed or was refused: the audit records no row count for them.',
    }),
    truncated: z.boolean().nullable().meta({
      description:
        'Whether a cap cut the result. Null for an EXPLAIN and for a read that failed or was refused: the audit records it only for a completed query.',
    }),
    durationMs: z.int().min(0).nullable().meta({
      description:
        'Duration on the target. Null for a read that failed or was refused: the audit records no duration for it.',
    }),
    outcome: z.enum(['succeeded', 'failed']),
    errorCode: z.string().regex(ERROR_CODE_TEXT).nullable().meta({
      description: 'The error code of a failed or refused read; null when it succeeded.',
    }),
    client: z.enum(['web', 'rest', 'mcp', 'cli', 'ci']).meta({
      description:
        'The client the read came through (an MCP client reads in the name of the person who delegated to it).',
    }),
    callerClass: z.enum(['human', 'agent']),
  })
  .meta({ id: 'QueryHistoryEntry' })

export const QueryHistoryQuerySchema = z.strictObject({
  limit: limitSchema(200, 50).optional(),
  cursor: CursorSchema.optional(),
})

export const QueryHistorySchema = z
  .object({
    items: z.array(QueryHistoryEntrySchema),
    nextCursor: CursorSchema.nullable().meta({
      description: 'Cursor for the next (older) page, null on the last page.',
    }),
    source: z.literal('audit').meta({
      description: 'Every entry is a data.read event of the audit chain, newest first.',
    }),
  })
  .meta({ id: 'QueryHistory' })

/** A saved query's name: untrusted, short, one line, no control or bidirectional formatting characters. */
export const SavedQueryNameSchema = untrustedText(
  120,
  'A name for the saved query; untrusted text, never interpreted.',
)
  .min(1)
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are refused on purpose
  .regex(/^[^\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]+$/)

export const SavedQuerySqlSchema = untrustedText(
  65_536,
  'The SQL text as written (at most 65,536 characters). Saving never runs, parses or classifies it; running it is an ordinary data read.',
).min(1)

export const SavedQueryVisibilitySchema = z.enum(['personal', 'project']).meta({
  id: 'SavedQueryVisibility',
  description:
    'personal: only its owner sees it. project: everyone who may read data in its scope sees it; only the owner changes or deletes it.',
})

export const SavedQueryScopeRequestSchema = z
  .discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('project'), projectId: ProjectIdSchema }),
    z.strictObject({
      kind: z.literal('target'),
      target: TargetRefSchema,
    }),
  ])
  .meta({ id: 'SavedQueryScopeRequest' })

export const SavedQueryScopeSchema = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('project'), projectId: ProjectIdSchema }),
    z.object({ kind: z.literal('target'), targetId: TargetIdSchema }),
  ])
  .meta({ id: 'SavedQueryScope' })

export const SavedQueryCreateRequestSchema = z
  .strictObject({
    name: SavedQueryNameSchema,
    sql: SavedQuerySqlSchema,
    visibility: SavedQueryVisibilitySchema.default('personal'),
    scope: SavedQueryScopeRequestSchema.meta({
      description: 'Where the query belongs: one project or one target. It never changes.',
    }),
  })
  .meta({ id: 'SavedQueryCreateRequest' })

export const SavedQueryUpdateRequestSchema = z
  .strictObject({
    name: SavedQueryNameSchema,
    sql: SavedQuerySqlSchema,
    visibility: SavedQueryVisibilitySchema,
    revision: z.int().min(1).meta({
      description: 'The revision the change is based on; another one answers CONFLICT.',
    }),
  })
  .meta({ id: 'SavedQueryUpdateRequest' })

export const SavedQuerySchema = z
  .object({
    id: SavedQueryIdSchema,
    name: SavedQueryNameSchema,
    sql: SavedQuerySqlSchema,
    sqlDigest: Sha256DigestSchema.meta({
      description:
        'sha256 of the SQL text with its constants redacted (the construction of the data-read audit); the audit of a change records this digest only.',
    }),
    visibility: SavedQueryVisibilitySchema,
    scope: SavedQueryScopeSchema,
    ownerIdentityId: IdentityIdSchema,
    ownedByCaller: z.boolean(),
    revision: z.int().min(1),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .meta({ id: 'SavedQuery' })

export const SavedQueryListQuerySchema = z.strictObject({
  target: TargetRefSchema.optional().meta({
    description:
      'Only the saved queries of this target and of its project (a target as tgt_ id or path).',
  }),
  limit: limitSchema(200, 50).optional(),
  cursor: CursorSchema.optional(),
})

export const SavedQueryListSchema = z
  .object({
    items: z.array(SavedQuerySchema),
    nextCursor: CursorSchema.nullable().meta({
      description: 'Cursor for the next page, null on the last page.',
    }),
  })
  .meta({ id: 'SavedQueryList' })

export const SavedQueryDeletedSchema = z
  .object({ id: SavedQueryIdSchema, deleted: z.literal(true) })
  .meta({ id: 'SavedQueryDeleted' })

// ----- migrations -----

export const VerificationStatusSchema = z
  .enum(['pending', 'passed', 'failed', 'partial', 'error'])
  .meta({ id: 'VerificationStatus' })

const LedgerVerificationCoreSchema = z.object({
  status: VerificationStatusSchema,
  verifiedAt: TimestampSchema.nullable(),
  verifyDigest: ApplyChecksumSchema.nullable(),
})

const LedgerEntryCoreSchema = z.object({
  migrationId: z.union([
    MigrationIdSchema,
    BaselineRefSchema,
    z.string().regex(/^legacy:[^\s]{1,200}$/),
  ]),
  origin: z.enum(['exponetdb', 'legacy_import', 'baseline']),
  name: name(200, 'Migration name.'),
  checksum: z.string().regex(/^sha256:[a-z0-9:]{64,80}$/),
  appliedAt: TimestampSchema,
  reverted: z.boolean(),
  operationId: OperationIdSchema.nullable(),
  verification: LedgerVerificationCoreSchema,
})

export const LedgerEntrySchema = LedgerEntryCoreSchema.extend({
  verification: LedgerVerificationCoreSchema.extend({
    via: BaselineRefSchema.optional().meta({
      description:
        "Part A follow-up 4, additive: an imported row is verified by its baseline's verification; status is this row's share of the baseline's latest run (passed when none of its expectations is open), verifiedAt that run's end.",
    }),
    excused: z.int().min(0).optional().meta({
      description:
        "Part A follow-up 4, additive: this imported row's failing expectations a review decision excused in that run.",
    }),
    superseded: z.literal(true).optional().meta({
      description:
        "Part A follow-up 4, additive: the row's file was decided superseded; the baseline's verification does not check it, and status is the baseline run's.",
    }),
  }),
}).meta({ id: 'LedgerEntry' })

const MigrationStatusCoreSchema = z.object({
  targetId: TargetIdSchema,
  ledgerStateHash: LedgerStateHashSchema.nullable(),
  baselineId: BaselineRefSchema.nullable(),
  applied: z.array(LedgerEntryCoreSchema),
  pending: z.array(
    z.object({
      migrationId: MigrationIdSchema,
      name: name(64, 'Migration name.'),
      checksum: ApplyChecksumSchema,
    }),
  ),
  mirror: z.object({ inSync: z.boolean(), checkedAt: TimestampSchema }),
  incompleteNontransactional: z.array(MigrationIdSchema).optional().meta({
    description:
      'Non-transactional migrations that started and were neither completed nor cleaned up (Wave 6): they block schema plans until resume or cleanup.',
  }),
  source: ObservationSourceSchema,
  observedAt: TimestampSchema,
})

/**
 * The migration status as the MCP tool `migration_status` returns it: the
 * ledger entries without the additive fields of follow-up 4 (`via`,
 * `excused`, `superseded`), so its definition and `toolVersion` stay pinned;
 * an imported row's `status` is the same as over REST.
 */
export const McpMigrationStatusSchema = MigrationStatusCoreSchema

export const MigrationStatusSchema = z
  .object({
    targetId: TargetIdSchema,
    ledgerStateHash: LedgerStateHashSchema.nullable(),
    baselineId: BaselineRefSchema.nullable(),
    applied: z.array(LedgerEntrySchema),
    pending: z.array(
      z.object({
        migrationId: MigrationIdSchema,
        name: name(64, 'Migration name.'),
        checksum: ApplyChecksumSchema,
      }),
    ),
    mirror: z.object({ inSync: z.boolean(), checkedAt: TimestampSchema }),
    incompleteNontransactional: z.array(MigrationIdSchema).optional().meta({
      description:
        'Non-transactional migrations that started and were neither completed nor cleaned up (Wave 6): they block schema plans until resume or cleanup.',
    }),
    source: ObservationSourceSchema,
    observedAt: TimestampSchema,
  })
  .meta({ id: 'MigrationStatus' })

// ----- Wave 8: the promotion stream of a project (from the Control Store mirrors) -----

export const MigrationStreamStateSchema = openEnum(
  ['not_applied', 'applied', 'verified', 'failed', 'reverted', 'divergent', 'unknown'],
  "The mirror state of one migration on one target: not_applied (the mirror holds no row), applied (a ledger row, no passed verification), verified (the latest mirrored verification passed), failed (the latest mirrored verification failed, was partial or errored), reverted (the ledger row was reverted), divergent (the target's ledger differs from the mirror in a way no ExponetDB operation explains), unknown (the mirror holds no record of this target at its current generation).",
)

export const MigrationStreamCellSchema = z
  .object({
    environment: SlugSchema,
    state: MigrationStreamStateSchema,
    checksum: ApplyChecksumSchema.nullable().meta({
      description: 'The apply checksum the mirror holds for the ledger row; null without one.',
    }),
    checksumMatches: z.boolean().nullable().meta({
      description:
        'Whether that checksum equals the newest stored revision of the bundle; null without a ledger row.',
    }),
    appliedAt: TimestampSchema.nullable(),
    verification: z
      .object({
        status: VerificationStatusSchema,
        verifiedAt: TimestampSchema.nullable(),
      })
      .nullable()
      .meta({ description: 'The latest mirrored verification; null when none was mirrored.' }),
    observedAt: TimestampSchema.nullable().meta({
      description: 'When the mirror of this target was last written; null when it never was.',
    }),
  })
  .meta({ id: 'MigrationStreamCell' })

export const MigrationStreamSchema = z
  .object({
    projectId: ProjectIdSchema,
    graph: z.object({
      valid: z.boolean(),
      errors: z.array(
        z.object({
          code: z.string().regex(/^[A-Z][A-Z0-9_]+$/),
          migrationIds: z.array(z.string().max(80)).max(256),
        }),
      ),
    }),
    heads: z.array(MigrationIdSchema).max(1000).meta({
      description:
        'Bundles no other bundle depends on (at most 1000, by id); empty when the graph is not valid (then `bundles` are ordered by id).',
    }),
    baselines: z.array(BaselineRefSchema).max(1000).meta({
      description: 'Baseline nodes the bundles depend on.',
    }),
    bundles: z
      .array(
        z.object({
          migrationId: MigrationIdSchema,
          name: name(64, 'Migration name.'),
          revision: z.int().min(1),
          checksum: ApplyChecksumSchema,
          dependsOn: z.array(z.union([MigrationIdSchema, BaselineRefSchema])).max(1000),
          states: z.array(MigrationStreamCellSchema).max(200).meta({
            description:
              'One entry per environment that has a target the caller may see, in the order of `environments`.',
          }),
        }),
      )
      .max(1000)
      .meta({ description: 'In dependency order (a bundle after everything it depends on).' }),
    bundleCount: z.int().min(0).meta({ description: 'Bundles in the stream.' }),
    truncated: z.boolean().meta({
      description:
        'More than 1000 bundles: the last 1000 in dependency order are listed; the graph and `heads` cover all of them.',
    }),
    environments: z
      .array(
        z.object({
          slug: SlugSchema,
          displayName: name(128, 'Display name.'),
          tier: TierSchema,
          evidenceFrom: SlugSchema.nullable(),
          rank: z.int().min(0),
          target: z
            .object({
              id: TargetIdSchema,
              path: TargetPathSchema,
              lifecycle: TargetStateSchema,
              generation: z.int().min(1),
            })
            .nullable()
            .meta({
              description:
                "The project's live target in this environment; null when there is none or the caller may not see it (the two read alike).",
            }),
          mirror: z
            .object({
              observedAt: TimestampSchema,
              ledgerStateHash: LedgerStateHashSchema,
              baselineId: BaselineRefSchema.nullable(),
              divergent: z.boolean(),
              divergence: z
                .object({
                  missing: z.array(z.string().max(210)).max(16),
                  checksumDiffers: z.array(z.string().max(210)).max(16),
                  unrecorded: z.array(z.string().max(210)).max(16),
                })
                .nullable(),
              entriesOutsideStream: z.int().min(0).meta({
                description:
                  'Mirrored ledger rows that are no bundle of this stream (a baseline, an imported legacy entry, a bundle never ingested).',
              }),
            })
            .nullable()
            .meta({
              description:
                'The mirror of the target at its current generation; null when it holds none (every cell is then `unknown`).',
            }),
        }),
      )
      .max(200)
      .meta({
        description:
          'The environments of the product in evidence order: an environment after the one it takes evidence from; among those that may come next, the lower rank first, then the slug.',
      }),
    source: ObservationSourceSchema.meta({
      description:
        "cached: the Control Store mirrors of the targets' ledgers and verification runs, written by the worker after each operation, not a live read of the targets. Each cell and environment carries the time of its mirror.",
    }),
    observedAt: TimestampSchema.meta({ description: 'When the server read the mirrors.' }),
  })
  .meta({ id: 'MigrationStream' })

export const LintFindingSchema = z
  .object({
    rule: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    level: z.enum(['error', 'warn', 'info']),
    blocking: z.boolean(),
    message: z.string().max(1024),
    file: z.enum(['migration.yaml', 'up.sql', 'verify.sql', 'down.sql']).nullable(),
    statementIndex: z.int().min(0).nullable(),
    code: LintCodeSchema.optional(),
  })
  .meta({ id: 'LintFinding' })

export const MigrationLintRequestSchema = z
  .strictObject({
    bundles: z.array(BundleSubmissionSchema).min(1).max(50),
    defaults: ProjectDefaultsSchema.optional().meta({
      description: 'The defaults block of exponetdb.project.yaml (part of the apply checksum).',
    }),
    postgresMajor: z
      .union([z.literal(16), z.literal(17), z.literal(18)])
      .optional()
      .meta({ description: 'The grammar to lint with (default 17); no target is read.' }),
  })
  .meta({ id: 'MigrationLintRequest' })

export const MigrationLintResultSchema = z
  .object({
    bundles: z.array(
      z.object({
        directory: z.string().max(91),
        migrationId: MigrationIdSchema.nullable(),
        checksum: ApplyChecksumSchema.nullable(),
        verifyDigest: ApplyChecksumSchema.nullable(),
        rollbackDigest: ApplyChecksumSchema.nullable(),
        bundleDigest: ApplyChecksumSchema.nullable(),
        sourceDigest: Sha256DigestSchema.nullable(),
        findings: z.array(LintFindingSchema),
      }),
    ),
    graph: z.object({
      valid: z.boolean(),
      errors: z.array(
        z.object({
          code: z.string().regex(/^[A-Z][A-Z0-9_]+$/),
          migrationIds: z.array(z.string().max(80)),
        }),
      ),
    }),
  })
  .meta({ id: 'MigrationLintResult' })

// ----- plans and operations -----

export const PlanStateSchema = z
  .enum(['active', 'consumed', 'expired', 'invalidated', 'denied', 'withdrawn'])
  .meta({ id: 'PlanState' })
export const PolicyDecisionSchema = z.enum(['allow', 'require', 'deny'])

export const RequirementSchema = z
  .discriminatedUnion('kind', [
    z.object({
      kind: z.literal('approval'),
      count: z.int().min(1),
      permission: z.literal('plans.approve'),
    }),
    z.object({ kind: z.literal('reauth'), withinSeconds: z.int().min(1) }),
    z.object({
      kind: z.literal('backup'),
      newerThan: z.string().regex(/^P/),
      verified: z.literal(true),
    }),
    z.object({ kind: z.literal('maintenance_window'), windowId: z.string().max(64) }),
    z.object({ kind: z.literal('break_glass'), rules: z.array(z.string().max(128)) }),
  ])
  .meta({ id: 'PolicyRequirement' })
export type PolicyRequirement = z.infer<typeof RequirementSchema>
export type PolicyDecisionKind = z.infer<typeof PolicyDecisionSchema>

export const ActorSchema = z
  .union([
    z.object({
      identityId: IdentityIdSchema,
      kind: z.enum(['human', 'service']),
      via: z.enum(['web', 'rest', 'mcp', 'cli', 'ci']).meta({
        description:
          'The client the identity acted through; a service account acts through `ci` (an API key or a machine grant).',
      }),
    }),
    z.object({
      identityId: z.null(),
      kind: z.literal('system'),
      via: z.literal('system').meta({
        description:
          'ExponetDB itself (a worker reconciliation, such as suspending writes to a target whose identity marker no longer matches); never a person or a service account.',
      }),
    }),
  ])
  .meta({ id: 'Actor' })

export const SubjectRefSchema = z
  .object({
    targetId: TargetIdSchema.nullable(),
    targetPath: TargetPathSchema.nullable(),
    clusterId: ClusterIdSchema.nullable(),
    nodeId: NodeIdSchema.nullable(),
    tier: TierSchema.nullable(),
  })
  .meta({ id: 'SubjectRef' })

/**
 * A plan as read through REST and MCP. The kind-specific `content` and
 * `analysis` shapes are added with the wave that implements each kind (Wave 6
 * for migrations); until then they are not part of the read contract.
 */
export const PlanViewSchema = z
  .object({
    id: PlanIdSchema,
    kind: ActionIdSchema,
    kindVersion: z.int().min(1),
    class: ActionClassSchema,
    state: PlanStateSchema,
    planHash: Sha256DigestSchema,
    createdAt: TimestampSchema,
    expiresAt: TimestampSchema,
    actor: ActorSchema,
    clientId: OAuthClientIdSchema.nullable(),
    subject: SubjectRefSchema,
    contentChecksum: Sha256DigestSchema,
    decision: PolicyDecisionSchema,
    requirements: z.array(RequirementSchema),
    overriddenRules: z.array(z.string().max(128)),
    approvals: z.object({ required: z.int().min(0), given: z.int().min(0) }),
    change: z.object({ content: JsonValueSchema, analysis: JsonValueSchema }).optional().meta({
      description:
        'Content and analysis of the plan: the exact change and its analysis (access, registry, target and node kinds; Wave 6: the migration kinds, whose content names bundles by digest and never carries SQL text).',
    }),
    policyRules: z.array(PolicyRuleResultSchema).max(128).optional().meta({
      description:
        'Wave 6: the rules that did not pass (fail, unknown, warn) with their message, remediation and whether break-glass may override them; why a plan is denied or what it requires.',
    }),
  })
  .meta({ id: 'PlanView' })

export const OperationStateSchema = z
  .enum([
    'awaiting_approval',
    'queued',
    'running',
    'verifying',
    'needs_reconciliation',
    'needs_attention',
    'succeeded',
    'failed',
    'verification_failed',
    'canceled',
  ])
  .meta({ id: 'OperationState' })
export const ApplyOutcomeSchema = z
  .enum(['not_started', 'applied', 'not_applied', 'partially_applied', 'unknown'])
  .meta({ id: 'ApplyOutcome' })
export const VerificationOutcomeSchema = z
  .enum(['not_applicable', 'pending', 'passed', 'failed', 'partial', 'error'])
  .meta({ id: 'VerificationOutcome' })

export const OperationNextActionSchema = z
  .enum(['none', 'wait', 'approve', 'inspect', 'resume', 'forward_fix', 'replan'])
  .meta({
    id: 'OperationNextAction',
    description:
      'Wave 6, additive: what a person does next, derived from the state and the outcomes. `wait`: the server is still working (queued, running, verifying, reconciling); `approve`: an approval is pending; `inspect`: needs attention, a person decides; `resume`: a non-transactional migration stopped part-way (an explicit resume plan); `forward_fix`: applied but verification failed (never a rollback by default); `replan`: nothing was applied, fix the cause and plan again; `none`: finished.',
  })

export const OperationSchema = z
  .object({
    id: OperationIdSchema,
    kind: ActionIdSchema,
    planId: PlanIdSchema.nullable(),
    state: OperationStateSchema,
    applyOutcome: ApplyOutcomeSchema,
    verificationOutcome: VerificationOutcomeSchema,
    subject: SubjectRefSchema,
    actor: ActorSchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    waitingFor: z.object({ operationId: OperationIdSchema }).nullable(),
    approvalUrl: z.url().nullable(),
    errorCode: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{1,63}$/)
      .nullable(),
    steps: z.array(
      z.object({
        index: z.int().min(0),
        name: z.string().regex(/^[a-z][a-z0-9_.]{0,63}$/),
        state: z.enum(['pending', 'running', 'succeeded', 'failed', 'skipped']),
        startedAt: TimestampSchema.nullable(),
        finishedAt: TimestampSchema.nullable(),
      }),
    ),
    migrations: z.array(MigrationProgressSchema).optional().meta({
      description:
        'Per-migration apply and verification outcomes of a migration operation (Wave 6), in plan order.',
    }),
    observedAt: TimestampSchema.optional().meta({
      description: 'Wave 6, additive: when the server read this state (the Control Store clock).',
    }),
    lastEventId: z
      .string()
      .regex(/^(0|[1-9][0-9]{0,18})$/)
      .optional()
      .meta({
        description:
          'Wave 6, additive: the newest event of the operation (monotonic); a watcher that sees it unchanged knows nothing happened since.',
      }),
    nextAction: OperationNextActionSchema.optional(),
    verifications: z
      .array(VerificationRunSchema.omit({ verifyDigest: true }))
      .max(50)
      .optional()
      .meta({
        description:
          "Part A follow-up 3, additive: the verification runs of a migration operation (the Control Store's mirror of the target's history), newest last, each with its failing expectations, so a failed verification says what failed.",
      }),
  })
  .meta({
    id: 'Operation',
    description: 'Apply and verification outcomes are separate fields (C-13).',
  })

// ----- sessions, locks, statistics -----

export const SessionSchema = z
  .object({
    pid: z.int().min(1),
    backendStart: TimestampSchema,
    queryStart: TimestampSchema.nullable(),
    role: name(63, 'Session role.'),
    applicationName: name(128, 'application_name.'),
    state: z
      .string()
      .max(64)
      .meta({
        'x-extensible-enum': [
          'active',
          'idle',
          'idle in transaction',
          'idle in transaction (aborted)',
          'fastpath function call',
          'disabled',
        ],
      }),
    waitEvent: z.object({ type: z.string().max(64), event: z.string().max(64) }).nullable(),
    transactionAgeMs: z.int().min(0).nullable(),
    queryAgeMs: z.int().min(0).nullable(),
    stateAgeMs: z.int().min(0).nullable(),
    statement: z
      .object({
        redacted: name(16384, 'Redacted statement text.'),
        digest: Sha256DigestSchema.nullable(),
        truncated: z.boolean().meta({
          description:
            'The redacted text was cut at its cap (2 000 characters for people, 500 for MCP clients); the digest is of the whole redacted text.',
        }),
      })
      .nullable()
      .meta({
        description: 'Always redacted; raw text needs diagnostics.read_sensitive in the Web App.',
      }),
    exponetdbOperationId: OperationIdSchema.nullable(),
  })
  .meta({ id: 'Session' })

export const SessionListSchema = z
  .object({
    targetId: TargetIdSchema,
    sessions: z.array(SessionSchema),
    truncated: z.boolean(),
    cap: z.int().min(1),
    source: ObservationSourceSchema,
    observedAt: TimestampSchema,
  })
  .meta({ id: 'SessionList' })

export const LockGraphSchema = z
  .object({
    targetId: TargetIdSchema,
    waits: z.array(
      z.object({
        waitingPid: z.int().min(1),
        blockingPids: z.array(z.int().min(1)).min(1),
        lockMode: z.string().max(64),
        relation: name(127, 'Relation name.').nullable(),
        waitingSince: TimestampSchema.nullable(),
        exponetdbOperationId: OperationIdSchema.nullable(),
      }),
    ),
    truncated: z.boolean(),
    source: ObservationSourceSchema,
    observedAt: TimestampSchema,
  })
  .meta({ id: 'LockGraph' })

/** The statement sampler's state for a target (performance.md §2). */
export const StatementSamplingSchema = z
  .object({
    state: z
      .enum(['active', 'extension_missing', 'not_sampled_yet', 'failing', 'not_permitted'])
      .meta({
        description:
          "extension_missing: pg_stat_statements is not installed or not preloaded (CAPABILITY_UNAVAILABLE for live reads); not_permitted: the observer role cannot read other roles' statements (pg_read_all_stats); failing: the last samples failed.",
      }),
    intervalSeconds: z.int().min(60),
    lastSampleAt: TimestampSchema.nullable(),
    lastErrorCode: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{1,63}$/)
      .nullable(),
    resets: z
      .array(
        z.object({
          at: TimestampSchema,
          kind: z.enum(['stats_reset', 'server_restart', 'entries_deallocated']),
        }),
      )
      .max(64)
      .meta({
        description:
          'Discontinuities inside the window: deltas never cross one, so no value is negative.',
      }),
    gaps: z
      .array(z.object({ from: TimestampSchema, to: TimestampSchema }))
      .max(64)
      .meta({ description: 'Intervals without a successful sample inside the window.' }),
  })
  .meta({ id: 'StatementSampling' })

export const StatementRegressionSchema = z
  .object({
    state: z.enum(['regressed', 'none', 'insufficient_data']),
    meanTimeMs24h: z.number().min(0).nullable(),
    meanTimeMs7d: z.number().min(0).nullable(),
    factor: z.number().min(0).nullable(),
    thresholdFactor: z.number().min(1),
    minCalls: z.int().min(1),
    migrationsBetween: z.int().min(0).nullable().meta({
      description:
        'Migrations applied to the target between the baseline and the window (from the ledger mirror). A time coincidence, never a proven cause.',
    }),
  })
  .meta({ id: 'StatementRegression' })

export const QueryStatsSchema = z
  .object({
    targetId: TargetIdSchema,
    window: z.object({ from: TimestampSchema, to: TimestampSchema }),
    statements: z.array(
      z.object({
        digest: Sha256DigestSchema,
        normalizedText: name(16384, 'Normalized statement with constants removed.'),
        calls: z.int().min(0),
        totalTimeMs: z.number().min(0),
        meanTimeMs: z.number().min(0),
        rows: z.int().min(0),
        sharedBlocksHit: z.int().min(0),
        sharedBlocksRead: z.int().min(0),
        queryId: z
          .string()
          .regex(/^-?[0-9]{1,20}$/)
          .optional()
          .meta({ description: 'Wave 9, additive: pg_stat_statements queryid.' }),
        database: name(63, 'Database name.').optional(),
        role: name(63, 'Role name.').optional(),
        textRedacted: z.boolean().optional().meta({
          description:
            'Wave 9, additive: the text was replaced because it could carry a secret (utility statements naming passwords, role or user mapping options).',
        }),
        regression: StatementRegressionSchema.optional(),
      }),
    ),
    truncated: z.boolean(),
    source: ObservationSourceSchema,
    observedAt: TimestampSchema,
    sampling: StatementSamplingSchema.optional().meta({
      description: 'Wave 9, additive: the sampler state, resets and gaps of the window.',
    }),
  })
  .meta({ id: 'QueryStats' })

export const TableStatsSchema = z
  .object({
    targetId: TargetIdSchema,
    tables: z.array(
      z.object({
        schema: name(63, 'Schema.'),
        name: name(63, 'Table.'),
        sizeBytes: z.int().min(0),
        indexSizeBytes: z.int().min(0),
        sequentialScans: z.int().min(0),
        indexScans: z.int().min(0),
        liveTuples: z.int().min(0),
        deadTuples: z.int().min(0),
        lastVacuumAt: TimestampSchema.nullable(),
        lastAutovacuumAt: TimestampSchema.nullable(),
        lastAnalyzeAt: TimestampSchema.nullable(),
        lastAutoanalyzeAt: TimestampSchema.nullable(),
        bloatEstimateBytes: z
          .int()
          .min(0)
          .nullable()
          .meta({ description: 'An estimate, labeled as such.' }),
        xidAge: z.int().min(0),
      }),
    ),
    indexes: z.array(
      z.object({
        schema: name(63, 'Schema.'),
        table: name(63, 'Table.'),
        name: name(63, 'Index.'),
        sizeBytes: z.int().min(0),
        scans: z.int().min(0),
        valid: z.boolean(),
        duplicateOf: name(63, 'Index with the same definition.').nullable(),
        unique: z.boolean().optional(),
        primary: z.boolean().optional(),
      }),
    ),
    truncated: z.boolean(),
    source: ObservationSourceSchema,
    observedAt: TimestampSchema,
    statsSince: TimestampSchema.nullable().optional().meta({
      description:
        'Wave 9, additive: since when the database statistics count (pg_stat_database.stats_reset, else the server start): "unused" means unused since then.',
    }),
    estimateMethod: z.literal('heuristic_page_estimate').optional().meta({
      description: 'Wave 9, additive: how bloatEstimateBytes is estimated (never measured).',
    }),
  })
  .meta({ id: 'TableStats' })

export const ADVISOR_CATEGORIES = [
  'security',
  'performance',
  'operations',
  'change_safety',
] as const
export const AdvisorCategorySchema = z.enum(ADVISOR_CATEGORIES).meta({ id: 'AdvisorCategory' })

export const AdvisorRunRequestSchema = z
  .strictObject({
    categories: z.array(AdvisorCategorySchema).min(1).max(4).default(['security', 'performance']),
  })
  .meta({ id: 'AdvisorRunRequest' })

export const AdvisorRunSchema = z
  .object({
    targetId: TargetIdSchema,
    ranAt: TimestampSchema,
    findings: z.array(
      z.object({
        rule: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
        category: AdvisorCategorySchema,
        level: z.enum(['info', 'warning', 'critical']),
        object: name(512, 'Affected object.').nullable(),
        message: z.string().max(1024),
        remediation: z.string().max(2048),
        findingId: FindingIdSchema.nullable().optional().meta({
          description: 'Wave 9, additive: the recorded finding (deduplicated).',
        }),
        evidence: z
          .record(
            z.string().regex(/^[a-z][a-zA-Z0-9]{0,31}$/),
            z.union([z.string().max(256), z.number(), z.boolean(), z.null()]),
          )
          .optional()
          .meta({
            untrusted: true,
            description: 'Wave 9, additive: bounded facts behind the finding.',
          }),
        draft: z.enum(['none', 'migration_draft']).optional().meta({
          description:
            'Wave 9, additive: migration_draft: a fix can be drafted as a migration bundle for review (never executed here; OD-44 limits apply).',
        }),
      }),
    ),
    id: AdvisorRunIdSchema.optional(),
    catalogVersion: z.int().min(1).optional(),
    skipped: z
      .array(
        z.object({
          rule: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
          reason: z.enum([
            'needs_node',
            'version_unsupported',
            'not_permitted',
            'timeout',
            'error',
            // The statistics have been collected for less time than the rule needs (unused indexes).
            'stats_window_short',
          ]),
        }),
      )
      .max(64)
      .optional()
      .meta({ description: 'Wave 9, additive: rules that did not run, and why (never a pass).' }),
  })
  .meta({ id: 'AdvisorRun' })

/** Cancel a running query of a session (performance.md §5; an inline plan). */
export const ConnectionCancelRequestSchema = z
  .strictObject({
    backendStart: TimestampSchema,
    queryStart: TimestampSchema.meta({
      description: 'The query the person saw: the cancel acts only while the same query runs.',
    }),
  })
  .meta({ id: 'ConnectionCancelRequest' })

/** Terminate a session (a stored plan; precondition re-checked in the terminating statement). */
export const ConnectionTerminateRequestSchema = z
  .strictObject({
    backendStart: TimestampSchema,
    condition: z.enum(['stalled', 'idle_in_transaction', 'long_running', 'any']).meta({
      description:
        'The condition that must still hold when the session is terminated, re-checked in the same statement: stalled (active, ClientRead, query age >= 60 s), idle_in_transaction (state age >= 60 s), long_running (active, query age >= 300 s), any.',
    }),
    reason: z.string().min(1).max(500).meta({ untrusted: true }).optional(),
  })
  .meta({ id: 'ConnectionTerminateRequest' })

export const FindingSummarySchema = z
  .object({
    open: z.int().min(0),
    bySeverity: z.object({
      critical: z.int().min(0),
      warning: z.int().min(0),
      info: z.int().min(0),
    }),
    byKind: z.array(z.object({ kind: z.string().max(64), count: z.int().min(0) })).max(32),
    topCodes: z
      .array(
        z.object({
          kind: z.string().max(64),
          code: z.string().max(64),
          severity: z.enum(['info', 'warning', 'critical']),
          count: z.int().min(0),
        }),
      )
      .max(50),
    source: z.literal('control_store'),
    observedAt: TimestampSchema,
  })
  .meta({
    id: 'FindingSummary',
    description: 'Counts of the open findings the caller may read (Wave 9; the UI/UX U8 read).',
  })

// ----- infrastructure -----

export const ServerSchema = z
  .object({
    id: ServerIdSchema,
    displayName: name(128, 'Mutable label; nothing binds to it.'),
    provider: ServerProviderSchema,
    location: name(64, 'Location label.').nullable(),
    derivedTier: TierSchema.nullable(),
    observedFacts: z
      .object({
        os: name(128, 'OS.'),
        kernel: name(128, 'Kernel.'),
        cpus: z.int().min(1),
        memoryBytes: z.int().min(0),
        reportedAt: TimestampSchema,
      })
      .nullable(),
    state: z.enum(['active', 'retired']).meta({
      description:
        'retired: the record left the registry by an operation (final, registry.md §4.4); the machine itself was not touched.',
    }),
    retiredAt: TimestampSchema.nullable(),
  })
  .meta({ id: 'Server' })

export const ClusterSchema = z
  .object({
    id: ClusterIdSchema,
    displayName: name(128, 'Mutable label.'),
    serverId: ServerIdSchema.nullable(),
    managementMode: z.enum(['agent', 'external']),
    state: z.enum(['pending', 'active', 'retired']).meta({
      description:
        'pending until a person confirmed it and its system_identifier was pinned; a pending cluster hosts no target.',
    }),
    confirmedAt: TimestampSchema.nullable(),
    postgresVersion: PostgresVersionSchema.nullable(),
    systemIdentifier: z
      .string()
      .regex(/^[0-9]{1,20}$/)
      .nullable()
      .meta({ description: 'Pinned system_identifier.' }),
    derivedTier: TierSchema.nullable(),
    declaredTier: TierSchema.nullable().optional().meta({
      description:
        'The intended tier a person declared with production authority (OD-22); null while undeclared, which counts as prod for registry authority.',
    }),
    health: HealthSummarySchema.nullable(),
    retiredAt: TimestampSchema.nullable().optional().meta({
      description:
        'When the record was retired by an operation (registry.md §4.4); null while it is not. The PostgreSQL cluster itself is not touched.',
    }),
  })
  .meta({ id: 'Cluster' })

export const CapabilityRefSchema = z
  .strictObject({
    name: z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/),
    major: z.int().min(1).max(1000),
  })
  .meta({
    id: 'CapabilityRef',
    description: 'Capability name and major version (postgres.config.apply@1).',
  })

export const NodeSchema = z
  .object({
    id: NodeIdSchema,
    serverId: ServerIdSchema,
    state: NodeHealthStateSchema,
    agentVersion: z
      .string()
      .regex(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/)
      .nullable(),
    protocolMajor: z.int().min(1).nullable(),
    lastHeartbeatAt: TimestampSchema.nullable(),
    clockSkewMs: z.int().nullable(),
    capabilities: z.array(CapabilityRefSchema),
  })
  .meta({ id: 'Node' })

export const NodeStatusSchema = NodeSchema.extend({
  clusters: z.array(
    z.object({
      clusterId: ClusterIdSchema.nullable(),
      localName: name(64, 'Local cluster name such as 17/main.'),
      running: z.boolean(),
      pendingRestart: z.boolean(),
      serverCertificateExpiresAt: TimestampSchema.nullable(),
    }),
  ),
  host: z
    .object({
      loadAverage1m: z.number().min(0),
      memoryUsedBytes: z.int().min(0),
      diskUsedPercent: z.number().min(0).max(100),
    })
    .nullable(),
  nodeCertificateExpiresAt: TimestampSchema.nullable(),
  source: ObservationSourceSchema,
  observedAt: TimestampSchema,
}).meta({ id: 'NodeStatus' })

/**
 * The one response that carries an enrollment token (control-plane.md §4):
 * shown once to the identity that applied `node.enroll`, never stored or
 * logged, valid 30 minutes and redeemable once.
 */
export const EnrollmentTokenRevealSchema = z
  .strictObject({
    tokenId: EnrollmentTokenIdSchema,
    serverId: ServerIdSchema,
    token: z
      .string()
      .regex(/^exdbt1\.[A-Za-z0-9_-]+$/)
      .max(4096)
      .meta({
        description:
          'exdbt1 token: give it to `exponetdb-node enroll --token-file` on the host; it is never shown again.',
      }),
    expiresAt: TimestampSchema,
  })
  .meta({ id: 'EnrollmentTokenReveal' })

export const BackupSchema = BackupEntrySchema

export const BackupCatalogSchema = z
  .object({
    clusterId: ClusterIdSchema,
    state: BackupHealthStateSchema,
    backups: z.array(BackupEntrySchema),
    walWindow: z.object({ from: TimestampSchema, to: TimestampSchema }).nullable(),
    achievableRpoSeconds: z
      .int()
      .min(0)
      .nullable()
      .meta({ description: 'Measured, never assumed (C-30).' }),
    lastDrillAt: TimestampSchema.nullable(),
    truncated: z.boolean(),
    source: ObservationSourceSchema,
    observedAt: TimestampSchema,
    repositories: z.array(BackupRepositorySummarySchema).max(64).meta({
      description: 'Wave 9 Part B, additive: the repositories, without location or credential.',
    }),
    protection: BackupProtectionSchema.meta({
      description:
        'Wave 9 Part B, additive: the measured protection and the reasons it is not protected.',
    }),
    walCoverage: z.array(WalCoverageSchema).max(64),
    nextCursor: z.string().max(512).nullable(),
  })
  .meta({ id: 'BackupCatalog' })

// ----- audit and installation -----

export const AuditEventSchema = z
  .object({
    id: AuditEventIdSchema,
    occurredAt: TimestampSchema,
    action: z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/),
    phase: z.enum(['requested', 'denied', 'accepted', 'completed', 'failed', 'reconciled']),
    actor: z.object({
      identityId: IdentityIdSchema.nullable(),
      kind: z.enum(['human', 'service', 'system']),
      label: z.string().max(64).meta({ description: 'Pseudonymous label.' }),
    }),
    client: z
      .object({
        clientId: OAuthClientIdSchema.nullable(),
        kind: z.enum(['web', 'rest', 'mcp', 'cli', 'ci', 'system']),
        grantId: GrantIdSchema.nullable(),
        sessionId: SessionIdSchema.nullable(),
      })
      .nullable(),
    subject: SubjectRefSchema,
    refs: z.object({
      planId: PlanIdSchema.nullable(),
      planHash: Sha256DigestSchema.nullable(),
      operationId: OperationIdSchema.nullable(),
      jobId: JobIdSchema.nullable(),
    }),
    reason: untrustedText(2000, 'Caller-supplied reason, recorded and never evaluated.').nullable(),
    denial: z
      .object({
        action: z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/),
        reason: z.string().regex(/^[a-z][a-z_]{0,31}$/),
        tool: z
          .string()
          .regex(/^[a-z][a-z0-9_]{0,47}$/)
          .nullable(),
      })
      .nullable()
      .meta({
        description:
          'For `authz.denied` (a denied high-risk action): the denied action, the reason code and the MCP tool it came through; never an argument value. Null for every other event.',
      }),
    result: z.object({
      status: z.enum(['succeeded', 'failed', 'denied']),
      errorCode: z
        .string()
        .regex(/^[A-Z][A-Z0-9_]{1,63}$/)
        .nullable(),
    }),
  })
  .meta({ id: 'AuditEvent' })

export const InstallationSchema = z
  .object({
    installationId: InstallationIdSchema.optional().meta({
      description:
        "This installation's id (Wave 6, additive): a client that recorded it notices when another installation answers at the same origin.",
    }),
    version: z.string().regex(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/),
    contracts: z.object({
      restApi: z.literal('v1'),
      mcpCatalog: z.literal('exponetdb.mcp/v1'),
      nodeProtocol: z.literal('exponetdb.node/v1'),
      migrationManifest: z.literal('exponetdb.migration/v1'),
      projectConfig: z.literal('exponetdb.project/v1'),
    }),
    features: z.array(z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/)),
    oauthClientRegistration: z.enum(['open', 'review']).optional().meta({
      description:
        'How this installation admits a new OAuth client (Wave 8, additive; `EXPONETDB_OAUTH_CLIENT_REGISTRATION`, OD-5): `open` approves a new CIMD or DCR client automatically, `review` waits for an administrator. A person still consents in both modes. Absent when the serving process does not report it.',
    }),
  })
  .meta({ id: 'Installation' })
export type Installation = z.infer<typeof InstallationSchema>
export type BackupCatalog = z.infer<typeof BackupCatalogSchema>

/** A machine reason code (`lower_snake`): never prose, never text from a database or a client. */
const ReasonCodeSchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/)

export const InstallationComponentSchema = z
  .object({
    component: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,63}$/)
      .meta({
        'x-extensible-enum': [
          'control_store',
          'workers',
          'samplers',
          'gateway',
          'keyring',
          'maintenance',
          'data_reads',
          'audit_chain',
        ],
      }),
    state: ControlPlaneHealthStateSchema,
    source: ObservationSourceSchema,
    observedAt: TimestampSchema,
    reasons: z.array(ReasonCodeSchema).max(16).optional().meta({
      description:
        'Wave 8, additive: why the state is not `operational` (machine codes), or what the state rests on when it is. Empty or absent when there is nothing to add.',
    }),
    values: z
      .record(
        z.string().regex(/^[a-zA-Z][a-zA-Z0-9]{0,63}$/),
        z.union([z.number(), z.boolean(), z.null()]),
      )
      .optional()
      .meta({
        description:
          'Wave 8, additive: the counts and ages behind the state (for example liveWorkers, enrolledNodes, consecutiveFailures); numbers and flags only, never text, a host name or a build.',
      }),
  })
  .meta({ id: 'InstallationComponent' })

export const InstallationHealthSchema = z
  .object({
    state: ControlPlaneHealthStateSchema.meta({
      description:
        'The worst state of the observed components. Components in `unobserved` are not part of it: a state that cannot be known is never counted as operational.',
    }),
    components: z.array(InstallationComponentSchema),
    unobserved: z
      .array(
        z.object({
          component: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
          reason: ReasonCodeSchema,
        }),
      )
      .optional()
      .meta({
        description:
          'Wave 8, additive: components this release cannot observe, each with the reason (for example `gateway` with `not_applicable` while no node is enrolled and no gateway runs). The installation findings of self-observability.md §5 are not stored (a finding needs a target), so the reasons and values of the components carry what a self-check found.',
      }),
    observedAt: TimestampSchema.optional().meta({
      description: 'Wave 8, additive: when the server read these signals.',
    }),
  })
  .meta({
    id: 'InstallationHealth',
    description: 'Control Plane health; distinct from target health (C-29).',
  })

// ----- Wave 8: health history (health.md §6) -----

export const HealthHistoryCountsSchema = z
  .object({
    healthy: z.int().min(0),
    degraded: z.int().min(0),
    unhealthy: z.int().min(0),
    unreachable: z.int().min(0),
    unknown: z.int().min(0),
    suspended: z.int().min(0),
  })
  .meta({ id: 'HealthHistoryCounts' })

export const HealthHistoryBucketSchema = z
  .object({
    start: TimestampSchema.meta({ description: 'Start of the bucket (aligned to its size).' }),
    worst: TargetHealthStateSchema.meta({
      description:
        'The worst state of the samples in the bucket, in the order unreachable, unhealthy, degraded, suspended, unknown, healthy: a bucket that holds an `unknown` sample is never `healthy`.',
    }),
    samples: z.int().min(1),
    counts: HealthHistoryCountsSchema,
  })
  .meta({ id: 'HealthHistoryBucket' })

export const HealthHistoryGapSchema = z
  .object({
    from: TimestampSchema,
    to: TimestampSchema,
    durationSeconds: z.int().min(1),
    cause: openEnum(
      ['control_plane_down', 'sampler_lagging', 'unknown'],
      'Why no sample was written, derived from the process heartbeats that cover the interval: control_plane_down (no live worker heartbeat covered it: the sampler runs in the worker), sampler_lagging (a worker was alive but wrote no sample), unknown (the heartbeat history does not cover it; `reason` says why). node_offline and target_unreachable are not derived: a sample that failed is a sample, not a gap.',
    ),
    reason: ReasonCodeSchema.nullable().meta({
      description:
        'Detail of the cause as a machine code: for control_plane_down `no_live_process` (neither serve nor worker) or `no_live_worker` (serve was alive); for unknown `heartbeats_pruned`.',
    }),
  })
  .meta({ id: 'HealthHistoryGap' })

export const TargetHealthHistoryQuerySchema = z.strictObject({
  from: TimestampSchema.optional(),
  to: TimestampSchema.optional(),
})

export const TargetHealthHistorySchema = z
  .object({
    targetId: TargetIdSchema,
    from: TimestampSchema.meta({ description: 'The range served after the defaults.' }),
    to: TimestampSchema.meta({ description: 'The range served; never later than `observedAt`.' }),
    bucketSeconds: z.int().min(1).meta({
      description:
        'The bucket size chosen from the range (at most 500 buckets); aligned to multiples of itself.',
    }),
    samplePeriodSeconds: z.int().min(1),
    gapThresholdSeconds: z.int().min(1).meta({
      description: 'An interval without a sample longer than this is a gap (twice the period).',
    }),
    firstSampleAt: TimestampSchema.nullable().meta({
      description:
        'The earliest retained sample of the target; null when it has none. Nothing before it is a gap: it is before the target was sampled, or before the retention (3 to 60 days, 14 by default).',
    }),
    buckets: z.array(HealthHistoryBucketSchema).max(501).meta({
      description:
        'Buckets that hold at least one sample, oldest first. A missing bucket is inside a gap, or no sample landed in it.',
    }),
    gaps: z.array(HealthHistoryGapSchema).max(200),
    gapsTruncated: z.boolean().meta({
      description: 'More than 200 gaps in the range: the oldest 200 are listed.',
    }),
    source: ObservationSourceSchema,
    observedAt: TimestampSchema,
  })
  .meta({ id: 'TargetHealthHistory' })

// ----- Wave 8: the audit chain (audit.md §4) -----

const AuditHashSchema = z.string().regex(/^sha256:ac1:[0-9a-f]{64}$/)

export const AuditChainRunSchema = z
  .object({
    outcome: z.enum(['succeeded', 'failed', 'skipped']).nullable(),
    reason: ReasonCodeSchema.nullable(),
    finishedAt: TimestampSchema.nullable(),
    consecutiveFailures: z.int().min(0),
    nextRunAt: TimestampSchema,
  })
  .meta({
    id: 'AuditChainRun',
    description: 'The last run of a worker maintenance task, as the Control Store keeps it.',
  })

export const AuditChainVerificationSchema = z
  .discriminatedUnion('status', [
    z.object({
      status: z.literal('verified'),
      scope: z.enum(['from_checkpoint', 'full']),
      anchorCheckpointSeq: z.int().min(1).nullable(),
      fromSeq: z.int().min(1),
      throughSeq: z.int().min(1),
      verifiedEvents: z.int().min(0),
      verifiedAt: TimestampSchema,
    }),
    z.object({
      status: z.literal('broken'),
      scope: z.enum(['from_checkpoint', 'full']),
      anchorCheckpointSeq: z.int().min(1).nullable(),
      failingSeq: z.int().min(0),
      reason: openEnum(
        [
          'anchor_missing',
          'checkpoint_mismatch',
          'sequence_gap',
          'prev_hash_mismatch',
          'not_canonical',
          'invalid_event',
          'columns_mismatch',
          'hash_mismatch',
        ],
        'Why the chain does not hold at `failingSeq`.',
      ),
      verifiedEvents: z.int().min(0),
      verifiedAt: TimestampSchema,
    }),
    z.object({
      status: z.literal('not_verified'),
      reason: openEnum(
        ['too_many_events', 'empty_chain'],
        'Why nothing was verified: more events than the bound since the latest checkpoint (or since the start, without a checkpoint), or no event at all.',
      ),
      anchorCheckpointSeq: z.int().min(1).nullable(),
      eventsSinceAnchor: z.int().min(0),
      limit: z.int().min(1),
    }),
  ])
  .meta({
    id: 'AuditChainVerification',
    description:
      'Computed on this request, read-only in one repeatable-read transaction, incrementally from the latest checkpoint (the checkpoint must match its event). A repeat within 15 seconds at the same head returns the same result with its original `verifiedAt`.',
  })

export const AuditChainSchema = z
  .object({
    head: z
      .object({ seq: z.int().min(1), occurredAt: TimestampSchema, hash: AuditHashSchema })
      .nullable()
      .meta({ description: 'The newest event of the chain; null when the chain is empty.' }),
    checkpoints: z
      .array(
        z.object({
          seq: z.int().min(1),
          hash: AuditHashSchema,
          createdAt: TimestampSchema,
          reason: z.enum(['scheduled', 'retention', 'manual']),
        }),
      )
      .max(20)
      .meta({ description: 'The newest checkpoints, newest first.' }),
    exports: z.object({
      sinks: z
        .array(
          z.object({
            kind: z.enum(['file', 's3', 'other']),
            state: z.enum(['up_to_date', 'behind']),
            lastExportedSeq: z.int().min(1).nullable(),
            lastExportedAt: TimestampSchema.nullable(),
            pendingCheckpoints: z.int().min(0),
          }),
        )
        .max(16)
        .meta({
          description:
            'One entry per exporter that ever recorded an export; never its bucket, path or endpoint. An exporter that was replaced stays and reads `behind`: compare `lastExportedAt`.',
        }),
      task: AuditChainRunSchema.nullable().meta({
        description:
          'The worker task `audit.export`: `skipped` with `export_unconfigured` means no exporter is configured.',
      }),
    }),
    verification: AuditChainVerificationSchema,
    workerVerification: z.object({
      runsIn: z.literal('worker'),
      resultPersisted: z.literal(false).meta({
        description:
          'A full verification (daily) and the hourly incremental one run in the worker; the sequence and time they covered are not stored, only the outcome of the task below.',
      }),
      incremental: AuditChainRunSchema.nullable(),
      full: AuditChainRunSchema.nullable(),
    }),
    source: ObservationSourceSchema,
    observedAt: TimestampSchema,
  })
  .meta({ id: 'AuditChain' })

// ----- Wave 8: the audit export (owner decision 2026-10-13; audit.md §5.1) -----

/** The most events one export response carries (audit.md §5.1). */
export const AUDIT_EXPORT_MAX_EVENTS = 10_000
export const AUDIT_EXPORT_FORMAT = 'exponetdb.audit-export/v1'

/**
 * A bound of the export range: an RFC 3339 UTC time (`occurredAt`) or a
 * decimal sequence number (`seq`). `from` is inclusive and `to` exclusive for
 * both kinds.
 */
export const AuditExportBoundSchema = z
  .string()
  .regex(/^(?:[1-9][0-9]{0,15}|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z)$/)
  .meta({
    description:
      'An RFC 3339 UTC time ending in Z, or a decimal sequence number. `from` is inclusive, `to` is exclusive.',
  })

export const AuditExportQuerySchema = z.strictObject({
  from: AuditExportBoundSchema.optional(),
  to: AuditExportBoundSchema.optional(),
  cursor: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,512}$/)
    .optional()
    .meta({ description: 'The `nextCursor` of the previous response; the range is the same.' }),
  limit: z
    .int()
    .min(1)
    .max(AUDIT_EXPORT_MAX_EVENTS)
    .optional()
    .meta({
      description: `Events per response, at most ${AUDIT_EXPORT_MAX_EVENTS} (the default).`,
    }),
})

export const AuditExportHeaderSchema = z
  .object({
    type: z.literal('header'),
    format: z.literal(AUDIT_EXPORT_FORMAT),
    chain: z.literal('ac1'),
    from: z.string().nullable(),
    to: z.string().nullable(),
    firstSeq: z.int().min(1).nullable(),
    lastSeq: z.int().min(1).nullable(),
    count: z.int().min(0).max(AUDIT_EXPORT_MAX_EVENTS),
    more: z.boolean(),
    nextCursor: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,512}$/)
      .nullable(),
    checkpoints: z
      .array(z.object({ seq: z.int().min(1), hash: AuditHashSchema, createdAt: TimestampSchema }))
      .max(50)
      .meta({
        description:
          'Checkpoints of the chain with `firstSeq - 1 <= seq <= lastSeq`, oldest first (at most 50): anchors a verifier compares with the event hashes of the page.',
      }),
    generatedAt: TimestampSchema,
  })
  .meta({ id: 'AuditExportHeader' })

export const AuditExportEventLineSchema = z
  .object({
    type: z.literal('event'),
    seq: z.int().min(1),
    prevHash: z.string(),
    hash: AuditHashSchema,
    event: StoredAuditEventSchema.meta({
      description:
        'The stored event verbatim: its JCS (RFC 8785) text is exactly what ac1 hashed, so a verifier canonicalizes this member to check `hash`. Contains full event content (personal data per OD-8).',
    }),
  })
  .meta({ id: 'AuditExportEventLine' })

/** One line of the NDJSON response: the header first, then the events by ascending `seq`. */
export const AuditExportLineSchema = z
  .discriminatedUnion('type', [AuditExportHeaderSchema, AuditExportEventLineSchema])
  .meta({ id: 'AuditExportLine' })

export type AuditExportHeader = z.infer<typeof AuditExportHeaderSchema>

// ----- Wave 8: live statement classification (additive, REST only) -----

/** The input bounds of `POST /sql/classifications` (sql-execution-security.md §2.5). */
export const SQL_CLASSIFY_MAX_BYTES = 64 * 1024
export const SQL_CLASSIFY_MAX_STATEMENTS = 200

/** The classes a statement can carry (sql-execution-security.md §2.5); several can apply. */
export const SQL_CLASSES = [
  'read_only',
  'write',
  'destructive',
  'rewrite',
  'non_transactional',
  'security',
] as const

/**
 * The UTF-8 length of a string without `TextEncoder` (the contracts build for every runtime):
 * one byte below U+0080, two below U+0800, four for a surrogate pair, three otherwise (a lone
 * surrogate counts three, as its replacement character U+FFFD would).
 */
export function utf8Length(text: string): number {
  let bytes = 0
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i)
    if (unit < 0x80) bytes += 1
    else if (unit < 0x800) bytes += 2
    else if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4
        i++
      } else bytes += 3
    } else bytes += 3
  }
  return bytes
}

export const SqlClassificationRequestSchema = z
  .strictObject({
    sql: z
      .string()
      .min(1)
      .max(SQL_CLASSIFY_MAX_BYTES)
      .refine((v) => utf8Length(v) <= SQL_CLASSIFY_MAX_BYTES, {
        message: 'At most 64 KiB (UTF-8 bytes).',
      })
      .meta({
        untrusted: true,
        description:
          'The text to classify: at most 64 KiB (UTF-8 bytes) and 200 statements. Parsed on the server, never executed, never stored, never echoed.',
      }),
    postgresMajor: z
      .union([z.literal(16), z.literal(17), z.literal(18)])
      .optional()
      .meta({
        description:
          'The PostgreSQL grammar to parse with (each major has its own); 17 when absent. Echoed in the answer.',
      }),
  })
  .meta({ id: 'SqlClassificationRequest' })

const SqlPositionSchema = z
  .object({
    line: z.int().min(1).meta({ description: '1-based; lines end at U+000A.' }),
    column: z.int().min(1).meta({
      description:
        '1-based, counted in Unicode code points from the start of the line (a character outside the Basic Multilingual Plane counts once; U+000D counts as a character).',
    }),
    offset: z.int().min(0).meta({
      description:
        '0-based UTF-16 code unit offset into the submitted text, as JavaScript string indices and CodeMirror count.',
    }),
  })
  .meta({ id: 'SqlPosition' })

const SqlReadRefusalSchema = z
  .object({
    code: z.enum(['QUERY_NOT_READ_ONLY', 'QUERY_CONSTRUCT_UNSUPPORTED', 'QUERY_PARSE_ERROR']),
    reason: z.string().regex(/^[a-z][a-z_]{0,31}$/),
  })
  .meta({
    id: 'SqlReadRefusal',
    description:
      'Why the read-only data path would refuse it: the admission error code and its reason code, never the construct or any text of the statement.',
  })

export const SqlClassificationSchema = z
  .object({
    status: z.enum(['parsed', 'empty', 'parse_error']),
    postgresMajor: z.union([z.literal(16), z.literal(17), z.literal(18)]),
    grammar: z
      .string()
      .max(128)
      .meta({ description: 'The parser build that produced the answer.' }),
    bytes: z.int().min(0).meta({ description: 'UTF-8 bytes of the submitted text.' }),
    statementCount: z.int().min(0).max(SQL_CLASSIFY_MAX_STATEMENTS),
    statements: z
      .array(
        z.object({
          index: z.int().min(0),
          kind: z
            .string()
            .regex(/^[A-Z][A-Za-z0-9]{0,63}$/)
            .meta({
              description: "The parser's node kind, e.g. `IndexStmt`.",
            }),
          label: z
            .string()
            .regex(/^[A-Z][A-Z ]{0,63}$/)
            .meta({
              description:
                'A readable name from a closed vocabulary, e.g. `CREATE INDEX CONCURRENTLY`.',
            }),
          start: SqlPositionSchema.meta({
            description:
              'Where the statement text begins (its first token; leading comments excluded).',
          }),
          end: SqlPositionSchema.meta({
            description:
              'Just after its last character: exclusive, without the terminating semicolon and without trailing white space.',
          }),
          classes: z.array(z.enum(SQL_CLASSES)).max(6),
          procedural: z.boolean().meta({
            description:
              'A top-level SELECT, a DO block or a CALL: the effects of the code it runs are not derivable from the text.',
          }),
          readOnlyPath: z.boolean().meta({
            description:
              'True when the read-only data path would admit this statement on its own (`admitRead`).',
          }),
          readOnlyRefusal: SqlReadRefusalSchema.nullable(),
          migrationRefusal: z
            .string()
            .regex(/^[a-z][a-z_]{0,31}$/)
            .nullable()
            .meta({
              description:
                'The reason code when the migration engine would refuse the statement in `up.sql` (transaction control, role management, ...); null otherwise.',
            }),
        }),
      )
      .max(SQL_CLASSIFY_MAX_STATEMENTS),
    readOnlyPath: z.object({
      admitted: z.boolean().meta({
        description:
          'True when the whole text is exactly one statement the read-only data path admits.',
      }),
      refusal: SqlReadRefusalSchema.nullable(),
    }),
    parseError: z
      .object({
        reason: z.enum(['syntax', 'parser_limit', 'nul', 'too_large', 'empty']),
        position: SqlPositionSchema.nullable().meta({
          description: "The parser's error position; null when it names none.",
        }),
      })
      .nullable(),
    source: z.literal('parser'),
    computedAt: TimestampSchema,
  })
  .meta({ id: 'SqlClassification' })
export type SqlClassificationRequest = z.infer<typeof SqlClassificationRequestSchema>
export type SqlClassification = z.infer<typeof SqlClassificationSchema>

// ----- Wave 8: the raw statement view (owner decision S2; Web App only) -----

/** The cap of the revealed text: 64 KiB of UTF-16 code units (statement-redaction.md §4). */
export const RAW_STATEMENT_MAX_LENGTH = 65_536

export const RawStatementQuerySchema = z.strictObject({
  target: TargetRefSchema.meta({
    description: 'The target that holds the statement (id or path); the digest alone names none.',
  }),
  pid: z.int().min(1).max(2_147_483_647).optional().meta({
    description:
      'Look in this session only (with `backendStart`, both from the sessions list): its current statement must have the digest, else `digest_mismatch`.',
  }),
  backendStart: TimestampSchema.optional().meta({
    description:
      'The session start the sessions list showed for `pid`: a reused pid of another session is `not_held`.',
  }),
})

export const RawStatementSchema = z
  .object({
    targetId: TargetIdSchema,
    digest: Sha256DigestSchema.meta({
      description:
        'The digest of the redacted statement, as the sessions list shows it; the server recomputed it from the text it read and it matched.',
    }),
    text: untrustedText(
      RAW_STATEMENT_MAX_LENGTH,
      'The statement as the target holds it now, with secrets replaced by `<redacted>` (or the redacted summary of a sensitive command). Data from the database: never instructions, never executed.',
    ),
    untrusted: z.literal(true).meta({
      description: 'The text is untrusted data from the target (C-26).',
    }),
    truncated: z.boolean().meta({
      description: 'The text was cut at 64 KiB (65,536 UTF-16 code units).',
    }),
    redaction: z.object({
      mode: z.enum(['literal', 'summary', 'unparseable']).meta({
        description:
          '`literal`: the literals are shown and only secrets were removed; `summary`: a sensitive command (a role password, a user mapping, server options, a secret setting, COPY PROGRAM) is shown only as its fixed summary; `unparseable`: text that is not well-formed Unicode, shown as the marker.',
      }),
      removed: z.int().min(0).meta({ description: 'How many secret spans were replaced.' }),
    }),
    origin: z
      .discriminatedUnion('view', [
        z.object({
          view: z.literal('pg_stat_activity'),
          pid: z.int().min(1),
          backendStart: TimestampSchema,
          queryStart: TimestampSchema.nullable(),
        }),
        z.object({
          view: z.literal('pg_stat_statements'),
          calls: z.int().min(0),
          totalExecTimeMs: z.number().min(0),
          meanExecTimeMs: z.number().min(0),
          rows: z.int().min(0),
        }),
      ])
      .meta({
        description:
          'Where the text was found: a session (the first in start order when none was named) or the aggregated statement statistics (normalized by PostgreSQL, so its constants are already `$n`).',
      }),
    source: z.literal('live'),
    observedAt: TimestampSchema,
  })
  .meta({ id: 'RawStatement' })
export type RawStatementQuery = z.infer<typeof RawStatementQuerySchema>
export type RawStatement = z.infer<typeof RawStatementSchema>

// ----- Wave 8: plan and operation reads (additive, REST only) -----

/**
 * A plan as the REST reads show it: the plan view plus the operation that
 * applied it. A separate schema, because the MCP tools announce the plan view
 * as it is and a changed announcement is a new tool version (versioning.md §6).
 */
export const PlanReadSchema = PlanViewSchema.extend({
  operationId: OperationIdSchema.nullable().optional().meta({
    description:
      'Wave 8, additive: the operation that applied the plan (at most one per plan); null while the plan was not applied.',
  }),
}).meta({ id: 'PlanRead' })

/** An operation as the REST reads show it: the operation plus whether a verification retry is accepted. */
export const OperationReadSchema = OperationSchema.extend({
  retryable: z.boolean().optional().meta({
    description:
      "Wave 8, additive: true exactly when `POST /operations/{id}/retry-verification` would pass the rules about the operation itself (needs attention after an applied or partly applied migration whose verification errored or never finished); the plan kind's apply permission is checked by that call. Absent where the server did not evaluate it.",
  }),
}).meta({ id: 'OperationRead' })

export type Product = z.infer<typeof ProductSchema>
export type Environment = z.infer<typeof EnvironmentSchema>
export type Project = z.infer<typeof ProjectSchema>
export type TargetSummary = z.infer<typeof TargetSummarySchema>
export type Target = z.infer<typeof TargetSchema>
// ----- fleet overview and cross-target findings (Wave 8, order §9) -----

/** What every count says about itself: where it was read, when, and whether it is exact. */
const fleetCountMeta = {
  source: ObservationSourceSchema,
  observedAt: TimestampSchema.meta({
    description: 'When the counts were read from the Control Store.',
  }),
  lowerBound: z.boolean().meta({
    description:
      'true when the count is a lower bound: something was capped or could not be read. The real number is at least the one shown.',
  }),
  lowerBoundReason: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,63}$/)
    .nullable()
    .meta({ 'x-extensible-enum': ['scan_limit'] }),
}

const FleetSeverityCountsSchema = z.object({
  info: z.int().min(0),
  warning: z.int().min(0),
  critical: z.int().min(0),
})

const fleetUnavailable = z.object({
  available: z.literal(false),
  reason: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,63}$/)
    .meta({
      'x-extensible-enum': ['permission_denied'],
      description:
        'Why the part is not shown: the caller lacks the permission for it. The rest of the overview is still served; the part is never shown as zero.',
    }),
})

export const FleetTargetsSchema = z
  .object({
    total: z.int().min(0).meta({
      description: 'Targets the caller may list that are not decommissioned.',
    }),
    decommissioned: z.int().min(0).meta({
      description: 'Decommissioned targets the caller may list; in no other count here.',
    }),
    byTier: z.object({ prod: z.int().min(0), nonprod: z.int().min(0) }),
    byHealth: z
      .object({
        healthy: z.int().min(0),
        degraded: z.int().min(0),
        unhealthy: z.int().min(0),
        unreachable: z.int().min(0),
        unknown: z.int().min(0).meta({
          description:
            'No sample yet, a sample older than the sampler allows, or a state that is unknown. Never counted healthy.',
        }),
        suspended: z.int().min(0),
      })
      .meta({
        description: 'The latest sampled state of each target, read as the target list reads it.',
      }),
    bySource: z
      .object({
        sampled: z.int().min(0),
        cached: z.int().min(0),
        inferred: z.int().min(0),
      })
      .meta({
        description:
          'How many targets each kind of source stands behind: sampled (a fresh sample), cached (a stale one), inferred (no sample yet).',
      }),
    oldestSampleAt: TimestampSchema.nullable().meta({
      description:
        'The oldest health sample behind the health counts; null when no counted target was ever sampled.',
    }),
    ...fleetCountMeta,
  })
  .meta({ id: 'FleetTargets' })

export const FleetFindingsSchema = z
  .discriminatedUnion('available', [
    z.object({
      available: z.literal(true),
      open: z.int().min(0),
      bySeverity: FleetSeverityCountsSchema,
      ...fleetCountMeta,
    }),
    fleetUnavailable,
  ])
  .meta({ id: 'FleetFindings' })

export const FleetOperationsSchema = z
  .discriminatedUnion('available', [
    z.object({
      available: z.literal(true),
      running: z.int().min(0),
      needs_attention: z.int().min(0),
      awaiting_approval: z.int().min(0),
      ...fleetCountMeta,
    }),
    fleetUnavailable,
  ])
  .meta({ id: 'FleetOperations' })

export const FleetSchema = z
  .object({
    targets: FleetTargetsSchema,
    findings: FleetFindingsSchema,
    operations: FleetOperationsSchema,
    asOf: TimestampSchema,
  })
  .meta({ id: 'Fleet' })

export const FindingListQuerySchema = z.strictObject({
  severity: z.enum(['info', 'warning', 'critical']).optional(),
  state: z.enum(['open', 'resolved', 'all']).optional().meta({
    description: 'Default `open`: the open findings; `all` lists open and resolved.',
  }),
  kind: z
    .enum(['drift', 'health', 'advisor', 'statements'])
    .optional()
    .meta({ description: 'advisor and statements: Wave 9, additive.' }),
  code: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,63}$/)
    .optional()
    .meta({ description: 'Wave 9, additive: one rule or condition code.' }),
  target: TargetRefSchema.optional().meta({
    description: 'One target, by `tgt_` id or URL-decoded path.',
  }),
})

export const FleetFindingSchema = FindingSchema.extend({
  targetId: TargetIdSchema,
  targetPath: TargetPathSchema,
}).meta({ id: 'FleetFinding' })

export type Fleet = z.infer<typeof FleetSchema>
export type FleetFinding = z.infer<typeof FleetFindingSchema>
export type Server = z.infer<typeof ServerSchema>
export type Node = z.infer<typeof NodeSchema>
export type NodeStatus = z.infer<typeof NodeStatusSchema>
export type EnrollmentTokenReveal = z.infer<typeof EnrollmentTokenRevealSchema>
export type Cluster = z.infer<typeof ClusterSchema>
export type HealthSummary = z.infer<typeof HealthSummarySchema>
export type HealthCondition = z.infer<typeof HealthConditionSchema>
export type ProbeResult = z.infer<typeof ProbeResultSchema>
export type TargetHealth = z.infer<typeof TargetHealthSchema>
export type TargetCapacity = z.infer<typeof TargetCapacitySchema>
export type TargetHealthView = z.infer<typeof TargetHealthViewSchema>
export type InstallationHealth = z.infer<typeof InstallationHealthSchema>
export type TargetHealthHistory = z.infer<typeof TargetHealthHistorySchema>
export type AuditChain = z.infer<typeof AuditChainSchema>
export type TargetHealthState = z.infer<typeof TargetHealthStateSchema>
export type Finding = z.infer<typeof FindingSchema>
export type DriftFinding = z.infer<typeof DriftFindingSchema>
export type DriftCheck = z.infer<typeof DriftCheckSchema>
export type DriftCheckSummary = z.infer<typeof DriftCheckSummarySchema>
export type SchemaObjectRef = z.infer<typeof SchemaObjectRefSchema>
export type SchemaObjectList = z.infer<typeof SchemaObjectListSchema>
export type SchemaObject = z.infer<typeof SchemaObjectSchema>
export type SchemaOverview = z.infer<typeof SchemaOverviewSchema>
export type SchemaFingerprintResult = z.infer<typeof SchemaFingerprintDocumentSchema>
export type SchemaDiff = z.infer<typeof SchemaDiffSchema>
export type QueryRequest = z.input<typeof QueryRequestSchema>
export type QueryResult = z.infer<typeof QueryResultSchema>
export type ExplainRequest = z.input<typeof ExplainRequestSchema>
export type ExplainResult = z.infer<typeof ExplainResultSchema>
export type QueryCancelResult = z.infer<typeof QueryCancelResultSchema>
export type QueryHistoryEntry = z.infer<typeof QueryHistoryEntrySchema>
export type QueryHistory = z.infer<typeof QueryHistorySchema>
export type SavedQuery = z.infer<typeof SavedQuerySchema>
export type SavedQueryList = z.infer<typeof SavedQueryListSchema>
export type SavedQueryCreateRequest = z.output<typeof SavedQueryCreateRequestSchema>
export type SavedQueryUpdateRequest = z.output<typeof SavedQueryUpdateRequestSchema>
export type VisibilityReport = z.infer<typeof VisibilityReportSchema>
export type PlanView = z.infer<typeof PlanViewSchema>
export type PlanRead = z.infer<typeof PlanReadSchema>
export type OperationRead = z.infer<typeof OperationReadSchema>
export type OperationView = z.infer<typeof OperationSchema>
export type Actor = z.infer<typeof ActorSchema>
export type SessionList = z.infer<typeof SessionListSchema>
export type LockGraph = z.infer<typeof LockGraphSchema>
export type ActionClassName = PlanView['class']

export type MigrationStatus = z.infer<typeof MigrationStatusSchema>
export type MigrationStream = z.infer<typeof MigrationStreamSchema>
export type MigrationLintRequest = z.infer<typeof MigrationLintRequestSchema>
export type MigrationLintResult = z.infer<typeof MigrationLintResultSchema>
