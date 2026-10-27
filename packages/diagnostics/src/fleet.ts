import type { Queryable } from '@exponetdb/control-store'
import { type TargetVisibility, targetVisibilitySql } from '@exponetdb/registry'
import { LAGGING_AFTER_MS, STALE_AFTER_MS } from './health.ts'

/**
 * The counts behind the fleet overview (Wave 8, `GET /fleet`): targets by
 * tier and health, open findings by severity. Each is one aggregate query
 * over the targets the caller may read (`targetVisibilitySql`, the target
 * list's own rule), so the number of queries does not grow with the number of
 * targets, and no count includes a target the caller cannot list.
 */
export const FLEET_HEALTH_STATES = [
  'healthy',
  'degraded',
  'unhealthy',
  'unreachable',
  'unknown',
  'suspended',
] as const
export type FleetHealthState = (typeof FLEET_HEALTH_STATES)[number]
export type FleetTier = 'prod' | 'nonprod'
export type FleetSeverity = 'info' | 'warning' | 'critical'

export interface FleetTargetCounts {
  /** Targets that are not decommissioned. */
  readonly total: number
  /** Decommissioned targets the caller may read, counted in neither tier nor health. */
  readonly decommissioned: number
  readonly byTier: Readonly<Record<FleetTier, number>>
  readonly byHealth: Readonly<Record<FleetHealthState, number>>
  /** How many of the counted targets each kind of source stands behind. */
  readonly bySource: Readonly<Record<'sampled' | 'cached' | 'inferred', number>>
  /** The oldest status observation among the counted targets; null when none was ever sampled. */
  readonly oldestObservedAt: string | null
  readonly asOf: string
}

const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`

/**
 * Health is the latest status the sampler wrote, read exactly as
 * `healthSummary` reads it for the target list: no status is `unknown`
 * (inferred, never sampled); a status older than the lagging bound is
 * `unknown` and `cached`; older than the stale bound it is `cached`; a
 * state that is `unknown` stays `unknown` and is never counted healthy.
 */
export async function fleetTargetCounts(
  q: Queryable,
  visibility: TargetVisibility,
): Promise<FleetTargetCounts> {
  const visible = targetVisibilitySql(visibility, 1)
  const { rows } = await q.query(
    'observation.fleet.targets',
    `WITH seen AS (
       SELECT t.tier, t.state AS lifecycle, s.target_id AS sampled_id, s.state, s.observed_at,
              extract(epoch FROM clock_timestamp() - s.observed_at) * 1000 AS age_ms
         FROM registry.targets t
         JOIN registry.projects j ON j.project_id = t.project_id
         LEFT JOIN observation.target_status s ON s.target_id = t.target_id
        WHERE ${visible.sql})
     SELECT tier, (lifecycle = 'decommissioned') AS gone,
            CASE WHEN sampled_id IS NULL OR age_ms > $8 THEN 'unknown' ELSE state END AS health,
            CASE WHEN sampled_id IS NULL THEN 'inferred'
                 WHEN age_ms > $9 THEN 'cached' ELSE 'sampled' END AS source,
            count(*)::int AS n,
            to_char(min(observed_at) AT TIME ZONE 'UTC', ${ISO}) AS oldest,
            to_char(clock_timestamp() AT TIME ZONE 'UTC', ${ISO}) AS as_of
       FROM seen GROUP BY 1, 2, 3, 4`,
    [...visible.params, LAGGING_AFTER_MS, STALE_AFTER_MS],
  )
  const byTier: Record<FleetTier, number> = { prod: 0, nonprod: 0 }
  const byHealth = Object.fromEntries(FLEET_HEALTH_STATES.map((s) => [s, 0])) as Record<
    FleetHealthState,
    number
  >
  const bySource = { sampled: 0, cached: 0, inferred: 0 }
  let decommissioned = 0
  let oldest: string | null = null
  let asOf: string | null = null
  for (const row of rows) {
    const n = row.int('n')
    asOf = row.text('as_of')
    if (row.bool('gone')) {
      decommissioned += n
      continue
    }
    byTier[row.text('tier') === 'prod' ? 'prod' : 'nonprod'] += n
    const health = row.text('health')
    byHealth[
      (FLEET_HEALTH_STATES as readonly string[]).includes(health)
        ? (health as FleetHealthState)
        : 'unknown'
    ] += n
    const source = row.text('source')
    bySource[source === 'sampled' || source === 'cached' ? source : 'inferred'] += n
    const o = row.textOrNull('oldest')
    if (o !== null && (oldest === null || o < oldest)) oldest = o
  }
  return {
    total: byTier.prod + byTier.nonprod,
    decommissioned,
    byTier,
    byHealth,
    bySource,
    oldestObservedAt: oldest,
    asOf: asOf ?? new Date().toISOString(),
  }
}

export interface FleetFindingCounts {
  readonly total: number
  readonly bySeverity: Readonly<Record<FleetSeverity, number>>
  readonly asOf: string
}

/** Open findings by severity over the targets the caller may read (findings of a decommissioned target stay open and count; since Wave 9 Part B with the targets' advisor and statement findings). */
export async function fleetFindingCounts(
  q: Queryable,
  visibility: TargetVisibility,
): Promise<FleetFindingCounts> {
  const visible = targetVisibilitySql(visibility, 1)
  const { rows } = await q.query(
    'observation.fleet.findings',
    `SELECT f.severity, count(*)::int AS n,
            to_char(clock_timestamp() AT TIME ZONE 'UTC', ${ISO}) AS as_of
       FROM (SELECT f.severity, f.target_id, f.state FROM observation.findings f
             UNION ALL
             SELECT s.severity, s.target_id, s.state FROM observation.subject_findings s
              WHERE s.target_id IS NOT NULL) f
       JOIN registry.targets t ON t.target_id = f.target_id
       JOIN registry.projects j ON j.project_id = t.project_id
      WHERE f.state = 'open' AND ${visible.sql}
      GROUP BY f.severity`,
    visible.params,
  )
  const bySeverity: Record<FleetSeverity, number> = { info: 0, warning: 0, critical: 0 }
  let asOf: string | null = null
  for (const row of rows) {
    asOf = row.text('as_of')
    const severity = row.text('severity')
    bySeverity[severity === 'critical' || severity === 'info' ? severity : 'warning'] +=
      row.int('n')
  }
  return {
    total: bySeverity.info + bySeverity.warning + bySeverity.critical,
    bySeverity,
    asOf: asOf ?? new Date().toISOString(),
  }
}
