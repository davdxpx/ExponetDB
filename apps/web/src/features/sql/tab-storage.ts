import {
  MAX_STORED_SQL,
  MAX_TABS,
  newTabId,
  type SavedRef,
  SQL_MODES,
  type SqlTab,
  TAB_ORIGINS,
  type TabsState,
} from './sql-model.ts'

/**
 * The tabs of the SQL workspace kept in this browser (information-architecture.md
 * §2: client state keyed by target id): only their unsent text, mode and where
 * it came from, never a result or a classification. Every access is guarded:
 * storage that is unavailable, full or holding something else leaves the tabs
 * for the page only.
 */
const STORAGE_PREFIX = 'exdb.sql.tabs.'

export function storageKey(targetId: string): string {
  return `${STORAGE_PREFIX}${targetId}`
}

function storage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage
  } catch {
    return undefined
  }
}

function readSaved(value: unknown): SavedRef | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const r = value as Record<string, unknown>
  const { id, name, revision, visibility, owned } = r
  if (
    typeof id !== 'string' ||
    !/^sqy_[0-9A-HJKMNP-TV-Z]{26}$/.test(id) ||
    typeof name !== 'string' ||
    typeof revision !== 'number' ||
    !Number.isInteger(revision) ||
    (visibility !== 'personal' && visibility !== 'project') ||
    typeof owned !== 'boolean'
  ) {
    return undefined
  }
  return { id, name, revision, visibility, owned }
}

/**
 * The tabs this browser kept for a target, or `undefined` when there are none
 * or storage is unavailable or holds something else. Only text is kept: never
 * a result, never a classification.
 */
export function loadTabs(targetId: string): TabsState | undefined {
  try {
    const raw = storage()?.getItem(storageKey(targetId))
    if (raw === null || raw === undefined) return undefined
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const record = parsed as Record<string, unknown>
    const list = Array.isArray(record['tabs']) ? (record['tabs'] as unknown[]) : []
    const tabs: SqlTab[] = []
    for (const item of list.slice(0, MAX_TABS)) {
      if (typeof item !== 'object' || item === null) continue
      const t = item as Record<string, unknown>
      const mode = SQL_MODES.find((m) => m === t['mode'])
      const origin = TAB_ORIGINS.find((o) => o === t['origin'])
      const sql = t['sql']
      if (mode === undefined || origin === undefined || typeof sql !== 'string') continue
      if (sql.length > MAX_STORED_SQL) continue
      const saved = readSaved(t['saved'])
      tabs.push({ id: newTabId(), mode, sql, origin, ...(saved === undefined ? {} : { saved }) })
    }
    if (tabs.length === 0) return undefined
    const activeIndex =
      typeof record['active'] === 'number' &&
      Number.isInteger(record['active']) &&
      record['active'] >= 0 &&
      record['active'] < tabs.length
        ? record['active']
        : 0
    return { tabs, active: tabs[activeIndex]?.id ?? '' }
  } catch {
    return undefined
  }
}

/** Keeps the tabs' text in this browser; a refused or full storage keeps them for the page only. */
export function saveTabs(targetId: string, state: TabsState): void {
  try {
    const tabs = state.tabs
      .filter((tab) => tab.sql.length <= MAX_STORED_SQL)
      .map((tab) => ({
        mode: tab.mode,
        sql: tab.sql,
        origin: tab.origin,
        ...(tab.saved === undefined ? {} : { saved: tab.saved }),
      }))
    const active = Math.max(
      0,
      state.tabs
        .filter((tab) => tab.sql.length <= MAX_STORED_SQL)
        .findIndex((t) => t.id === state.active),
    )
    storage()?.setItem(storageKey(targetId), JSON.stringify({ tabs, active }))
  } catch {
    // Storage refused: the tabs last for this page.
  }
}
