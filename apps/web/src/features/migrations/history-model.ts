import type { LedgerEntry, MigrationStatus } from '@exponetdb/sdk/operations'
import { PAGE_SIZES } from '@exponetdb/ui-patterns'
import { searchTextOf } from '../targets/model.ts'

/**
 * The migration centre's URL contract and the history's filters as pure functions (unit-tested).
 * The ledger read (`GET /targets/{t}/migrations`) returns the whole ledger in one answer; the
 * page filters, sorts and pages what it read and says so. It never claims a server page.
 *
 * shortcut: the history pages one whole-ledger read in the browser; fine for the thousands of
 * rows a real ledger holds, upgrade to the paged ledger read of PRE-WAVE-11-REVIEW.md (UI/UX,
 * "Backend reads") before ledgers of 10,000+ rows.
 */

export const MIGRATION_VIEWS = [
  'history',
  'pending',
  'timeline',
  'promote',
  'plans',
  'drift',
  'import',
] as const
export type MigrationView = (typeof MIGRATION_VIEWS)[number]

export const ORIGINS = ['exponetdb', 'legacy_import', 'baseline'] as const
export type OriginFilter = (typeof ORIGINS)[number]

/** `failed` covers failed, partial and error: every verification that did not pass. */
export const VERIFICATION_FILTERS = ['passed', 'pending', 'failed', 'superseded'] as const
export type VerificationFilter = (typeof VERIFICATION_FILTERS)[number]

export const SORTS = ['newest', 'oldest'] as const
export type HistorySort = (typeof SORTS)[number]

export const HISTORY_SEARCH_MAX_LENGTH = 100
export const DEFAULT_HISTORY_SIZE = 50

export interface MigrationsSearch {
  readonly report?: string | undefined
  readonly view?: MigrationView | undefined
  readonly q?: string | undefined
  readonly origin?: OriginFilter | undefined
  readonly verification?: VerificationFilter | undefined
  readonly sort?: HistorySort | undefined
  readonly page?: number | undefined
  readonly size?: number | undefined
  /** A migration whose SQL panel is open (`<ULID>`). */
  readonly migration?: string | undefined
}

const REPORT = /^imr_[0-7][0-9A-HJKMNP-TV-Z]{25}$/
const MIGRATION = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/

function oneOf<T extends string>(values: readonly T[], value: unknown): T | undefined {
  return typeof value === 'string' && (values as readonly string[]).includes(value)
    ? (value as T)
    : undefined
}

/**
 * The validated search of `/t/…/migrations`. Every key is present, `undefined` when its value is
 * outside the grammar: the router merges the raw search of the parent routes into a route's
 * validated search, so a key left out here would arrive unchecked.
 */
export function migrationsSearch(search: Readonly<Record<string, unknown>>): MigrationsSearch {
  const q = searchTextOf(search['q'], HISTORY_SEARCH_MAX_LENGTH)
  const page = Number(search['page'])
  const size = Number(search['size'])
  const report = search['report']
  const migration = search['migration']
  return {
    report: typeof report === 'string' && REPORT.test(report) ? report : undefined,
    view: oneOf(MIGRATION_VIEWS, search['view']),
    q,
    origin: oneOf(ORIGINS, search['origin']),
    verification: oneOf(VERIFICATION_FILTERS, search['verification']),
    sort: oneOf(SORTS, search['sort']),
    page: Number.isInteger(page) && page > 1 && page < 1_000_000 ? page : undefined,
    size: (PAGE_SIZES as readonly number[]).includes(size) ? size : undefined,
    migration: typeof migration === 'string' && MIGRATION.test(migration) ? migration : undefined,
  }
}

/** The view the page shows: the one named, else the legacy import for a report link, else history. */
export function viewOf(search: MigrationsSearch): MigrationView {
  return search.view ?? (search.report === undefined ? 'history' : 'import')
}

/** The verification group of a ledger row, as the filters and counters name it. */
export function verificationGroup(entry: LedgerEntry): VerificationFilter {
  if (entry.verification.superseded === true) return 'superseded'
  switch (entry.verification.status) {
    case 'passed':
      return 'passed'
    case 'pending':
      return 'pending'
    default:
      // failed, partial, error, and a status this version does not know: never "passed".
      return 'failed'
  }
}

/** The rows that match, newest applied first (or oldest), ties by migration id. */
export function historyRows(
  entries: readonly LedgerEntry[],
  search: MigrationsSearch,
): readonly LedgerEntry[] {
  const needle = search.q?.trim().toLowerCase() ?? ''
  const filtered = entries.filter(
    (entry) =>
      (search.origin === undefined || entry.origin === search.origin) &&
      (search.verification === undefined || verificationGroup(entry) === search.verification) &&
      (needle === '' ||
        entry.name.toLowerCase().includes(needle) ||
        entry.migrationId.toLowerCase().includes(needle)),
  )
  const direction = search.sort === 'oldest' ? 1 : -1
  return [...filtered].sort(
    (a, b) =>
      direction * a.appliedAt.localeCompare(b.appliedAt) ||
      a.migrationId.localeCompare(b.migrationId),
  )
}

export interface LedgerCounts {
  readonly applied: number
  readonly verified: number
  readonly verificationPending: number
  readonly failed: number
  readonly superseded: number
  readonly imported: number
  readonly baselines: number
  /** Bundles of the project not applied to this target. */
  readonly notApplied: number
}

/** The counters of the migration centre, from the one ledger read. */
export function ledgerCounts(status: MigrationStatus): LedgerCounts {
  const counts = {
    applied: status.applied.length,
    verified: 0,
    verificationPending: 0,
    failed: 0,
    superseded: 0,
    imported: 0,
    baselines: 0,
    notApplied: status.pending.length,
  }
  for (const entry of status.applied) {
    const group = verificationGroup(entry)
    if (group === 'passed') counts.verified += 1
    else if (group === 'pending') counts.verificationPending += 1
    else if (group === 'failed') counts.failed += 1
    else counts.superseded += 1
    if (entry.origin === 'legacy_import') counts.imported += 1
    if (entry.origin === 'baseline') counts.baselines += 1
  }
  return counts
}
