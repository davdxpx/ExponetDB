import { createHmac } from 'node:crypto'
import type { Queryable, Tx } from '@exponetdb/control-store'
import type { IdentityId } from '@exponetdb/kernel'
import type { InstallationKeys } from './keys.ts'

/**
 * Authentication rate limits (identity.md §2). Failures are counted per
 * bucket:
 *
 * - `acct:` the account address as typed (normalized e-mail), whether or
 *   not an account exists, so the limit itself reveals nothing;
 * - `ip:` the client address;
 * - `idn:` an identity, for the second factor and re-authentication.
 *
 * Account and client addresses are stored only as HMAC-SHA-256 under the
 * installation's rate-limit key (separate from the audit pseudonym key);
 * a plain hash of an IPv4 address could be reversed by enumeration.
 *
 * After `delayAfter` failures in a window each further failure blocks the
 * bucket for an exponentially growing delay (1, 2, 4 … seconds, capped);
 * at `maxFailures` the bucket is locked for `lockSeconds`. Requests during
 * a block are refused with `RATE_LIMITED` before any credential is
 * checked. Counting is one atomic upsert per bucket. The password step
 * locks its buckets' rows and counts the attempt before the password is
 * checked (`lockBuckets`, then a failure; a right password gives it back),
 * so concurrent guesses take turns instead of all passing the check before
 * the first failure is counted. A successful sign-in clears the account
 * and identity buckets, never the client bucket.
 */
export type BucketKind = 'acct' | 'ip' | 'idn'

export interface RateLimitPolicy {
  readonly windowSeconds: number
  readonly delayAfter: number
  readonly maxDelaySeconds: number
  readonly maxFailures: number
  readonly lockSeconds: number
}

export const RATE_LIMITS: Readonly<Record<BucketKind, RateLimitPolicy>> = {
  acct: {
    windowSeconds: 900,
    delayAfter: 3,
    maxDelaySeconds: 30,
    maxFailures: 10,
    lockSeconds: 900,
  },
  idn: {
    windowSeconds: 900,
    delayAfter: 3,
    maxDelaySeconds: 30,
    maxFailures: 10,
    lockSeconds: 900,
  },
  ip: {
    windowSeconds: 900,
    delayAfter: 20,
    maxDelaySeconds: 30,
    maxFailures: 100,
    lockSeconds: 900,
  },
}

/** Failures are written to the audit in aggregate: at 5, then each time the count doubles, and at the lock. */
const FIRST_AUDIT_AT = 5

export interface Bucket {
  readonly kind: BucketKind
  readonly key: string
  readonly identityId?: IdentityId
}

function keyed(key: Uint8Array, kind: BucketKind, value: string): string {
  return createHmac('sha256', key)
    .update(`exponetdb/auth-rate-limit/v1\n${kind}\n${value}`, 'utf8')
    .digest('base64url')
}

export async function accountBucket(
  keys: InstallationKeys,
  normalizedEmail: string,
): Promise<Bucket> {
  return { kind: 'acct', key: `acct:${keyed(await keys.rateLimitKey(), 'acct', normalizedEmail)}` }
}

export async function clientBucket(
  keys: InstallationKeys,
  clientIp: string | undefined,
): Promise<Bucket> {
  // Without a known address every such request shares one bucket: never unlimited.
  return {
    kind: 'ip',
    key: `ip:${keyed(await keys.rateLimitKey(), 'ip', clientIp ?? 'unknown')}`,
  }
}

export function identityBucket(identityId: IdentityId): Bucket {
  return { kind: 'idn', key: `idn:${identityId}`, identityId }
}

/** The longest remaining block of the buckets in seconds, or 0 when none is blocked. */
export async function blockedFor(q: Queryable, buckets: readonly Bucket[]): Promise<number> {
  if (buckets.length === 0) {
    return 0
  }
  const { rows } = await q.query(
    'auth.rate_limit.check',
    `SELECT coalesce(max(ceil(extract(epoch FROM locked_until - clock_timestamp()))), 0)::int AS wait
       FROM auth.rate_limits WHERE bucket = ANY($1::text[]) AND locked_until > clock_timestamp()`,
    [buckets.map((b) => b.key)],
  )
  return Math.max(0, rows[0]?.int('wait') ?? 0)
}

/**
 * Locks the buckets' rows for the caller's transaction (creating missing
 * ones) and returns the longest remaining block in seconds, or 0.
 * Concurrent attempts on a bucket wait here for each other.
 */
