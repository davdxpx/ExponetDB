import * as z from 'zod'
import {
  ApplyChecksumSchema,
  BreakGlassGrantIdSchema,
  CursorSchema,
  IdentityIdSchema,
  ImportReportIdSchema,
  LedgerStateHashSchema,
  limitSchema,
  MigrationIdSchema,
  OperationIdSchema,
  PlanIdSchema,
  ProjectIdSchema,
  SchemaFingerprintSchema,
  Sha256DigestSchema,
  StepUpIdSchema,
  TargetIdSchema,
  TargetPathSchema,
  TargetRefSchema,
  TierSchema,
  TimestampSchema,
  untrustedText,
  VerificationRunIdSchema,
} from '../common.ts'
import { BUNDLE_FILE_NAMES, BundleSubmissionSchema } from '../manifest/bundle.ts'
import {
  BaselineRefSchema,
  CompatibilityClassSchema,
  MigrationNameSchema,
  RollbackSafetySchema,
} from '../manifest/migration.ts'
import {
  ProjectDefaultsSchema,
  ProjectInvariantsSchema,
  ProjectLintSchema,
} from '../manifest/project.ts'

/**
 * The migration engine's wire shapes (Wave 6;
 * [planning-and-apply.md](../../../../exponetdb-docs/04-migrations/planning-and-apply.md),
 * [verification.md](../../../../exponetdb-docs/04-migrations/verification.md),
 * [authoring-and-ci.md §1](../../../../exponetdb-docs/04-migrations/authoring-and-ci.md#1-source-reference-model)).
 * Bundle text is untrusted input (C-26): it is stored and shown, never
 * interpreted outside the engine's parser.
 */

// ----- limits -----

/**
 * Request body limits of the routes that carry bundle text inline, in bytes
 * of the JSON body, enforced while the body arrives (before parsing). One
 * bundle of maximal files fits; many small bundles fit; a submission larger
 * than the limit is split by the client (the CLI ingests in batches).
 */
export const MIGRATION_BODY_LIMIT_BYTES = 32 * 1024 * 1024
/** Bundles per request and migration ids per plan request. */
export const MIGRATION_REQUEST_LIMITS = { bundles: 50, migrationIds: 200 } as const

// ----- source references (claimed only, OD-6 (a)) -----

/**
 * Where a bundle came from, as its submitter says. Stored as a claim
 * (`provenance: claimed`): ExponetDB never fetches the repository, never
 * resolves a branch or tag and never holds repository credentials. A commit
 * is a full Git object id; a branch name, a tag or a short id is not a
 * commit and is refused.
 */
export const SourceClaimSchema = z
  .strictObject({
    repository: z
      .string()
      .max(200)
      .regex(/^[a-z0-9][a-z0-9.-]{0,99}(\/[A-Za-z0-9._-]{1,100}){1,4}$/)
      .meta({
        description:
          'Repository as host and path, e.g. github.com/owner/repo (no scheme, no credentials).',
      }),
    commit: z
      .string()
      .regex(/^([0-9a-f]{40}|[0-9a-f]{64})$/)
      .meta({ description: 'Full Git object id (SHA-1 or SHA-256), never a branch or tag.' }),
    path: z
      .string()
      .max(400)
      .regex(/^[A-Za-z0-9._\-/]{1,400}$/)
      .refine(
        (p) =>
          !p.startsWith('/') &&
          p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..'),
        { message: 'A relative path without empty, "." or ".." segments.' },
      )
      .meta({ description: 'Bundle directory relative to the repository root.' }),
  })
  .meta({ id: 'MigrationSourceClaim' })

export const SourceReferenceSchema = SourceClaimSchema.extend({
  provenance: z.literal('claimed'),
}).meta({ id: 'MigrationSourceReference' })

// ----- bundle store -----

/**
 * The `defaults` block of the project file. The apply checksum materializes
 * them (c1), so the server hashes with exactly these values and stores them
 * with each revision; an execution role alias resolves only through the
 * registry's map of the project, never through a client's declaration.
 */
const ProjectDefaultsMember = ProjectDefaultsSchema.optional().meta({
  description:
    'The defaults block of exponetdb.project.yaml (lockTimeout, statementTimeout, role alias, searchPath); part of the apply checksum.',
})

export const BundleIngestRequestSchema = z
  .strictObject({
    bundles: z.array(BundleSubmissionSchema).min(1).max(MIGRATION_REQUEST_LIMITS.bundles),
    defaults: ProjectDefaultsMember,
    source: SourceClaimSchema.optional(),
  })
  .meta({ id: 'MigrationBundleIngestRequest' })

