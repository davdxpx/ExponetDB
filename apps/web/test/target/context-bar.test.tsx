import '@testing-library/jest-dom/vitest'
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountApp, project, World } from './support.tsx'

vi.mock('../../src/shell/app-shell.tsx', async () => ({
  AppShell: (await import('./test-shell.tsx')).TestShell,
}))

afterEach(cleanup)

const bar = () => screen.findByRole('navigation', { name: 'Target' })

/** The environment button of the context bar (its name starts with the word "Environment"). */
async function switcher() {
  return within(await bar()).findByRole('button', { name: /^Environment\b/ })
}

async function openSwitcher(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await switcher())
  return screen.findByRole('menu')
}

/** Opens the command menu and waits until it lists the commands of this page. */
async function paletteHas(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.keyboard('{Control>}k{/Control}')
  const dialog = await screen.findByRole('dialog')
  await within(dialog).findByText(name)
  await user.keyboard('{Escape}')
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
}

describe('the context bar', () => {
  it('shows product and project as text and the environment with its tier chip', async () => {
    mountApp(
      '/t/shop/platform/staging',
      (() => {
        const world = new World()
        project(world)
        return world
      })(),
    )
    const nav = await bar()
    expect(within(nav).getByText('shop')).toBeInTheDocument()
    expect(within(nav).getByText('platform')).toBeInTheDocument()
    expect(within(nav).queryByRole('link')).not.toBeInTheDocument()
    const button = await switcher()
    expect(button).toHaveTextContent('staging')
    await waitFor(() => expect(button).toHaveTextContent('Non-production'))
  })

  it('on a phone keeps the environment and its tier chip, and the menu names product and project', async () => {
    const world = new World()
    project(world, 'shop', 'platform')
    mountApp('/t/shop/platform/staging', world)
    const nav = await bar()
    // Below the md breakpoint the crumbs for product and project are hidden by class.
    for (const crumb of [within(nav).getByText('shop'), within(nav).getByText('platform')]) {
      expect(crumb.closest('li')?.className).toContain('max-md:hidden')
    }
    const button = await switcher()
    await waitFor(() => expect(button).toHaveTextContent('Non-production'))
    const user = userEvent.setup()
    const menu = await openSwitcher(user)
    expect(within(menu).getByText('shop / platform')).toBeInTheDocument()
  })

  it('renders nothing outside a target page, and asks for nothing', async () => {
    const world = new World()
    project(world)
    mountApp('/', world)
    await screen.findByRole('heading', { level: 1, name: 'Overview' })
    expect(screen.queryByRole('navigation', { name: 'Target' })).not.toBeInTheDocument()
    // The overview reads its own fleet data (the list of targets for "needs attention"
    // among it); the context bar asks for no target, project or environment.
    expect(
      world.apiRequests.filter((path) => /\/(targets\/|projects|environments)/.test(path)),
    ).toEqual([])
  })

  it("lists the environments of the project with the chip of each one's tier field", async () => {
    const user = userEvent.setup()
    const world = new World()
    world.add('shop/platform/staging')
    // The names say one thing and the tier fields another: the tier field decides.
    world.add('shop/platform/prod', { tier: 'nonprod' })
    world.add('shop/platform/live', { tier: 'prod' })
    world.add('shop/other/elsewhere', { tier: 'prod' })
    mountApp('/t/shop/platform/staging', world)
    const menu = await openSwitcher(user)
    await waitFor(() => expect(within(menu).getAllByRole('menuitem')).toHaveLength(3))
    const items = within(menu).getAllByRole('menuitem')
    const byName = (slug: string) => items.find((item) => item.textContent?.startsWith(slug))
    expect(byName('prod')).toHaveTextContent('Non-production')
    expect(byName('prod')).not.toHaveTextContent(/^prodProduction/)
    expect(within(byName('prod') as HTMLElement).queryByText('Production')).not.toBeInTheDocument()
    expect(within(byName('live') as HTMLElement).getByText('Production')).toBeInTheDocument()
    // An environment of another project is not offered.
    expect(items.some((item) => item.textContent?.includes('elsewhere'))).toBe(false)
    // The current environment is marked, and is not a link.
    const current = byName('staging') as HTMLElement
    expect(current).toHaveAttribute('aria-current', 'true')
    expect(current).toHaveTextContent('Current environment')
    expect(current.closest('a')).toBeNull()
    expect(byName('live')?.getAttribute('href')).toBe('/t/shop/platform/live')
  })

  it('goes to the same page on the chosen environment', async () => {
    const user = userEvent.setup()
    const world = new World()
    project(world)
    world.sample('shop/platform/production')
    const { router } = mountApp('/t/shop/platform/staging/locks', world)
    const menu = await openSwitcher(user)
    const production = await within(menu).findByRole('menuitem', { name: /^production/ })
    expect(production).toHaveAttribute('href', '/t/shop/platform/production/locks')
    await user.click(production)
    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/t/shop/platform/production/locks'),
    )
    expect(await screen.findByRole('heading', { level: 1, name: 'Locks' })).toBeInTheDocument()
    // The new page shows the production cue.
    await waitFor(() =>
      expect(document.querySelector('[data-slot="target-layout"]')).toHaveAttribute(
        'data-tier',
        'production',
      ),
    )
    expect(await switcher()).toHaveTextContent('production')
    expect(menuIsClosed()).toBe(true)
  })

  it('keeps a schema kind and goes to the overview from the overview', async () => {
    const user = userEvent.setup()
    const world = new World()
    project(world)
    const { router } = mountApp('/t/shop/platform/staging/schema/tables', world)
    let menu = await openSwitcher(user)
    await user.click(await within(menu).findByRole('menuitem', { name: /^development/ }))
    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/t/shop/platform/development/schema/tables'),
    )
    await router.navigate({ href: '/t/shop/platform/development' })
    await screen.findByRole('heading', { level: 1, name: 'Overview' })
    menu = await openSwitcher(user)
    await user.click(await within(menu).findByRole('menuitem', { name: /^staging/ }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/t/shop/platform/staging'))
  })
})

