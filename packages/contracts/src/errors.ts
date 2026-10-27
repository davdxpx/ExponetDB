import * as z from 'zod'
import {
  ApplyChecksumSchema,
  MigrationIdSchema,
  OperationIdSchema,
  PlanIdSchema,
  RequestIdSchema,
  TargetIdSchema,
  TimestampSchema,
  untrustedText,
} from './common.ts'
import { ScopeSchema } from './scopes.ts'

/** Groups of the catalog ([error-model.md §3](../../../exponetdb-docs/02-control-plane/error-model.md#3-catalog)). */
export const ERROR_GROUPS = [
  'plans_and_operations',
  'migrations',
  'evidence_and_policy',
  'authentication_and_authorization',
  'targets_clusters_nodes',
  'backup_and_restore',
  'queries_and_diagnostics',
  'generic',
] as const
export type ErrorGroup = (typeof ERROR_GROUPS)[number]

export interface ErrorDefinition {
  readonly group: ErrorGroup
  /** HTTP status of the problem document. */
  readonly status: number
  /** Where the catalog names another status for a non-problem response. */
  readonly statusNote?: string
  /** The same request may succeed later without changes. */
  readonly retryable: boolean
  /** Short title (RFC 9457). */
  readonly title: string
  /**
   * The public message. Fixed per code: it never contains request data,
   * secrets, raw PostgreSQL DETAIL or exception text. Specific facts go into
   * schema-checked `details`.
   */
  readonly message: string
  readonly remediation?: string
  /**
   * Strict schema of `details`; absent means the code carries no details in v1.
   * A schema that accepts `undefined` (`.optional()`) makes the details optional.
   */
  readonly details?: z.ZodType
}

const BindingValueSchema = z.union([z.string().max(512), z.number(), z.boolean(), z.null()])

const ChangedBindingSchema = z.strictObject({
  binding: z.string().regex(/^[a-zA-Z][a-zA-Z0-9.]{0,63}$/),
  expected: BindingValueSchema.optional(),
  actual: BindingValueSchema.optional(),
  hint: untrustedText(
    512,
    'Human-readable hint, e.g. which migration was applied meanwhile.',
  ).optional(),
})

const IssueSchema = z
  .strictObject({
    path: z.string().max(512).meta({ description: 'JSON Pointer to the offending value.' }),
    code: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    message: z.string().max(512),
  })
  .meta({ id: 'ValidationIssue' })

const RuleResultSchema = z
  .strictObject({
    id: z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z0-9-]+)+$/),
    result: z.enum(['pass', 'fail', 'not_applicable', 'unknown']),
    severity: z.enum(['deny', 'require', 'warn']),
    message: z.string().max(1024),
    remediation: z.string().max(1024).optional(),
    overridableByBreakGlass: z.boolean(),
  })
  .meta({
    id: 'PolicyRuleResult',
    description:
      'A rule result without its facts: facts stay in the plan, never in an error (no arbitrary objects on the wire).',
  })

const DependencyRefSchema = z.union([
  MigrationIdSchema,
  z.string().regex(/^baseline:[a-z0-9]+(-[a-z0-9]+)*$/),
])

/** Reasons a bundle is refused by `migrations/format` (and later by ingestion). */
export const BUNDLE_INVALID_REASONS = [
  'invalid_directory_name',
  'directory_mismatch',
  'missing_file',
  'unexpected_file',
  'file_too_large',
  'invalid_utf8',
  'bom',
  'nul',
  'unterminated_string',
  'unterminated_quoted_identifier',
  'unterminated_dollar_quote',
  'unterminated_block_comment',
  'empty_migration',
  'no_statements',
  'verify_file_mismatch',
  'rollback_file_mismatch',
  'duplicate_migration_id',
  'project_mismatch',
] as const

const VerificationCheckSchema = z.strictObject({
  name: untrustedText(128, 'Check name from verify.sql or engine-generated.'),
  layer: z.enum(['L0', 'L1', 'L2', 'L3', 'L4']),
  status: z.enum(['passed', 'failed', 'error', 'no_rows']),
  message: untrustedText(1024, 'Redacted failure description.').optional(),
})

/**
 * The stable error catalog. Codes are never renamed or reused; deprecated codes
 * keep working (versioning.md).
 */