export const BundleFileDigestSchema = z.object({
  bytes: z.int().min(0),
  digest: Sha256DigestSchema.meta({ description: 'SHA-256 of the exact bytes as stored.' }),
})

export const BundleRevisionSchema = z
  .object({
    revision: z.int().min(1),
    verifyDigest: ApplyChecksumSchema.nullable(),
    rollbackDigest: ApplyChecksumSchema.nullable(),
    sourceDigest: Sha256DigestSchema,
    bundleDigest: ApplyChecksumSchema,
    files: z.partialRecord(z.enum(BUNDLE_FILE_NAMES), BundleFileDigestSchema),
    source: SourceReferenceSchema.nullable(),
    ingestedAt: TimestampSchema,
  })
  .meta({ id: 'MigrationBundleRevision' })

export const BundleIngestResultSchema = z
  .object({
    items: z.array(
      z.object({
        migrationId: MigrationIdSchema,
        name: MigrationNameSchema,
        checksum: ApplyChecksumSchema,
        revision: z.int().min(1),
        status: z.enum(['stored', 'unchanged', 'verify_revision', 'rewritten_unapplied']).meta({
          description:
            'stored: first ingestion; unchanged: the same bytes again; verify_revision: same apply checksum, new verify, rollback or comment bytes; rewritten_unapplied: a new apply checksum for an id never applied anywhere (the earlier content stays stored for audit).',
        }),
      }),
    ),
  })
  .meta({ id: 'MigrationBundleIngestResult' })

export const BundleViewSchema = z
  .object({
    projectId: ProjectIdSchema,
    migrationId: MigrationIdSchema,
    name: MigrationNameSchema,
    checksum: ApplyChecksumSchema,
    transactional: z.boolean(),
    dependsOn: z.array(z.union([MigrationIdSchema, BaselineRefSchema])),
    revisions: z.array(BundleRevisionSchema),
    superseded: z
      .array(z.object({ checksum: ApplyChecksumSchema, ingestedAt: TimestampSchema }))
      .meta({ description: 'Earlier apply checksums of this id that were never applied.' }),
  })
  .meta({ id: 'MigrationBundle' })

export const BundleFileSchema = z
  .object({
    migrationId: MigrationIdSchema,
    revision: z.int().min(1),
    file: z.enum(BUNDLE_FILE_NAMES),
    text: z.string().meta({ untrusted: true, description: 'Exact stored text (UTF-8).' }),
    bytes: z.int().min(0),
    digest: Sha256DigestSchema,
  })
  .meta({ id: 'MigrationBundleFile' })

// ----- planning -----

export const MigrationPlanRequestSchema = z
  .strictObject({
    bundles: z.array(BundleSubmissionSchema).max(MIGRATION_REQUEST_LIMITS.bundles).optional(),
    defaults: ProjectDefaultsMember,
    migrationIds: z.array(MigrationIdSchema).max(MIGRATION_REQUEST_LIMITS.migrationIds).optional(),
    source: SourceClaimSchema.optional(),
    lintProfile: z.enum(['strict', 'standard']).optional().meta({
      description: "The project file's lint profile (default strict).",
    }),
    lint: ProjectLintSchema.optional().meta({
      description:
        "The project file's lint block. Rules the engine enforces cannot be lowered; every lowered rule is shown in the plan.",
    }),
    invariants: ProjectInvariantsSchema.optional(),
    lockWaitSeconds: z.int().min(1).max(600).optional().meta({
      description:
        'How long the executor tries to take the target schema lock (default 30 s, at most 10 minutes).',
    }),
    breakGlassGrantId: BreakGlassGrantIdSchema.optional().meta({
      description:
        "Plan under the caller's own active break-glass grant on this target: the rules it names are overridden (shown in the plan) where they allow it; nothing else is.",
    }),
  })
  .refine((r) => (r.bundles?.length ?? 0) > 0 || (r.migrationIds?.length ?? 0) > 0, {
    message: 'Name bundles or migration ids to plan.',
  })
  .meta({ id: 'MigrationPlanRequest' })

export const LockSeveritySchema = z.enum(['none', 'low', 'medium', 'high', 'critical', 'unknown'])

/** An observed class: the declared classes, or `unknown` when no rule classifies a statement (never made additive). */
export const ObservedCompatibilitySchema = z.enum([
  'additive',
  'potentially_breaking',
  'data_rewrite',
  'destructive',
  'unknown',
])