export async function lockBuckets(tx: Tx, buckets: readonly Bucket[]): Promise<number> {
  const keys = [...new Set(buckets.map((b) => b.key))].sort()
  if (keys.length === 0) {
    return 0
  }
  const { rows } = await tx.query(
    'auth.rate_limit.lock',
    `INSERT INTO auth.rate_limits AS r (bucket, window_started_at, failures, updated_at)
     SELECT k, clock_timestamp(), 0, clock_timestamp() FROM unnest($1::text[]) AS k ORDER BY k
     ON CONFLICT (bucket) DO UPDATE SET updated_at = clock_timestamp()
     RETURNING greatest(coalesce(ceil(extract(epoch FROM r.locked_until - clock_timestamp())), 0), 0)::int AS wait`,
    [keys],
  )
  return rows.reduce((max, row) => Math.max(max, row.int('wait')), 0)
}

/** Gives back an attempt counted in advance that turned out right (never below zero; blocks stay). */
export async function refundAttempt(tx: Tx, buckets: readonly Bucket[]): Promise<void> {
  await tx.query(
    'auth.rate_limit.refund',
    `UPDATE auth.rate_limits SET failures = greatest(failures - 1, 0), updated_at = clock_timestamp()
      WHERE bucket = ANY($1::text[])`,
    [buckets.map((b) => b.key)],
  )
}

export interface FailureRecord {
  readonly bucket: Bucket
  readonly failures: number
  /** This failure started a lock. */
  readonly lockedNow: boolean
  /** This failure is due for an aggregated audit event. */
  readonly auditDue: boolean
}

export async function recordFailure(tx: Tx, bucket: Bucket): Promise<FailureRecord> {
  const policy = RATE_LIMITS[bucket.kind]
  const counted = await tx.query(
    'auth.rate_limit.count',
    `INSERT INTO auth.rate_limits AS r (bucket, window_started_at, failures, last_failure_at, updated_at)
     VALUES ($1, clock_timestamp(), 1, clock_timestamp(), clock_timestamp())
     ON CONFLICT (bucket) DO UPDATE SET
       failures = CASE WHEN r.window_started_at < clock_timestamp() - make_interval(secs => $2::int)
                       THEN 1 ELSE r.failures + 1 END,
       audited_failures = CASE WHEN r.window_started_at < clock_timestamp() - make_interval(secs => $2::int)
                               THEN 0 ELSE r.audited_failures END,
       locked_until = CASE WHEN r.window_started_at < clock_timestamp() - make_interval(secs => $2::int)
                           THEN NULL ELSE r.locked_until END,
       window_started_at = CASE WHEN r.window_started_at < clock_timestamp() - make_interval(secs => $2::int)
                                THEN clock_timestamp() ELSE r.window_started_at END,
       last_failure_at = clock_timestamp(),
       updated_at = clock_timestamp()
     RETURNING failures, audited_failures`,
    [bucket.key, policy.windowSeconds],
  )
  const row = counted.rows[0]
  const failures = row?.int('failures') ?? 1
  const audited = row?.int('audited_failures') ?? 0
  const lockedNow = failures === policy.maxFailures
  const auditDue =
    lockedNow || (failures >= FIRST_AUDIT_AT && failures >= Math.max(FIRST_AUDIT_AT, audited * 2))
  const delay =
    failures >= policy.maxFailures
      ? policy.lockSeconds
      : failures >= policy.delayAfter
        ? Math.min(2 ** (failures - policy.delayAfter), policy.maxDelaySeconds)
        : 0
  await tx.query(
    'auth.rate_limit.block',
    `UPDATE auth.rate_limits
        SET locked_until = CASE WHEN $2::int > 0
                                THEN greatest(coalesce(locked_until, clock_timestamp()),
                                              clock_timestamp() + make_interval(secs => $2::int))
                                ELSE locked_until END,
            audited_failures = CASE WHEN $3 THEN failures ELSE audited_failures END
      WHERE bucket = $1`,
    [bucket.key, delay, auditDue],
  )
  return { bucket, failures, lockedNow, auditDue }
}

/** A successful sign-in or re-authentication clears these buckets (never a client bucket). */
export async function clearBuckets(tx: Tx, buckets: readonly Bucket[]): Promise<void> {
  const keys = buckets.filter((b) => b.kind !== 'ip').map((b) => b.key)
  if (keys.length === 0) {
    return
  }
  await tx.query(
    'auth.rate_limit.clear',
    `UPDATE auth.rate_limits SET failures = 0, audited_failures = 0, locked_until = NULL,
            window_started_at = clock_timestamp(), updated_at = clock_timestamp()
      WHERE bucket = ANY($1::text[])`,
    [keys],
  )
}
