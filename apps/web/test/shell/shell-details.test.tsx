import '@testing-library/jest-dom/vitest'
import { act, cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { axeViolations } from '../../../../packages/ui/test/support/axe.ts'
import { RECENT_TARGETS_PREFIX, rememberTarget } from '../../src/features/target/recent-storage.ts'
import { setLetterShortcuts } from '../../src/lib/preferences/shortcuts.ts'
import { setSidebarMode } from '../../src/lib/preferences/sidebar.ts'
import { mountApp, World } from '../target/support.tsx'

const IDENTITY = 'idn_00000000000000000000000001'
const OTHER = 'idn_00000000000000000000000002'

beforeEach(() => window.localStorage.clear())
afterEach(() => {
  cleanup()
  window.localStorage.clear()
  setSidebarMode('hover')
  setLetterShortcuts(true)
})

/** Escape closes a tooltip; jsdom has no pointer geometry for Radix to close it by leaving. */
async function closeTooltip(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.keyboard('{Escape}')
  await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull())
}

describe('the tooltips of the icon rail', () => {
  async function railLink(name: string): Promise<HTMLElement> {
    const rail = await screen.findByRole('navigation', { name: 'Main navigation' })
    return within(rail).getByRole('link', { name })
  }

  it('name the section and its keys from the registry while the rail is collapsed', async () => {
    const user = userEvent.setup()
    setSidebarMode('collapsed')
    mountApp('/audit', new World())
    await screen.findByRole('heading', { level: 1, name: 'Audit' })
    await user.hover(await railLink('Databases'))
    const tip = await screen.findByRole('tooltip')
    expect(tip).toHaveTextContent('Databases')
    // The words are the registry's: G then T (the label of the shortcut says "targets", the rail says "Databases").
    expect(tip).toHaveTextContent('G then T')
    await closeTooltip(user)
    await user.hover(await railLink('Changes'))
    await waitFor(() => expect(screen.getByRole('tooltip')).toHaveTextContent('G then C'))
  })

  it('give the keys of every section of the rail', async () => {
    const user = userEvent.setup()
    setSidebarMode('collapsed')
    mountApp('/audit', new World())
    await screen.findByRole('heading', { level: 1, name: 'Audit' })
    const keys: Record<string, string> = {
      Overview: 'G then H',
      Databases: 'G then T',
      Changes: 'G then C',
      Infrastructure: 'G then I',
      Backups: 'G then B',
      Access: 'G then A',
      Audit: 'G then U',
      Settings: 'G then S',
    }
    for (const [name, spoken] of Object.entries(keys)) {
      const link = await railLink(name)
      await user.hover(link)
      await waitFor(() => expect(screen.getByRole('tooltip')).toHaveTextContent(spoken))
      await closeTooltip(user)
    }
  })

  it('leave the keys out when the letter shortcuts are off, and keep the label', async () => {
    const user = userEvent.setup()
    setSidebarMode('collapsed')
    setLetterShortcuts(false)
    mountApp('/audit', new World())
    await screen.findByRole('heading', { level: 1, name: 'Audit' })
    await user.hover(await railLink('Databases'))
    const tip = await screen.findByRole('tooltip')
    expect(tip).toHaveTextContent('Databases')
    expect(tip.textContent).not.toContain('then')
  })

  it('are not shown while the rail is expanded, which shows the labels itself', async () => {
    const user = userEvent.setup()
    setSidebarMode('open')
    mountApp('/audit', new World())
    await screen.findByRole('heading', { level: 1, name: 'Audit' })
    await user.hover(await railLink('Databases'))
    await new Promise((resolve) => setTimeout(resolve, 450))
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('have no accessibility violations with a tooltip open', async () => {
    const user = userEvent.setup()
    setSidebarMode('collapsed')
    mountApp('/audit', new World())
    await screen.findByRole('heading', { level: 1, name: 'Audit' })
    await user.hover(await railLink('Settings'))
    await screen.findByRole('tooltip')
    expect(await axeViolations()).toEqual([])
  })
})

describe('the page starts at its top', () => {
  /** The element that scrolls the page beside the section menu. */
  function scroller(): HTMLElement {
    const found = screen.getByRole('main').querySelector<HTMLElement>('.overflow-auto')
    if (found === null) throw new Error('no scrolling page')
    return found
  }

  function scrollTo(element: Element, top: number): void {
    // jsdom has no layout: give the element a scroll offset the effect can reset.
    Object.defineProperty(element, 'scrollTop', { configurable: true, writable: true, value: top })
  }

  // jsdom has no `scrollingElement`; a browser's is the document element.
  beforeEach(() => {
    Object.defineProperty(document, 'scrollingElement', {
      configurable: true,
      value: document.documentElement,
    })
  })
  afterEach(() => {
    Reflect.deleteProperty(document, 'scrollingElement')
  })

  it('scrolls to the top when the address changes', async () => {
    const { router } = mountApp('/changes/plans', new World())
    await screen.findByRole('heading', { level: 1, name: 'Plans' })
    scrollTo(scroller(), 240)
    scrollTo(document.documentElement, 90)
    await act(() => router.navigate({ href: '/changes/operations' }))
    await screen.findByRole('heading', { level: 1, name: 'Operations' })
    expect(scroller().scrollTop).toBe(0)
    expect(document.documentElement.scrollTop).toBe(0)
  })

  it('does not scroll when only the query string changes', async () => {
    const { router } = mountApp('/changes/plans', new World())
    await screen.findByRole('heading', { level: 1, name: 'Plans' })
    scrollTo(scroller(), 240)
    await act(() => router.navigate({ href: '/changes/plans?filter=open' }))
    await waitFor(() => expect(router.state.location.searchStr).toBe('?filter=open'))
    expect(scroller().scrollTop).toBe(240)
  })

  it('scrolls to the top on a page without a section menu too', async () => {
    const { router } = mountApp('/audit', new World())
    await screen.findByRole('heading', { level: 1, name: 'Audit' })
    scrollTo(document.documentElement, 500)
    await act(() => router.navigate({ href: '/account' }))
    await screen.findByRole('heading', { level: 1 })
    expect(document.documentElement.scrollTop).toBe(0)
  })
})

describe('the version of the app in the account menu', () => {
  const INSTALLATION = { version: '1.4.2', contracts: {}, features: [] }

  async function openMenu(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
    await screen.findByRole('heading', { level: 1, name: 'Audit' })
    await user.click(await screen.findByRole('button', { name: 'Account' }))
    return screen.findByRole('menu')
  }

  it('shows the version read from the installation when the menu opens', async () => {
    const user = userEvent.setup()
    const world = new World()
    world.installation = INSTALLATION
    mountApp('/audit', world)
    await screen.findByRole('heading', { level: 1, name: 'Audit' })
    // Nothing is requested before the menu opens.
    expect(world.requests).not.toContain('/api/v1/installation')
    const menu = await openMenu(user)
    expect(await within(menu).findByText('Version 1.4.2')).toBeInTheDocument()
    expect(world.requests.filter((r) => r === '/api/v1/installation')).toHaveLength(1)
  })

  it('shows nothing when the installation could not be read, and the menu still works', async () => {
    const user = userEvent.setup()
    const world = new World()
    world.failures.set('/api/v1/installation', { status: 500, code: 'INTERNAL_ERROR' })
    mountApp('/audit', world)
    const menu = await openMenu(user)
    await waitFor(() => expect(world.requests).toContain('/api/v1/installation'))
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(within(menu).queryByText(/^Version/)).toBeNull()
    expect(within(menu).queryByText(/undefined|null|unknown/i)).toBeNull()
    expect(within(menu).getByRole('menuitem', { name: 'Sign out' })).toBeInTheDocument()
  })

  it('shows nothing while the installation is being read', async () => {
    const user = userEvent.setup()
    const world = new World()
    world.installation = INSTALLATION
    let release: () => void = () => undefined
    world.delays.set(
      '/api/v1/installation',
      new Promise<void>((resolve) => {
        release = resolve
      }),
    )
    mountApp('/audit', world)
    const menu = await openMenu(user)
    expect(within(menu).queryByText(/^Version/)).toBeNull()
    release()
    expect(await within(menu).findByText('Version 1.4.2')).toBeInTheDocument()
  })

  it('has no accessibility violations with the version shown', async () => {
    const user = userEvent.setup()
    const world = new World()
    world.installation = INSTALLATION
    mountApp('/audit', world)
    const menu = await openMenu(user)
    await within(menu).findByText('Version 1.4.2')
    expect(await axeViolations()).toEqual([])
  })
})

describe("the recent databases when a person's page opens", () => {
  it('removes the lists of other people and keeps the own', async () => {
    rememberTarget(IDENTITY, 'shop/platform/staging')
    rememberTarget(OTHER, 'billing/api/live')
    mountApp('/audit', new World())
    await screen.findByRole('heading', { level: 1, name: 'Audit' })
    await waitFor(() =>
      expect(window.localStorage.getItem(`${RECENT_TARGETS_PREFIX}${OTHER}`)).toBeNull(),
    )
    expect(window.localStorage.getItem(`${RECENT_TARGETS_PREFIX}${IDENTITY}`)).toBe(
      '["shop/platform/staging"]',
    )
  })
})