export const StatementAnalysisSchema = z.object({
  index: z.int().min(0),
  line: z.int().min(1),
  kind: z.string().max(64),
  transactional: z.boolean(),
  compatibility: ObservedCompatibilitySchema,
  lock: z
    .object({
      mode: z.string().max(40),
      severity: LockSeveritySchema,
      objects: z.array(z.string().max(300)),
    })
    .nullable(),
  rewrite: z.enum(['none', 'table', 'possible', 'unknown']),
  coverage: z.enum(['derived', 'partly_derived', 'underived']),
  conditional: z.boolean(),
})

/**
 * Set on a lint finding only when `verify.sql` admission refused the file
 * (verification.md §4.2): `MIGRATION_STATEMENT_FORBIDDEN` for a statement form
 * (anything but a SELECT check, `SELECT … INTO`, a locking clause, a
 * data-modifying CTE), `VERIFY_CONSTRUCT_UNSUPPORTED` for any other construct
 * it cannot classify. Absent on every other finding.
 */
export const LintCodeSchema = z.enum([
  'MIGRATION_STATEMENT_FORBIDDEN',
  'VERIFY_CONSTRUCT_UNSUPPORTED',
])

export const LintEntrySchema = z.object({
  rule: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  level: z.enum(['error', 'warn', 'info']),
  blocking: z.boolean(),
  message: z.string().max(1024),
  file: z.enum(BUNDLE_FILE_NAMES).nullable(),
  statementIndex: z.int().min(0).nullable(),
  line: z.int().min(1).nullable(),
  remediation: z.string().max(512).nullable(),
  code: LintCodeSchema.optional(),
})

export const VerifyCheckAdmissionSchema = z.object({
  index: z.int().min(0),
  name: z.string().max(128),
  class: z.enum(['builtin', 'consumer_code']),
  covers: z.array(z.string().max(128)),
  consumer: z
    .object({
      kind: z.enum(['function', 'view']),
      identity: z.string().max(400),
      definitionDigest: Sha256DigestSchema,
      securityDefiner: z.boolean(),
    })
    .nullable(),
})

export const MigrationAnalysisSchema = z.object({
  migrationId: MigrationIdSchema,
  statements: z.array(StatementAnalysisSchema),
  compatibility: z.object({
    declared: CompatibilityClassSchema,
    observed: ObservedCompatibilitySchema,
    agreement: z.boolean(),
  }),
  destructive: z.array(z.string().max(300)),
  lockSeverity: LockSeveritySchema,
  rewriteRisk: z.array(
    z.object({
      relation: z.string().max(300),
      bytes: z.int().min(0).nullable(),
      rows: z.int().min(0).nullable(),
      estimate: z.literal(true),
    }),
  ),
  rollback: z.object({ available: z.boolean(), declaredSafety: RollbackSafetySchema.nullable() }),
  conditionalDdl: z.boolean(),
  structuralExpectations: z.int().min(0),
  underivedStatements: z.int().min(0),
  verify: z.object({
    present: z.boolean(),
    checks: z.array(VerifyCheckAdmissionSchema),
  }),
  lint: z.array(LintEntrySchema),
})

export const MigrationPlanItemSchema = z.object({
  migrationId: MigrationIdSchema,
  name: MigrationNameSchema,
  revision: z.int().min(1),
  checksum: ApplyChecksumSchema,
  verifyDigest: ApplyChecksumSchema.nullable(),
  rollbackDigest: ApplyChecksumSchema.nullable(),
  sourceDigest: Sha256DigestSchema,
  bundleDigest: ApplyChecksumSchema,
  transactional: z.boolean(),
  executionRole: z.string().max(63),
  searchPath: z.array(z.string().max(63)),
  lockTimeoutMs: z.int().min(1),
  statementTimeoutMs: z.int().min(1),
  dependsOn: z.array(z.union([MigrationIdSchema, BaselineRefSchema])),
  source: SourceReferenceSchema.nullable(),
  verifyChecks: z.int().min(0).meta({ description: 'Admitted verify.sql checks.' }),
  consumerCode: z
    .array(
      z.object({
        check: z.int().min(0),
        kind: z.enum(['function', 'view']),
        declared: z.string().max(300).meta({ untrusted: true }),
        oid: z.string().regex(/^[0-9]{1,10}$/),
        owner: z.string().max(63).meta({ untrusted: true }),
        digest: Sha256DigestSchema,
      }),
    )
    .meta({
      description:
        'Declared consumer functions and views of verify.sql with the identity and definition digest the plan binds.',
    }),
})

