import * as z from 'zod'
import { ActionClassSchema, ActionIdSchema } from '../actions.ts'
import {
  ApplyChecksumSchema,
  AuditEventIdSchema,
  BackupIdSchema,
  ClusterIdSchema,
  EnvironmentIdSchema,
  FindingIdSchema,
  GrantIdSchema,
  IdentityIdSchema,
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
  SchemaFingerprintSchema,
  ServerIdSchema,
  SessionIdSchema,
  Sha256DigestSchema,
  SlugSchema,
  TargetIdSchema,
  TargetPathSchema,
  TierSchema,
  TimestampSchema,
  untrustedText,
} from '../common.ts'
import { BaselineRefSchema, BundleSubmissionSchema } from '../manifest/index.ts'

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
  })
  .meta({ id: 'Environment' })

export const ProjectSchema = z
  .object({
    id: ProjectIdSchema,
    productId: ProductIdSchema,
    slug: SlugSchema,
    path: z.string().regex(/^[a-z][a-z0-9-]{0,38}\/[a-z][a-z0-9-]{0,38}$/),
    displayName: name(128, 'Display name.'),
    evidenceOverride: z
      .enum(['none'])
      .nullable()
      .meta({ description: 'Explicit, audited opt-out of the evidence chain (I-9).' }),
  })
  .meta({ id: 'Project' })

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
  ])
  .meta({ id: 'NodeHealthState' })
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
    observedAt: TimestampSchema,
  })
  .meta({ id: 'ProbeResult' })

export const TargetHealthSchema = z
  .object({
    targetId: TargetIdSchema,
    state: TargetHealthStateSchema,
    source: ObservationSourceSchema,
    observedAt: TimestampSchema,
    conditions: z.array(HealthConditionSchema),
    unknownBecause: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,63}$/)
      .nullable()
      .meta({
        'x-extensible-enum': ['control_plane_degraded', 'never_sampled', 'sampler_lagging'],
        description: 'Set when state is unknown.',
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

export const TargetStateSchema = z
  .enum(['registered', 'active', 'suspended', 'decommissioned'])
  .meta({ id: 'TargetState' })

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
    targetId: TargetIdSchema,
    checkedAt: TimestampSchema,
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
  })
  .meta({ id: 'SchemaObjectRef' })

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
  })
  .meta({ id: 'QueryRequest' })

export const QueryResultSchema = z
  .object({
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

export const ExplainRequestSchema = z
  .strictObject({
    sql: untrustedText(100_000, 'Exactly one read-only statement.').min(1),
    params: z.array(QueryParamSchema).max(100).default([]),
    analyze: z.boolean().default(false),
  })
  .meta({ id: 'ExplainRequest' })

export const ExplainResultSchema = z
  .object({
    plan: JsonValueSchema.meta({
      untrusted: true,
      description: 'EXPLAIN (FORMAT JSON) output, redacted.',
    }),
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
    source: ObservationSourceSchema,
    observedAt: TimestampSchema,
  })
  .meta({ id: 'MigrationStatus' })

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
  .strictObject({ bundles: z.array(BundleSubmissionSchema).min(1).max(50) })
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

export const ActorSchema = z
  .object({
    identityId: IdentityIdSchema,
    kind: z.enum(['human', 'service']),
    via: z.enum(['web', 'rest', 'mcp', 'cli']),
  })
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

export const InstallationHealthSchema = z
  .object({
    state: ControlPlaneHealthStateSchema,
    components: z.array(
      z.object({
        component: z
          .string()
          .regex(/^[a-z][a-z0-9_]{0,63}$/)
          .meta({
            'x-extensible-enum': ['control_store', 'workers', 'samplers', 'gateway', 'keyring'],
          }),
        state: ControlPlaneHealthStateSchema,
        source: ObservationSourceSchema,
        observedAt: TimestampSchema,
      }),
    ),
  })
  .meta({
    id: 'InstallationHealth',
    description: 'Control Plane health; distinct from target health (C-29).',
  })
