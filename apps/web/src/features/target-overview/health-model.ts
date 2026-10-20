import type {
  HealthCondition,
  ProbeResult,
  TargetHealth,
  TargetHealthHistory,
} from '@exponetdb/sdk/operations'
import type { BreakdownBar, TimeSeriesPoint } from '@exponetdb/ui-patterns'
import type { MessageKey } from '../../lib/i18n/i18n.ts'

/**
 * The pure part of the overview's health and history blocks: the incident
 * order of a health sample (health.md, "three questions") and the history as
 * chart input. No component, no clock, so every rule is a table test.
 */

export type TargetHealthStateName = TargetHealth['state']

/** The six states of a target, worst first (the order the history uses for `worst`). */
export const STATE_ORDER: readonly TargetHealthStateName[] = [
  'unreachable',
  'unhealthy',
  'degraded',
  'suspended',
  'unknown',
  'healthy',
]

export function stateLabelKey(state: TargetHealthStateName): MessageKey {
  return `overview.health.stateword.${state}`
}

export function seriesLabelKey(state: TargetHealthStateName): MessageKey {
  return `overview.history.series.${state}`
}

/** The three questions of health, in the order an incident asks them. */
export const INCIDENT_GROUPS = ['path', 'answers', 'stuck'] as const
export type IncidentGroupId = (typeof INCIDENT_GROUPS)[number]

const PROBE_GROUP: Readonly<Record<ProbeResult['probe'], IncidentGroupId>> = {
  simple: 'path',
  extended: 'answers',
  identity: 'answers',
  activity: 'stuck',
  settings: 'stuck',
}

const CONDITION_GROUP: ReadonlyMap<string, IncidentGroupId> = new Map([
  ['probe_simple_failed', 'path'],
  ['node_offline', 'path'],
  ['control_plane_degraded', 'path'],
  ['tls_expiring', 'path'],
  ['extended_protocol_failing', 'answers'],
  ['identity_mismatch', 'answers'],
  ['identity_unverified', 'answers'],
  ['settings_unreadable', 'answers'],
])

/** The group of a condition; a condition this page does not know belongs to the last question. */
export function conditionGroup(condition: string): IncidentGroupId {
  return CONDITION_GROUP.get(condition) ?? 'stuck'
}

/** Whether the page knows the condition by name (else it shows the raw code as untrusted text). */
export function isKnownCondition(condition: string): boolean {
  return KNOWN_CONDITIONS.has(condition)
}

const KNOWN_CONDITIONS: ReadonlySet<string> = new Set([
  ...CONDITION_GROUP.keys(),
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
  'plaintext_connections',
  'activity_unreadable',
])

/**
 * The numbers a condition carries besides its count (`values`: numbers and
 * flags only, never text from the database). They are the server's
 * observations, shown as they came: this page compares none of them with a
 * limit, for the limits are set on the server (health.md, "rules shared").
 */
export type ConditionDetail =
  | { readonly kind: 'slots'; readonly used: number; readonly usable: number }
  | { readonly kind: 'oldest'; readonly seconds: number }
  | { readonly kind: 'xidAge'; readonly age: number }

