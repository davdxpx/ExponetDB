import { useSyncExternalStore } from 'react'

/**
 * The resolved color scheme, read from `data-theme` on `<html>` (the single
 * theme mechanism, design-system.md section 2): a value containing `dark` is
 * dark, `light` is light, and without the attribute the system preference
 * decides. Charts and other code that must know the scheme at run time use
 * this instead of a theme library.
 */
export type ColorScheme = 'light' | 'dark'

const DARK_QUERY = '(prefers-color-scheme: dark)'

export function resolveColorScheme(attribute: string | null, systemDark: boolean): ColorScheme {
  if (attribute === null || attribute === '') return systemDark ? 'dark' : 'light'
  if (attribute.includes('dark')) return 'dark'
  if (attribute.includes('light')) return 'light'
  return systemDark ? 'dark' : 'light'
}

function snapshot(): ColorScheme {
  if (typeof document === 'undefined') return 'light'
  const systemDark =
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(DARK_QUERY).matches
      : false
  return resolveColorScheme(document.documentElement.getAttribute('data-theme'), systemDark)
}

function subscribe(onChange: () => void): () => void {
  if (typeof document === 'undefined') return () => {}
  const observer = new MutationObserver(onChange)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  const media =
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(DARK_QUERY)
      : undefined
  media?.addEventListener('change', onChange)
  return () => {
    observer.disconnect()
    media?.removeEventListener('change', onChange)
  }
}

export function useColorScheme(): ColorScheme {
  return useSyncExternalStore(subscribe, snapshot, () => 'light')
}
