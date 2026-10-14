import '@testing-library/jest-dom/vitest'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { axeViolations } from '../../../../packages/ui/test/support/axe.ts'
import { AppProviders } from '../../src/app/providers.tsx'
import { createReauthBridge } from '../../src/features/reauth/reauth.tsx'
import { ApiClient } from '../../src/lib/api/client.ts'
import { type SidebarMode, setSidebarMode } from '../../src/lib/preferences/sidebar.ts'
import { createQueryClient } from '../../src/lib/query/client.ts'
import { routeTree } from '../../src/routeTree.gen.ts'

afterEach(cleanup)

const ME = {
  identity: {
    id: 'idn_01JZ0000000000000000000000',
    kind: 'human',
    state: 'active',
    label: 'owner',
    displayName: 'Ada ‮evil',
    email: 'owner@example.test',
  },
  session: {},
  bindings: [],
  effectivePermissions: [],
}

function mount(path: string) {
  const fetchFn = vi.fn(async (url: string | URL | Request) => {
    if (String(url) === '/api/v1/me') {
      return new Response(JSON.stringify(ME), { status: 200 })
    }
    return new Response(JSON.stringify({ code: 'NOT_FOUND', message: 'Not found.' }), {
      status: 404,
    })
  })
  const client = new ApiClient({
    fetch: fetchFn as unknown as typeof fetch,
    cookies: () => '__Host-exdb_csrf=t',
    onSessionGone: vi.fn(),
  })
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
  })
  render(
    <AppProviders
      services={{
        queryClient: createQueryClient(),
        client,
        reauth: createReauthBridge(),
        navigate: (to) => void router.navigate({ href: to }),
      }}
    >
      <RouterProvider router={router} />
    </AppProviders>,
  )
  return { router, fetchFn }
}

describe('the shell of signed-in pages', () => {
  it('renders the navigation of the IA with the current page marked, after reading the session', async () => {
    mount('/')
    expect(await screen.findByRole('heading', { level: 1, name: 'Overview' })).toBeInTheDocument()
    const nav = screen.getByRole('navigation', { name: 'Main navigation' })
    const overview = within(nav).getByRole('link', { name: 'Overview' })
    expect(overview).toHaveAttribute('aria-current', 'page')
    expect(within(nav).getByRole('link', { name: 'Audit' })).toHaveAttribute('href', '/audit')
    expect(within(nav).getByRole('link', { name: 'Audit' })).not.toHaveAttribute('aria-current')
    expect(screen.getByRole('link', { name: 'Skip to content' })).toHaveAttribute(
      'href',
      '#content',
    )
    expect(screen.getByRole('main')).toHaveAttribute('id', 'content')
  })

  it('renders "page not found" for a path no route knows, without echoing it', async () => {
    mount('/no/such/page%3Cscript%3E')
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('script')
  })

  it('navigates through the link seam without a page load', async () => {
    const { router } = mount('/')
    await screen.findByRole('heading', { name: 'Overview' })
    const nav = screen.getByRole('navigation', { name: 'Main navigation' })
    await act(async () => {
      within(nav).getByRole('link', { name: 'Audit' }).click()
    })
    expect(router.state.location.pathname).toBe('/audit')
  })
})

