import type { ExpectedMigration } from './bundles.ts'
import type { Queryable } from './store.ts'

/**
 * The Control Store's own migration ledger (`control.schema_migrations`) and
 * verification history (`control.migration_verifications`), modeled on the
 * target ledger ([ledger.md §2](../../../exponetdb-docs/04-migrations/ledger.md#2-schema-exponetdb-in-each-target-database))
 * without target identity. Both tables are append-only; the current
 * verification status of a migration is its latest verification row.
 * No SQL content is stored, only ids, digests and outcomes.
 */
export interface LedgerEntry {
  readonly migrationId: string
  readonly name: string
  readonly checksum: string
  readonly verifyDigest: string
  readonly appliedSeq: number
  readonly appliedAt: Date
}

export interface LatestVerification {
  readonly migrationId: string
  readonly verifyDigest: string
  readonly status: 'passed' | 'failed' | 'error'
  readonly finishedAt: Date
}

export interface Ledger {
  /** False when the Control Store has no ledger yet (fresh database). */
  readonly exists: boolean
  readonly entries: readonly LedgerEntry[]
  readonly latest: ReadonlyMap<string, LatestVerification>
}

function verificationStatus(value: string): LatestVerification['status'] {
  if (value === 'passed' || value === 'failed' || value === 'error') {
    return value
  }
  return 'error'
}

export async function readLedger(q: Queryable): Promise<Ledger> {
  const probe = await q.query(
    'migration.ledger.probe',
    `SELECT to_regclass('control.schema_migrations') IS NOT NULL AS ledger,
            to_regclass('control.migration_verifications') IS NOT NULL AS verifications`,
  )
  const row = probe.rows[0]
  if (row === undefined || !row.bool('ledger')) {
    return { exists: false, entries: [], latest: new Map() }
  }
  const entries = await q.query(
    'migration.ledger.read',
    `SELECT migration_id, name, checksum, verify_digest, applied_seq, applied_at
       FROM control.schema_migrations ORDER BY applied_seq`,
  )
  const latest = new Map<string, LatestVerification>()
  if (row.bool('verifications')) {
    const v = await q.query(
      'migration.ledger.read_verifications',
      `SELECT DISTINCT ON (migration_id) migration_id, verify_digest, status, finished_at
         FROM control.migration_verifications
        ORDER BY migration_id, verification_seq DESC`,
    )
    for (const r of v.rows) {
      latest.set(r.text('migration_id'), {
        migrationId: r.text('migration_id'),
        verifyDigest: r.text('verify_digest'),
        status: verificationStatus(r.text('status')),
        finishedAt: r.date('finished_at'),
      })
    }
  }
  return {
    exists: true,
    entries: entries.rows.map((r) => ({
      migrationId: r.text('migration_id'),
      name: r.text('name'),
      checksum: r.text('checksum'),
      verifyDigest: r.text('verify_digest'),
      appliedSeq: r.int('applied_seq'),
      appliedAt: r.date('applied_at'),
    })),
    latest,
  }
}

/**
 * The Control Store schema compared with what this release expects. Every
 * expected id is checked with its checksum and verification state, never
 * "the latest id" or a file name (DAG, and the REOSA lesson of missing
 * migrations behind a fail-soft read).
 *
 * Order of precedence: `mismatch` (an applied id with another checksum: hard
 * failure), `newer` (the ledger has ids this release does not know: refuse to
 * start, no downgrade), `uninitialized`, `pending`, `unverified`, `current`.
 */
export type SchemaState =
  | { readonly status: 'current' }
  | { readonly status: 'uninitialized' }
  | { readonly status: 'pending'; readonly missing: readonly string[] }
  | { readonly status: 'unverified'; readonly ids: readonly string[] }
  | { readonly status: 'newer'; readonly unknown: readonly string[] }
  | { readonly status: 'mismatch'; readonly ids: readonly string[] }

export function compareSchema(expected: readonly ExpectedMigration[], ledger: Ledger): SchemaState {
  const byId = new Map(expected.map((e) => [e.id, e]))
  const applied = new Map(ledger.entries.map((e) => [e.migrationId, e]))
  const mismatch = ledger.entries
    .filter((e) => {
      const want = byId.get(e.migrationId)
      return want !== undefined && want.checksum !== e.checksum
    })
    .map((e) => e.migrationId)
  if (mismatch.length > 0) {
    return { status: 'mismatch', ids: mismatch.sort() }
  }
  const unknown = ledger.entries.filter((e) => !byId.has(e.migrationId)).map((e) => e.migrationId)
  if (unknown.length > 0) {
    return { status: 'newer', unknown: unknown.sort() }
  }
  if (!ledger.exists) {
    return { status: 'uninitialized' }
  }
  const missing = expected.filter((e) => !applied.has(e.id)).map((e) => e.id)
  if (missing.length > 0) {
    return { status: 'pending', missing }
  }
  const unverified = expected
    .filter((e) => {
      const v = ledger.latest.get(e.id)
      return v === undefined || v.status !== 'passed' || v.verifyDigest !== e.verifyDigest
    })
    .map((e) => e.id)
  if (unverified.length > 0) {
    return { status: 'unverified', ids: unverified }
  }
  return { status: 'current' }
}

export async function schemaState(
  q: Queryable,
  expected: readonly ExpectedMigration[],
): Promise<SchemaState> {
  return compareSchema(expected, await readLedger(q))
}
