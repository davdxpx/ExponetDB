import type { JsonObject } from '@exponetdb/kernel'
import type { ExecutionRoleFacts } from '@exponetdb/postgres'
import type { ExecutionRoleExceptionRecord } from '@exponetdb/registry'
import type { Severity } from './findings.ts'

/**
 * The live role against its declared exception ([ADR-0034 §4](../../../exponetdb-docs/01-architecture/adr/0034-execution-roles-for-adopted-schemas.md#4-drift-and-parity)):
 * the health sampler compares every active declaration of a target's
 * environment with the role's attributes on the target and keeps one
 * finding (`execution_role_exception_drift`) open per declaration that no
 * longer matches. The finding never changes the declaration or the role; a
 * person revokes or re-declares.
 *
 * - `privilege_exceeded` (critical): the role gained an attribute no
 *   exception excuses (`SUPERUSER`, `CREATEROLE`, `CREATEDB`,
 *   `REPLICATION`); every plan is refused anyway.
 * - `review_passed` (warning): the review date passed; the declaration
 *   excuses nothing until a person re-declares or revokes it.
 * - `role_missing`, `bypassrls_lost` (warning): the declaration is stale
 *   and should be revoked.
 */
export type ExceptionDriftReason =
  | 'privilege_exceeded'
  | 'review_passed'
  | 'role_missing'
  | 'bypassrls_lost'

export interface ExceptionDrift {
  readonly exceptionId: string
  readonly role: string
  readonly reason: ExceptionDriftReason
  readonly severity: Severity
}

export const EXCEPTION_FINDING_CODE = 'execution_role_exception_drift'
export const EXCEPTION_FINDING_PREFIX = 'health:execution_role_exception:'

export function exceptionFindingKey(exceptionId: string): string {
  return `${EXCEPTION_FINDING_PREFIX}${exceptionId}`
}

/** How one active declaration stands against the role's live facts, or `null` when it matches. */
export function exceptionDrift(
  e: ExecutionRoleExceptionRecord,
  facts: ExecutionRoleFacts | undefined,
): ExceptionDrift | null {
  const at = (reason: ExceptionDriftReason, severity: Severity): ExceptionDrift => ({
    exceptionId: e.exceptionId,
    role: e.role,
    reason,
    severity,
  })
  const exists = facts?.exists === true
  if (exists && (facts.superuser || facts.createRole || facts.createDb || facts.replication)) {
    return at('privilege_exceeded', 'critical')
  }
  if (e.expired) return at('review_passed', 'warning')
  if (!exists) return at('role_missing', 'warning')
  if (!facts.bypassRls) return at('bypassrls_lost', 'warning')
  return null
}

const SUMMARIES: Readonly<Record<ExceptionDriftReason, string>> = {
  privilege_exceeded:
    'An execution role declared for BYPASSRLS carries another privileged attribute; its migrations are refused.',
  review_passed:
    'A declared BYPASSRLS exception passed its review date and excuses nothing until it is declared again or revoked.',
  role_missing: 'A declared BYPASSRLS exception names a role that does not exist on this database.',
  bypassrls_lost:
    'An execution role declared for BYPASSRLS no longer has it; the declaration is stale and can be revoked.',
}

export function exceptionDriftSummary(d: ExceptionDrift): string {
  return SUMMARIES[d.reason]
}

/** Finding details: ids, the role name (untrusted, from the registry) and the reason; never a value. */
export function exceptionDriftDetails(d: ExceptionDrift): JsonObject {
  return {
    exceptionId: d.exceptionId,
    role: d.role.slice(0, 63),
    reason: d.reason,
    securityRelevant: true,
    object: null,
  }
}