function menuIsClosed(): boolean {
  return screen.queryByRole('menu') === null
}

describe('the environment list is a truthful read', () => {
  it('shows a failed read as a failure with a retry, never as an empty menu', async () => {
    const user = userEvent.setup()
    const world = new World()
    project(world)
    world.failures.set('/api/v1/targets?product', {
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'The control store did not answer.',
    })
    mountApp('/t/shop/platform/staging', world)
    // The page itself is fine, and the bar still knows the tier of this environment.
    await screen.findByRole('heading', { level: 1, name: 'Overview' })
    await waitFor(() =>
      expect(
        within(screen.getByRole('navigation', { name: 'Target' })).getByText('Non-production'),
      ),
    )
    const menu = await openSwitcher(user)
    expect(menu).toHaveTextContent(
      'Could not read the environments of this project: The control store did not answer. (INTERNAL_ERROR) This does not mean there are no other environments.',
    )
    expect(
      within(menu)
        .queryAllByRole('menuitem')
        .map((i) => i.textContent),
    ).toEqual(['Try again'])

    world.failures.clear()
    await user.click(within(menu).getByRole('menuitem', { name: 'Try again' }))
    await waitFor(() => expect(within(menu).getAllByRole('menuitem')).toHaveLength(3))
    expect(menu).not.toHaveTextContent('Could not read')
  })

  it('shows a loading state while the list is read', async () => {
    const user = userEvent.setup()
    const world = new World()
    project(world)
    let release: () => void = () => undefined
    world.delays.set(
      '/api/v1/targets?product',
      new Promise<void>((resolve) => {
        release = resolve
      }),
    )
    mountApp('/t/shop/platform/staging', world)
    const menu = await openSwitcher(user)
    expect(menu).toHaveTextContent('Loading environments')
    expect(within(menu).queryAllByRole('menuitem')).toHaveLength(0)
    // The tier of this environment comes from its own read in the meantime.
    expect(await switcher()).toHaveTextContent('staging')
    release()
    await waitFor(() => expect(within(menu).getAllByRole('menuitem')).toHaveLength(3))
    expect(menu).not.toHaveTextContent('Loading environments')
  })

  it('says it shows part of the list when the server has more, and lists what it has', async () => {
    const user = userEvent.setup()
    const world = new World()
    project(world)
    world.nextCursor = 'cur_next'
    mountApp('/t/shop/platform/staging', world)
    const menu = await openSwitcher(user)
    await waitFor(() => expect(within(menu).getAllByRole('menuitem')).toHaveLength(3))
    expect(menu).toHaveTextContent(
      'Showing part of the environments. More environments exist than one read returns.',
    )
  })

  it('does not show an environment whose path is not three slugs of this project, and says so', async () => {
    const user = userEvent.setup()
    const world = new World()
    world.add('shop/platform/staging')
    world.listOverride = {
      items: [
        { ...world.targets.get('shop/platform/staging') },
        {
          ...world.targets.get('shop/platform/staging'),
          id: 'tgt_00000000000000000000000099',
          path: 'Shop/platform/<b>x</b>',
        },
      ],
      nextCursor: null,
    }
    mountApp('/t/shop/platform/staging', world)
    const menu = await openSwitcher(user)
    await waitFor(() => expect(menu).toHaveTextContent('Showing part of the environments'))
    expect(menu).toHaveTextContent('Some environments have a path the page cannot show.')
    expect(within(menu).getAllByRole('menuitem')).toHaveLength(1)
    expect(menu.innerHTML).not.toContain('<b>')
  })

  it('shows an earlier read with its age and a refresh when the list cannot be refreshed', async () => {
    const user = userEvent.setup()
    const world = new World()
    project(world)
    const { queryClient } = mountApp('/t/shop/platform/staging', world)
    await screen.findByRole('heading', { level: 1, name: 'Overview' })
    await waitFor(() =>
      expect(world.apiRequests.some((r) => r.startsWith('/api/v1/targets?'))).toBe(true),
    )
    await waitFor(() =>
      expect(
        queryClient.getQueryState(['targets', 'environments', 'shop', 'platform'])?.status,
      ).toBe('success'),
    )
    world.failures.set('/api/v1/targets?product', { status: 500, code: 'INTERNAL_ERROR' })
    await queryClient.refetchQueries({ queryKey: ['targets', 'environments', 'shop', 'platform'] })
    const menu = await openSwitcher(user)
    expect(menu).toHaveTextContent('Showing an earlier read of the environments, observed')
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((i) => i.textContent),
    ).toEqual(expect.arrayContaining(['Refresh']))
    // The earlier list is still there.
    expect(within(menu).getByRole('menuitem', { name: /^production/ })).toBeInTheDocument()
    world.failures.clear()
    await user.click(within(menu).getByRole('menuitem', { name: 'Refresh' }))
    await waitFor(() => expect(menu).not.toHaveTextContent('Showing an earlier read'))
  })

  it('names what is missing when more environments exist than one read returns, never as a full list', async () => {
    const user = userEvent.setup()
    const world = new World()
    project(world)
    world.nextCursor = 'more'
    mountApp('/t/shop/platform/staging', world)
    const menu = await openSwitcher(user)
    await waitFor(() =>
      expect(menu).toHaveTextContent(
        'Showing part of the environments. More environments exist than one read returns.',
      ),
    )
  })

  it('says "found no environments" only after a read that succeeded', async () => {
    const user = userEvent.setup()
    const world = new World()
    project(world)
    world.listOverride = { items: [], nextCursor: null }
    mountApp('/t/shop/platform/staging', world)
    const menu = await openSwitcher(user)
    await waitFor(() =>
      expect(menu).toHaveTextContent(
        'The read succeeded and found no environments for this project.',
      ),
    )
    expect(menu).not.toHaveTextContent('Could not read')
  })
})

