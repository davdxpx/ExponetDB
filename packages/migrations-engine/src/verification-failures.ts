import type { VerificationFailure } from '@exponetdb/contracts'
import { sha256Hex } from '@exponetdb/kernel/hash'
import type {
  CheckOptions,
  ClusterGlobalResult,
  ClusterGlobalValueDigest,
  ExpectationResult,
} from '@exponetdb/postgres'
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

/** A structural result that did not hold, as a failure (names only). */
function structuralFailure(
  file: string | null,
  r: Pick<ExpectationResult, 'statement' | 'kind' | 'description' | 'failed'>,
): ExpectationFailure {
  return {
    file,
    statement: r.statement,
    kind: r.kind,
    object: cut(r.description, 300),
    failed: [...(r.failed ?? ['missing'])].slice(0, 16),
  }
}

/** The structural results of one file that did not hold. */
export function structuralFailures(
  file: string | null,
  results: readonly ExpectationResult[],
): ExpectationFailure[] {
  return results.filter((r) => !r.ok).map((r) => structuralFailure(file, r))
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

/** A cluster-global expectation that does not hold, as a failure (role names only). */
function clusterGlobalFailure(
  file: string | null,
  e: ClusterGlobalExpectation,
): ExpectationFailure {
  const existence = e.kind === 'role' || e.kind === 'membership'
  return {
    file,
    statement: null,
    kind: e.kind,
    object: cut(describeClusterGlobal(e), 300),
    failed: [existence ? (e.exists ? 'missing' : 'present') : 'value'],
  }
}

/** The cluster-global results of one file that apply on the target and do not hold. */
export function clusterGlobalFailures(
  file: string | null,
  results: readonly ClusterGlobalResult[],
): ExpectationFailure[] {
  return results
    .filter((r) => r.applies && !r.ok)
    .map((r) => clusterGlobalFailure(file, r.expectation))
}

// ----- excused values (OD-56 (a)) -----

/** Aspects that state existence, or that a value could not be read: no value is compared. */
const NO_VALUE: ReadonlySet<string> = new Set(['missing', 'present', 'unreadable', 'changed'])

/**
 * A failure of a value (OD-56 (a)): an aspect other than existence differs
 * (a type, a body, a comment, a role setting, …). Excusing it excuses the
 * value the analysis observed, compared by a keyed digest.
 */
export function isValueFailure(f: Pick<ExpectationFailure, 'failed'>): boolean {
  return f.failed.some((a) => !NO_VALUE.has(a))
}

/** The identity of a failure of a value: SHA-256 of its file, statement, kind, object and aspects. */
export function valueKeyOf(f: ExpectationFailure): string {
  return sha256Hex(`${failureKey(f)}\u0000${[...f.failed].sort().join(',')}`)
}

/** Makes the keyed digest of an observed value, bound to the failure's identity. */
export type ValueDigester = (input: string) => string

/** The structural check option that keys what a failing check of `file` observed. */
export function structuralValueDigest(file: string | null, digest: ValueDigester): CheckOptions {
  return {
    valueDigest: (failure, observation) =>
      digest(`${valueKeyOf(structuralFailure(file, failure))}\n${observation}`),
  }
}

/** The cluster-global check option that keys what a failing check of `file` observed. */
export function clusterGlobalValueDigest(
  file: string | null,
  digest: ValueDigester,
): { readonly valueDigest: ClusterGlobalValueDigest } {
  return {
    valueDigest: (e, observation) =>
      digest(`${valueKeyOf(clusterGlobalFailure(file, e))}\n${observation}`),
  }
}

/** The observed digests of a file's failing structural results, by failure identity. */
export function structuralDigests(
  file: string | null,
  results: readonly ExpectationResult[],
): Map<string, string> {
  const out = new Map<string, string>()
  for (const r of results) {
    if (r.ok || r.observedDigest === undefined) continue
    out.set(valueKeyOf(structuralFailure(file, r)), r.observedDigest)
  }
  return out
}

/** The observed digests of a file's failing cluster-global results, by failure identity. */
export function clusterGlobalDigests(
  file: string | null,
  results: readonly ClusterGlobalResult[],
): Map<string, string> {
  const out = new Map<string, string>()
  for (const r of results) {
    if (!r.applies || r.ok || r.observedDigest === undefined) continue
    out.set(valueKeyOf(clusterGlobalFailure(file, r.expectation)), r.observedDigest)
  }
  return out
}

/** What the analysis recorded for a report's values: the key version and the digests. */
export interface RecordedValues {
  /** `null`: the report was analyzed before digests were recorded (the legacy rule applies). */
  readonly keyRef: string | null | undefined
  /** By item id, by failure identity. */
  readonly digests: ReadonlyMap<number, ReadonlyMap<string, string>>
}

/**
 * Whether an excused failure of a value still holds the value the person
 * accepted (OD-56 (a)): the same key version as the analysis, a recorded
 * digest for this failure, and the same digest now. Anything else fails
 * closed: `value_changed` (another value), `value_unverifiable` (no key, a
 * rotated key, nothing recorded). A report without digests (`keyRef`
 * undefined: analyzed before them) keeps the rule of its baseline.
 */
export function excusedValue(
  recorded: RecordedValues,
  itemId: number,
  f: ExpectationFailure,
  current: { readonly keyRef: string | null; readonly digest: string | undefined },
): 'held' | 'value_changed' | 'value_unverifiable' {
  if (!isValueFailure(f) || recorded.keyRef === undefined) return 'held'
  const was = recorded.digests.get(itemId)?.get(valueKeyOf(f))
  if (
    recorded.keyRef === null ||
    was === undefined ||
    current.keyRef === null ||
    current.keyRef !== recorded.keyRef ||
    current.digest === undefined
  ) {
    return 'value_unverifiable'
  }
  return was === current.digest ? 'held' : 'value_changed'
}

/**
 * A file whose expectations could not be read on the target (a check that
 * raised, for example `permission denied for schema` on a schema the
 * observer may not use): the analysis records it with the file, so a
 * person who accepts the file sees and excuses it, and the verification
 * records it instead of erroring (P1-1 of the follow-up 3 review).
 */
export function unreadableFailure(
  file: string,
  layer: 'structural' | 'cluster_global',
): ExpectationFailure {
  return {
    file,
    statement: null,
    kind: layer === 'structural' ? 'expectations' : 'cluster_global_expectations',
    object: cut(
      `${layer === 'structural' ? 'structural' : 'cluster-global'} expectations of ${file}`,
      300,
    ),
    failed: ['unreadable'],
  }
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