export const EvidenceItemSchema = z.object({
  migrationId: MigrationIdSchema,
  status: z.enum(['present', 'missing', 'unverified', 'other_verify_digest', 'unreachable']),
  evidenceTargetId: TargetIdSchema.nullable(),
  verificationId: VerificationRunIdSchema.nullable(),
  verifiedAt: TimestampSchema.nullable(),
  generation: z.int().min(1).nullable(),
  lineage: z.enum(['match', 'mismatch', 'unknown']).nullable(),
})

/** `change.content` of a `migration.apply` plan (the plan view carries it as JSON). */
/**
 * What a `migration.resume` plan binds besides the apply content
 * ([failure-and-recovery.md §2](../../../../exponetdb-docs/04-migrations/failure-and-recovery.md#2-non-transactional-migrations)):
 * the event log since the start, the first statement it runs, the catalog
 * readback of the first unfinished statement and an optional cleanup of an
 * INVALID concurrent index.
 */
export const MigrationResumeBindingSchema = z
  .object({
    originalOperationId: OperationIdSchema,
    startedSeq: z.string().regex(/^[0-9]{1,20}$/),
    eventLogDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    nextStatement: z.int().min(0),
    fromStatement: z.int().min(0),
    statements: z.int().min(1),
    readback: z.enum([
      'all_done',
      'failed_without_effect',
      'absent',
      'present',
      'invalid_index',
      'ambiguous',
      'unreadable',
    ]),
    cleanup: z
      .object({
        indexOid: z.string().regex(/^[0-9]{1,10}$/),
        schema: z.string().max(63),
        name: z.string().max(63),
      })
      .nullable(),
    fingerprintBeforeMigration: SchemaFingerprintSchema.nullable(),
  })
  .meta({ id: 'MigrationResumeBinding' })

export const MigrationPlanContentSchema = z
  .object({
    projectId: ProjectIdSchema,
    migrations: z.array(MigrationPlanItemSchema).min(1),
    execution: z.object({
      mode: z.enum(['transactional', 'nontransactional']),
      lockWaitSeconds: z.int().min(1).max(600),
      stopOnVerificationFailure: z.literal(true),
    }),
    target: z.object({
      targetId: TargetIdSchema,
      path: z.string().max(120),
      tier: TierSchema,
      generation: z.int().min(1),
      clusterSystemIdentifier: z.string().regex(/^[0-9]{1,20}$/),
      databaseOid: z.string().regex(/^[0-9]{1,10}$/),
      serverVersionNum: z.int().min(160000),
    }),
    expectedState: z.object({
      schemaFingerprint: SchemaFingerprintSchema,
      ledgerStateHash: LedgerStateHashSchema,
      extensions: z.record(z.string().max(63), z.string().max(64)),
      executionRoles: z.record(z.string().max(63), z.string().max(64)),
    }),
    evidence: z
      .object({
        targetId: TargetIdSchema,
        generation: z.int().min(1),
        verifications: z.record(MigrationIdSchema, VerificationRunIdSchema),
      })
      .nullable()
      .meta({
        description:
          'The evidence the plan bound (production): the evidence target, its generation and the passed verification per migration; read again at acceptance.',
      }),
    facts: z
      .object({
        compatibility: ObservedCompatibilitySchema,
        lockSeverity: LockSeveritySchema,
        nontransactional: z.boolean(),
        blockingFindings: z.int().min(0),
        consumerCode: z.int().min(0),
        requirementsUnmet: z.array(z.enum(['postgres', 'extensions', 'execution_role'])),
        evidence: z.enum([
          'present',
          'missing',
          'unverified',
          'other_verify_digest',
          'unreachable',
          'not_required',
        ]),
        lineage: z.enum(['match', 'mismatch', 'unknown', 'not_required']),
        dependenciesVerified: z.boolean(),
        legacyProject: z.boolean(),
      })
      .meta({ description: 'What the policy rules decide on (policy-engine.md §4, Migrations).' }),
    resume: MigrationResumeBindingSchema.optional().meta({
      description: 'Present on a migration.resume plan only.',
    }),
    breakGlass: z
      .object({
        grantId: BreakGlassGrantIdSchema,
        rules: z.array(z.string().max(128)).min(1).max(32),
      })
      .optional()
      .meta({
        description:
          'The break-glass grant the plan was made under and the rules it names; acceptance uses the grant once more.',
      }),
  })
  .meta({ id: 'MigrationPlanContent' })

