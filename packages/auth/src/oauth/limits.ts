import { createHmac } from 'node:crypto'
import type { Queryable } from '@exponetdb/control-store'
import type { InstallationKeys } from '../keys.ts'

/**
 * Rate limits of the protocol endpoints (oauth.md §5): fixed-window
 * counters in `oauth.rate_limits`, one atomic upsert per hit. A client
 * address appears only as an HMAC under the installation's rate-limit key
 * (never stored in clear); without a known address every such request shares
 * one bucket, never unlimited.
 */
export type OAuthBucketKind =
  | 'dcr-ip'
  | 'dcr-all'
  | 'token-ip'
  | 'assertion'
  | 'device-idn'
  | 'device-ip'
  | 'authorize-ip'

export interface WindowLimit {
  readonly limit: number
  readonly windowSeconds: number
}

export const OAUTH_RATE_LIMITS: Readonly<Record<OAuthBucketKind, WindowLimit>> = {
  'authorize-ip': { limit: 60, windowSeconds: 60 },
  'token-ip': { limit: 120, windowSeconds: 60 },
  assertion: { limit: 60, windowSeconds: 60 },
  'dcr-ip': { limit: 10, windowSeconds: 3600 },
  'dcr-all': { limit: 100, windowSeconds: 3600 },
  'device-ip': { limit: 30, windowSeconds: 600 },
  'device-idn': { limit: 10, windowSeconds: 600 },
}

export interface OAuthBucket {
  readonly kind: OAuthBucketKind
  readonly key: string
}

function keyed(key: Uint8Array, kind: OAuthBucketKind, value: string): string {
  return createHmac('sha256', key)
    .update(`exponetdb/oauth-rate-limit/v1\n${kind}\n${value}`, 'utf8')
    .digest('base64url')
}

/** A bucket of a client address (`dcr-ip`, `token-ip`, `device-ip`, `authorize-ip`). */
export async function addressBucket(
  keys: InstallationKeys,
  kind: 'dcr-ip' | 'token-ip' | 'device-ip' | 'authorize-ip',
  clientIp: string | undefined,
): Promise<OAuthBucket> {
  return { kind, key: `${kind}:${keyed(await keys.rateLimitKey(), kind, clientIp ?? 'unknown')}` }
}

/** A bucket of an entity id (`assertion`: a client, `device-idn`: an identity). */
export function entityBucket(kind: 'assertion' | 'device-idn', id: string): OAuthBucket {
  return { kind, key: `${kind}:${id}` }
}

export const GLOBAL_DCR_BUCKET: OAuthBucket = { kind: 'dcr-all', key: 'dcr-all:global' }

/**
 * Counts one hit and returns 0 when it is within the limit, else the
 * seconds until the window ends. A refused hit is still counted, so a client
 * that keeps hammering stays refused until the window ends.
 */
export async function hit(q: Queryable, bucket: OAuthBucket): Promise<number> {
  const { limit, windowSeconds } = OAUTH_RATE_LIMITS[bucket.kind]
  const { rows } = await q.query(
    'oauth.rate_limit.hit',
    `INSERT INTO oauth.rate_limits AS r (bucket, window_started_at, hits, updated_at)
     VALUES ($1, clock_timestamp(), 1, clock_timestamp())
     ON CONFLICT (bucket) DO UPDATE SET
       hits = CASE WHEN r.window_started_at <= clock_timestamp() - make_interval(secs => $2::int)
                   THEN 1 ELSE least(r.hits + 1, 1000000) END,
       window_started_at = CASE WHEN r.window_started_at <= clock_timestamp() - make_interval(secs => $2::int)
                                THEN clock_timestamp() ELSE r.window_started_at END,
       updated_at = clock_timestamp()
     RETURNING hits,
       greatest(1, ceil(extract(epoch FROM r.window_started_at + make_interval(secs => $2::int)
                                            - clock_timestamp())))::int AS reset`,
    [bucket.key, windowSeconds],
  )
  const row = rows[0]
  if (row === undefined) {
    return windowSeconds
  }
  return row.int('hits') > limit ? row.int('reset') : 0
}
