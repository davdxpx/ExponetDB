import '@testing-library/jest-dom/vitest'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppProviders } from '../../src/app/providers.tsx'
import { createReauthBridge } from '../../src/features/reauth/reauth.tsx'
import { ApiClient } from '../../src/lib/api/client.ts'
import { createQueryClient } from '../../src/lib/query/client.ts'
import { routeTree } from '../../src/routeTree.gen.ts'
import { isCurrent } from '../../src/shell/app-shell.tsx'

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

describe('isCurrent', () => {
  it('matches the section and pages below it, never a sibling with the same prefix', () => {
    expect(isCurrent('/', '/')).toBe(true)
    expect(isCurrent('/', '/audit')).toBe(false)
    expect(isCurrent('/audit', '/audit')).toBe(true)
    expect(isCurrent('/changes', '/changes/plans/pln_1')).toBe(true)
    expect(isCurrent('/access/roles', '/access/roles-extra')).toBe(false)
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