/** `change.analysis` of a `migration.apply` plan. */
export const MigrationPlanAnalysisSchema = z
  .object({
    perMigration: z.array(MigrationAnalysisSchema),
    summary: z.object({
      compatibility: ObservedCompatibilitySchema,
      lockSeverity: LockSeveritySchema,
      destructive: z.boolean(),
      nontransactional: z.boolean(),
      consumerCodeChecks: z.int().min(0),
      blockingLints: z.int().min(0),
    }),
    evidence: z.array(EvidenceItemSchema),
  })
  .meta({ id: 'MigrationPlanAnalysis' })

// ----- status and history -----

export const VerificationLayerSchema = z.object({
  status: z.enum(['passed', 'failed', 'partial', 'error', 'skipped']),
  checks: z.int().min(0),
  failed: z.int().min(0),
  firstFailure: z
    .object({ name: z.string().max(128), detail: z.string().max(200).nullable() })
    .nullable()
    .meta({ untrusted: true }),
})

export const VerificationRunSchema = z
  .object({
    verificationId: VerificationRunIdSchema,
    migrationId: MigrationIdSchema,
    operationId: OperationIdSchema,
    verifyDigest: ApplyChecksumSchema.nullable(),
    status: z.enum(['passed', 'failed', 'partial', 'error']),
    startedAt: TimestampSchema,
    finishedAt: TimestampSchema,
    structural: VerificationLayerSchema,
    runtime: VerificationLayerSchema,
    engine: VerificationLayerSchema,
    fingerprint: SchemaFingerprintSchema,
  })
  .meta({ id: 'MigrationVerificationRun' })

export const MigrationEventSchema = z.object({
  at: TimestampSchema,
  event: z.enum([
    'nontx_started',
    'nontx_statement_done',
    'nontx_failed',
    'applied',
    'reverted',
    'imported',
    'baselined',
    'ledger_reconciled',
  ]),
  operationId: OperationIdSchema.nullable(),
  statementIndex: z.int().min(0).nullable(),
  sqlstate: z
    .string()
    .regex(/^[0-9A-Z]{5}$/)
    .nullable(),
})

export const MigrationDetailSchema = z
  .object({
    targetId: TargetIdSchema,
    migrationId: z.union([MigrationIdSchema, BaselineRefSchema]),
    state: z.enum(['applied', 'reverted', 'pending', 'partially_applied', 'unknown_to_target']),
    checksum: ApplyChecksumSchema.nullable(),
    appliedAt: TimestampSchema.nullable(),
    operationId: OperationIdSchema.nullable(),
    planId: PlanIdSchema.nullable(),
    fingerprintBefore: SchemaFingerprintSchema.nullable(),
    fingerprintAfter: SchemaFingerprintSchema.nullable(),
    events: z.array(MigrationEventSchema),
    verifications: z.array(VerificationRunSchema),
    source: z.enum(['live', 'cached']),
    observedAt: TimestampSchema,
  })
  .meta({ id: 'MigrationDetail' })

/** Per-migration progress of a migration operation (on the operation view). */
export const MigrationProgressSchema = z
  .object({
    migrationId: MigrationIdSchema,
    name: MigrationNameSchema,
    applyOutcome: z.enum(['not_started', 'applied', 'not_applied', 'partially_applied', 'unknown']),
    verificationOutcome: z.enum([
      'not_applicable',
      'pending',
      'passed',
      'failed',
      'partial',
      'error',
    ]),
    statementIndex: z.int().min(0).nullable(),
    sqlstate: z
      .string()
      .regex(/^[0-9A-Z]{5}$/)
      .nullable(),
    errorCode: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{1,63}$/)
      .nullable(),
  })
  .meta({ id: 'MigrationProgress' })

// ----- re-verification, rollback, resume -----

export const MigrationVerifyRequestSchema = z
  .strictObject({
    revision: z.int().min(1).optional().meta({
      description:
        'The bundle revision whose verify.sql runs (default: the newest revision with the applied checksum).',
    }),
  })
  .meta({ id: 'MigrationVerifyRequest' })

export const MigrationRollbackRequestSchema = z
  .strictObject({})
  .meta({ id: 'MigrationRollbackRequest' })

export const MigrationResumeRequestSchema = z
  .strictObject({
    cleanup: z.boolean().optional().meta({
      description:
        'Plan a cleanup of the failed statement’s leftovers (an invalid concurrent index) before continuing.',
    }),
  })
  .meta({ id: 'MigrationResumeRequest' })

