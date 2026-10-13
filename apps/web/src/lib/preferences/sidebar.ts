import { useSyncExternalStore } from 'react'

/**
 * How the icon rail behaves on wide screens (order §7): it expands while
 * the pointer or focus is on it (`hover`, the default), stays open (`open`)
 * or stays collapsed to its icons (`collapsed`). A display preference kept
 * in this browser's `localStorage`; when storage is unavailable the choice
 * lasts for the page. Small screens always use the sheet.
 */
export type SidebarMode = 'hover' | 'open' | 'collapsed'

export const SIDEBAR_MODE_KEY = 'exdb.sidebar.mode'

const MODES: readonly SidebarMode[] = ['hover', 'open', 'collapsed']

let current: SidebarMode = 'hover'
/** The mode the toggle returns to when it closes an open rail. */
let lastClosed: Exclude<SidebarMode, 'open'> = 'hover'
const listeners = new Set<() => void>()

function storage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage
  } catch {
    return undefined
  }
}

export function parseSidebarMode(value: unknown): SidebarMode {
  return MODES.find((mode) => mode === value) ?? 'hover'
}

export function initSidebarMode(): SidebarMode {
  try {
    current = parseSidebarMode(storage()?.getItem(SIDEBAR_MODE_KEY))
  } catch {
    current = 'hover'
  }
  if (current !== 'open') lastClosed = current
  return current
}

export function setSidebarMode(mode: SidebarMode): void {
  current = mode
  if (mode !== 'open') lastClosed = mode
  try {
    if (mode === 'hover') storage()?.removeItem(SIDEBAR_MODE_KEY)
    else storage()?.setItem(SIDEBAR_MODE_KEY, mode)
  } catch {
    // Storage refused: the choice lasts for this page.
  }
  for (const listener of listeners) listener()
}

/** The sidebar's toggle (button or rail): open, or back to the mode it was opened from. */
export function toggleSidebarMode(open: boolean): void {
  setSidebarMode(open ? 'open' : lastClosed)
}

export function useSidebarMode(): SidebarMode {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => current,
    () => current,
  )
}
