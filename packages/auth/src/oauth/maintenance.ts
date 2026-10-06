import type { ControlStore } from '@exponetdb/control-store'

export interface OAuthPruneResult {
  readonly requests: number
  readonly codes: number
  readonly accessTokens: number
  readonly refreshTokens: number
  readonly deviceCodes: number
  readonly assertions: number
  readonly rateLimits: number
  readonly dcrClients: number
}

/**
 * Worker maintenance of the `oauth` schema (data-retention.md §1): removes
 * what can no longer be used and is no longer needed to recognize misuse.
 * Each delete stays inside what the database guards allow, so a wrong
 * window here fails the run instead of removing live state:
 *
 * - authorization requests, codes and device codes a day after they ended;
 * - access tokens a day after they expired;
 * - refresh tokens 30 days after their grant ended (until then a rotated-out
 *   token presented again is recognized as reuse);
 * - assertion ids an hour after they expired (their replay window is over);
 * - rate-limit buckets idle for a day;
 * - DCR registrations never approved, 7 days after their last change.
 *
 * Grants, clients that were ever approved, service accounts and API keys are
 * never removed. Bounded per run (`limit` rows per kind); idempotent.
 */
export async function pruneOAuthState(
  store: ControlStore,
  limit = 1000,
): Promise<OAuthPruneResult> {
  return store.transaction('oauth.prune', async (tx) => {
    const requests = await tx.query(
      'oauth.prune.requests',
      `DELETE FROM oauth.authorization_requests WHERE request_id IN (
         SELECT request_id FROM oauth.authorization_requests
          WHERE expires_at < clock_timestamp() - interval '1 day'
          ORDER BY expires_at LIMIT $1)`,
      [limit],
    )
    const codes = await tx.query(
      'oauth.prune.codes',
      `DELETE FROM oauth.authorization_codes WHERE grant_id IN (
         SELECT grant_id FROM oauth.authorization_codes
          WHERE expires_at < clock_timestamp() - interval '1 day'
          ORDER BY expires_at LIMIT $1)`,
      [limit],
    )
    const accessTokens = await tx.query(
      'oauth.prune.access_tokens',
      `DELETE FROM oauth.tokens WHERE token_id IN (
         SELECT token_id FROM oauth.tokens
          WHERE kind = 'access' AND expires_at < clock_timestamp() - interval '1 day'
          ORDER BY expires_at LIMIT $1)`,
      [limit],
    )
    const refreshTokens = await tx.query(
      'oauth.prune.refresh_tokens',
      `DELETE FROM oauth.tokens WHERE token_id IN (
         SELECT t.token_id FROM oauth.tokens t
           JOIN oauth.grants g ON g.grant_id = t.grant_id
          WHERE t.kind = 'refresh'
            AND coalesce(g.revoked_at, g.expires_at) < clock_timestamp() - interval '31 days'
          ORDER BY t.token_id DESC LIMIT $1)`,
      [limit],
    )
    const deviceCodes = await tx.query(
      'oauth.prune.device_codes',
      `DELETE FROM oauth.device_codes WHERE device_id IN (
         SELECT device_id FROM oauth.device_codes
          WHERE expires_at < clock_timestamp() - interval '1 day'
          ORDER BY expires_at LIMIT $1)`,
      [limit],
    )
    const assertions = await tx.query(
      'oauth.prune.assertions',
      // The worker may not read the jti hashes (the key), so the batch is cut by expiry.
      `DELETE FROM oauth.client_assertions
        WHERE expires_at < clock_timestamp() - interval '2 hours'
          AND expires_at <= (SELECT max(expires_at) FROM (
                SELECT expires_at FROM oauth.client_assertions
                 WHERE expires_at < clock_timestamp() - interval '2 hours'
                 ORDER BY expires_at LIMIT $1) batch)`,
      [limit],
    )
    const rateLimits = await tx.query(
      'oauth.prune.rate_limits',
      `DELETE FROM oauth.rate_limits WHERE bucket IN (
         SELECT bucket FROM oauth.rate_limits
          WHERE updated_at < clock_timestamp() - interval '1 day'
          ORDER BY updated_at LIMIT $1)`,
      [limit],
    )
    const dcrClients = await tx.query(
      'oauth.prune.dcr_clients',
      `DELETE FROM oauth.clients WHERE client_id IN (
         SELECT client_id FROM oauth.clients
          WHERE registration = 'dcr' AND state IN ('pending', 'rejected') AND approved_at IS NULL
            AND state_changed_at < clock_timestamp() - interval '8 days'
          ORDER BY state_changed_at LIMIT $1)`,
      [limit],
    )
    return {
      requests: requests.rowCount,
      codes: codes.rowCount,
      accessTokens: accessTokens.rowCount,
      refreshTokens: refreshTokens.rowCount,
      deviceCodes: deviceCodes.rowCount,
      assertions: assertions.rowCount,
      rateLimits: rateLimits.rowCount,
      dcrClients: dcrClients.rowCount,
    }
  })
}