// ----- legacy import -----

export const ImportItemStateSchema = z.enum([
  'recorded_present',
  'unrecorded_present',
  'recorded_missing',
  'unrecorded_missing',
  'superseded',
  'not_applicable',
  'ambiguous',
])

/** A legacy file as submitted: its file name (the stem is its identity) and its exact text. */
export const LegacyFileSchema = z
  .strictObject({
    name: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,195}\.sql$/)
      .meta({ description: 'The file name; its stem (without .sql) is the legacy identity.' }),
    text: z.string().max(4 * 1024 * 1024),
  })
  .meta({ id: 'LegacyFile' })

/**
 * `migration.import.analyze` (legacy-import.md §2): plans the replay of the
 * submitted legacy files, in the declared order, on an explicit scratch
 * target (registered, nonprod, same project, empty); the imported target
 * is only read. Hints are curated evidence, never proof by themselves.
 */
export const ImportAnalysisRequestSchema = z
  .strictObject({
    scratchTarget: TargetRefSchema.meta({
      description:
        'A registered, empty nonprod target of the same project the legacy chain is replayed on (it is consumed: an analysis needs it empty).',
    }),
    baseline: z
      .string()
      .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
      .max(64)
      .meta({ description: 'The baseline slug new bundles depend on (baseline:<slug>).' }),
    files: z.array(LegacyFileSchema).min(1).max(1000),
    ledgers: z
      .array(z.enum(['supabase', 'drizzle', 'applied_migrations']))
      .max(3)
      .optional()
      .meta({ description: 'The legacy ledgers to read on the imported target (evidence only).' }),
    aliases: z
      .record(z.string().max(200), z.string().max(200))
      .refine((a) => Object.keys(a).length <= 1000, { message: 'At most 1000 aliases.' })
      .optional()
      .meta({ description: 'Curated: an applied ledger name → the file stem it stands for.' }),
    notApplicable: z
      .array(z.string().max(200))
      .max(1000)
      .optional()
      .meta({ description: 'File stems that belong to another project or target.' }),
    role: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,62}$/)
      .optional()
      .meta({
        description: "The project's execution role alias the replay runs as (default owner).",
      }),
    searchPath: z
      .array(z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/))
      .max(8)
      .optional()
      .meta({ description: 'The search path of the replay (default public).' }),
  })
  .meta({ id: 'ImportAnalysisRequest' })

export const ImportReportSchema = z
  .object({
    id: ImportReportIdSchema,
    targetId: TargetIdSchema,
    projectId: ProjectIdSchema,
    baselineId: BaselineRefSchema,
    state: z.enum(['pending', 'incomplete', 'open', 'resolved', 'baselined', 'superseded']),
    createdAt: TimestampSchema,
    fingerprint: SchemaFingerprintSchema.nullable().meta({
      description:
        "The imported target's fingerprint the analysis compared with (null until it ran).",
    }),
    replayFingerprint: SchemaFingerprintSchema.nullable().optional(),
    scratchTargetId: TargetIdSchema.optional(),
    incompleteReason: z.string().max(200).nullable().optional().meta({
      description:
        'Why the analysis could not finish (a replay error names the file and SQLSTATE).',
    }),
    items: z.array(
      z.object({
        itemId: z.string().regex(/^[0-9]{1,6}$/),
        legacyId: z.string().max(200),
        name: z.string().max(200).meta({ untrusted: true }),
        state: ImportItemStateSchema,
        contentDigest: Sha256DigestSchema.nullable(),
        evidence: z.array(z.string().max(200)).max(16).optional().meta({
          description:
            'The evidence the classification used (ledger hash, statements, alias, expectations held).',
        }),
        decision: z
          .object({
            state: ImportItemStateSchema,
            note: z.string().max(1000).meta({ untrusted: true }),
            decidedAt: TimestampSchema,
          })
          .nullable(),
      }),
    ),
    unresolved: z.int().min(0),
  })
  .meta({ id: 'ImportReport' })

export const ImportDecisionRequestSchema = z
  .strictObject({
    state: ImportItemStateSchema.exclude(['ambiguous']),
    note: z.string().min(1).max(1000),
  })
  .meta({ id: 'ImportDecisionRequest' })

export const BaselinePlanRequestSchema = z
  .strictObject({ importReportId: ImportReportIdSchema })
  .meta({ id: 'BaselinePlanRequest' })