export const ERRORS = {
  // ----- Plans and operations -----
  PLAN_STALE: {
    group: 'plans_and_operations',
    status: 409,
    retryable: false,
    title: 'Plan is stale',
    message: 'The plan no longer matches the target. Create a new plan.',
    remediation: 'Create a new plan for the same change.',
    details: z.strictObject({
      planId: PlanIdSchema,
      changedBindings: z.array(ChangedBindingSchema).min(1).max(32),
    }),
  },
  PLAN_EXPIRED: {
    group: 'plans_and_operations',
    status: 409,
    retryable: false,
    title: 'Plan expired',
    message: 'The plan passed its expiry time. Create a new plan.',
    remediation: 'Create a new plan.',
  },
  ORDER_DIVERGES_FROM_EVIDENCE: {
    group: 'plans_and_operations',
    status: 409,
    retryable: false,
    title: 'Order diverges from evidence',
    message:
      'Production state makes the evidence order of unordered, overlapping migrations impossible.',
    remediation: 'Add an explicit dependsOn edge or reconcile, then create a new plan.',
  },
  PLAN_ALREADY_USED: {
    group: 'plans_and_operations',
    status: 409,
    retryable: false,
    title: 'Plan already used',
    message: 'The plan was already consumed by another request or caller.',
  },
  PLAN_NOT_FOUND: {
    group: 'plans_and_operations',
    status: 404,
    retryable: false,
    title: 'Plan not found',
    message: 'No such plan is visible to the caller.',
    remediation: 'Use a plan id from a plan this caller created, or create a new plan.',
  },
  PLAN_BINDING_ACTOR: {
    group: 'plans_and_operations',
    status: 403,
    retryable: false,
    title: 'Not the plan actor',
    message: 'Only the identity and client that created the plan may use it.',
  },
  PLAN_DENIED: {
    group: 'plans_and_operations',
    status: 403,
    retryable: false,
    title: 'Plan denied',
    message: 'The policy decision for this plan is deny; the plan exists for explanation only.',
  },
  APPROVAL_REQUIRED: {
    group: 'plans_and_operations',
    status: 409,
    statusNote:
      '202 Accepted with an operation in awaiting_approval when the request can wait; 409 when the kind cannot wait',
    retryable: false,
    title: 'Approval required',
    message: 'The plan needs a human approval before it can run.',
  },
  HUMAN_APPLY_REQUIRED: {
    group: 'plans_and_operations',
    status: 403,
    retryable: false,
    title: 'A person applies this plan',
    message:
      'The plan is critical: only a person applies it, through a Web App session or the CLI, with a fresh re-authentication.',
    remediation:
      'Tell your person what the plan does and give them its id. A plan is bound to the caller who made it, so they make it again themselves (for a rollback `exponetdb migration rollback <migration> --target <target>`), review it with `exponetdb plan show <planId>` and apply it with `exponetdb plan apply <planId>`. An agent cannot apply it.',
    details: z.strictObject({ planId: PlanIdSchema }),
  },
  APPROVALS_PENDING_LIMIT: {
    group: 'plans_and_operations',
    status: 409,
    retryable: false,
    title: 'Too many operations wait for approval',
    message:
      'This caller already has 20 operations through this client that wait for a human approval; no further one is accepted until some are decided or canceled.',
    remediation:
      'Ask your person to decide the operations that wait (Web App, Approvals), or cancel the ones no longer needed (`operation_cancel`, `POST /operations/{operationId}/cancel`); then apply again. The plan stays active until it expires.',
  },
  REAUTH_REQUIRED: {
    group: 'plans_and_operations',
    status: 401,
    retryable: false,
    title: 'Re-authentication required',
    message: 'A fresh passkey or TOTP proof is needed.',
  },
  APPROVAL_COOLING_PERIOD: {
    group: 'plans_and_operations',
    status: 409,
    retryable: true,
    title: 'Approval cooling period',
    message:
      'A critical self-approval is in its cooling period. Apply again after the time in details, with a fresh re-authentication.',
    details: z.strictObject({ notBefore: TimestampSchema }),
  },
  SELF_APPROVAL_UNACKNOWLEDGED: {
    group: 'plans_and_operations',
    status: 422,
    retryable: false,
    title: 'Self-approval not acknowledged',
    message: 'Approving your own plan must be acknowledged explicitly in the request.',
  },
  APPROVAL_NOT_PENDING: {
    group: 'plans_and_operations',
    status: 409,
    retryable: false,
    title: 'No approval pending',
    message: 'The operation does not await an approval.',
  },
  APPROVAL_DUPLICATE: {
    group: 'plans_and_operations',
    status: 409,
    retryable: false,
    title: 'Already decided',
    message: 'This person already decided on this operation.',
  },
  BREAK_GLASS_REQUIRED: {
    group: 'plans_and_operations',
    status: 403,
    retryable: false,
    title: 'Break-glass required',
    message: 'Only a break-glass grant can override the listed rules.',
    details: z.strictObject({ rules: z.array(z.string().max(128)).min(1).max(32) }),
  },
  BREAK_GLASS_UNAVAILABLE: {
    group: 'plans_and_operations',
    status: 409,
    retryable: false,
    title: 'Break-glass unavailable',
    message: 'No break-glass grant can be activated or used for this request.',
    remediation:
      'An activation needs a configured notification channel; a plan needs your own active grant on this target.',
    details: z.strictObject({
      reason: z.enum([
        'notification_channel_not_configured',
        'grant_not_usable',
        'rule_not_overridable',
      ]),
    }),
  },
  OPERATION_NOT_FOUND: {
    group: 'plans_and_operations',
    status: 404,
    retryable: false,
    title: 'Operation not found',
    message: 'No such operation is visible to the caller.',
    remediation: 'Use an operation id from the operation list.',
  },
  OPERATION_CONFLICT: {
    group: 'plans_and_operations',
    status: 409,
    retryable: true,
    title: 'Operation conflict',
    message: 'Another operation holds the exclusivity domain and the request asked not to wait.',
    details: z.strictObject({ blockingOperationId: OperationIdSchema }),
  },
  OPERATION_NOT_CANCELABLE: {
    group: 'plans_and_operations',
    status: 409,
    retryable: false,
    title: 'Operation cannot be canceled',
    message:
      'Only an operation that has not started (awaiting approval or queued) can be canceled; a running operation is never interrupted.',
    details: z.strictObject({
      state: z.enum([
        'running',
        'verifying',
        'needs_reconciliation',
        'needs_attention',
        'succeeded',
        'failed',
        'verification_failed',
        'canceled',
      ]),
    }),
  },
  OPERATION_NOT_RETRYABLE: {
    group: 'plans_and_operations',
    status: 409,
    retryable: false,
    title: 'Verification cannot be retried',
    message:
      'Only an operation that needs attention after an applied change whose verification could not run or did not finish can be verified again.',
    details: z.strictObject({
      state: z.enum([
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
      ]),
    }),
  },
  OPERATION_CANCELLED: {
    group: 'plans_and_operations',
    status: 409,
    retryable: false,
    title: 'Operation cancelled',
    message: 'The operation was cancelled.',
  },
  OUTCOME_UNKNOWN: {
    group: 'plans_and_operations',
    status: 409,
    retryable: false,
    title: 'Outcome unknown',
    message: 'The operation needs reconciliation. Do not retry; wait for reconciliation.',
  },
  PRECONDITION_FAILED: {
    group: 'plans_and_operations',
    status: 412,
    retryable: false,
    title: 'Precondition failed',
    message: 'The object changed since it was observed; the inline precondition no longer matches.',
  },
  IDEMPOTENCY_KEY_REUSED: {
    group: 'plans_and_operations',
    status: 422,
    retryable: false,
    title: 'Idempotency key reused',
    message: 'The idempotency key was already used for a different request.',
  },
  // ----- Migrations -----
  MIGRATION_CHECKSUM_MISMATCH: {
    group: 'migrations',
    status: 409,
    retryable: false,
    title: 'Migration checksum mismatch',
    message:
      'This migration id is already known with a different checksum. Applied history is immutable.',
    remediation: 'Restore the original bundle and add a new migration for the change.',
    details: z.strictObject({
      migrationId: MigrationIdSchema,
      knownChecksum: ApplyChecksumSchema,
      where: z.discriminatedUnion('kind', [
        z.strictObject({ kind: z.literal('target_ledger'), targetId: TargetIdSchema }),
        z.strictObject({ kind: z.literal('bundle_store') }),
      ]),
    }),
  },
  MIGRATION_DEPENDENCY_MISSING: {
    group: 'migrations',
    status: 409,
    retryable: false,
    title: 'Migration dependency missing',
    message: 'A dependency is neither applied on the target nor part of the plan.',
    details: z.strictObject({ missing: z.array(DependencyRefSchema).min(1).max(256) }),
  },
  MIGRATION_DEPENDENCY_UNVERIFIED: {
    group: 'migrations',
    status: 409,
    retryable: false,
    title: 'Migration dependency unverified',
    message: 'A dependency is applied but not verified on this production-tier target.',
  },
  MIGRATION_DEPENDENCY_CYCLE: {
    group: 'migrations',
    status: 422,
    retryable: false,
    title: 'Migration dependency cycle',
    message: 'The declared dependencies form a cycle.',
    details: z.strictObject({ cycle: z.array(DependencyRefSchema).min(1).max(256) }),
  },
  MIGRATION_DEPENDENCY_UNKNOWN: {
    group: 'migrations',
    status: 422,
    retryable: false,
    title: 'Migration dependency unknown',
    message: 'dependsOn names an id that is not in the project stream.',
  },
  MIGRATION_MANIFEST_INVALID: {
    group: 'migrations',
    status: 422,
    retryable: false,
    title: 'Migration manifest invalid',
    message: 'migration.yaml does not match the manifest schema.',
    details: z.strictObject({ errors: z.array(IssueSchema).min(1).max(100) }),
  },
  MIGRATION_BUNDLE_INVALID: {
    group: 'migrations',
    status: 422,
    retryable: false,
    title: 'Migration bundle invalid',
    message: 'The bundle layout, encoding or file set is invalid.',
    details: z.strictObject({
      reason: z.enum(BUNDLE_INVALID_REASONS),
      file: z.enum(['migration.yaml', 'up.sql', 'verify.sql', 'down.sql']).optional(),
    }),
  },
  MIGRATION_LINT_BLOCKED: {
    group: 'migrations',
    status: 422,
    retryable: false,
    title: 'Blocking lint findings',
    message: 'The bundle has lint findings that block it.',
    details: z.strictObject({
      findings: z
        .array(
          z.strictObject({
            rule: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
            level: z.enum(['error', 'warn', 'info']),
            message: z.string().max(1024),
          }),
        )
        .min(1)
        .max(200),
    }),
  },
  MIGRATION_ALREADY_APPLIED: {
    group: 'migrations',
    status: 409,
    retryable: false,
    title: 'Migration already applied',
    message: 'The same id and checksum are already applied on this target.',
  },
  VERIFY_CONSTRUCT_UNSUPPORTED: {
    group: 'migrations',
    status: 422,
    retryable: false,
    title: 'verify.sql construct unsupported',
    message: 'verify.sql uses a construct the admission cannot classify.',
    remediation: 'Rewrite the check with allowlisted built-ins or declare a consumer check.',
    details: z.strictObject({
      construct: untrustedText(
        256,
        'The function, operator, cast, relation or column that was refused.',
      ),
      check: untrustedText(128, 'Name of the check.'),
    }),
  },
  MIGRATION_STATEMENT_FORBIDDEN: {
    group: 'migrations',
    status: 422,
    retryable: false,
    title: 'Statement forbidden',
    message: 'A statement class is not allowed in this context.',
    remediation:
      'Use only the statements this file allows: verify.sql holds SELECT checks that return an ok column and never changes data or settings; up.sql does not control the transaction. Remove the statement the finding or details name.',
    // Given for a verify.sql refusal (as VERIFY_CONSTRUCT_UNSUPPORTED); the members are required
    // inside the object so that no exception object can pass as details.
    details: z
      .strictObject({
        construct: untrustedText(256, 'The statement class that was refused.'),
        check: untrustedText(128, 'Name of the verify.sql check.'),
      })
      .optional(),
  },
  MIGRATION_LOCK_TIMEOUT: {
    group: 'migrations',
    status: 409,
    retryable: false,
    title: 'Migration lock timeout',
    message:
      'The advisory lock or lock_timeout was hit; nothing was applied and the plan is consumed.',
    remediation: 'Create a new plan, ideally at a quieter time.',
  },
  MIGRATION_EXECUTION_FAILED: {
    group: 'migrations',
    status: 422,
    retryable: false,
    title: 'Migration execution failed',
    message: 'A migration statement failed.',
    details: z.strictObject({
      sqlstate: z.string().regex(/^[0-9A-Z]{5}$/),
      statementIndex: z.int().min(0),
      position: z.int().min(1).nullable(),
      applyOutcome: z.enum(['not_applied', 'partially_applied', 'unknown']),
    }),
  },
  MIGRATION_REQUIREMENT_UNMET: {
    group: 'migrations',
    status: 409,
    retryable: false,
    title: 'Migration requirement unmet',
    message: 'The PostgreSQL version or an extension requirement is not met.',
  },
  MIGRATION_INCOMPLETE: {
    group: 'migrations',
    status: 409,
    retryable: false,
    title: 'Migration incomplete',
    message:
      'A non-transactional migration on this target stopped part-way; no other schema change is planned until it is resolved.',
    remediation:
      'Plan migration.resume for it, or a cleanup migration and a fresh plan when it never recorded applied.',
    details: z.strictObject({ migrationId: MigrationIdSchema }),
  },
  MIGRATION_REVERTED: {
    group: 'migrations',
    status: 409,
    retryable: false,
    title: 'Migration reverted',
    message:
      'The migration was rolled back on this target; its id is neither applied nor verified there again.',
    remediation: 'Write a new migration with a new id.',
    details: z.strictObject({ migrationId: MigrationIdSchema }),
  },
  MIGRATION_ROLLBACK_BLOCKED: {
    group: 'migrations',
    status: 409,
    retryable: false,
    title: 'Rollback blocked',
    message: 'The rollback cannot be planned in the current state of the target.',
    remediation: 'Roll back the later or dependent migrations first, or write a forward migration.',
    details: z.strictObject({
      migrationId: MigrationIdSchema,
      reason: z.enum(['dependents_applied', 'not_latest', 'no_down_sql']),
    }),
  },
  VERIFICATION_FAILED: {
    group: 'migrations',
    status: 409,
    statusNote: '200 inside an operation record; 409 on synchronous calls',
    retryable: false,
    title: 'Verification failed',
    message: 'Verification ran and failed.',
    details: z.strictObject({ checks: z.array(VerificationCheckSchema).min(1).max(256) }),
  },
  VERIFICATION_ERROR: {
    group: 'migrations',
    status: 409,
    retryable: true,
    title: 'Verification error',
    message: 'Verification could not run.',
  },
  SCHEMA_FINGERPRINT_MISMATCH: {
    group: 'migrations',
    status: 409,
    retryable: false,
    title: 'Schema fingerprint mismatch',
    message: 'The schema fingerprint differs from the expectation.',
  },
  LEDGER_DIVERGENCE: {
    group: 'migrations',
    status: 409,
    retryable: false,
    title: 'Ledger divergence',
    message: 'The target ledger and the Control Store mirror disagree; schema changes are blocked.',
    details: z.strictObject({
      missing: z
        .array(untrustedText(210, 'A mirrored migration id the target ledger no longer has.'))
        .max(16),
      checksumDiffers: z
        .array(
          untrustedText(210, 'A migration id whose target ledger row differs from the mirror.'),
        )
        .max(16),
      unrecorded: z
        .array(
          untrustedText(
            210,
            'A migration id in the target ledger that no ExponetDB operation of this target wrote.',
          ),
        )
        .max(16),
    }),
  },
  LEDGER_NOT_INITIALIZED: {
    group: 'migrations',
    status: 409,
    retryable: false,
    title: 'Ledger not initialized',
    message: 'The target has no exponetdb schema or baseline yet.',
  },
  LEGACY_IMPORT_AMBIGUOUS: {
    group: 'migrations',
    status: 409,
    retryable: false,
    title: 'Legacy import needs decisions',
    message: 'The import cannot proceed until the listed items are resolved by a human.',
    details: z.strictObject({
      items: z
        .array(z.strictObject({ itemId: z.string().regex(/^[A-Za-z0-9_:-]{1,128}$/) }))
        .min(1)
        .max(1000),
      // Wave 9 (additive): how many items wait, when more than `items` lists.
      total: z.int().min(1).optional(),
    }),
  },
  LEGACY_IMPORT_TRUNCATED: {
    group: 'migrations',
    status: 409,
    retryable: false,
    title: 'Legacy import report incomplete',
    message:
      'The import report holds fewer global drift items than exist, so it cannot become a baseline.',
    remediation:
      'Narrow the managed schema scope or correct the import inputs so that the drift fits the report, then analyze again.',
    details: z.strictObject({
      // null: the report was analyzed before drift totals were kept; analyze again.
      driftTotal: z.int().min(0).nullable(),
      held: z.int().min(0),
    }),
  },
  // Part A follow-up 3 review (additive): a report analyzed before failing expectations were
  // recorded would excuse every failure of an accepted file at the baseline's verification.
  LEGACY_IMPORT_ANALYSIS_OUTDATED: {
    group: 'migrations',
    status: 409,
    retryable: false,
    title: 'Legacy import analyzed before failures were recorded',
    message:
      'The import report was analyzed before the failing expectations of each file were recorded, so a review decision would not say what it accepts.',
    remediation: 'Analyze the import again and record the decisions on the new report.',
    details: z.strictObject({
      // How many file items of the report have no recorded failures.
      items: z.int().min(1),
    }),
  },
  // ----- Evidence and policy -----
  STAGING_EVIDENCE_MISSING: {
    group: 'evidence_and_policy',
    status: 409,
    retryable: false,
    title: 'Staging evidence missing',
    message: 'This checksum has not been applied on the evidence target.',
  },
  STAGING_VERIFICATION_FAILED: {
    group: 'evidence_and_policy',
    status: 409,
    retryable: false,
    title: 'Staging verification failed',
    message:
      'The migration was applied on the evidence target, but verification failed or is pending.',
  },
  STAGING_EVIDENCE_UNREACHABLE: {
    group: 'evidence_and_policy',
    status: 409,
    retryable: true,
    title: 'Staging evidence unreachable',
    message: 'The evidence target cannot be read to confirm evidence.',
  },
  EVIDENCE_CHAIN_MISCONFIGURED: {
    group: 'evidence_and_policy',
    status: 409,
    retryable: false,
    title: 'Evidence chain misconfigured',
    message: 'The evidence configuration of the project or environment is invalid.',
  },
  POLICY_DENIED: {
    group: 'evidence_and_policy',
    status: 403,
    retryable: false,
    title: 'Policy denied',
    message: 'A policy rule denies this change.',
    details: z.strictObject({ rules: z.array(RuleResultSchema).min(1).max(64) }),
  },
  MAINTENANCE_WINDOW_REQUIRED: {
    group: 'evidence_and_policy',
    status: 409,
    retryable: false,
    title: 'Maintenance window required',
    message: 'This change may only run inside a maintenance window.',
  },
  BACKUP_REQUIRED: {
    group: 'evidence_and_policy',
    status: 409,
    retryable: false,
    title: 'Backup required',
    message: 'Policy requires a verified backup newer than the stated age.',
    details: z.strictObject({
      newerThan: z.string().regex(/^P(?!$)(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+S)?)?$/),
    }),
  },
  BACKUP_NOT_VERIFIED: {
    group: 'evidence_and_policy',
    status: 409,
    retryable: false,
    title: 'Backup not verified',
    message: 'The referenced backup has no successful verification.',
  },
  // ----- Authentication and authorization -----
  UNAUTHENTICATED: {
    group: 'authentication_and_authorization',
    status: 401,
    retryable: false,
    title: 'Unauthenticated',
    message: 'Credentials are missing or invalid.',
  },
  TOKEN_EXPIRED: {
    group: 'authentication_and_authorization',
    status: 401,
    retryable: false,
    title: 'Token expired',
    message: 'The access token expired. Refresh and retry.',
  },
  INSUFFICIENT_SCOPE: {
    group: 'authentication_and_authorization',
    status: 403,
    retryable: false,
    title: 'Insufficient scope',
    message: 'The token lacks the scope this action needs.',
    remediation:
      'Reconnect the client and approve the scope named in requiredScope on the consent page; a client that cannot step up must be connected again with it.',
    details: z.strictObject({ requiredScope: ScopeSchema }),
  },
  PERMISSION_DENIED: {
    group: 'authentication_and_authorization',
    status: 403,
    retryable: false,
    title: 'Permission denied',
    message: 'The identity lacks the permission at this scope.',
    remediation: 'Ask an administrator for a role with this permission at this scope.',
  },
  TARGET_NOT_IN_GRANT: {
    group: 'authentication_and_authorization',
    status: 403,
    retryable: false,
    title: 'Target not in grant',
    message: "The token's grant does not include this target.",
  },
  TIER_NOT_PERMITTED: {
    group: 'authentication_and_authorization',
    status: 403,
    retryable: false,
    title: 'Tier not permitted',
    message: 'The scope exists only for the other tier.',
  },
  GRANT_REVOKED: {
    group: 'authentication_and_authorization',
    status: 401,
    retryable: false,
    title: 'Grant revoked',
    message: 'The grant behind this token was revoked.',
  },
  CLIENT_NOT_APPROVED: {
    group: 'authentication_and_authorization',
    status: 403,
    retryable: false,
    title: 'Client not approved',
    message: 'The OAuth client is registered but not approved by an administrator.',
  },
  AUTHORIZATION_REQUEST_INVALID: {
    group: 'authentication_and_authorization',
    status: 400,
    retryable: false,
    title: 'Authorization request invalid',
    message:
      'The authorization request is unknown, expired, already decided or was started in another browser.',
    remediation: 'Start again from the application that asked for access.',
  },
  USER_CODE_INVALID: {
    group: 'authentication_and_authorization',
    status: 400,
    retryable: false,
    title: 'Code not valid',
    message: 'The code is unknown, expired or already used.',
    remediation: 'Check the code the device shows, or start the sign-in on the device again.',
  },
  SCOPE_NOT_DELEGABLE: {
    group: 'authentication_and_authorization',
    status: 403,
    retryable: false,
    title: 'Scope not delegable',
    message:
      'A scope cannot be delegated: the identity does not hold its permission, or the client may never receive it.',
    details: z.strictObject({ scopes: z.array(ScopeSchema).max(64) }),
  },
  PRODUCTION_CONFIRMATION_REQUIRED: {
    group: 'authentication_and_authorization',
    status: 400,
    retryable: false,
    title: 'Production confirmation required',
    message: 'Production authority needs an explicit confirmation in the request.',
  },
  CLIENT_METADATA_INVALID: {
    group: 'authentication_and_authorization',
    status: 422,
    retryable: true,
    title: 'Client metadata invalid',
    message: 'The client metadata document could not be fetched safely or is not valid.',
    details: z.strictObject({
      reason: z
        .string()
        .regex(/^[a-z][a-z0-9_]{0,63}$/)
        .meta({ description: 'Why the document was refused (fetch or validation rule).' }),
    }),
  },
  AUTHENTICATION_FAILED: {
    group: 'authentication_and_authorization',
    status: 401,
    retryable: false,
    title: 'Authentication failed',
    message: 'Sign-in failed. Check what you entered and start again.',
  },
  SESSION_EXPIRED: {
    group: 'authentication_and_authorization',
    status: 401,
    retryable: false,
    title: 'Session ended',
    message: 'The session expired, was revoked or was replaced. Sign in again.',
  },
  AMBIGUOUS_CREDENTIALS: {
    group: 'authentication_and_authorization',
    status: 400,
    retryable: false,
    title: 'Ambiguous credentials',
    message: 'A request carries either a session cookie or a bearer token, never both.',
  },
  CSRF_FAILED: {
    group: 'authentication_and_authorization',
    status: 403,
    retryable: false,
    title: 'CSRF check failed',
    message: 'The request comes from another origin or lacks a valid CSRF token for this session.',
  },
  AUTH_CHALLENGE_EXPIRED: {
    group: 'authentication_and_authorization',
    status: 401,
    retryable: false,
    title: 'Ceremony expired',
    message: 'The authentication ceremony expired. Start it again.',
  },
  AUTH_CHALLENGE_INVALID: {
    group: 'authentication_and_authorization',
    status: 401,
    retryable: false,
    title: 'Ceremony invalid',
    message: 'The authentication ceremony is invalid or was already used. Start it again.',
  },
  LINK_INVALID: {
    group: 'authentication_and_authorization',
    status: 401,
    retryable: false,
    title: 'Link invalid',
    message: 'The link is invalid, already used or expired. Ask for a new one.',
  },
  RECOVERY_REQUIRED: {
    group: 'authentication_and_authorization',
    status: 403,
    retryable: false,
    title: 'Recovery required',
    message:
      'This session was opened with a recovery code. Set up a new passkey and authenticator first.',
  },
  PASSWORD_REJECTED: {
    group: 'authentication_and_authorization',
    status: 422,
    retryable: false,
    title: 'Credential rejected',
    message:
      'The new fallback credential does not meet the policy (length, or a commonly used value).',
    details: z.strictObject({
      reason: z.enum(['too_short', 'too_long', 'common', 'contains_email', 'control_characters']),
    }),
  },
  ENROLLMENT_INCOMPLETE: {
    group: 'authentication_and_authorization',
    status: 409,
    retryable: false,
    title: 'Enrollment incomplete',
    message: 'Set up a passkey, the fallback credential and the authenticator first.',
  },
  IDENTITY_EXISTS: {
    group: 'authentication_and_authorization',
    status: 409,
    retryable: false,
    title: 'Identity exists',
    message: 'An identity with this e-mail address already exists.',
  },
  IDENTITY_STATE_INVALID: {
    group: 'authentication_and_authorization',
    status: 409,
    retryable: false,
    title: 'Identity state',
    message: 'The identity is not in a state that allows this change.',
  },
  BINDING_EXISTS: {
    group: 'authentication_and_authorization',
    status: 409,
    retryable: false,
    title: 'Binding exists',
    message: 'The identity already holds this role at this scope.',
  },
  LAST_FACTOR: {
    group: 'authentication_and_authorization',
    status: 409,
    retryable: false,
    title: 'Last factor',
    message: 'The last passkey cannot be removed. Add another passkey first.',
  },
  OWNER_INVARIANT: {
    group: 'authentication_and_authorization',
    status: 409,
    retryable: false,
    title: 'Owner invariant',
    message: 'The change would leave the installation without an active owner.',
  },
  // ----- Targets, clusters, nodes -----
  TARGET_NOT_FOUND: {
    group: 'targets_clusters_nodes',
    status: 404,
    retryable: false,
    title: 'Target not found',
    message: 'No such target is visible to the caller.',
    remediation:
      "Use a path or tgt_ id from the target list. A target outside the caller's roles or this client's consent is never visible; ask an administrator for access or give a new consent.",
  },
  TARGET_SUSPENDED: {
    group: 'targets_clusters_nodes',
    status: 409,
    retryable: false,
    title: 'Target suspended',
    message: 'Writes to this target are blocked.',
    details: z.strictObject({
      reason: z
        .string()
        .regex(/^[a-z][a-z0-9_]{0,63}$/)
        .meta({ 'x-extensible-enum': ['identity_mismatch', 'ledger_divergence', 'administrator'] }),
    }),
  },
  TARGET_UNAVAILABLE: {
    group: 'targets_clusters_nodes',
    status: 503,
    retryable: true,
    title: 'Target unavailable',
    message: 'ExponetDB cannot connect to the target. This is never reported as empty data.',
  },
  TARGET_CREDENTIAL_INVALID: {
    group: 'targets_clusters_nodes',
    status: 503,
    retryable: false,
    title: 'Target credential invalid',
    message: 'Authentication to PostgreSQL failed; the credential needs rotation or repair.',
  },
  TARGET_TLS_FAILED: {
    group: 'targets_clusters_nodes',
    status: 503,
    retryable: false,
    title: 'Target TLS failed',
    message: 'TLS verification of the target failed.',
  },
  TARGET_IDENTITY_MISMATCH: {
    group: 'targets_clusters_nodes',
    status: 409,
    retryable: false,
    title: 'Target identity mismatch',
    message:
      'The identity marker in the database does not match the expected target; the target was suspended.',
  },
  CLUSTER_IDENTITY_MISMATCH: {
    group: 'targets_clusters_nodes',
    status: 409,
    retryable: false,
    title: 'Cluster identity mismatch',
    message: 'The cluster system identifier does not match the pinned value.',
  },
  TARGET_REGISTRATION_REFUSED: {
    group: 'targets_clusters_nodes',
    status: 409,
    retryable: false,
    title: 'Target registration refused',
    message:
      'The database cannot be registered as this target; nothing in it was changed. The reason names what was found.',
    remediation:
      'A Control Store, a database marked by another installation or another target, and a database with an exponetdb schema but no marker are never adopted; register a different database.',
    details: z.strictObject({
      reason: z
        .string()
        .regex(/^[a-z][a-z0-9_]{0,63}$/)
        .meta({
          'x-extensible-enum': [
            'control_store',
            'foreign_installation',
            'other_target',
            'generation_mismatch',
            'schema_exists_without_marker',
            'marker_unreadable',
            'database_mismatch',
            'cluster_hosts_control_store',
            'unsupported_version',
            'credential_missing',
            'lock_unavailable',
          ],
        }),
    }),
  },
  REGISTRY_CONFLICT: {
    group: 'targets_clusters_nodes',
    status: 409,
    retryable: false,
    title: 'Registry conflict',
    message:
      'The registry does not allow this change in its current state: the name, path or address is taken, or an object is in the wrong state.',
    details: z.strictObject({
      reason: z
        .string()
        .regex(/^[a-z][a-z0-9_]{0,63}$/)
        .meta({
          'x-extensible-enum': [
            'slug_taken',
            'path_taken',
            'address_taken',
            'database_taken',
            'cluster_not_confirmed',
            'cluster_already_confirmed',
            'cluster_retired',
            'evidence_cycle',
            'evidence_other_product',
            'tier_in_use',
            'target_state',
            'endpoint_retired',
            'database_not_found',
            'database_retired',
            'database_in_use',
            'cluster_in_use',
            'server_retired',
            'server_in_use',
            'no_active_endpoint',
            'observer_credential_missing',
            'system_identifier_taken',
            'credential_missing',
            'exception_active',
            'exception_not_active',
            'cluster_unmapped',
            'cluster_not_agent_managed',
            'postgres_ca_missing',
            'ca_bundle_lacks_postgres_ca',
            'role_missing',
            'cluster_ambiguous',
            'egress_addresses_unknown',
            'role_privileges',
            'role_superuser',
            'tls_name_not_registered',
            'credential_pending',
            'job_key_already_staged',
            'job_key_not_staged',
            'job_key_not_trusted',
            'job_key_trust_unproven',
            'job_key_not_retiring',
            'job_key_still_trusted',
            'job_key_not_addable',
            'job_key_not_removable',
            'job_key_overlap',
            'job_keys_invalid',
            // Wave 8, drift acceptance: the finding is already resolved; the
            // target's current schema could not be read completely.
            'finding_resolved',
            'snapshot_incomplete',
            // Wave 9 Part B, backups and restores (ADR-0036 to ADR-0038).
            'repository_location_taken',
            'repository_retired',
            'repository_not_adopted_observed',
            'repository_other_cluster',
            'repository_runs_not_allowed',
            'repository_in_use',
            'run_active',
            'restore_not_discardable',
            'policy_repository_unknown',
            'backup_not_found',
            'backup_not_verified',
            'wal_not_continuous',
            'point_in_time_outside_window',
            'no_backup_selectable',
          ],
        }),
    }),
  },
  NODE_OFFLINE: {
    group: 'targets_clusters_nodes',
    status: 503,
    retryable: true,
    title: 'Node offline',
    message: 'No heartbeat from the node within the threshold.',
  },
  NODE_REVOKED: {
    group: 'targets_clusters_nodes',
    status: 409,
    retryable: false,
    title: 'Node revoked',
    message: 'The node identity was revoked.',
  },
  CAPABILITY_UNAVAILABLE: {
    group: 'targets_clusters_nodes',
    status: 409,
    retryable: false,
    title: 'Capability unavailable',
    message: 'The node does not report this capability version, or the cluster is external.',
  },
  JOB_EXPIRED: {
    group: 'targets_clusters_nodes',
    status: 409,
    retryable: false,
    title: 'Job expired',
    message: 'The job was not claimed before it expired.',
  },
  NODE_PROTOCOL_UNSUPPORTED: {
    group: 'targets_clusters_nodes',
    status: 400,
    retryable: false,
    title: 'Node protocol unsupported',
    message:
      'The agent and the gateway have no protocol major in common, or a protocol header is missing.',
    remediation: 'Install an agent version that speaks a protocol major the gateway supports.',
  },
  NODE_ENROLLMENT_REFUSED: {
    group: 'targets_clusters_nodes',
    status: 401,
    retryable: false,
    title: 'Enrollment refused',
    message: 'The enrollment token is unknown, expired, already used or does not match.',
    remediation: 'Create a new enrollment token for the server and enroll again.',
  },
  NODE_PROOF_INVALID: {
    group: 'targets_clusters_nodes',
    status: 400,
    retryable: false,
    title: 'Node proof invalid',
    message: 'A proof of key possession or a node signature does not verify.',
  },
  NODE_ALREADY_ENROLLED: {
    group: 'targets_clusters_nodes',
    status: 409,
    retryable: false,
    title: 'Node already enrolled',
    message: 'The server already has a node that is not revoked or decommissioned.',
    remediation: 'Revoke or decommission the existing node first.',
  },
  NODE_CERTIFICATE_REFUSED: {
    group: 'targets_clusters_nodes',
    status: 403,
    retryable: false,
    title: 'Node certificate refused',
    message:
      "The client certificate is not the node's current certificate, or the node's state does not allow the request.",
  },
  NODE_CAPABILITY_FAILED: {
    group: 'targets_clusters_nodes',
    status: 422,
    retryable: false,
    title: 'Node capability failed',
    message:
      'The node ran the capability and reported a failure before it changed the host; the operation shows its message.',
    remediation: 'Correct what the message names and plan the change again.',
  },
  NODE_OBSERVATION_STALE: {
    group: 'targets_clusters_nodes',
    status: 409,
    retryable: false,
    title: 'Node observation missing or stale',
    message:
      'No node-signed observation of this cluster is recent enough to plan against (at most 10 minutes).',
    remediation: 'Inspect the cluster through the node, then plan again.',
    details: z.strictObject({
      capability: z
        .string()
        .regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+@[1-9][0-9]{0,3}$/)
        .meta({ description: 'The capability to inspect first.' }),
    }),
  },
  // ----- Backup and restore -----
  BACKUP_FAILED: {
    group: 'backup_and_restore',
    status: 422,
    retryable: false,
    title: 'Backup failed',
    message: 'The backup failed.',
  },
  BACKUP_REPOSITORY_UNAVAILABLE: {
    group: 'backup_and_restore',
    status: 503,
    retryable: true,
    title: 'Backup repository unavailable',
    message: 'The backup repository cannot be reached.',
  },
  RESTORE_TARGET_MISMATCH: {
    group: 'backup_and_restore',
    status: 409,
    retryable: false,
    title: 'Restore target mismatch',
    message:
      'The destination is not the target named in the plan, or its identity or tier differs.',
  },
  RESTORE_SOURCE_INVALID: {
    group: 'backup_and_restore',
    status: 409,
    retryable: false,
    title: 'Restore source invalid',
    message:
      'The backup is missing or incomplete, or the WAL range does not cover the requested point in time.',
  },
  RESTORE_FAILED: {
    group: 'backup_and_restore',
    status: 422,
    retryable: false,
    title: 'Restore failed',
    message: 'The restore failed.',
  },
  FEATURE_NOT_ACTIVATED: {
    group: 'backup_and_restore',
    status: 409,
    retryable: false,
    title: 'Not activated on this installation',
    message:
      'This installation has not activated the action for this tier: backup runs and restores stay off until the evidence they need exists.',
    remediation:
      'An operator activates it with EXPONETDB_BACKUP_EXECUTION or EXPONETDB_RESTORE_EXECUTION after the pre-Wave-11 drills passed; until then plan it only.',
    details: z.strictObject({
      setting: z.enum(['EXPONETDB_BACKUP_EXECUTION', 'EXPONETDB_RESTORE_EXECUTION']),
      current: z.enum(['disabled', 'nonprod', 'scratch', 'all']),
    }),
  },
  // ----- Queries and diagnostics -----
  QUERY_NOT_READ_ONLY: {
    group: 'queries_and_diagnostics',
    status: 422,
    retryable: false,
    title: 'Query not read-only',
    message: 'The statement was classified as writing. Use a migration for changes.',
    remediation: 'Write the change as a migration bundle, lint and plan it, then apply the plan.',
  },
  QUERY_CONSTRUCT_UNSUPPORTED: {
    group: 'queries_and_diagnostics',
    status: 422,
    retryable: false,
    title: 'Query construct unsupported',
    message: 'The query uses a construct the admission cannot classify as free of side effects.',
    details: z.strictObject({
      construct: untrustedText(256, 'The function, operator, cast or relation that was refused.'),
    }),
  },
  QUERY_TIMEOUT: {
    group: 'queries_and_diagnostics',
    status: 408,
    retryable: true,
    title: 'Query timeout',
    message: 'The statement timeout was reached.',
  },
  QUERY_FAILED: {
    group: 'queries_and_diagnostics',
    status: 422,
    retryable: false,
    title: 'Query failed',
    message:
      'The statement failed on the target; only its SQLSTATE is returned (a server message can quote data).',
    remediation: 'Look up the SQLSTATE, correct the statement and run it again.',
    details: z.strictObject({ sqlstate: z.string().regex(/^[0-9A-Z]{5}$/) }),
  },
  QUERY_CANCELED: {
    group: 'queries_and_diagnostics',
    status: 409,
    retryable: false,
    title: 'Query canceled',
    message: 'The query was canceled before it finished; no rows are returned.',
    remediation: 'Run it again if you still need it, with a narrower statement or a lower row cap.',
  },
  QUERY_RESULT_TOO_LARGE: {
    group: 'queries_and_diagnostics',
    status: 413,
    retryable: false,
    title: 'Query result too large',
    message: 'The row or byte cap was reached.',
    details: z.strictObject({
      cap: z.strictObject({ kind: z.enum(['rows', 'bytes']), limit: z.int().min(1) }),
    }),
  },
  QUERY_PARSE_ERROR: {
    group: 'queries_and_diagnostics',
    status: 422,
    retryable: false,
    title: 'Query parse error',
    message: 'The parser rejected the statement.',
    details: z.strictObject({ position: z.int().min(1) }),
  },
  DATA_READ_NOT_PERMITTED: {
    group: 'queries_and_diagnostics',
    status: 403,
    retryable: false,
    title: 'Data read not permitted',
    message: 'Data reads are disabled on this target or tier for this client.',
    remediation:
      'The data.read policy rule of the target decides who reads its rows; by default production rows are for people only. Read a non-production target, or ask a person to run the read.',
  },
  STATEMENT_NOT_AVAILABLE: {
    group: 'queries_and_diagnostics',
    status: 404,
    retryable: false,
    title: 'Statement not available',
    message:
      'The target does not hold a statement with this digest now, or it could not be read live; no stored or invented text is returned.',
    remediation:
      'Open the raw view from a current sessions list while the statement is still running or held, and make sure the target is reachable.',
    details: z.strictObject({
      reason: z.enum(['not_held', 'target_unreachable', 'digest_mismatch', 'extension_missing']),
    }),
  },
  SAMPLE_STALE: {
    group: 'queries_and_diagnostics',
    status: 503,
    statusNote: '200 with a warning when stale data is returned and labeled as stale',
    retryable: true,
    title: 'Sample stale',
    message: 'The diagnostics are older than the freshness threshold and a live read failed.',
  },
  // ----- Generic -----
  VALIDATION_FAILED: {
    group: 'generic',
    status: 422,
    retryable: false,
    title: 'Validation failed',
    message: 'The request does not match the contract.',
    remediation: 'Correct the fields listed in details and send the request again.',
    details: z.strictObject({ errors: z.array(IssueSchema).min(1).max(100) }),
  },
  NOT_FOUND: {
    group: 'generic',
    status: 404,
    retryable: false,
    title: 'Not found',
    message: 'No such resource is visible to the caller.',
    remediation: 'Use an id from a list the caller can see.',
  },
  CONFLICT: {
    group: 'generic',
    status: 409,
    retryable: false,
    title: 'Conflict',
    message: 'The resource changed (If-Match did not match).',
  },
  RATE_LIMITED: {
    group: 'generic',
    status: 429,
    retryable: true,
    title: 'Rate limited',
    message: 'Too many requests. Retry after the time in Retry-After.',
    // The same time as the Retry-After header of a REST answer, for MCP, which has no header.
    details: z.strictObject({ retryAfterSeconds: z.int().positive() }).optional(),
  },
  CONTROL_PLANE_DEGRADED: {
    group: 'generic',
    status: 503,
    retryable: true,
    title: 'Control Plane degraded',
    message: 'ExponetDB itself is not ready. This says nothing about the target databases.',
  },
  INTERNAL: {
    group: 'generic',
    status: 500,
    retryable: true,
    title: 'Internal error',
    message: 'An unexpected error occurred. Quote the request id when reporting it.',
  },
} as const satisfies Record<string, ErrorDefinition>

