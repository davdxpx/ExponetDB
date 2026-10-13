import { type ControlStore, HEARTBEAT_INTERVAL_MS, type Queryable } from '@exponetdb/control-store'
import { SAMPLE_INTERVAL_MS } from './health.ts'

/**
 * The sampled health history of one target ([health.md §6](../../../exponetdb-docs/10-observability/health.md#6-failed-reads-and-gaps),
 * Wave 8 order §9). The worker appends one row to `observation.health_samples`
 * about every 15 seconds per sampled target (daily partitions, kept 3 to 60
 * days, 14 by default). A read downsamples them to at most 500 buckets (the
 * worst state of each and the count of every state) and finds the gaps: the
 * intervals between two samples longer than twice the sampling period.
 *
 * A gap is not a row, so its cause is derived, never stored: from the process
 * heartbeats that cover it. `control_plane_down`: no worker heartbeat covered
 * it (the sampler runs in the worker); `sampler_lagging`: a worker was alive
 * and wrote no sample; `unknown`: the heartbeats that could say were pruned
 * (they are kept a day after a process stopped, seven after its last beat).
 * `node_offline` cannot be derived (a node keeps only its current state), and
 * a failed sample is a sample, not a gap.
 */

/** The sampling period the worker keeps (seconds). */
export const SAMPLE_PERIOD_SECONDS = SAMPLE_INTERVAL_MS / 1000
/** An interval without a sample longer than this is a gap: twice the period. */
export const GAP_THRESHOLD_SECONDS = 2 * SAMPLE_PERIOD_SECONDS
/** Buckets a read returns at most. */
export const HISTORY_MAX_BUCKETS = 500
/** Gaps a read lists at most (the oldest first). */
export const HISTORY_MAX_GAPS = 200
/** The longest range a read serves: the longest retention (data-retention.md §2). */
export const HISTORY_MAX_RANGE_MS = 60 * 24 * 3_600_000
/** Heartbeat rows are complete for this long: a stopped process's row is pruned after a day. */
export const HEARTBEAT_HISTORY_MS = 24 * 3_600_000

export const HEALTH_STATES = [
  'healthy',
  'degraded',
  'unhealthy',
  'unreachable',
  'unknown',
  'suspended',
] as const
export type HistoryState = (typeof HEALTH_STATES)[number]

/** Higher is worse. An `unknown` sample is never `healthy`; a known problem outranks not knowing. */
const SEVERITY: Readonly<Record<HistoryState, number>> = {
  healthy: 0,
  unknown: 1,
  suspended: 2,
  degraded: 3,
  unhealthy: 4,
  unreachable: 5,
}

export type StateCounts = Readonly<Record<HistoryState, number>>

export function worstState(counts: StateCounts): HistoryState {
  let worst: HistoryState = 'healthy'
  for (const state of HEALTH_STATES) {
    if (counts[state] > 0 && SEVERITY[state] > SEVERITY[worst]) worst = state
  }
  return worst
}

const BUCKET_SIZES = [
  15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14_400, 21_600, 43_200, 86_400,
] as const

/**
 * The smallest bucket size, from a fixed ladder, with which a range yields at
 * most {@link HISTORY_MAX_BUCKETS} buckets even when its ends are not aligned
 * to the size (one more bucket).
 */
export function chooseBucketSeconds(rangeSeconds: number): number {
  for (const size of BUCKET_SIZES) {
    if (Math.ceil(rangeSeconds / size) + 1 <= HISTORY_MAX_BUCKETS) return size
  }
  return BUCKET_SIZES[BUCKET_SIZES.length - 1] ?? 86_400
}

export type GapCause = 'control_plane_down' | 'sampler_lagging' | 'unknown'

export interface HistoryGap {
  readonly from: string
  readonly to: string
  readonly durationSeconds: number
  readonly cause: GapCause
  readonly reason: string | null
}

/** A span of time in which a process was alive, by its heartbeat row (epoch milliseconds). */
export interface AliveInterval {
  readonly from: number
  readonly to: number
}

