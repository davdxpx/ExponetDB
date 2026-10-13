import { useSyncExternalStore } from 'react'

/**
 * The person's theme choice on this device (design-system.md §2: `data-theme`
 * on `<html>` is the single theme mechanism). `system` removes the attribute,
 * so the token CSS follows `prefers-color-scheme`. The choice is a display
 * preference only, kept in this browser's `localStorage` under one key; when
 * storage is unavailable the choice lasts for the page.
 */
export type ThemePreference = 'system' | 'light' | 'dark'

export const THEME_STORAGE_KEY = 'exdb.theme'
const PREFERENCES: readonly ThemePreference[] = ['system', 'light', 'dark']

export function parseThemePreference(value: string | null | undefined): ThemePreference {
  return PREFERENCES.find((p) => p === value) ?? 'system'
}

export function applyTheme(preference: ThemePreference, root: HTMLElement): void {
  if (preference === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', preference)
}

function storage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage
  } catch {
    return undefined
  }
}

let current: ThemePreference = 'system'
const listeners = new Set<() => void>()

/** Reads the stored choice and applies it; called once before the first render. */
export function initTheme(root: HTMLElement): ThemePreference {
  try {
    current = parseThemePreference(storage()?.getItem(THEME_STORAGE_KEY))
  } catch {
    current = 'system'
  }
  applyTheme(current, root)
  return current
}

export function setThemePreference(preference: ThemePreference, root: HTMLElement): void {
  current = preference
  applyTheme(preference, root)
  try {
    if (preference === 'system') storage()?.removeItem(THEME_STORAGE_KEY)
    else storage()?.setItem(THEME_STORAGE_KEY, preference)
  } catch {
    // Storage refused (private mode, quota): the choice lasts for this page.
  }
  for (const listener of listeners) listener()
}

export function useThemePreference(): ThemePreference {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => current,
    () => current,
  )
}