describe('the icon rail and the section menu', () => {
  it('lists the sections of the rail and the pages of the current section beside the page', async () => {
    mount('/infrastructure/clusters')
    await screen.findByRole('heading', { level: 1, name: 'Clusters' })
    const rail = screen.getByRole('navigation', { name: 'Main navigation' })
    expect(
      within(rail)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual([
      'Overview',
      'Databases',
      'Changes',
      'Infrastructure',
      'Backups',
      'Access',
      'Audit',
      'Settings',
    ])
    expect(within(rail).getByRole('link', { name: 'Infrastructure' })).toHaveAttribute(
      'aria-current',
      'true',
    )
    const menu = screen.getByRole('navigation', { name: 'Infrastructure pages' })
    expect(
      within(menu)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual(['Servers', 'Clusters', 'Nodes', 'Certificates'])
    expect(within(menu).getByRole('link', { name: 'Clusters' })).toHaveAttribute(
      'aria-current',
      'page',
    )
    expect(within(menu).getByRole('link', { name: 'Servers' })).not.toHaveAttribute('aria-current')
    expect(screen.getByRole('separator', { name: 'Resize the section menu' })).toBeInTheDocument()
  })

  it('below md the page takes the whole width: no section panel reserves space beside it', async () => {
    const width = window.innerWidth
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 390 })
    try {
      mount('/infrastructure/clusters')
      await screen.findByRole('heading', { level: 1, name: 'Clusters' })
      await waitFor(() =>
        expect(screen.queryByRole('separator', { name: 'Resize the section menu' })).toBeNull(),
      )
      expect(document.querySelector('[data-slot="resizable-panel-group"]')).toBeNull()
      expect(screen.queryByRole('navigation', { name: 'Infrastructure pages' })).toBeNull()
    } finally {
      Object.defineProperty(window, 'innerWidth', {
        configurable: true,
        writable: true,
        value: width,
      })
    }
  })

  it('has no accessibility violations with the rail, the section menu and the header', async () => {
    mount('/access/not-a-page')
    await screen.findByRole('heading', { name: 'Page not found' })
    expect(await axeViolations()).toEqual([])
  })

  it('shows no section menu for a section with one page', async () => {
    mount('/')
    await screen.findByRole('heading', { name: 'Overview' })
    expect(screen.queryByRole('navigation', { name: /pages$/ })).not.toBeInTheDocument()
  })

  it('marks the longest matching page of a section menu as current', async () => {
    mount('/changes/plans')
    await screen.findByRole('heading', { level: 1, name: 'Plans' })
    const menu = screen.getByRole('navigation', { name: 'Changes pages' })
    expect(within(menu).getByRole('link', { name: 'Plans' })).toHaveAttribute(
      'aria-current',
      'page',
    )
    expect(within(menu).getByRole('link', { name: 'All changes' })).not.toHaveAttribute(
      'aria-current',
    )
  })

  it('keeps the chosen sidebar mode in the preferences of this browser', async () => {
    const user = userEvent.setup()
    window.localStorage.removeItem('exdb.sidebar.mode')
    mount('/')
    await screen.findByRole('heading', { name: 'Overview' })
    await user.click(screen.getByRole('button', { name: 'Sidebar' }))
    await user.click(await screen.findByRole('menuitemradio', { name: 'Always open' }))
    expect(window.localStorage.getItem('exdb.sidebar.mode')).toBe('open')
    await user.click(screen.getByRole('button', { name: 'Sidebar' }))
    await user.click(await screen.findByRole('menuitemradio', { name: 'Expand on hover' }))
    expect(window.localStorage.getItem('exdb.sidebar.mode')).toBeNull()
  })
})

/**
 * The rail never covers the page (a screenshot run at 1440×900 found the
 * expanded rail over the first 160 px of every page after a click in it).
 * jsdom has no layout, so this pins the classes and states that decide it;
 * the browser suite (`apps/server/test/web.e2e.test.ts`) measures the
 * rectangles in Chromium.
 */
