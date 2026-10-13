import type { Queryable } from '@exponetdb/control-store'
import { type GrantId, InvariantError } from '@exponetdb/kernel'

/**
 * The last use of a grant (Wave 7 order §16, decision 10): the minute and
 * the class of the use, as the data basis of "last used" (Wave 8) and of an
 * "unused for 30 days" finding (Wave 9). Never a log of requests and never
 * an input to a decision: the live role bindings and the grant decide.
 *
 * Classes: an MCP tool's rate class (`read`, `plan`, `apply`, `data`) or
 * `rest` for a call to `/api/v1`.
 */
export const GRANT_USE_CLASSES = ['read', 'plan', 'apply', 'data', 'rest'] as const
export type GrantUseClass = (typeof GRANT_USE_CLASSES)[number]

export interface GrantUse {
  readonly lastUsedAt: string
  readonly useClass: GrantUseClass
}

/**
 * Records a use at the minute of `at`: a write only when the stored minute
 * is older, so the row changes at most once a minute across processes.
 */
export async function recordGrantUse(
  q: Queryable,
  grantId: GrantId,
  useClass: GrantUseClass,
  at: Date,
): Promise<void> {
  await q.query(
    'oauth.grant_use.record',
    `INSERT INTO oauth.grant_last_use AS u (grant_id, last_used_at, use_class)
     VALUES ($1, date_trunc('minute', $2::timestamptz), $3)
     ON CONFLICT (grant_id) DO UPDATE
       SET last_used_at = EXCLUDED.last_used_at, use_class = EXCLUDED.use_class
       WHERE u.last_used_at < EXCLUDED.last_used_at`,
    [grantId, at.toISOString(), useClass],
  )
}

export async function readGrantUse(q: Queryable, grantId: GrantId): Promise<GrantUse | undefined> {
  const { rows } = await q.query(
    'oauth.grant_use.read',
    `SELECT to_char(last_used_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS last_used_at,
            use_class
       FROM oauth.grant_last_use WHERE grant_id = $1`,
    [grantId],
  )
  const row = rows[0]
  if (row === undefined) return undefined
  const useClass = row.text('use_class')
  if (!(GRANT_USE_CLASSES as readonly string[]).includes(useClass)) {
    // The table's CHECK constraint makes this impossible: never invent a class.
    throw new InvariantError('grant_use_class_unknown')
  }
  return { lastUsedAt: row.text('last_used_at'), useClass: useClass as GrantUseClass }
}
