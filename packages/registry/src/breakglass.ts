import type { Queryable, Tx } from '@exponetdb/control-store'
import { isJsonArray, isJsonObject } from '@exponetdb/kernel'
import type { PlanRecord } from '@exponetdb/operations'
import type { BreakGlass } from '@exponetdb/policy'

/**
 * Break-glass grants ([operations-engine.md §8](../../../exponetdb-docs/02-control-plane/operations-engine.md#8-break-glass)):
 * a person's time-boxed override of named rules on one target, recorded
 * with a reason. A plan made under a grant carries it in its content; the
 * policy engine overrides exactly the named rules that allow it (and only
 * for a person outside MCP), and lists them as a `break_glass`
 * requirement. Accepting such a plan uses the grant once: it must still be
 * the acceptor's own, on the plan's target, unexpired, unrevoked and not
 * used up. An expired grant leaves its unused plans unacceptable.
 */
export interface BreakGlassGrant {
  readonly grantId: string
  readonly identityId: string
  readonly targetId: string
  readonly rules: readonly string[]
  readonly reason: string
  readonly createdAt: string
  readonly expiresAt: string
  readonly maxUses: number | null
  readonly uses: number
  readonly revokedAt: string | null
  readonly reviewedAt: string | null
}

const COLUMNS = `grant_id, identity_id, target_id, to_jsonb(rules) AS rules, reason,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
  to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_at,
  max_uses, uses,
  to_char(revoked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS revoked_at,
  to_char(reviewed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS reviewed_at`

type Row = Awaited<ReturnType<Queryable['query']>>['rows'][number]

function grantOf(row: Row): BreakGlassGrant {
  const rules = row.json('rules')
  return {
    grantId: row.text('grant_id'),
    identityId: row.text('identity_id'),
    targetId: row.text('target_id'),
    rules: Array.isArray(rules) ? rules.filter((r): r is string => typeof r === 'string') : [],
    reason: row.text('reason'),
    createdAt: row.text('created_at'),
    expiresAt: row.text('expires_at'),
    maxUses: row.intOrNull('max_uses'),
    uses: row.int('uses'),
    revokedAt: row.textOrNull('revoked_at'),
    reviewedAt: row.textOrNull('reviewed_at'),
  }
}

export async function readBreakGlassGrant(
  q: Queryable,
  grantId: string,
): Promise<BreakGlassGrant | undefined> {
  const { rows } = await q.query(
    'registry.breakglass.read',
    `SELECT ${COLUMNS} FROM breakglass.grants WHERE grant_id = $1`,
    [grantId],
  )
  const row = rows[0]
  return row === undefined ? undefined : grantOf(row)
}

/** Whether a person may use the grant on the target now. */
export function grantUsable(
  grant: BreakGlassGrant,
  identityId: string,
  targetId: string,
  nowMs: number,
): boolean {
  return (
    grant.identityId === identityId &&
    grant.targetId === targetId &&
    grant.revokedAt === null &&
    Date.parse(grant.expiresAt) > nowMs &&
    (grant.maxUses === null || grant.uses < grant.maxUses)
  )
}

export async function recordBreakGlassGrant(
  tx: Tx,
  input: {
    readonly grantId: string
    readonly identityId: string
    readonly targetId: string
    readonly rules: readonly string[]
    readonly reason: string
    readonly durationMinutes: number
    readonly maxUses: number | null
  },
): Promise<BreakGlassGrant> {
  const { rows } = await tx.query(
    'registry.breakglass.insert',
    `INSERT INTO breakglass.grants
       (grant_id, identity_id, target_id, rules, reason, created_at, expires_at, max_uses)
     SELECT $1, $2, $3, ARRAY(SELECT pg_catalog.jsonb_array_elements_text($4::jsonb)), $5,
            now, now + make_interval(mins => $6::int), $7
       FROM (SELECT clock_timestamp() AS now) t
     RETURNING ${COLUMNS}`,
    [
      input.grantId,
      input.identityId,
      input.targetId,
      JSON.stringify(input.rules),
      input.reason,
      input.durationMinutes,
      input.maxUses,
    ],
  )
  const row = rows[0]
  if (row === undefined) throw new Error('the grant was not recorded')
  return grantOf(row)
}

