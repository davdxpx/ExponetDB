import type { VerificationFailure } from '@exponetdb/contracts'
import type { ClusterGlobalResult, ExpectationResult } from '@exponetdb/postgres'
import type { ClusterGlobalExpectation } from '@exponetdb/postgres/parser'

/**
 * Failing expectations, by where they come from, what they expected and
 * which aspects differ (Part A follow-up 3, F1 and F2): what an import
 * records per file at the analysis, what a review decision excuses, and
 * what a verification keeps so that a failed one says what failed. Names
 * only: never a value read from the catalog.
 */
export type ExpectationFailure = Omit<VerificationFailure, 'excused'>

/** The most failures a verification layer keeps (the rest are counted). */
export const MAX_KEPT_FAILURES = 200

/** The same expectation of the same statement of the same file, whatever its outcome. */
export function failureKey(f: Pick<ExpectationFailure, 'file' | 'statement' | 'kind' | 'object'>) {
  return `${f.file ?? ''}\u0000${f.statement ?? ''}\u0000${f.kind}\u0000${f.object}`
}

/** The same expectation failing in the same way: the same aspects differ. */
export function sameFailure(a: ExpectationFailure, b: ExpectationFailure): boolean {
  return (
    failureKey(a) === failureKey(b) &&
    a.failed.length === b.failed.length &&
    [...a.failed].sort().every((x, i) => x === [...b.failed].sort()[i])
  )
}

/**
 * Whether a person's decision excuses a failure found by a baseline's
 * verification (legacy-import.md §2 step 7, follow-up 3 F1): only a
 * decision that accepts the file as applied, and then exactly what the
 * analysis recorded failing, failing the same way. A report analyzed
 * before failures were recorded (`recorded` null) excuses every failure of
 * a file a person accepted; the fingerprint binds the managed scope.
 */
export function excusedBy(
  decision: { readonly accepted: boolean; readonly recorded: readonly ExpectationFailure[] | null },
  f: ExpectationFailure,
): boolean {
  if (!decision.accepted) return false
  return decision.recorded === null || decision.recorded.some((r) => sameFailure(r, f))
}

const cut = (text: string, max: number) => (text.length <= max ? text : text.slice(0, max))

/** The structural results of one file that did not hold. */
export function structuralFailures(
  file: string | null,
  results: readonly ExpectationResult[],
): ExpectationFailure[] {
  return results
    .filter((r) => !r.ok)
    .map((r) => ({
      file,
      statement: r.statement,
      kind: r.kind,
      object: cut(r.description, 300),
      failed: [...(r.failed ?? ['missing'])].slice(0, 16),
    }))
}

/** What a cluster-global expectation states, by role names (never a setting's value). */
export function describeClusterGlobal(e: ClusterGlobalExpectation): string {
  switch (e.kind) {
    case 'role':
      return `${e.exists ? 'role' : 'no role'} ${e.role}`
    case 'role_attribute':
      return `${e.attribute} ${e.value ? 'on' : 'off'} for role ${e.role}`
    case 'role_connection_limit':
      return `connection limit of role ${e.role}`
    case 'membership':
      return `${e.exists ? 'membership' : 'no membership'} of ${e.member} in ${e.role}`
    case 'membership_option':
      return `${e.option} option ${e.value ? 'on' : 'off'} for ${e.member} in ${e.role}`
    case 'role_setting':
      return `setting ${e.name} for role ${e.role ?? '(all)'} in database ${e.database ?? '(all)'}`
    case 'role_comment':
      return `comment on role ${e.role}`
  }
}

/** The cluster-global results of one file that apply on the target and do not hold. */
export function clusterGlobalFailures(
  file: string | null,
  results: readonly ClusterGlobalResult[],
): ExpectationFailure[] {
  return results
    .filter((r) => r.applies && !r.ok)
    .map((r) => {
      const e = r.expectation
      const existence = e.kind === 'role' || e.kind === 'membership'
      return {
        file,
        statement: null,
        kind: e.kind,
        object: cut(describeClusterGlobal(e), 300),
        failed: [existence ? (e.exists ? 'missing' : 'present') : 'value'],
      }
    })
}

/** Reads a stored list of failures; anything else is `null` (not recorded). */
export function failuresOf(value: unknown): ExpectationFailure[] | null {
  if (!Array.isArray(value)) return null
  const out: ExpectationFailure[] = []
  for (const v of value) {
    if (typeof v !== 'object' || v === null) return null
    const f = v as Record<string, unknown>
    if (
      (f['file'] !== null && typeof f['file'] !== 'string') ||
      (f['statement'] !== null && typeof f['statement'] !== 'number') ||
      typeof f['kind'] !== 'string' ||
      typeof f['object'] !== 'string' ||
      !Array.isArray(f['failed'])
    ) {
      return null
    }
    out.push({
      file: f['file'] as string | null,
      statement: f['statement'] as number | null,
      kind: f['kind'],
      object: f['object'],
      failed: (f['failed'] as unknown[]).map(String),
    })
  }
  return out
}
