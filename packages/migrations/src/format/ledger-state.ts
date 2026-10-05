import { compareUtf8, err, ok, type Result } from '@exponetdb/kernel'
import { sha256Hex } from '@exponetdb/kernel/hash'

/**
 * `ls1` ledger state hash ([ledger.md §3](../../../../exponetdb-docs/04-migrations/ledger.md#3-derived-values)).
 * FROZEN AT G1. A pure function over ledger rows: independent of row order,
 * no database access.
 */

export interface LedgerRow {
  /** ULID, `legacy:<identity>` or `baseline:<slug>`. */
  readonly migrationId: string
  readonly checksum: string
  /** `reverted_at IS NOT NULL`. */
  readonly reverted: boolean
}

export type LedgerStateRefusal =
  | { readonly code: 'invalid_migration_id'; readonly index: number }
  | { readonly code: 'invalid_checksum'; readonly index: number }
  | { readonly code: 'duplicate_migration_id'; readonly migrationId: string }
  | { readonly code: 'invalid_baseline_id' }

export interface LedgerState {
  /** `sha256:ls1:<hex>` */
  readonly hash: string
  /** The exact text that was hashed. */
  readonly hashInput: string
}

const BASELINE_ID = /^baseline:[a-z0-9]+(-[a-z0-9]+)*$/
const BASELINE_SLUG_MAX = 64

/** No code point up to U+0020 and no U+007F, so the separators cannot occur inside a field. */
function isField(value: string): boolean {
  if (value.length === 0) {
    return false
  }
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i)
    if (c <= 0x20 || c === 0x7f) {
      return false
    }
  }
  return value.isWellFormed()
}

export function ledgerStateHash(
  rows: readonly LedgerRow[],
  baselineId: string | null,
): Result<LedgerState, LedgerStateRefusal> {
  for (const [index, row] of rows.entries()) {
    if (!isField(row.migrationId)) {
      return err({ code: 'invalid_migration_id', index })
    }
    if (!isField(row.checksum)) {
      return err({ code: 'invalid_checksum', index })
    }
  }
  const seen = new Set<string>()
  for (const row of rows) {
    if (seen.has(row.migrationId)) {
      return err({ code: 'duplicate_migration_id', migrationId: row.migrationId })
    }
    seen.add(row.migrationId)
  }
  if (
    baselineId !== null &&
    (!BASELINE_ID.test(baselineId) || baselineId.length > 'baseline:'.length + BASELINE_SLUG_MAX)
  ) {
    return err({ code: 'invalid_baseline_id' })
  }
  const lines = [...rows]
    .sort((a, b) => compareUtf8(a.migrationId, b.migrationId))
    .map((r) => `${r.migrationId} ${r.checksum} ${r.reverted ? 'R' : 'A'}\n`)
  const hashInput = `${lines.join('')}baseline ${baselineId ?? '-'}\n`
  return ok({ hash: `sha256:ls1:${sha256Hex(hashInput)}`, hashInput })
}