/** Counts one use if the grant is still usable at the database's time; false when it is not. */
export async function useBreakGlassGrant(
  tx: Tx,
  grantId: string,
  identityId: string,
  targetId: string,
): Promise<boolean> {
  const { rows } = await tx.query(
    'registry.breakglass.use',
    `UPDATE breakglass.grants SET uses = uses + 1
      WHERE grant_id = $1 AND identity_id = $2 AND target_id = $3
        AND revoked_at IS NULL AND expires_at > clock_timestamp()
        AND (max_uses IS NULL OR uses < max_uses)
     RETURNING uses`,
    [grantId, identityId, targetId],
  )
  return rows.length === 1
}

// ----- list and review (Wave 8, order §9) -----

export type BreakGlassGrantState = 'active' | 'expired' | 'revoked' | 'used_up'

/** A grant as the owners and admins who review it see it: its target, derived state and review. */
export interface BreakGlassGrantRecord {
  readonly grantId: string
  readonly target: { readonly targetId: string; readonly path: string; readonly tier: string }
  readonly state: BreakGlassGrantState
  readonly activatedBy: { readonly identityId: string }
  readonly rules: readonly string[]
  readonly reason: string
  readonly createdAt: string
  readonly expiresAt: string
  readonly maxUses: number | null
  readonly uses: number
  readonly revokedAt: string | null
  readonly review: {
    readonly reviewedBy: { readonly identityId: string }
    readonly reviewedAt: string
    readonly note: string
  } | null
}

