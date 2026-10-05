import * as z from 'zod'
import {
  ApplyChecksumSchema,
  MigrationIdSchema,
  OperationIdSchema,
  PlanIdSchema,
  RequestIdSchema,
  TargetIdSchema,
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
  /** Strict schema of `details`; absent means the code carries no details in v1. */
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
  REAUTH_REQUIRED: {
    group: 'plans_and_operations',
    status: 401,
    retryable: false,
    title: 'Re-authentication required',
    message: 'A fresh passkey or TOTP proof is needed.',
  },
  BREAK_GLASS_REQUIRED: {
    group: 'plans_and_operations',
    status: 403,
    retryable: false,
    title: 'Break-glass required',
    message: 'Only a break-glass grant can override the listed rules.',
    details: z.strictObject({ rules: z.array(z.string().max(128)).min(1).max(32) }),
  },
  OPERATION_NOT_FOUND: {
    group: 'plans_and_operations',
    status: 404,
    retryable: false,
    title: 'Operation not found',
    message: 'No such operation is visible to the caller.',
  },
  OPERATION_CONFLICT: {
    group: 'plans_and_operations',
    status: 409,
    retryable: true,
    title: 'Operation conflict',
    message: 'Another operation holds the exclusivity domain and the request asked not to wait.',
    details: z.strictObject({ blockingOperationId: OperationIdSchema }),
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
    details: z.strictObject({ requiredScope: ScopeSchema }),
  },
  PERMISSION_DENIED: {
    group: 'authentication_and_authorization',
    status: 403,
    retryable: false,
    title: 'Permission denied',
    message: 'The identity lacks the permission at this scope.',
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
  // ----- Targets, clusters, nodes -----
  TARGET_NOT_FOUND: {
    group: 'targets_clusters_nodes',
    status: 404,
    retryable: false,
    title: 'Target not found',
    message: 'No such target is visible to the caller.',
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
  // ----- Queries and diagnostics -----
  QUERY_NOT_READ_ONLY: {
    group: 'queries_and_diagnostics',
    status: 422,
    retryable: false,
    title: 'Query not read-only',
    message: 'The statement was classified as writing. Use a migration for changes.',
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
    details: z.strictObject({ errors: z.array(IssueSchema).min(1).max(100) }),
  },
  NOT_FOUND: {
    group: 'generic',
    status: 404,
    retryable: false,
    title: 'Not found',
    message: 'No such resource is visible to the caller.',
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

/** The MCP tool-error structured content: the problem body without HTTP fields. */
export const ToolErrorSchema = z.object(errorBody).meta({ id: 'ToolError' })
export type ToolError = z.infer<typeof ToolErrorSchema>

export const ValidationIssueSchema = IssueSchema
export const PolicyRuleResultSchema = RuleResultSchema
