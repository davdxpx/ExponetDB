import { isTargetPath } from './params.ts'

/**
 * The databases a person opened lately, kept in this browser so the switcher
 * can offer them first: at most five target paths per signed-in person, newest
 * first, under `exdb.recent.targets.<identityId>`. Only paths that match the
 * slug grammar are kept and read back, so storage that holds anything else
 * (an older shape, text another script wrote) shows nothing. The key names the
 * person, so another person on the same browser never sees the list; sign-out
 * removes every such key, and the shell removes the keys of any other person
 * when a person's page opens (an ended session cannot clear them itself).
 * Every access is guarded: storage that is unavailable, full or throws leaves
 * the list for the page only.
 */
export const RECENT_TARGETS_PREFIX = 'exdb.recent.targets.'
export const RECENT_TARGETS_MAX = 5

/** An identity id is `idn_` and a ULID; anything that could change the shape of the key is refused. */
const KEY_PART = /^[A-Za-z0-9_-]{1,64}$/

function storage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage
  } catch {
    return undefined
  }
}

function keyOf(identityId: string): string | undefined {
  return KEY_PART.test(identityId) ? `${RECENT_TARGETS_PREFIX}${identityId}` : undefined
}

/** The recent target paths of this person, newest first; empty when there are none or storage fails. */
export function readRecentTargets(identityId: string): readonly string[] {
  const key = keyOf(identityId)
  if (key === undefined) return []
  try {
    const raw = storage()?.getItem(key)
    if (raw === null || raw === undefined) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const paths: string[] = []
    for (const item of parsed as unknown[]) {
      if (isTargetPath(item) && !paths.includes(item)) paths.push(item)
    }
    return paths.slice(0, RECENT_TARGETS_MAX)
  } catch {
    return []
  }
}

/** Puts `path` first in this person's list (once), keeping the five newest. A path that is no target path is ignored. */
export function rememberTarget(identityId: string, path: string): void {
  const key = keyOf(identityId)
  if (key === undefined || !isTargetPath(path)) return
  const next = [path, ...readRecentTargets(identityId).filter((p) => p !== path)].slice(
    0,
    RECENT_TARGETS_MAX,
  )
  try {
    storage()?.setItem(key, JSON.stringify(next))
  } catch {
    // Storage refused: the list lasts for this page only.
  }
}

function recentKeys(store: Storage): string[] {
  const keys: string[] = []
  for (let i = 0; i < store.length; i += 1) {
    const key = store.key(i)
    if (key?.startsWith(RECENT_TARGETS_PREFIX) === true) keys.push(key)
  }
  return keys
}

function removeKeys(keys: readonly string[], store: Storage): void {
  for (const key of keys) {
    try {
      store.removeItem(key)
    } catch {
      // One key refused: the others still go.
    }
  }
}

/** Removes every recent-targets list this browser kept, of any person (sign-out). */
export function forgetRecentTargets(): void {
  try {
    const store = storage()
    if (store !== undefined) removeKeys(recentKeys(store), store)
  } catch {
    // Storage unavailable: nothing was kept in it.
  }
}

/** Removes the lists of every person but `identityId` (a session that ended without a sign-out). */
export function pruneRecentTargets(identityId: string): void {
  const own = keyOf(identityId)
  try {
    const store = storage()
    if (store !== undefined)
      removeKeys(
        recentKeys(store).filter((key) => key !== own),
        store,
      )
  } catch {
    // Storage unavailable: nothing was kept in it.
  }
}
