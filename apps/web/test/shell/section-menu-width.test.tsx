import '@testing-library/jest-dom/vitest'
import type { ResizablePanel, ResizablePanelGroup } from '@exponetdb/ui'
import { act, cleanup, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  parseSectionMenuWidth,
  readSectionMenuWidth,
  rememberSectionMenuWidth,
  resetSectionMenuWidthCache,
  SECTION_MENU_DEFAULT_WIDTH,
  SECTION_MENU_MAX_WIDTH,
  SECTION_MENU_MIN_WIDTH,
  SECTION_MENU_WIDTH_KEY,
} from '../../src/lib/preferences/section-menu.ts'
import { mountApp, World } from '../target/support.tsx'

/**
 * The width of the section menu, kept per browser. The resizable group of the
 * library cannot be driven in jsdom (it has no layout), so the wiring is proved
 * on the props the shell hands the group and its panel; the preference itself
 * is proved on its own.
 */
const seen = vi.hoisted(() => ({
  group: undefined as ComponentProps<typeof ResizablePanelGroup> | undefined,
  panel: undefined as ComponentProps<typeof ResizablePanel> | undefined,
}))

vi.mock('@exponetdb/ui', async (importOriginal) => {
  const original = await importOriginal<typeof import('@exponetdb/ui')>()
  return {
    ...original,
    ResizablePanelGroup: (props: Parameters<typeof original.ResizablePanelGroup>[0]) => {
      seen.group = props
      return original.ResizablePanelGroup(props)
    },
    ResizablePanel: (props: Parameters<typeof original.ResizablePanel>[0]) => {
      if (props.id === 'section-menu') seen.panel = props
      return original.ResizablePanel(props)
    },
  }
})

beforeEach(() => {
  window.localStorage.clear()
  resetSectionMenuWidthCache()
  seen.group = undefined
  seen.panel = undefined
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  window.localStorage.clear()
  resetSectionMenuWidthCache()
})

describe('the preference of the section menu width', () => {
  it('reads a stored width only when it is a whole number within the limits of the panel', () => {
    expect(parseSectionMenuWidth('320')).toBe(320)
    expect(parseSectionMenuWidth('200')).toBe(SECTION_MENU_MIN_WIDTH)
    expect(parseSectionMenuWidth('400')).toBe(SECTION_MENU_MAX_WIDTH)
    for (const bad of [
      '199',
      '401',
      '0',
      '-300',
      '3e2',
      '320.5',
      '320px',
      '',
      ' 320',
      'NaN',
      null,
      320,
      undefined,
    ]) {
      expect(parseSectionMenuWidth(bad), String(bad)).toBeUndefined()
    }
  })

  it('starts with the default and keeps what a person chose', () => {
    expect(readSectionMenuWidth()).toBe(SECTION_MENU_DEFAULT_WIDTH)
    rememberSectionMenuWidth(333.4)
    expect(readSectionMenuWidth()).toBe(333)
    expect(window.localStorage.getItem(SECTION_MENU_WIDTH_KEY)).toBe('333')
    resetSectionMenuWidthCache()
    expect(readSectionMenuWidth()).toBe(333)
  })

  it('holds a chosen width within the limits and stores nothing for the default', () => {
    rememberSectionMenuWidth(9_000)
    expect(readSectionMenuWidth()).toBe(SECTION_MENU_MAX_WIDTH)
    rememberSectionMenuWidth(10)
    expect(readSectionMenuWidth()).toBe(SECTION_MENU_MIN_WIDTH)
    rememberSectionMenuWidth(SECTION_MENU_DEFAULT_WIDTH)
    expect(window.localStorage.getItem(SECTION_MENU_WIDTH_KEY)).toBeNull()
  })

  it('ignores a width that is not a size', () => {
    rememberSectionMenuWidth(Number.NaN)
    rememberSectionMenuWidth(0)
    rememberSectionMenuWidth(-5)
    rememberSectionMenuWidth(Number.POSITIVE_INFINITY)
    expect(readSectionMenuWidth()).toBe(SECTION_MENU_DEFAULT_WIDTH)
    expect(window.localStorage.length).toBe(0)
  })

  it('falls back to the default for storage that holds anything else or throws', () => {
    window.localStorage.setItem(SECTION_MENU_WIDTH_KEY, '<script>')
    expect(readSectionMenuWidth()).toBe(SECTION_MENU_DEFAULT_WIDTH)
    resetSectionMenuWidthCache()
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('full')
    })
    expect(readSectionMenuWidth()).toBe(SECTION_MENU_DEFAULT_WIDTH)
    expect(() => rememberSectionMenuWidth(300)).not.toThrow()
    // The choice lasts for the page when it cannot be stored.
    expect(readSectionMenuWidth()).toBe(300)
  })
})

describe('the section menu in the shell', () => {
  it('starts at the stored width and enforces the limits of the preference', async () => {
    window.localStorage.setItem(SECTION_MENU_WIDTH_KEY, '320')
    mountApp('/changes/plans', new World())
    await screen.findByRole('separator', { name: 'Resize the section menu' })
    expect(seen.panel?.defaultSize).toBe(320)
    expect(seen.panel?.minSize).toBe(SECTION_MENU_MIN_WIDTH)
    expect(seen.panel?.maxSize).toBe(SECTION_MENU_MAX_WIDTH)
  })

  it('starts at the default width when none was chosen', async () => {
    mountApp('/changes/plans', new World())
    await screen.findByRole('separator', { name: 'Resize the section menu' })
    expect(seen.panel?.defaultSize).toBe(SECTION_MENU_DEFAULT_WIDTH)
  })

  it('keeps the width a person dragged it to, and only then', async () => {
    mountApp('/changes/plans', new World())
    await screen.findByRole('separator', { name: 'Resize the section menu' })
    const handle = seen.panel?.panelRef
    const current =
      typeof handle === 'object' && handle !== null && 'current' in handle ? handle.current : null
    expect(current).not.toBeNull()
    if (current === null) return
    vi.spyOn(current, 'getSize').mockReturnValue({ asPercentage: 30, inPixels: 288 })
    // The library lays the panels out by itself on mount and on a window resize: not a choice.
    act(() => seen.group?.onLayoutChanged?.({ 'section-menu': 30 }, { isUserInteraction: false }))
    expect(window.localStorage.getItem(SECTION_MENU_WIDTH_KEY)).toBeNull()
    act(() => seen.group?.onLayoutChanged?.({ 'section-menu': 30 }, { isUserInteraction: true }))
    expect(window.localStorage.getItem(SECTION_MENU_WIDTH_KEY)).toBe('288')
    expect(readSectionMenuWidth()).toBe(288)
  })
})
