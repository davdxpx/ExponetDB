/**
 * Source of the current time. Domain code receives a Clock instead of calling
 * `Date.now()`, so time-dependent behavior (plan expiry, lease renewal, id
 * timestamps) is deterministic in tests.
 */
export interface Clock {
  /** Milliseconds since the Unix epoch (UTC). */
  nowMs(): number
}

export const systemClock: Clock = {
  nowMs: () => Date.now(),
}

/** A clock that always returns the same instant. */
export function fixedClock(atMs: number): Clock {
  return { nowMs: () => atMs }
}

export interface ManualClock extends Clock {
  advance(ms: number): void
  set(atMs: number): void
}

/** A clock that only moves when the test moves it. */
export function manualClock(startMs: number): ManualClock {
  let now = startMs
  return {
    nowMs: () => now,
    advance: (ms) => {
      now += ms
    },
    set: (atMs) => {
      now = atMs
    },
  }
}

/** RFC 3339 UTC timestamp with millisecond precision, e.g. `2026-10-04T12:00:00.000Z`. */
export function formatTimestamp(atMs: number): string {
  return new Date(atMs).toISOString()
}