const covers = (intervals: readonly AliveInterval[], at: number): boolean =>
  intervals.some((i) => i.from <= at && at < i.to)

interface Segment {
  from: number
  to: number
  cause: GapCause
  reason: string | null
}

/**
 * Splits one gap into the stretches that have one cause each, from the
 * intervals in which a worker (and a serve process) was alive. Stretches
 * shorter than the gap threshold merge into the stretch before them (the
 * first into the one after): the cause is derived at the resolution of the
 * sampling period, and a worker that came up seconds before its first sample
 * does not split an outage in two. `horizon`: the earliest time the
 * heartbeat rows are complete for; before it only a worker that is known to
 * have been alive says anything.
 */
export function causesOfGap(
  gap: { readonly from: number; readonly to: number },
  workers: readonly AliveInterval[],
  serves: readonly AliveInterval[],
  horizon: number,
): { from: number; to: number; cause: GapCause; reason: string | null }[] {
  const points = new Set<number>([gap.from, gap.to])
  const inside = (t: number) => t > gap.from && t < gap.to
  for (const i of [...workers, ...serves]) {
    if (inside(i.from)) points.add(i.from)
    if (inside(i.to)) points.add(i.to)
  }
  if (inside(horizon)) points.add(horizon)
  const ordered = [...points].sort((a, b) => a - b)
  const segments: Segment[] = []
  for (let n = 0; n + 1 < ordered.length; n++) {
    const from = ordered[n] as number
    const to = ordered[n + 1] as number
    const mid = from + (to - from) / 2
    let cause: GapCause
    let reason: string | null = null
    if (covers(workers, mid)) {
      cause = 'sampler_lagging'
    } else if (mid < horizon) {
      cause = 'unknown'
      reason = 'heartbeats_pruned'
    } else {
      cause = 'control_plane_down'
      reason = covers(serves, mid) ? 'no_live_worker' : 'no_live_process'
    }
    segments.push({ from, to, cause, reason })
  }
  const minimum = GAP_THRESHOLD_SECONDS * 1000
  // Absorb short stretches: into the previous one, the first into the next.
  const merged: Segment[] = []
  for (const s of segments) {
    const last = merged[merged.length - 1]
    if (
      last !== undefined &&
      (s.to - s.from < minimum || (last.cause === s.cause && last.reason === s.reason))
    ) {
      last.to = s.to
    } else {
      merged.push({ ...s })
    }
  }
  while (merged.length > 1 && (merged[0] as Segment).to - (merged[0] as Segment).from < minimum) {
    const first = merged.shift() as Segment
    const next = merged[0] as Segment
    next.from = first.from
  }
  // Stretches that kept the same cause after absorbing are one stretch.
  const out: Segment[] = []
  for (const s of merged) {
    const last = out[out.length - 1]
    if (last !== undefined && last.cause === s.cause && last.reason === s.reason) last.to = s.to
    else out.push(s)
  }
  return out
}

export interface HealthHistoryInput {
  readonly targetId: string
  readonly state: 'registered' | 'active' | 'suspended' | 'decommissioned'
  /** ISO time of the last lifecycle change (when sampling ended, for a decommissioned target). */
  readonly stateChangedAt: string
  readonly from: Date
  readonly to: Date
}

export interface HealthHistory {
  readonly from: string
  readonly to: string
  readonly bucketSeconds: number
  readonly firstSampleAt: string | null
  readonly buckets: readonly {
    readonly start: string
    readonly worst: HistoryState
    readonly samples: number
    readonly counts: StateCounts
  }[]
  readonly gaps: readonly HistoryGap[]
  readonly gapsTruncated: boolean
  /** The Control Store's clock when it was read. */
  readonly observedAt: string
}

const iso = (ms: number) => new Date(ms).toISOString()