export type ErrorCode = keyof typeof ERRORS

export function isErrorCode(value: string): value is ErrorCode {
  return Object.hasOwn(ERRORS, value)
}

export const ERROR_CODES: readonly ErrorCode[] = Object.keys(ERRORS).filter(isErrorCode)

export function errorDefinition(code: ErrorCode): ErrorDefinition {
  return ERRORS[code]
}

/** The ExponetDB error code on the wire. Open: clients must handle codes they do not know. */
export const ErrorCodeSchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]{1,63}$/)
  .meta({ 'x-extensible-enum': ERROR_CODES, description: 'Stable ExponetDB error code.' })

/** `PLAN_STALE` → `https://db.exponet.cloud/errors/plan-stale`. */
export function errorTypeUri(code: ErrorCode): string {
  return `https://db.exponet.cloud/errors/${code.toLowerCase().replaceAll('_', '-')}`
}

const errorBody = {
  code: ErrorCodeSchema,
  message: z.string().max(1024),
  retryable: z.boolean(),
  details: z
    .record(z.string(), z.unknown())
    .optional()
    .meta({ description: 'Code-specific details; schema per code in the catalog.' }),
  remediation: z.string().max(1024).optional(),
  requestId: RequestIdSchema,
  operationId: OperationIdSchema.optional(),
  planId: PlanIdSchema.optional(),
}

/** RFC 9457 problem document with the ExponetDB extensions (error-model.md §2). */
export const ProblemSchema = z
  .object({
    type: z.url(),
    title: z.string().max(128),
    status: z.int().min(400).max(599),
    ...errorBody,
  })
  .meta({
    id: 'Problem',
    description: 'application/problem+json (RFC 9457) with the ExponetDB error fields.',
  })
export type Problem = z.infer<typeof ProblemSchema>

/**
 * The MCP tool error: the problem body without HTTP fields. It is sent as text in
 * the tool result, not as `structuredContent`: clients validate `structuredContent`
 * against the tool's success schema (error-model.md §2).
 */
export const ToolErrorSchema = z.object(errorBody).meta({ id: 'ToolError' })
export type ToolError = z.infer<typeof ToolErrorSchema>

export const ValidationIssueSchema = IssueSchema
export const PolicyRuleResultSchema = RuleResultSchema
export type PolicyRuleResult = z.infer<typeof RuleResultSchema>
