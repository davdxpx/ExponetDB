/**
 * Exit codes ([`15-cli/README.md` §5](../../../../exponetdb-docs/15-cli/README.md#5-exit-codes)).
 * A failed verification, a parser, API or network error and an incomplete
 * list never exit 0.
 */
export const EXIT = {
  ok: 0,
  failure: 1,
  usage: 2,
  auth: 3,
  blocked: 4,
  unavailable: 5,
  unresolved: 6,
  interrupted: 130,
} as const

export type ExitCode = (typeof EXIT)[keyof typeof EXIT]

const AUTH = new Set([
  'UNAUTHENTICATED',
  'TOKEN_EXPIRED',
  'GRANT_REVOKED',
  'INSUFFICIENT_SCOPE',
  'PERMISSION_DENIED',
  'REAUTH_REQUIRED',
  'TARGET_NOT_IN_GRANT',
  'TIER_NOT_PERMITTED',
  'CLIENT_NOT_APPROVED',
  'AUTHENTICATION_FAILED',
  'SESSION_EXPIRED',
  'CLIENT_AUTHENTICATION_FAILED',
  'signed_out',
  'expired',
])

const BLOCKED = new Set([
  'POLICY_DENIED',
  'PLAN_DENIED',
  'APPROVAL_REQUIRED',
  'APPROVAL_COOLING_PERIOD',
  'SELF_APPROVAL_UNACKNOWLEDGED',
  'BREAK_GLASS_REQUIRED',
  'BREAK_GLASS_UNAVAILABLE',
  'BACKUP_REQUIRED',
  'BACKUP_NOT_VERIFIED',
  'MAINTENANCE_WINDOW_REQUIRED',
  'STAGING_EVIDENCE_MISSING',
  'STAGING_VERIFICATION_FAILED',
  'STAGING_EVIDENCE_UNREACHABLE',
  'EVIDENCE_CHAIN_MISCONFIGURED',
  'PRODUCTION_CONFIRMATION_REQUIRED',
  'LEGACY_IMPORT_AMBIGUOUS',
  'MIGRATION_LINT_BLOCKED',
])

const UNAVAILABLE = new Set([
  'TRANSPORT_FAILED',
  'RESPONSE_INVALID',
  'CONTROL_PLANE_DEGRADED',
  'INTERNAL',
  'RATE_LIMITED',
  'network',
  'protocol',
  'discovery_failed',
  'installation_changed',
  'incompatible_server',
  'lab_unavailable',
])

const USAGE = new Set(['VALIDATION_FAILED', 'usage', 'server_invalid'])

/** The exit code of an error code (the server's catalog or the CLI's own). */
export function exitFor(code: string): ExitCode {
  if (code === 'OUTCOME_UNKNOWN') return EXIT.unresolved
  if (AUTH.has(code)) return EXIT.auth
  if (BLOCKED.has(code)) return EXIT.blocked
  if (UNAVAILABLE.has(code)) return EXIT.unavailable
  if (USAGE.has(code)) return EXIT.usage
  return EXIT.failure
}
