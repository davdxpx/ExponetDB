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
