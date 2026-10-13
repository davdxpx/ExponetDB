import { useSyncExternalStore } from 'react'

/**
 * Whether the letter shortcuts (`G` then a key, `?`) are on for this person on
 * this device (WCAG 2.1.4: character-key shortcuts can be turned off). A
 * display preference kept in this browser's `localStorage`; when storage is
 * unavailable the choice lasts for the page. `Mod+K` stays on either way.
 */
export const LETTER_SHORTCUTS_KEY = 'exdb.shortcuts.letters'

let current = true
const listeners = new Set<() => void>()

function storage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage
  } catch {
    return undefined
  }
}

export function initLetterShortcuts(): boolean {
  try {
    current = storage()?.getItem(LETTER_SHORTCUTS_KEY) !== 'off'
  } catch {
    current = true
  }
  return current
}

export function setLetterShortcuts(on: boolean): void {
  current = on
  try {
    if (on) storage()?.removeItem(LETTER_SHORTCUTS_KEY)
    else storage()?.setItem(LETTER_SHORTCUTS_KEY, 'off')
  } catch {
    // Storage refused: the choice lasts for this page.
  }
  for (const listener of listeners) listener()
}

export function useLetterShortcuts(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => current,
    () => current,
  )
}