describe('the rail and the page beside it', () => {
  async function shell(mode: SidebarMode) {
    setSidebarMode(mode)
    mount('/')
    await screen.findByRole('heading', { name: 'Overview' })
    const rail = document.querySelector('[data-collapsible][data-state]')
    const main = screen.getByRole('main')
    if (rail === null) throw new Error('no rail')
    // The rail's own box (the first child) is what the flex row lays out beside the page.
    const gap = rail.firstElementChild
    return { rail, gap, main }
  }

  afterEach(() => setSidebarMode('hover'))

  it('expand on hover: the layout keeps the icon width; the rail opens over the page only while hovered', async () => {
    const user = userEvent.setup()
    const { rail, gap, main } = await shell('hover')
    expect(rail).toHaveClass('w-12')
    expect(rail).toHaveAttribute('data-state', 'collapsed')
    expect(rail).toHaveAttribute('data-collapsible', 'icon')
    // The rail's box is out of the flow (absolute) and the page follows the 3rem slot.
    expect(gap).toHaveClass('absolute')
    expect(rail.nextElementSibling).toBe(main)

    const link = within(rail as HTMLElement).getAllByRole('link')[2] as HTMLElement
    await user.hover(link)
    expect(rail).toHaveAttribute('data-state', 'expanded')
    await user.click(link)
    await user.unhover(link)
    // Focus stays on the clicked link, but the rail is closed again: the page is not covered.
    expect(rail).toHaveAttribute('data-state', 'collapsed')
    expect(rail).toHaveAttribute('data-collapsible', 'icon')
  })

  it('always open: the rail takes its full width in the layout and the page starts after it', async () => {
    const { rail, gap, main } = await shell('open')
    expect(rail).not.toHaveClass('w-12')
    expect(rail).toHaveAttribute('data-state', 'expanded')
    expect(rail).toHaveAttribute('data-collapsible', '')
    // In the flow (relative) at the sidebar width: the page beside it is offset by the same width.
    expect(gap).toHaveClass('relative', 'w-(--sidebar-width)')
    expect(gap).not.toHaveClass('absolute')
    expect(rail.nextElementSibling).toBe(main)
  })

  it('collapsed: the rail takes the icon width in the layout and never opens by itself', async () => {
    const user = userEvent.setup()
    const { rail, gap, main } = await shell('collapsed')
    expect(rail).toHaveAttribute('data-state', 'collapsed')
    expect(rail).toHaveAttribute('data-collapsible', 'icon')
    expect(gap).toHaveClass('relative', 'group-data-[collapsible=icon]:w-(--sidebar-width-icon)')
    expect(rail.nextElementSibling).toBe(main)
    const link = within(rail as HTMLElement).getAllByRole('link')[2] as HTMLElement
    await user.hover(link)
    expect(rail).toHaveAttribute('data-state', 'collapsed')
  })
})

describe('commands and shortcuts of the shell', () => {
  it('opens the command menu with Control+K and goes to a section by its name', async () => {
    const user = userEvent.setup()
    const { router } = mount('/')
    await screen.findByRole('heading', { name: 'Overview' })
    await user.keyboard('{Control>}k{/Control}')
    const dialog = await screen.findByRole('dialog')
    await user.type(within(dialog).getByRole('combobox'), 'audit')
    await user.keyboard('{Enter}')
    await waitFor(() => expect(router.state.location.pathname).toBe('/audit'))
  })

  it('goes to a section with a G sequence from the registry', async () => {
    const user = userEvent.setup()
    const { router } = mount('/')
    await screen.findByRole('heading', { name: 'Overview' })
    await user.keyboard('gu')
    await waitFor(() => expect(router.state.location.pathname).toBe('/audit'))
    await user.keyboard('gp')
    await waitFor(() => expect(router.state.location.pathname).toBe('/changes/plans'))
    await user.keyboard('gc')
    await waitFor(() => expect(router.state.location.pathname).toBe('/changes'))
  })

  it('ignores letter shortcuts while typing in a field', async () => {
    const user = userEvent.setup()
    const { router } = mount('/')
    await screen.findByRole('heading', { name: 'Overview' })
    const field = document.createElement('input')
    document.body.append(field)
    field.focus()
    await user.keyboard('gu')
    expect(router.state.location.pathname).toBe('/')
    field.remove()
  })

  it('opens the shortcut help with ?', async () => {
    const user = userEvent.setup()
    mount('/')
    await screen.findByRole('heading', { name: 'Overview' })
    await user.keyboard('?')
    expect(await screen.findByRole('dialog', { name: /keyboard shortcuts/i })).toBeInTheDocument()
  })
})