function finite(condition: HealthCondition, key: string): number | undefined {
  const value = condition.values?.[key]
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

export function conditionDetails(condition: HealthCondition): readonly ConditionDetail[] {
  const details: ConditionDetail[] = []
  const used = finite(condition, 'clientBackends')
  const usable = finite(condition, 'usableSlots')
  if (used !== undefined && usable !== undefined) details.push({ kind: 'slots', used, usable })
  const oldest = finite(condition, 'oldestSeconds')
  if (oldest !== undefined) details.push({ kind: 'oldest', seconds: oldest })
  const age = finite(condition, 'xidAge')
  if (age !== undefined) details.push({ kind: 'xidAge', age })
  return details
}

export function conditionKey(condition: string): MessageKey | undefined {
  return isKnownCondition(condition)
    ? (`overview.health.condition.${condition}` as MessageKey)
    : undefined
}

/**
 * What the latest sample says about one question.
 *
 * - `problem`: a probe of the group failed or timed out, or a condition of
 *   the group is a warning or critical.
 * - `ok`: at least one probe of the group passed, none failed, no condition,
 *   and the sample as a whole is not `unknown`.
 * - `not_observed`: the sample holds no probe of the group and no condition
 *   that says otherwise. Never shown as fine.
 * - `overall_unknown`: the sample as a whole is `unknown`, so a passing probe
 *   is not read as healthy (C-28).
 */
export type GroupVerdict = 'problem' | 'ok' | 'not_observed' | 'overall_unknown'

export interface IncidentGroup {
  readonly id: IncidentGroupId
  readonly verdict: GroupVerdict
  readonly probes: readonly ProbeResult[]
  readonly conditions: readonly HealthCondition[]
}

const SEVERITY_ORDER: Readonly<Record<HealthCondition['severity'], number>> = {
  critical: 0,
  warning: 1,
  info: 2,
}

export function incidentGroups(health: TargetHealth): readonly IncidentGroup[] {
  return INCIDENT_GROUPS.map((id) => {
    const probes = health.probes.filter((probe) => PROBE_GROUP[probe.probe] === id)
    const conditions = health.conditions
      .filter((condition) => conditionGroup(condition.condition) === id)
      .slice()
      .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
    return { id, probes, conditions, verdict: verdictOf(health.state, probes, conditions) }
  })
}

function verdictOf(
  overall: TargetHealthStateName,
  probes: readonly ProbeResult[],
  conditions: readonly HealthCondition[],
): GroupVerdict {
  const failed = probes.some((probe) => probe.outcome !== 'ok')
  const serious = conditions.some((condition) => condition.severity !== 'info')
  if (failed || serious) return 'problem'
  if (overall === 'unknown') return 'overall_unknown'
  if (probes.length === 0) return 'not_observed'
  return 'ok'
}

// ----- history -----

/** The keys of the chart series: one per state, in `STATE_ORDER`. */
export const SERIES_KEYS: readonly TargetHealthStateName[] = [...STATE_ORDER].reverse()

export function worstOf(history: TargetHealthHistory): TargetHealthStateName | null {
  let worst: TargetHealthStateName | null = null
  for (const bucket of history.buckets) {
    if (worst === null || STATE_ORDER.indexOf(bucket.worst) < STATE_ORDER.indexOf(worst)) {
      worst = bucket.worst
    }
  }
  return worst
}

/** The key of a gap cause the page has words for, else `other`. */
export function gapCauseKey(cause: string): MessageKey {
  switch (cause) {
    case 'control_plane_down':
      return 'overview.history.cause.control_plane_down'
    case 'sampler_lagging':
      return 'overview.history.cause.sampler_lagging'
    case 'unknown':
      return 'overview.history.cause.unknown'
    default:
      return 'overview.history.cause.other'
  }
}

export function gapReasonKey(reason: string): MessageKey {
  switch (reason) {
    case 'no_live_process':
      return 'overview.history.reason.no_live_process'
    case 'no_live_worker':
      return 'overview.history.reason.no_live_worker'
    case 'heartbeats_pruned':
      return 'overview.history.reason.heartbeats_pruned'
    default:
      return 'overview.history.reason.other'
  }
}

/** A gap the chart can attach to a missing point: its words come from the caller (the catalog). */
export type GapWords = (gap: TargetHealthHistory['gaps'][number]) => string

/**
 * The history as chart points: one point per bucket (the sample count of
 * every state) and, where buckets are missing, a point whose values are all
 * `null`, so the chart breaks the line there and never interpolates. A bucket
 * exists only where a sample landed, so a hole between two buckets (or after
 * the last one) is a stretch without samples; the cause comes from the gap
 * that covers it, and is left out when none does.
 */
export function historyPoints(
  history: TargetHealthHistory,
  words: GapWords,
): readonly TimeSeriesPoint[] {
  const step = Math.max(1, history.bucketSeconds) * 1000
  const buckets = history.buckets
    .map((bucket) => ({ bucket, at: Date.parse(bucket.start) }))
    .filter((entry) => Number.isFinite(entry.at))
    .sort((a, b) => a.at - b.at)
  const gaps = history.gaps
    .map((gap) => ({ gap, from: Date.parse(gap.from), to: Date.parse(gap.to) }))
    .filter((entry) => Number.isFinite(entry.from) && Number.isFinite(entry.to))
  const rangeEnd = Date.parse(history.to)

  const hole = (at: number): TimeSeriesPoint => {
    const covering = gaps.find((entry) => entry.from <= at && at <= entry.to)
    const nulls = Object.fromEntries(SERIES_KEYS.map((key) => [key, null]))
    const cause = covering === undefined ? undefined : words(covering.gap)
    return {
      time: new Date(at).toISOString(),
      values: nulls,
      ...(cause === undefined
        ? {}
        : { gaps: Object.fromEntries(SERIES_KEYS.map((key) => [key, cause])) }),
    }
  }

  const points: TimeSeriesPoint[] = []
  buckets.forEach((entry, index) => {
    points.push({
      time: new Date(entry.at).toISOString(),
      values: { ...entry.bucket.counts },
    })
    const next = buckets[index + 1]
    if (next !== undefined && next.at - entry.at > step) {
      points.push(hole(entry.at + step))
    }
  })
  const last = buckets[buckets.length - 1]
  const longPast = Math.max(step, history.gapThresholdSeconds * 1000) * 2
  if (last !== undefined && Number.isFinite(rangeEnd) && rangeEnd - (last.at + step) > longPast) {
    points.push(hole(last.at + step))
  }
  return points
}

/** One bar with the samples of the whole range, split by the worst state of the sample. */
export function historyBreakdown(
  history: TargetHealthHistory,
  label: string,
): readonly BreakdownBar[] {
  const totals: Record<string, number> = Object.fromEntries(SERIES_KEYS.map((key) => [key, 0]))
  for (const bucket of history.buckets) {
    for (const key of SERIES_KEYS) {
      totals[key] = (totals[key] ?? 0) + bucket.counts[key]
    }
  }
  return [{ id: 'range', label, values: totals }]
}
