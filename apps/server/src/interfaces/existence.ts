/**
 * One response-time class for existence decisions (Wave 7 order §30): an
 * answer that an object does not exist, or that answers so to conceal it
 * (error-model.md §4), leaves no earlier than {@link EXISTENCE_FLOOR_MS}
 * after the request began. Measured before the floor (2026-10-13, in
 * process against PostgreSQL 17): an unknown target p50 6.1 ms, a target
 * outside the grant 8.4 ms; a caller averaging many answers could tell
 * them apart. The floor covers both paths with room for a slower database;
 * a path slower than the floor still differs, and the rate limits bound
 * how many samples a caller gets.
 */
export const EXISTENCE_FLOOR_MS = 50

/** A catalog code that says an object is not there (`TARGET_NOT_FOUND`, `NOT_FOUND`, …). */
export function isExistenceRefusal(code: string): boolean {
  return /(^|_)NOT_FOUND$/.test(code)
}

/** Waits until the floor has passed since `startedMs` (`performance.now()` at the request's start). */
export async function existenceFloor(startedMs: number): Promise<void> {
  // A timer may fire a little early against `performance.now()`: wait until the floor has passed.
  for (;;) {
    const wait = startedMs + EXISTENCE_FLOOR_MS - performance.now()
    if (wait <= 0) return
    await new Promise((resolve) => setTimeout(resolve, Math.ceil(wait)))
  }
}