/** Reads the history of a target in one repeatable-read, read-only transaction. */
export async function readHealthHistory(
  store: ControlStore,
  input: HealthHistoryInput,
): Promise<HealthHistory> {
  return store.transaction(
    'observation.health.history',
    async (tx) => {
      const facts = (
        await tx.query(
          'observation.health.history.facts',
          `SELECT clock_timestamp() AS now,
                  (SELECT min(observed_at) FROM observation.health_samples WHERE target_id = $1) AS first_at,
                  (SELECT max(observed_at) FROM observation.health_samples
                    WHERE target_id = $1 AND observed_at < $2::timestamptz) AS before_at`,
          [input.targetId, input.from.toISOString()],
        )
      ).rows[0]
      const now = facts?.date('now').getTime() ?? Date.now()
      const firstAt = facts?.dateOrNull('first_at') ?? null
      const beforeAt = facts?.dateOrNull('before_at') ?? null
      const from = input.from.getTime()
      const to = Math.min(input.to.getTime(), now)
      const bucketSeconds = chooseBucketSeconds(Math.max(1, (to - from) / 1000))
      const empty = (): HealthHistory => ({
        from: iso(from),
        to: iso(Math.max(from, to)),
        bucketSeconds,
        firstSampleAt: firstAt?.toISOString() ?? null,
        buckets: [],
        gaps: [],
        gapsTruncated: false,
        observedAt: iso(now),
      })
      if (to <= from || firstAt === null) return empty()

      const buckets = await bucketsOf(tx, input.targetId, from, to, bucketSeconds)
      const sampledUntil =
        input.state === 'decommissioned'
          ? Math.min(to, Date.parse(input.stateChangedAt))
          : input.state === 'registered'
            ? from
            : to
      const gaps = await gapsOf(tx, {
        targetId: input.targetId,
        from,
        to: sampledUntil,
        firstAt: firstAt.getTime(),
        beforeAt: beforeAt?.getTime() ?? null,
        now,
      })
      return {
        from: iso(from),
        to: iso(to),
        bucketSeconds,
        firstSampleAt: firstAt.toISOString(),
        buckets,
        gaps: gaps.gaps,
        gapsTruncated: gaps.truncated,
        observedAt: iso(now),
      }
    },
    { readOnly: true, isolation: 'repeatable read' },
  )
}

async function bucketsOf(
  q: Queryable,
  targetId: string,
  from: number,
  to: number,
  bucketSeconds: number,
): Promise<HealthHistory['buckets']> {
  const { rows } = await q.query(
    'observation.health.history.buckets',
    `SELECT floor(extract(epoch FROM observed_at) / $4)::bigint AS bucket,
            count(*) AS samples,
            count(*) FILTER (WHERE state = 'healthy') AS healthy,
            count(*) FILTER (WHERE state = 'degraded') AS degraded,
            count(*) FILTER (WHERE state = 'unhealthy') AS unhealthy,
            count(*) FILTER (WHERE state = 'unreachable') AS unreachable,
            count(*) FILTER (WHERE state = 'unknown') AS unknown,
            count(*) FILTER (WHERE state = 'suspended') AS suspended
       FROM observation.health_samples
      WHERE target_id = $1 AND observed_at >= $2::timestamptz AND observed_at <= $3::timestamptz
      GROUP BY 1 ORDER BY 1`,
    [targetId, iso(from), iso(to), bucketSeconds],
  )
  return rows.map((r) => {
    const counts: StateCounts = {
      healthy: r.int('healthy'),
      degraded: r.int('degraded'),
      unhealthy: r.int('unhealthy'),
      unreachable: r.int('unreachable'),
      unknown: r.int('unknown'),
      suspended: r.int('suspended'),
    }
    return {
      start: iso(r.int('bucket') * bucketSeconds * 1000),
      worst: worstState(counts),
      samples: r.int('samples'),
      counts,
    }
  })
}

