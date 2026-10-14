/**
 * The prefix of the keys under which the SQL workspace keeps its tabs in this
 * browser (`exdb.sql.tabs.<identityId>.<targetId>`, information-architecture.md §2).
 */
export const SQL_TABS_PREFIX = 'exdb.sql.tabs.'

/**
 * Removes every SQL tab this browser kept, of any person and any target, including
 * keys of an older shape. Storage that is unavailable or throws is left as it is.
 */
export function forgetSqlTabs(): void {
  try {
    const store = window.localStorage
    const keys: string[] = []
    for (let i = 0; i < store.length; i += 1) {
      const key = store.key(i)
      if (key?.startsWith(SQL_TABS_PREFIX) === true) keys.push(key)
    }
    for (const key of keys) {
      try {
        store.removeItem(key)
      } catch {
        // One key refused: the others still go.
      }
    }
  } catch {
    // Storage unavailable: nothing was kept in it.
  }
}
