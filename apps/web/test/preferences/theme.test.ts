// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  applyTheme,
  initTheme,
  parseThemePreference,
  setThemePreference,
  THEME_STORAGE_KEY,
} from '../../src/lib/preferences/theme.ts'

afterEach(() => {
  vi.restoreAllMocks()
  window.localStorage.clear()
  document.documentElement.removeAttribute('data-theme')
})

describe('theme preference', () => {
  it('accepts only the three known values', () => {
    expect(parseThemePreference('dark')).toBe('dark')
    expect(parseThemePreference('light')).toBe('light')
    expect(parseThemePreference('system')).toBe('system')
    expect(parseThemePreference('classic-dark')).toBe('system')
    expect(parseThemePreference(null)).toBe('system')
  })

  it('sets data-theme for light and dark and removes it for the system preference', () => {
    const root = document.documentElement
    applyTheme('dark', root)
    expect(root.getAttribute('data-theme')).toBe('dark')
    applyTheme('system', root)
    expect(root.hasAttribute('data-theme')).toBe(false)
  })

  it('stores the choice and applies it again on the next load', () => {
    const root = document.documentElement
    setThemePreference('dark', root)
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark')
    root.removeAttribute('data-theme')
    expect(initTheme(root)).toBe('dark')
    expect(root.getAttribute('data-theme')).toBe('dark')
    setThemePreference('system', root)
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull()
  })

  it('keeps working when storage refuses', () => {
    const root = document.documentElement
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError')
    })
    expect(() => setThemePreference('light', root)).not.toThrow()
    expect(root.getAttribute('data-theme')).toBe('light')
    expect(initTheme(root)).toBe('system')
  })
})
