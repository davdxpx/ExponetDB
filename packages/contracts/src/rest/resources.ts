import * as z from 'zod'
import { ActionClassSchema, ActionIdSchema } from '../actions.ts'
import {
  ApplyChecksumSchema,
  AuditEventIdSchema,
  BackupIdSchema,
  ClusterIdSchema,
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
import { MigrationProgressSchema } from './migrations.ts'

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

// ----- migrations -----

export const VerificationStatusSchema = z
  .enum(['pending', 'passed', 'failed', 'partial', 'error'])
  .meta({ id: 'VerificationStatus' })

export const LedgerEntrySchema = z
  .object({
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
    verification: z.object({
      status: VerificationStatusSchema,
      verifiedAt: TimestampSchema.nullable(),
      verifyDigest: ApplyChecksumSchema.nullable(),
    }),
  })
  .meta({ id: 'LedgerEntry' })

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
      }),
    ),
    truncated: z.boolean(),
    source: ObservationSourceSchema,
    observedAt: TimestampSchema,
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
      }),
    ),
    truncated: z.boolean(),
    source: ObservationSourceSchema,
    observedAt: TimestampSchema,
  })
  .meta({ id: 'TableStats' })

export const AdvisorRunRequestSchema = z
  .strictObject({
    categories: z
      .array(z.enum(['security', 'performance']))
      .min(1)
      .max(2)
      .default(['security', 'performance']),
  })
  .meta({ id: 'AdvisorRunRequest' })

export const AdvisorRunSchema = z
  .object({
    targetId: TargetIdSchema,
    ranAt: TimestampSchema,
    findings: z.array(
      z.object({
        rule: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
        category: z.enum(['security', 'performance']),
        level: z.enum(['info', 'warning', 'critical']),
        object: name(512, 'Affected object.').nullable(),
        message: z.string().max(1024),
        remediation: z.string().max(2048),
      }),
    ),
  })
  .meta({ id: 'AdvisorRun' })

// ----- infrastructure -----

export const ServerSchema = z
  .object({
    id: ServerIdSchema,
    displayName: name(128, 'Mutable label; nothing binds to it.'),
    provider: z.enum(['hetzner_cloud', 'hetzner_robot', 'other', 'unknown']),
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
    health: HealthSummarySchema.nullable(),
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

export const BackupSchema = z
  .object({
    id: BackupIdSchema,
    kind: z.enum(['full', 'differential', 'incremental', 'logical']),
    state: z.enum(['running', 'succeeded', 'failed']),
    startedAt: TimestampSchema,
    finishedAt: TimestampSchema.nullable(),
    sizeBytes: z.int().min(0).nullable(),
    verification: z.object({
      state: z.enum(['pending', 'passed', 'failed']),
      verifiedAt: TimestampSchema.nullable(),
    }),
  })
  .meta({ id: 'Backup' })

export const BackupCatalogSchema = z
  .object({
    clusterId: ClusterIdSchema,
    state: BackupHealthStateSchema,
    backups: z.array(BackupSchema),
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
  })
  .meta({ id: 'Installation' })
export type Installation = z.infer<typeof InstallationSchema>

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

export const SqlClassificationRequestSchema = z
  .strictObject({
    sql: z
      .string()
      .min(1)
      .max(SQL_CLASSIFY_MAX_BYTES)
      .refine((v) => new TextEncoder().encode(v).length <= SQL_CLASSIFY_MAX_BYTES, {
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
  kind: z.enum(['drift', 'health']).optional(),
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
export type InstallationHealth = z.infer<typeof InstallationHealthSchema>
export type TargetHealthHistory = z.infer<typeof TargetHealthHistorySchema>
export type AuditChain = z.infer<typeof AuditChainSchema>
export type TargetHealthState = z.infer<typeof TargetHealthStateSchema>
export type Finding = z.infer<typeof FindingSchema>
export type DriftFinding = z.infer<typeof DriftFindingSchema>
export type DriftCheck = z.infer<typeof DriftCheckSchema>
export type SchemaObjectRef = z.infer<typeof SchemaObjectRefSchema>
export type SchemaObject = z.infer<typeof SchemaObjectSchema>
export type SchemaOverview = z.infer<typeof SchemaOverviewSchema>
export type SchemaFingerprintResult = z.infer<typeof SchemaFingerprintDocumentSchema>
export type SchemaDiff = z.infer<typeof SchemaDiffSchema>
export type QueryRequest = z.input<typeof QueryRequestSchema>
export type QueryResult = z.infer<typeof QueryResultSchema>
export type ExplainRequest = z.input<typeof ExplainRequestSchema>
export type ExplainResult = z.infer<typeof ExplainResultSchema>
export type QueryCancelResult = z.infer<typeof QueryCancelResultSchema>
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