async function gapsOf(
  q: Queryable,
  range: {
    readonly targetId: string
    readonly from: number
    readonly to: number
    readonly firstAt: number
    readonly beforeAt: number | null
    readonly now: number
  },
): Promise<{ gaps: HistoryGap[]; truncated: boolean }> {
  // Nothing before the first sample is a gap, and nothing after sampling ended.
  const start = Math.max(range.from, range.firstAt)
  if (range.to <= start) return { gaps: [], truncated: false }
  // The sample before the range closes a gap that began before it.
  const lo = range.beforeAt ?? start
  const threshold = GAP_THRESHOLD_SECONDS
  const pairs = await q.query(
    'observation.health.history.gaps',
    `WITH s AS (
       SELECT observed_at, lag(observed_at) OVER (ORDER BY observed_at) AS prev
         FROM observation.health_samples
        WHERE target_id = $1 AND observed_at >= $2::timestamptz AND observed_at <= $3::timestamptz)
     SELECT prev, observed_at FROM s
      WHERE prev IS NOT NULL AND observed_at - prev > make_interval(secs => $4)
      ORDER BY observed_at LIMIT $5`,
    [range.targetId, iso(lo), iso(range.to), threshold, HISTORY_MAX_GAPS + 1],
  )
  const raw: { from: number; to: number }[] = pairs.rows.map((r) => ({
    from: r.date('prev').getTime(),
    to: r.date('observed_at').getTime(),
  }))
  let truncated = raw.length > HISTORY_MAX_GAPS
  if (!truncated) {
    // The trailing edge: no sample since, while the target is still sampled.
    const last = (
      await q.query(
        'observation.health.history.last',
        `SELECT max(observed_at) AS at FROM observation.health_samples
          WHERE target_id = $1 AND observed_at >= $2::timestamptz AND observed_at <= $3::timestamptz`,
        [range.targetId, iso(lo), iso(range.to)],
      )
    ).rows[0]?.dateOrNull('at')
    if (last !== null && last !== undefined && range.to - last.getTime() > threshold * 1000) {
      raw.push({ from: last.getTime(), to: range.to })
    }
  }
  const clipped = raw
    .map((g) => ({ from: Math.max(g.from, range.from), to: Math.min(g.to, range.to) }))
    .filter((g) => g.to > g.from)
    .slice(0, HISTORY_MAX_GAPS)
  if (raw.length > HISTORY_MAX_GAPS) truncated = true
  if (clipped.length === 0) return { gaps: [], truncated }

  const earliest = Math.min(...clipped.map((g) => g.from))
  const latest = Math.max(...clipped.map((g) => g.to))
  const beats = await q.query(
    'observation.health.history.processes',
    `SELECT role, started_at, stopped_at, heartbeat_at FROM control.process_heartbeats
      WHERE role IN ('serve', 'worker') AND started_at <= $2::timestamptz
        AND coalesce(stopped_at, heartbeat_at) + make_interval(secs => $3) >= $1::timestamptz`,
    [iso(earliest), iso(latest), HEARTBEAT_INTERVAL_MS / 1000],
  )
  const workers: AliveInterval[] = []
  const serves: AliveInterval[] = []
  for (const r of beats.rows) {
    const stopped = r.dateOrNull('stopped_at')
    // Alive until it stopped, or until the beat after its last one was due.
    const end =
      stopped !== null
        ? stopped.getTime()
        : r.date('heartbeat_at').getTime() + HEARTBEAT_INTERVAL_MS
    const interval = { from: r.date('started_at').getTime(), to: end }
    if (r.text('role') === 'worker') workers.push(interval)
    else serves.push(interval)
  }
  const horizon = range.now - HEARTBEAT_HISTORY_MS
  const gaps: HistoryGap[] = []
  for (const g of clipped) {
    for (const s of causesOfGap(g, workers, serves, horizon)) {
      gaps.push({
        from: iso(s.from),
        to: iso(s.to),
        durationSeconds: Math.max(1, Math.round((s.to - s.from) / 1000)),
        cause: s.cause,
        reason: s.reason,
      })
    }
  }
  if (gaps.length > HISTORY_MAX_GAPS) truncated = true
  return { gaps: gaps.slice(0, HISTORY_MAX_GAPS), truncated }
}
