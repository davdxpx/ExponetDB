/**
 * The pure parts of the statement statistics
 * ([performance.md §2](../../../exponetdb-docs/10-observability/performance.md#2-pg_stat_statements)):
 * discontinuities, deltas, gaps and the regression rule. Everything that
 * decides a number lives here, without I/O, so the rules are tested on
 * their own and the sampler and the reads share them.
 */

/** The sampler's period (the `statements.sample` worker task). */
export const STATEMENT_SAMPLE_INTERVAL_SECONDS = 300
/** Statements read per sample: the top by total execution time. */
export const STATEMENT_TOP = 200
/** A gap is an interval without a successful sample longer than this (two periods). */
export const STATEMENT_GAP_SECONDS = 2 * STATEMENT_SAMPLE_INTERVAL_SECONDS

/**
 * The regression rule (performance.md §2): the mean execution time of the
 * last 24 hours against the mean of the 7 days before them. A statement
 * regressed when the factor is at least `thresholdFactor` and it ran at
 * least `minCalls` times in both windows. One place, documented; the
 * owner may make them configurable later.
 */
export const REGRESSION = {
  thresholdFactor: 2,
  minCalls: 50,
  windowHours: 24,
  baselineDays: 7,
} as const

export type Discontinuity =
  | 'none'
  | 'first'
  | 'stats_reset'
  | 'server_restart'
  | 'entries_deallocated'

/** What a sample read besides the statements: `pg_stat_statements_info` and the server start. */
export interface SampleMarks {
  /** `pg_stat_statements_info.stats_reset` (microsecond text, UTC). */
  readonly statsReset: string | null
  /** `pg_stat_statements_info.dealloc`. */
  readonly dealloc: bigint | null
  /** `pg_postmaster_start_time()` (microsecond text, UTC). */
  readonly postmasterStart: string | null
}

/**
 * The discontinuity of a sample against the previous successful one: none
 * before (`first`), the server restarted (`server_restart`, the strongest:
 * counters may have been saved or lost), the statistics were reset
 * (`stats_reset`), or entries were evicted (`entries_deallocated`: deltas
 * stay possible per statement, guarded by its own counters).
 */
export function discontinuityOf(
  previous: SampleMarks | undefined,
  current: SampleMarks,
): Discontinuity {
  if (previous === undefined) return 'first'
  if (previous.postmasterStart !== current.postmasterStart) return 'server_restart'
  if (previous.statsReset !== current.statsReset) return 'stats_reset'
  if (previous.dealloc !== null && current.dealloc !== null && current.dealloc > previous.dealloc) {
    return 'entries_deallocated'
  }
  if (previous.dealloc !== null && current.dealloc !== null && current.dealloc < previous.dealloc) {
    // The counter itself went back: only a reset does that.
    return 'stats_reset'
  }
  return 'none'
}

/** Deltas are allowed only for these discontinuities (the Control Store's guard says the same). */
export function deltasAllowed(d: Discontinuity): boolean {
  return d === 'none' || d === 'entries_deallocated'
}

/** The cumulative counters of one statement (`pg_stat_statements`). */
export interface Counters {
  readonly calls: bigint
  readonly totalTimeMs: number
  readonly rows: bigint
  readonly blksHit: bigint
  readonly blksRead: bigint
}

/** The base of the next delta: the counters the last successful sample of the statement stored. */
export interface LatestCounters extends Counters {
  readonly statsReset: string | null
  readonly postmasterStart: string | null
  /** When that sample was taken (milliseconds since the epoch). */
  readonly sampledAtMs: number
}

export interface DeltaContext {
  readonly discontinuity: Discontinuity
  readonly statsReset: string | null
  readonly postmasterStart: string | null
  readonly sampledAtMs: number
}

/**
 * The delta of one statement since its previous value, or `null` when none
 * may be computed: a sample across a reset or restart, no previous value,
 * a previous value of another statistics epoch, an entry (re)created after
 * the previous value was read (`stats_since`, PostgreSQL 17+), or any
 * counter that went down (the entry was reset or evicted and added again).
 * A delta is never negative. A statement that did not run in between has
 * no delta (nothing to store).
 */