export const LedgerReconcileRequestSchema = z
  .strictObject({
    decision: z.enum(['adopt_target', 'flag_untrusted']),
    note: z.string().min(1).max(1000),
  })
  .meta({ id: 'LedgerReconcileRequest' })

// ----- CLI step-up (ADR-0026) -----

export const StepUpRequestSchema = z
  .strictObject({
    action: z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/),
    planId: PlanIdSchema.optional(),
    tokenId: z
      .string()
      .regex(/^ent_[0-7][0-9A-HJKMNP-TV-Z]{25}$/)
      .optional(),
  })
  .meta({ id: 'StepUpRequest' })

export const StepUpSchema = z
  .object({
    id: StepUpIdSchema,
    action: z.string().max(64),
    state: z.enum(['pending', 'confirmed', 'redeemed', 'expired', 'refused', 'canceled']),
    bindingDigest: Sha256DigestSchema,
    planHash: Sha256DigestSchema.nullable(),
    verificationUri: z.url(),
    userCode: z
      .string()
      .regex(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/)
      .nullable()
      .meta({ description: 'Shown to the CLI that created the step-up only; null elsewhere.' }),
    clientName: z.string().max(100).nullable(),
    expiresAt: TimestampSchema,
    receiptExpiresAt: TimestampSchema.nullable(),
  })
  .meta({ id: 'StepUp' })

export const StepUpConfirmRequestSchema = z
  .strictObject({
    userCode: z
      .string()
      .regex(/^[A-HJ-NP-Za-hj-np-z2-9]{4}-?[A-HJ-NP-Za-hj-np-z2-9]{4}$/)
      .meta({ description: 'The code the CLI shows; case and the dash do not matter.' }),
  })
  .meta({ id: 'StepUpConfirmRequest' })

export type MigrationPlanRequest = z.infer<typeof MigrationPlanRequestSchema>
export type MigrationPlanContent = z.infer<typeof MigrationPlanContentSchema>
export type MigrationPlanAnalysis = z.infer<typeof MigrationPlanAnalysisSchema>
export type MigrationPlanItem = z.infer<typeof MigrationPlanItemSchema>
export type MigrationAnalysis = z.infer<typeof MigrationAnalysisSchema>
export type BundleIngestResult = z.infer<typeof BundleIngestResultSchema>
export type BundleView = z.infer<typeof BundleViewSchema>
export type BundleFile = z.infer<typeof BundleFileSchema>
export type BundleIngestRequest = z.infer<typeof BundleIngestRequestSchema>
export type BundleRevision = z.infer<typeof BundleRevisionSchema>
export type SourceClaim = z.infer<typeof SourceClaimSchema>
export type SourceReference = z.infer<typeof SourceReferenceSchema>
export type MigrationDetail = z.infer<typeof MigrationDetailSchema>
export type VerificationRun = z.infer<typeof VerificationRunSchema>
export type MigrationProgress = z.infer<typeof MigrationProgressSchema>
export type ImportReport = z.infer<typeof ImportReportSchema>
export type StepUpView = z.infer<typeof StepUpSchema>
export type EvidenceItem = z.infer<typeof EvidenceItemSchema>

// ----- break-glass (operations-engine.md §8) -----

const RuleIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)+$/)
  .max(128)

export const BreakGlassActivateRequestSchema = z
  .strictObject({
    rules: z.array(RuleIdSchema).min(1).max(32).meta({
      description: 'The policy rule ids to override; only rules marked overridable by break-glass.',
    }),
    reason: z.string().min(20).max(2000).meta({
      description: 'Why, stored verbatim and shown with every use (at least 20 characters).',
    }),
    durationMinutes: z.int().min(1).max(120).optional().meta({
      description: 'How long the grant lasts (default 30 minutes, at most 2 hours).',
    }),
    maxUses: z.int().min(1).max(100).optional(),
  })
  .meta({ id: 'BreakGlassActivateRequest' })

export const BreakGlassGrantSchema = z
  .object({
    grantId: BreakGlassGrantIdSchema,
    targetId: TargetIdSchema,
    rules: z.array(RuleIdSchema),
    reason: z.string().max(2000),
    createdAt: TimestampSchema,
    expiresAt: TimestampSchema,
    maxUses: z.int().nullable(),
    uses: z.int().min(0),
    revokedAt: TimestampSchema.nullable(),
    reviewedAt: TimestampSchema.nullable(),
    notifications: z.object({
      recorded: z.int().min(0),
      sent: z.int().min(0),
      failed: z.int().min(0),
    }),
  })
  .meta({ id: 'BreakGlassGrant' })