const TS = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`

/**
 * The state of a grant at the instant `c.now` (one database clock reading per
 * statement): a recorded revocation first, then the end of the time box, then
 * a counted maximum of uses. The order matters only for display: a grant in
 * any state but `active` can no longer be used (`grantUsable`).
 */
const STATE = `CASE WHEN g.revoked_at IS NOT NULL THEN 'revoked'
                    WHEN g.expires_at <= c.now THEN 'expired'
                    WHEN g.max_uses IS NOT NULL AND g.uses >= g.max_uses THEN 'used_up'
                    ELSE 'active' END`

const RECORD_COLUMNS = `g.grant_id, g.identity_id, g.target_id, t.path AS target_path, t.tier AS target_tier,
  ${STATE} AS state, to_jsonb(g.rules) AS rules, g.reason,
  ${TS('g.created_at')} AS created_at, ${TS('g.expires_at')} AS expires_at,
  g.max_uses, g.uses, ${TS('g.revoked_at')} AS revoked_at,
  ${TS('g.reviewed_at')} AS reviewed_at, g.reviewed_by, g.review_note,
  ${TS('c.now')} AS observed_at`

function recordOf(row: Row): BreakGlassGrantRecord {
  const rules = row.json('rules')
  const reviewedAt = row.textOrNull('reviewed_at')
  const reviewedBy = row.textOrNull('reviewed_by')
  const note = row.textOrNull('review_note')
  return {
    grantId: row.text('grant_id'),
    target: {
      targetId: row.text('target_id'),
      path: row.text('target_path'),
      tier: row.text('target_tier'),
    },
    state: row.text('state') as BreakGlassGrantState,
    activatedBy: { identityId: row.text('identity_id') },
    rules: Array.isArray(rules) ? rules.filter((r): r is string => typeof r === 'string') : [],
    reason: row.text('reason'),
    createdAt: row.text('created_at'),
    expiresAt: row.text('expires_at'),
    maxUses: row.intOrNull('max_uses'),
    uses: row.int('uses'),
    revokedAt: row.textOrNull('revoked_at'),
    // The bundle's CHECK keeps the three review columns set together or not at all.
    review:
      reviewedAt === null || reviewedBy === null || note === null
        ? null
        : { reviewedBy: { identityId: reviewedBy }, reviewedAt, note },
  }
}

/**
 * One page of grants, newest first (keyset on the grant id, whose ULID
 * carries the activation time), with every state derived at one database
 * clock reading, returned as `observedAt`. Filters: a state, whether the
 * review is open or done, and a target. Reads only; nothing here can
 * activate, extend or use a grant.
 */
export async function listBreakGlassGrants(
  q: Queryable,
  filter: {
    readonly state?: BreakGlassGrantState | undefined
    readonly review?: 'open' | 'done' | undefined
    readonly targetId?: string | undefined
    readonly after: string | null
    readonly limit: number
  },
): Promise<{
  readonly items: BreakGlassGrantRecord[]
  readonly observedAt: string
  readonly more: boolean
  readonly last: string | null
}> {
  const { rows } = await q.query(
    'registry.breakglass.list',
    // One row with only the clock when nothing matches, so the time is always the database's.
    `WITH c AS (SELECT clock_timestamp() AS now)
     SELECT ${RECORD_COLUMNS}
       FROM c
       LEFT JOIN (breakglass.grants g JOIN registry.targets t ON t.target_id = g.target_id)
         ON ($1::text IS NULL OR g.grant_id < $1)
        AND ($2::text IS NULL OR g.target_id = $2)
        AND ($3::text IS NULL OR ($3 = 'open') = (g.reviewed_at IS NULL))
        AND ($4::text IS NULL OR ${STATE} = $4)
      ORDER BY g.grant_id DESC NULLS LAST
      LIMIT $5`,
    [
      filter.after,
      filter.targetId ?? null,
      filter.review ?? null,
      filter.state ?? null,
      filter.limit + 1,
    ],
  )
  const first = rows[0]
  if (first === undefined) throw new Error('the clock row is missing')
  const observedAt = first.text('observed_at')
  const found = rows.filter((r) => r.textOrNull('grant_id') !== null)
  const items = found.slice(0, filter.limit).map(recordOf)
  return {
    items,
    observedAt,
    more: found.length > filter.limit,
    last: items.at(-1)?.grantId ?? null,
  }
}

/** One grant as {@link listBreakGlassGrants} shows it, or undefined. */
export async function readBreakGlassRecord(
  q: Queryable,
  grantId: string,
): Promise<BreakGlassGrantRecord | undefined> {
  const { rows } = await q.query(
    'registry.breakglass.read_record',
    `WITH c AS (SELECT clock_timestamp() AS now)
     SELECT ${RECORD_COLUMNS}
       FROM breakglass.grants g
       JOIN registry.targets t ON t.target_id = g.target_id
       CROSS JOIN c
      WHERE g.grant_id = $1`,
    [grantId],
  )
  const row = rows[0]
  return row === undefined ? undefined : recordOf(row)
}

export type BreakGlassReviewOutcome = 'reviewed' | 'not_found' | 'already_reviewed' | 'active'

/**
 * Records the post-incident review into the review columns of the frozen
 * bundle, at most once: the UPDATE matches only an unreviewed grant that is
 * no longer active at the database's time, so of two concurrent reviews the
 * second finds the row reviewed after the first commits and changes
 * nothing; the bundle's guard trigger refuses any later change of a
 * recorded review. Writes nothing but `reviewed_at`, `reviewed_by` and
 * `review_note` (the only columns besides `uses` and `revoked_at` that
 * `exdb_serve` may update).
 */
export async function reviewBreakGlassGrant(
  tx: Tx,
  input: { readonly grantId: string; readonly reviewerId: string; readonly note: string },
): Promise<BreakGlassReviewOutcome> {
  const { rows } = await tx.query(
    'registry.breakglass.review',
    `UPDATE breakglass.grants g
        SET reviewed_at = clock_timestamp(), reviewed_by = $2, review_note = $3
      WHERE g.grant_id = $1 AND g.reviewed_at IS NULL
        AND (g.revoked_at IS NOT NULL OR g.expires_at <= clock_timestamp()
             OR (g.max_uses IS NOT NULL AND g.uses >= g.max_uses))
     RETURNING g.grant_id`,
    [input.grantId, input.reviewerId, input.note],
  )
  if (rows.length === 1) return 'reviewed'
  const current = await readBreakGlassGrant(tx, input.grantId)
  if (current === undefined) return 'not_found'
  return current.reviewedAt !== null ? 'already_reviewed' : 'active'
}

/** The grant a stored plan was made under (its content's `breakGlass`), if any. */
export function planBreakGlass(plan: Pick<PlanRecord, 'body'>): BreakGlass | undefined {
  const content = plan.body['content']
  const bg = isJsonObject(content) ? content['breakGlass'] : undefined
  if (!isJsonObject(bg)) return undefined
  const grantId = bg['grantId']
  const rules = bg['rules']
  if (typeof grantId !== 'string' || !isJsonArray(rules)) return undefined
  return { grantId, rules: rules.filter((r): r is string => typeof r === 'string') }
}
