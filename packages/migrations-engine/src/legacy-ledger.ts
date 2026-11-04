import { canonicalBytes } from '@exponetdb/kernel'
import { sha256Hex } from '@exponetdb/kernel/hash'
import { type CatalogReader, sql, TargetError } from '@exponetdb/postgres'

/**
 * Reads of a target's legacy ledgers that may be refused: run under a savepoint and reported as
 * unreadable, never as empty. Its own module, so the planner reads the Supabase ledger of an
 * observed target (W10-4) without importing the legacy import (and closing a module cycle).
 */
export const LEDGER_PRESENT = sql`SELECT pg_catalog.to_regclass($1) IS NOT NULL AS present`

/**
 * Runs a read under a savepoint: a refused read (a missing privilege on a
 * legacy ledger or a schema) is reported as unreadable instead of aborting
 * the transaction every later read needs.
 */
/**
 * SQLSTATE classes of a failure that may not happen again: a lost connection
 * (08), a serialization failure or deadlock (40), insufficient resources
 * (53), an object in use or a lock not available (55), a cancel, a timeout
 * or a shutdown (57), a system error (58).
 */
const TRANSIENT_CLASSES = new Set(['08', '40', '53', '55', '57', '58'])

/**
 * Whether a read that raised says something about what can be read on the
 * target (a privilege the observer lacks, a name the server refuses, a row
 * the engine cannot decode), so the same read fails the same way again: it
 * is `unreadable`. A failure that may pass on its own (the target
 * unreachable, a timeout, a lock wait, a cancel) is re-raised, so the run
 * errors and can be retried (follow-up 3 re-review).
 */
export function readsAsUnreadable(error: unknown): boolean {
  if (!(error instanceof TargetError)) return true
  if (
    error.code !== 'PERMISSION_DENIED' &&
    error.code !== 'QUERY_PARSE_ERROR' &&
    error.code !== 'TARGET_SQL_ERROR'
  ) {
    return false
  }
  return error.sqlstate === undefined || !TRANSIENT_CLASSES.has(error.sqlstate.slice(0, 2))
}

export async function guarded<T>(
  reader: CatalogReader,
  fn: () => Promise<T>,
): Promise<T | undefined> {
  await reader.query(sql`SAVEPOINT exdb_import_read`)
  try {
    const value = await fn()
    await reader.query(sql`RELEASE SAVEPOINT exdb_import_read`)
    return value
  } catch (error) {
    if (!readsAsUnreadable(error)) throw error
    await reader.query(sql`ROLLBACK TO SAVEPOINT exdb_import_read`)
    return undefined
  }
}

/** What an observed target's plan binds of its Supabase ledger (W10-4): bound, never matched. */
export type LegacyLedgerDigest =
  | {
      readonly source: 'supabase'
      readonly status: 'read'
      /** `sha256:` of the JCS list of `{version, name}` in version order. */
      readonly digest: string
      readonly entries: number
    }
  | { readonly source: 'supabase'; readonly status: 'absent' | 'unreadable' }

/** Names only: `statements` (the applied SQL) is never read, so a column grant on these two is enough. */
const SUPABASE_NAMES = sql`SELECT version::text AS version, coalesce(name::text, '') AS name
  FROM supabase_migrations.schema_migrations ORDER BY version`

/**
 * The digest and the count of `supabase_migrations.schema_migrations` as the observer may read
 * them (the optional ledger part of the observer script, ADR-0039). A ledger the observer may not
 * read is `unreadable`, never an empty list; a database without one says `absent`.
 */
export async function legacyLedgerDigest(reader: CatalogReader): Promise<LegacyLedgerDigest> {
  const read = await guarded(reader, async () => {
    const present = await reader.query(LEDGER_PRESENT, ['supabase_migrations.schema_migrations'])
    if (present[0]?.bool('present') !== true) return 'absent' as const
    return (await reader.query(SUPABASE_NAMES)).map((r) => ({
      version: r.text('version'),
      name: r.text('name'),
    }))
  })
  if (read === undefined) return { source: 'supabase', status: 'unreadable' }
  if (read === 'absent') return { source: 'supabase', status: 'absent' }
  const bytes = canonicalBytes(read)
  if (!bytes.ok) return { source: 'supabase', status: 'unreadable' }
  return {
    source: 'supabase',
    status: 'read',
    digest: `sha256:${sha256Hex(bytes.value)}`,
    entries: read.length,
  }
}
