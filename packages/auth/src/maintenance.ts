import type { ControlStore } from '@exponetdb/control-store'

/**
 * Worker maintenance of the auth schema (data-retention.md): removes
 * ceremony challenges that ended more than two days ago (the database
 * guard allows a day; the extra day covers child challenges, which the
 * delete cascades to) and rate-limit buckets untouched for a day (their
 * 15-minute window and lock are long over). Bounded per run; idempotent.
 */
export async function pruneAuthState(
  store: ControlStore,
  limit = 1000,
): Promise<{ readonly challenges: number; readonly rateLimits: number }> {
  return store.transaction('auth.prune', async (tx) => {
    const challenges = await tx.query(
      'auth.prune.challenges',
      `DELETE FROM auth.challenges WHERE challenge_id IN (
         SELECT challenge_id FROM auth.challenges
          WHERE expires_at < clock_timestamp() - interval '2 days'
          ORDER BY expires_at LIMIT $1)`,
      [limit],
    )
    const rateLimits = await tx.query(
      'auth.prune.rate_limits',
      `DELETE FROM auth.rate_limits WHERE bucket IN (
         SELECT bucket FROM auth.rate_limits
          WHERE updated_at < clock_timestamp() - interval '1 day'
          ORDER BY updated_at LIMIT $1)`,
      [limit],
    )
    return { challenges: challenges.rowCount, rateLimits: rateLimits.rowCount }
  })
}
