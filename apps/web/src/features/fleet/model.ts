import type { Fleet, TargetSummary } from '@exponetdb/sdk/operations'
import { HEALTH_RANK, type HealthFilter, healthOf } from '../targets/model.ts'
import { PART_STALE_AFTER_MS } from './keys.ts'

/**
 * The fleet read as the cards need it. A part is either a count with its
 * source and time, or unavailable with the server's reason: an unavailable
 * part has no number, so it can never render as zero (C-28). Pure functions,
 * unit-tested.
 */
export interface CountPart {
  readonly kind: 'count'
  readonly count: number
  /** The count is a floor ("at least N"); the reason is the server's text. */
  readonly lowerBound: boolean
  readonly lowerBoundReason: string | null
  readonly source: string
  readonly observedAt: string
}

export interface UnavailablePart {
  readonly kind: 'unavailable'
  readonly reason: string
}

export type Part = CountPart | UnavailablePart

export interface FleetModel {
  readonly asOf: string
  readonly targets: CountPart & {
    readonly byTier: Fleet['targets']['byTier']
    readonly byHealth: Fleet['targets']['byHealth']
    readonly bySource: Fleet['targets']['bySource']
    readonly decommissioned: number
    readonly oldestSampleAt: string | null
  }
  readonly findings: Part & {
    readonly bySeverity?: { critical: number; warning: number; info: number }
  }
  readonly approval: Part
  readonly running: Part
  readonly attention: Part
}

export function fleetModel(fleet: Fleet): FleetModel {
  const { targets, findings, operations } = fleet
  const opPart = (pick: 'awaiting_approval' | 'running' | 'needs_attention'): Part =>
    operations.available
      ? {
          kind: 'count',
          count: operations[pick],
          lowerBound: operations.lowerBound,
          lowerBoundReason: operations.lowerBoundReason,
          source: operations.source,
          observedAt: operations.observedAt,
        }
      : { kind: 'unavailable', reason: operations.reason }
  return {
    asOf: fleet.asOf,
    targets: {
      kind: 'count',
      count: targets.total,
      lowerBound: targets.lowerBound,
      lowerBoundReason: targets.lowerBoundReason,
      source: targets.source,
      observedAt: targets.observedAt,
      byTier: targets.byTier,
      byHealth: targets.byHealth,
      bySource: targets.bySource,
      decommissioned: targets.decommissioned,
      oldestSampleAt: targets.oldestSampleAt,
    },
    findings: findings.available
      ? {
          kind: 'count',
          count: findings.open,
          lowerBound: findings.lowerBound,
          lowerBoundReason: findings.lowerBoundReason,
          source: findings.source,
          observedAt: findings.observedAt,
          bySeverity: findings.bySeverity,
        }
      : { kind: 'unavailable', reason: findings.reason },
    approval: opPart('awaiting_approval'),
    running: opPart('running'),
    attention: opPart('needs_attention'),
  }
}

/** Whether a part was counted longer ago than the page trusts (an unreadable time counts as stale). */
export function partStale(observedAt: string, now: number): boolean {
  const observed = Date.parse(observedAt)
  return Number.isNaN(observed) || now - observed > PART_STALE_AFTER_MS
}

/** The messages for the reasons the server gives for an unavailable part. */
export function unavailableKind(reason: string): 'permission_denied' | 'unknown' {
  return reason === 'permission_denied' ? 'permission_denied' : 'unknown'
}

// ----- targets that need attention -----

/** The targets the overview lists as needing attention. */
export const ATTENTION_LIMIT = 10

/** Health states that need no person: a deliberate suspension is not a problem, a healthy target is not one. */
const NO_ATTENTION: ReadonlySet<HealthFilter> = new Set<HealthFilter>(['healthy', 'suspended'])

export interface Attention {
  /** The worst targets, worst first, at most `limit`. */
  readonly rows: readonly TargetSummary[]
  /** How many of the targets read need attention (a floor when the read was cut off). */
  readonly count: number
  /** The health word of the worst target: what "show all" filters the list by. */
  readonly worst: HealthFilter | undefined
}

/**
 * The targets with the worst health: `unhealthy`, `unreachable`, `degraded`,
 * `unknown` and targets with no health sample at all (an unobserved target is
 * never healthy), in the severity order the app uses everywhere, then the
 * oldest observation first (the one least recently confirmed), then by path.
 * Decommissioned targets are not listed, nor are healthy or suspended ones.
 */
export function needsAttention(
  targets: readonly TargetSummary[],
  limit: number = ATTENTION_LIMIT,
): Attention {
  const needing = targets.filter(
    (target) => target.state !== 'decommissioned' && !NO_ATTENTION.has(healthOf(target)),
  )
  const observed = (target: TargetSummary): number => {
    // A target with no sample, or a time that cannot be read, was confirmed never: oldest of all.
    const time = target.health === null ? Number.NaN : Date.parse(target.health.observedAt)
    return Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time
  }
  const ordered = [...needing].sort(
    (a, b) =>
      (HEALTH_RANK[healthOf(a)] ?? 0) - (HEALTH_RANK[healthOf(b)] ?? 0) ||
      observed(a) - observed(b) ||
      a.path.localeCompare(b.path),
  )
  const first = ordered[0]
  return {
    rows: ordered.slice(0, limit),
    count: needing.length,
    worst: first === undefined ? undefined : healthOf(first),
  }
}