// ----- break-glass list and review (Wave 8, order §9; operations-engine.md §8) -----

/**
 * The state of a grant, derived on each read from its stored columns and
 * the database clock (C-28): `revoked` (a revocation is recorded), else
 * `expired` (its time box has ended), else `used_up` (its maximum of uses is
 * counted), else `active`. The frozen `breakglass` bundle records a grant at
 * its activation, so there is no requested or approved state to show.
 */
export const BREAK_GLASS_GRANT_STATES = ['active', 'expired', 'revoked', 'used_up'] as const
export const BreakGlassGrantStateSchema = z.enum(BREAK_GLASS_GRANT_STATES).meta({
  id: 'BreakGlassGrantState',
  description:
    'Derived from the stored grant and the database clock: revoked, else expired, else used_up, else active.',
})

/** The longest review note in characters (the frozen bundle's CHECK on `review_note`). */
export const BREAK_GLASS_REVIEW_NOTE_MAX = 2000

/**
 * A review note: 1 to 2,000 characters, not blank, no control character
 * except the line feed, no bidirectional override (untrusted text, C-26).
 * It is stored with the grant permanently and cannot be changed or erased:
 * it must not hold personal data.
 */
export const BreakGlassReviewNoteSchema = z
  .string()
  .min(1)
  .max(BREAK_GLASS_REVIEW_NOTE_MAX)
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are refused on purpose
  .regex(/^[^\x00-\x09\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]*$/)
  .refine((v) => v.trim().length > 0, { message: 'The note is blank.' })
  .meta({
    untrusted: true,
    description:
      'The post-incident review: 1 to 2000 characters, no control characters except line feeds. Stored permanently with the grant; it can never be changed or erased, so it must not contain personal data.',
  })

export const BreakGlassReviewRequestSchema = z
  .strictObject({ note: BreakGlassReviewNoteSchema })
  .meta({ id: 'BreakGlassReviewRequest' })

export const BreakGlassGrantListQuerySchema = z.strictObject({
  state: BreakGlassGrantStateSchema.optional(),
  review: z.enum(['open', 'done']).optional().meta({
    description: 'open: not reviewed yet (an open finding); done: reviewed.',
  }),
  target: TargetRefSchema.optional(),
  limit: limitSchema(200, 50).optional(),
  cursor: CursorSchema.optional(),
})

export const BreakGlassGrantRecordSchema = z
  .object({
    grantId: BreakGlassGrantIdSchema,
    target: z.object({ targetId: TargetIdSchema, path: TargetPathSchema, tier: TierSchema }),
    state: BreakGlassGrantStateSchema,
    activatedBy: z.object({ identityId: IdentityIdSchema }).meta({
      description:
        'The person who activated the grant (the only one who may use it); there is no separate requester or approver.',
    }),
    rules: z.array(RuleIdSchema),
    reason: untrustedText(
      2000,
      'Why, as the person wrote it at activation: data, never instructions.',
    ),
    createdAt: TimestampSchema,
    expiresAt: TimestampSchema,
    maxUses: z.int().nullable(),
    uses: z.int().min(0),
    revokedAt: TimestampSchema.nullable(),
    review: z
      .object({
        reviewedBy: z.object({ identityId: IdentityIdSchema }),
        reviewedAt: TimestampSchema,
        note: untrustedText(
          BREAK_GLASS_REVIEW_NOTE_MAX,
          'The review note as written: data, never instructions; permanent.',
        ),
      })
      .nullable()
      .meta({ description: 'The post-incident review, or null while it is an open finding.' }),
  })
  .meta({ id: 'BreakGlassGrantRecord' })

export const BreakGlassGrantListSchema = z
  .object({
    items: z.array(BreakGlassGrantRecordSchema),
    nextCursor: CursorSchema.nullable().meta({
      description: 'Cursor for the next page, null on the last page.',
    }),
    source: z.literal('live'),
    observedAt: TimestampSchema.meta({
      description: 'The database time every state of this page was derived at.',
    }),
  })
  .meta({ id: 'BreakGlassGrantList' })

export type BreakGlassGrantState = z.infer<typeof BreakGlassGrantStateSchema>
export type BreakGlassGrantRecord = z.infer<typeof BreakGlassGrantRecordSchema>
export type BreakGlassGrantList = z.infer<typeof BreakGlassGrantListSchema>
export type BreakGlassReviewRequest = z.infer<typeof BreakGlassReviewRequestSchema>