describe('the shortcuts of the environment switcher', () => {
  it('lists a command per other environment in the section "Switch environment"', async () => {
    const user = userEvent.setup()
    const world = new World()
    project(world)
    mountApp('/t/shop/platform/staging', world)
    await user.keyboard('{Control>}k{/Control}')
    const dialog = await screen.findByRole('dialog')
    await within(dialog).findByText('Switch to production')
    expect(within(dialog).getByText('Switch to development')).toBeInTheDocument()
    expect(within(dialog).queryByText('Switch to staging')).not.toBeInTheDocument()
    expect(within(dialog).getByText('Switch environment')).toBeInTheDocument()
  })

  it('goes to production with E then P, and keeps the page', async () => {
    const user = userEvent.setup()
    const world = new World()
    project(world)
    const { router } = mountApp('/t/shop/platform/staging/migrations', world)
    await paletteHas(user, 'Switch to production')
    await user.keyboard('ep')
    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/t/shop/platform/production/migrations'),
    )
  })

  it('goes to staging with E then S, and to development with E then D', async () => {
    const user = userEvent.setup()
    const world = new World()
    project(world)
    const { router } = mountApp('/t/shop/platform/production/locks', world)
    await paletteHas(user, 'Switch to staging')
    await user.keyboard('es')
    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/t/shop/platform/staging/locks'),
    )
    await paletteHas(user, 'Switch to development')
    await user.keyboard('ed')
    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/t/shop/platform/development/locks'),
    )
  })

  it('leaves a shortcut unbound when there is no such environment, and does nothing for the current one', async () => {
    const user = userEvent.setup()
    const world = new World()
    world.add('shop/platform/staging')
    world.add('shop/platform/qa')
    const { router } = mountApp('/t/shop/platform/staging', world)
    await paletteHas(user, 'Switch to qa')
    await user.keyboard('ep')
    await user.keyboard('ed')
    await user.keyboard('es')
    expect(router.state.location.pathname).toBe('/t/shop/platform/staging')
  })

  it('falls back to the only environment with tier prod when none is called production', async () => {
    const user = userEvent.setup()
    const world = new World()
    world.add('shop/platform/staging')
    world.add('shop/platform/live', { tier: 'prod' })
    const { router } = mountApp('/t/shop/platform/staging', world)
    await paletteHas(user, 'Switch to live')
    await user.keyboard('ep')
    await waitFor(() => expect(router.state.location.pathname).toBe('/t/shop/platform/live'))
  })

  it('does not choose between several environments with tier prod', async () => {
    const user = userEvent.setup()
    const world = new World()
    world.add('shop/platform/staging')
    world.add('shop/platform/live', { tier: 'prod' })
    world.add('shop/platform/live-eu', { tier: 'prod' })
    const { router } = mountApp('/t/shop/platform/staging', world)
    await paletteHas(user, 'Switch to live-eu')
    await user.keyboard('ep')
    expect(router.state.location.pathname).toBe('/t/shop/platform/staging')
  })

  it('does not take the name for the tier: an environment named prod is not the production shortcut', async () => {
    const user = userEvent.setup()
    const world = new World()
    world.add('shop/platform/staging')
    world.add('shop/platform/prod', { tier: 'nonprod' })
    const { router } = mountApp('/t/shop/platform/staging', world)
    await paletteHas(user, 'Switch to prod')
    await user.keyboard('ep')
    expect(router.state.location.pathname).toBe('/t/shop/platform/staging')
  })

  it('binds nothing while the list of environments could not be read', async () => {
    const user = userEvent.setup()
    const world = new World()
    project(world)
    world.failures.set('/api/v1/targets?product', { status: 500, code: 'INTERNAL_ERROR' })
    const { router } = mountApp('/t/shop/platform/staging', world)
    await screen.findByRole('heading', { level: 1, name: 'Overview' })
    await waitFor(() =>
      expect(world.apiRequests.some((r) => r.startsWith('/api/v1/targets?'))).toBe(true),
    )
    await user.keyboard('ep')
    expect(router.state.location.pathname).toBe('/t/shop/platform/staging')
    await user.keyboard('{Control>}k{/Control}')
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).queryByText(/Switch to/)).not.toBeInTheDocument()
  })

  it('leaves with the target page: the commands and the shortcuts are gone elsewhere', async () => {
    const user = userEvent.setup()
    const world = new World()
    project(world)
    const { router } = mountApp('/t/shop/platform/staging', world)
    await paletteHas(user, 'Switch to production')
    await router.navigate({ href: '/' })
    await screen.findByRole('heading', { level: 1, name: 'Overview' })
    await user.keyboard('ep')
    expect(router.state.location.pathname).toBe('/')
    await user.keyboard('{Control>}k{/Control}')
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).queryByText(/Switch to/)).not.toBeInTheDocument()
  })
})

