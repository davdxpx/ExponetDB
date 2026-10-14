import type { DriftCheck, DriftFinding } from '@exponetdb/sdk/operations'
import type { StructuredDiffRow } from '@exponetdb/ui-data'

/**
 * The drift page as data. Triage is the contract's own: each compared item is
 * in exactly one bucket, and the page shows `drifted` first, then
 * `unmanaged`, then `matched`. A bucket this build does not know is kept
 * apart as `other`, never folded into `matched`.
 */
export type Bucket = DriftFinding['bucket']

export const BUCKET_ORDER = ['drifted', 'unmanaged', 'matched'] as const satisfies readonly Bucket[]

export interface Triage {
  readonly drifted: readonly DriftFinding[]
  readonly unmanaged: readonly DriftFinding[]
  readonly matched: readonly DriftFinding[]
  /** Findings whose bucket is not one of the three (a newer server): shown, never hidden. */
  readonly other: readonly DriftFinding[]
}

export function triage(findings: readonly DriftFinding[]): Triage {
  const drifted: DriftFinding[] = []
  const unmanaged: DriftFinding[] = []
  const matched: DriftFinding[] = []
  const other: DriftFinding[] = []
  for (const finding of findings) {
    switch (finding.bucket) {
      case 'drifted':
        drifted.push(finding)
        break
      case 'unmanaged':
        unmanaged.push(finding)
        break
      case 'matched':
        matched.push(finding)
        break
      default:
        other.push(finding)
    }
  }
  return { drifted, unmanaged, matched, other }
}

const SEVERITY_RANK: Readonly<Record<string, number>> = { critical: 0, warning: 1, info: 2 }

/** Most severe first; an unknown severity sorts last, not first. */
export function bySeverity<T extends { readonly severity: string }>(items: readonly T[]): T[] {
  return [...items].sort(
    (a, b) => (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3),
  )
}

/** A finding as a before/after row: expected on the left, actual on the right, `null` when absent. */
export function diffRowOf(finding: DriftFinding): StructuredDiffRow {
  return {
    key: finding.object ?? finding.code,
    before: finding.expected,
    after: finding.actual,
  }
}

/** The counts of a check, the three buckets first. */
export type CountName = 'drifted' | 'unmanaged' | 'matched' | 'opened' | 'updated' | 'resolved'

export function countsOf(check: DriftCheck): readonly (readonly [CountName, number])[] {
  const { counts } = check
  return [
    ['drifted', counts.drifted],
    ['unmanaged', counts.unmanaged],
    ['matched', counts.matched],
    ['opened', counts.opened],
    ['updated', counts.updated],
    ['resolved', counts.resolved],
  ]
}

/** The latest time any of the findings was seen by a check, or `undefined`. */
export function lastSeenOf(items: readonly { readonly lastSeenAt: string }[]): string | undefined {
  let best: { readonly at: string; readonly ms: number } | undefined
  for (const item of items) {
    const ms = Date.parse(item.lastSeenAt)
    if (Number.isFinite(ms) && (best === undefined || ms > best.ms)) {
      best = { at: item.lastSeenAt, ms }
    }
  }
  return best?.at
}
