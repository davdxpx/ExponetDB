/**
 * Per-browser preferences of the SQL workspace. Unlike the tabs (unsent text,
 * kept per person and target and removed at sign-out) a preference holds no
 * text of anyone: it is a number from a fixed list, so it stays on the
 * browser. Every access is guarded: storage that is unavailable, full or
 * holding something else leaves the default.
 */
export const SQL_ROW_LIMIT_KEY = 'exdb.sql.rowLimit'

/**
 * The row limits a person may choose for a run. The data-read endpoint takes
 * 1 to 5000 rows for a person (`QueryRequest.maxRows`).
 */
export const ROW_LIMITS = [100, 500, 1000, 5000] as const
export type RowLimit = (typeof ROW_LIMITS)[number]

/** The server's own default for a person (1,000 rows), used until a person chooses. */
export const DEFAULT_ROW_LIMIT: RowLimit = 1000

export function isRowLimit(value: unknown): value is RowLimit {
  return ROW_LIMITS.some((limit) => limit === value)
}

function storage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage
  } catch {
    return undefined
  }
}

/** The row limit this browser kept, or the default when none is kept or the value is not one of the list. */
export function loadRowLimit(): RowLimit {
  try {
    const raw = storage()?.getItem(SQL_ROW_LIMIT_KEY)
    if (raw === null || raw === undefined) return DEFAULT_ROW_LIMIT
    const value: unknown = JSON.parse(raw)
    return isRowLimit(value) ? value : DEFAULT_ROW_LIMIT
  } catch {
    return DEFAULT_ROW_LIMIT
  }
}

/** Keeps the row limit in this browser; a refused or full storage keeps it for the page only. */
export function saveRowLimit(limit: RowLimit): void {
  try {
    storage()?.setItem(SQL_ROW_LIMIT_KEY, JSON.stringify(limit))
  } catch {
    // Storage refused: the choice lasts for this page.
  }
}