export function deltaOf(
  previous: LatestCounters | undefined,
  now: Counters & { readonly statsSinceMs: number | null },
  ctx: DeltaContext,
): Counters | null {
  if (!deltasAllowed(ctx.discontinuity) || previous === undefined) return null
  if (previous.statsReset !== ctx.statsReset) return null
  if (previous.postmasterStart !== ctx.postmasterStart) return null
  if (previous.sampledAtMs >= ctx.sampledAtMs) return null
  if (now.statsSinceMs !== null && now.statsSinceMs > previous.sampledAtMs) return null
  const calls = now.calls - previous.calls
  const rows = now.rows - previous.rows
  const blksHit = now.blksHit - previous.blksHit
  const blksRead = now.blksRead - previous.blksRead
  const totalTimeMs = now.totalTimeMs - previous.totalTimeMs
  if (calls < 0n || rows < 0n || blksHit < 0n || blksRead < 0n || totalTimeMs < 0) return null
  if (calls === 0n) return null
  return { calls, totalTimeMs, rows, blksHit, blksRead }
}

export interface RegressionInput {
  readonly calls24h: number
  readonly timeMs24h: number
  readonly calls7d: number
  readonly timeMs7d: number
  /** Migrations applied to the target inside the 24-hour window (null: not determinable). */
  readonly migrationsBetween: number | null
}

export interface Regression {
  readonly state: 'regressed' | 'none' | 'insufficient_data'
  readonly meanTimeMs24h: number | null
  readonly meanTimeMs7d: number | null
  readonly factor: number | null
  readonly thresholdFactor: number
  readonly minCalls: number
  readonly migrationsBetween: number | null
}

const round3 = (n: number) => Math.round(n * 1000) / 1000

/** The regression verdict of one statement (never a cause: migrations are a time coincidence). */
export function regressionOf(input: RegressionInput): Regression {
  const mean24 = input.calls24h > 0 ? input.timeMs24h / input.calls24h : null
  const mean7 = input.calls7d > 0 ? input.timeMs7d / input.calls7d : null
  const base = {
    meanTimeMs24h: mean24 === null ? null : round3(Math.max(0, mean24)),
    meanTimeMs7d: mean7 === null ? null : round3(Math.max(0, mean7)),
    thresholdFactor: REGRESSION.thresholdFactor,
    minCalls: REGRESSION.minCalls,
    migrationsBetween: input.migrationsBetween,
  }
  if (
    mean24 === null ||
    mean7 === null ||
    mean7 <= 0 ||
    input.calls24h < REGRESSION.minCalls ||
    input.calls7d < REGRESSION.minCalls
  ) {
    return {
      ...base,
      state: 'insufficient_data',
      factor: mean24 !== null && mean7 !== null && mean7 > 0 ? round3(mean24 / mean7) : null,
    }
  }
  const factor = mean24 / mean7
  return {
    ...base,
    state: factor >= REGRESSION.thresholdFactor ? 'regressed' : 'none',
    factor: round3(factor),
  }
}

/**
 * Intervals of the window without a successful sample for longer than
 * {@link STATEMENT_GAP_SECONDS}: between two successful samples, before the
 * first one (from the window's start) and after the last one (to the
 * window's end, capped at `nowMs`). Ascending, at most `max`.
 */
export function gapsOf(
  okSamplesMs: readonly number[],
  window: { readonly fromMs: number; readonly toMs: number },
  nowMs: number,
  max = 64,
): { fromMs: number; toMs: number }[] {
  const limit = STATEMENT_GAP_SECONDS * 1000
  const end = Math.min(window.toMs, nowMs)
  const points = [...okSamplesMs]
    .filter((t) => t >= window.fromMs && t <= end)
    .sort((a, b) => a - b)
  const out: { fromMs: number; toMs: number }[] = []
  let previous = window.fromMs
  for (const t of points) {
    if (t - previous > limit) out.push({ fromMs: previous, toMs: t })
    previous = t
  }
  if (end - previous > limit) out.push({ fromMs: previous, toMs: end })
  return out.slice(0, max)
}

/** Whether a redaction mode means the text was replaced (it could carry a secret). */
export function textReplaced(mode: 'parse' | 'lexical' | 'summary' | 'unparseable'): boolean {
  return mode === 'summary' || mode === 'unparseable'
}
