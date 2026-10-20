/**
 * The defaults of the targets list that this browser remembers: how the list is
 * shown (`table` or `grid`) and how it is sorted. A display preference of the
 * browser, not of the person (like the sidebar and the theme), kept in
 * `localStorage` under `exdb.targets.view` and `exdb.targets.sort`.
 *
 * Storage can be missing, full, blocked or throw (a private window, cleared
 * site data, a thumbnail capture), so every access is guarded and the page
 * renders the same without it. A stored value that is not one of the known
 * words is ignored. The URL always wins over the stored default: the page
 * applies the default only to a key the address leaves out
 * (`features/targets/model.ts`).
 */
export const TARGETS_VIEW_KEY = 'exdb.targets.view'
export const TARGETS_SORT_KEY = 'exdb.targets.sort'

export const TARGET_VIEWS = ['table', 'grid'] as const
export const TARGET_SORTS = ['path', 'tier', 'health'] as const

export type TargetView = (typeof TARGET_VIEWS)[number]
export type TargetSort = (typeof TARGET_SORTS)[number]

/** What the browser remembers: a key that is absent (or unreadable) is `undefined`. */
export interface TargetsPreferences {
  readonly view?: TargetView | undefined
  readonly sort?: TargetSort | undefined
}

function storage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage
  } catch {
    return undefined
  }
}

function read<T extends string>(key: string, allowed: readonly T[]): T | undefined {
  try {
    const value = storage()?.getItem(key)
    return allowed.find((candidate) => candidate === value)
  } catch {
    return undefined
  }
}

/** The remembered view and sort of this browser. Never throws. */
export function readTargetsPreferences(): TargetsPreferences {
  return {
    view: read(TARGETS_VIEW_KEY, TARGET_VIEWS),
    sort: read(TARGETS_SORT_KEY, TARGET_SORTS),
  }
}

/**
 * Remembers the given keys (a key that is `undefined` is left as it is) and
 * returns what the browser now holds, read back: a write that storage refused
 * is visible in the answer, so the caller never assumes a default that was
 * not kept.
 */
export function writeTargetsPreferences(next: TargetsPreferences): TargetsPreferences {
  try {
    const store = storage()
    if (next.view !== undefined) store?.setItem(TARGETS_VIEW_KEY, next.view)
    if (next.sort !== undefined) store?.setItem(TARGETS_SORT_KEY, next.sort)
  } catch {
    // Storage refused: the choice lasts for this page, through the address.
  }
  return readTargetsPreferences()
}