describe('switching environment remounts the target outlet', () => {
  it('replaces the outlet when the target id changes, so target-scoped state starts fresh', async () => {
    const user = userEvent.setup()
    const world = new World()
    project(world)
    mountApp('/t/shop/platform/staging/migrations', world)
    await screen.findByRole('heading', { level: 2, name: 'Ledger' })
    const before = document.querySelector('[data-slot="target-outlet"]')
    expect(before).not.toBeNull()
    const menu = await openSwitcher(user)
    await user.click(await within(menu).findByRole('menuitem', { name: /^development/ }))
    await waitFor(() =>
      expect(document.querySelector('[data-slot="target-layout"]')).toBeInTheDocument(),
    )
    await screen.findByRole('heading', { level: 2, name: 'Ledger' })
    const after = document.querySelector('[data-slot="target-outlet"]')
    expect(after).not.toBeNull()
    expect(after).not.toBe(before)
    expect(before?.isConnected).toBe(false)
  })

  it('keeps the outlet while the same target is read again', async () => {
    const world = new World()
    project(world)
    const { queryClient } = mountApp('/t/shop/platform/staging/migrations', world)
    await screen.findByRole('heading', { level: 2, name: 'Ledger' })
    const before = document.querySelector('[data-slot="target-outlet"]')
    await queryClient.refetchQueries({ queryKey: ['targets', 'detail', 'shop/platform/staging'] })
    expect(document.querySelector('[data-slot="target-outlet"]')).toBe(before)
  })
})

describe('accessibility of the context bar', () => {
  it('has no axe violations with the menu closed and open', async () => {
    const { axeViolations } = await import('../../../../packages/ui/test/support/axe.ts')
    const user = userEvent.setup()
    const world = new World()
    project(world)
    mountApp('/t/shop/platform/production', world)
    const nav = await bar()
    await waitFor(() => expect(within(nav).getByText('Production')).toBeInTheDocument())
    expect(await axeViolations(nav)).toEqual([])
    const menu = await openSwitcher(user)
    await waitFor(() => expect(within(menu).getAllByRole('menuitem')).toHaveLength(3))
    expect(await axeViolations(menu)).toEqual([])
  })

  it('has no axe violations in the failed and loading states of the menu', async () => {
    const { axeViolations } = await import('../../../../packages/ui/test/support/axe.ts')
    const user = userEvent.setup()
    const world = new World()
    project(world)
    world.failures.set('/api/v1/targets?product', { status: 500, code: 'INTERNAL_ERROR' })
    mountApp('/t/shop/platform/staging', world)
    const menu = await openSwitcher(user)
    await waitFor(() => expect(menu).toHaveTextContent('Could not read the environments'))
    expect(await axeViolations(menu)).toEqual([])
  })
})
