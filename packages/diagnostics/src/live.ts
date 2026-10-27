import { sql, type TargetSession } from '@exponetdb/postgres'
import type { TargetRecord } from '@exponetdb/registry'
import { DiagnosticsError } from './errors.ts'
import { requireIdentity } from './identity.ts'
import type { SnapshotDeps } from './snapshots.ts'

/**
 * The live diagnostic path of Wave 9 Part B (statement samples, table
 * statistics, advisors, the session reads of a cancel or terminate plan):
 * engine-authored, read-only SQL on an observer session
 * ([sql-execution-security.md §1](../../../exponetdb-docs/03-database-model/sql-execution-security.md#1-engine-authored-sql-introspection-diagnostics-operator-actions),
 * performance.md §6), exactly the path the session list reads through
 * (`activity.ts`): the target must be active or suspended, the identity
 * marker is checked first, and the session's statement timeout is 5 s and
 * its lock timeout 1 s, so a diagnostic never waits on the locks of the
 * database it diagnoses.
 */
export const DIAGNOSTIC_STATEMENT_TIMEOUT_MS = 5000
export const DIAGNOSTIC_LOCK_TIMEOUT_MS = 1000

const LIMITS = sql`SELECT pg_catalog.set_config('statement_timeout', $1, false) AS s,
       pg_catalog.set_config('lock_timeout', $2, false) AS l`

/** Sets the diagnostic timeouts on an opened session (observer or operator). */
export async function diagnosticLimits(session: TargetSession): Promise<void> {
  await session.query(LIMITS, [
    `${DIAGNOSTIC_STATEMENT_TIMEOUT_MS}ms`,
    `${DIAGNOSTIC_LOCK_TIMEOUT_MS}ms`,
  ])
}

const STATS_VISIBLE = sql`SELECT pg_catalog.pg_has_role('pg_read_all_stats', 'USAGE') AS visible`

/** Whether the session's role may read other roles' statistics (`pg_read_all_stats`). */
export async function statsVisible(session: TargetSession): Promise<boolean> {
  const row = (await session.query(STATS_VISIBLE))[0]
  return row?.bool('visible') === true
}

/** Runs `read` on an identity-checked observer session of the target with the diagnostic limits. */
export async function onObserver<T>(
  deps: SnapshotDeps,
  target: TargetRecord,
  purpose: string,
  read: (session: TargetSession) => Promise<T>,
): Promise<T> {
  if (target.state !== 'active' && target.state !== 'suspended') {
    throw new DiagnosticsError(
      target.state === 'decommissioned' ? 'TARGET_NOT_FOUND' : 'TARGET_UNAVAILABLE',
    )
  }
  const opened = await deps.connector.forTarget(target, 'observer', `${purpose}/${target.targetId}`)
  try {
    await requireIdentity(opened.session, target, deps.installationId)
    await diagnosticLimits(opened.session)
    return await read(opened.session)
  } finally {
    await opened.session.close()
  }
}

/** UTC text of a timestamp column with microseconds (exact round trips; never a JS `Date`). */
export const usText = (column: string): string =>
  `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`

/** Milliseconds of a `usText` value. */
export function msOf(text: string): number {
  const n = Date.parse(text.replace(/(\.\d{3})\d+Z$/, '$1Z'))
  if (!Number.isFinite(n)) throw new DiagnosticsError('INTERNAL')
  return n
}

/** The contract's timestamp form (milliseconds, `Z`) of a `usText` value. */
export function isoOf(text: string): string {
  return new Date(msOf(text)).toISOString()
}

/**
 * A text array as one bind parameter (`$n::text[]`): target sessions bind
 * scalars only. Every element is double-quoted with `\` and `"` escaped, so
 * no value can end its element or the array.
 */
export function arrayParam(values: readonly string[]): string {
  return `{${values.map((v) => `"${v.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`).join(',')}}`
}
