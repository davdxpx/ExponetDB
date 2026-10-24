import '@testing-library/jest-dom/vitest'
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axeViolations } from '../../../../packages/ui/test/support/axe.ts'
import { RECENT_TARGETS_PREFIX } from '../../src/features/target/recent-storage.ts'
import { mountApp, World } from './support.tsx'

vi.mock('../../src/shell/app-shell.tsx', async () => ({
  AppShell: (await import('./test-shell.tsx')).TestShell,
}))

beforeEach(() => window.localStorage.clear())
afterEach(() => {
  cleanup()
  window.localStorage.clear()
})

const IDENTITY = 'idn_00000000000000000000000001'
const LIST_REQUEST = '/api/v1/targets?limit=200'

/** Three databases of two projects, one of them production by its tier field. */
function fleet(): World {
  const world = new World()
  world.add('shop/platform/development')
  world.add('shop/platform/staging')
  world.add('shop/platform/production', { tier: 'prod' })
  world.add('billing/api/staging')
  world.add('billing/api/live', { tier: 'prod' })
  return world
}

async function trigger(): Promise<HTMLElement> {
  return screen.findByRole('button', { name: /^Switch database/ })
}

async function openSwitcher(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await user.click(await trigger())
  return screen.findByRole('dialog')
}

/** The databases of the product groups: the shortcut group "Recent" repeats some of them and is left out. */
function listed(popover: HTMLElement): string[] {
  return within(popover)
    .queryAllByRole('option')
    .filter(
      (option) =>
        option.closest('[role="group"]')?.getAttribute('aria-labelledby') !== recentId(popover),
    )
    .map((option) => option.textContent ?? '')
}

function recentId(popover: HTMLElement): string | null {
  const heading = [...popover.querySelectorAll('[cmdk-group-heading]')].find(
    (node) => node.textContent === 'Recent',
  )
  return heading?.id ?? null
}

describe('the database switcher of the context bar', () => {
  it('shows product and project as the trigger, a button and not a link', async () => {
    mountApp('/t/shop/platform/staging', fleet())
    const button = await trigger()
    expect(button).toHaveTextContent('shop')
    expect(button).toHaveTextContent('platform')
    expect(button).toHaveAccessibleName('Switch database: shop / platform')
    expect(button.closest('li')?.className).toContain('max-md:hidden')
    expect(
      within(screen.getByRole('navigation', { name: 'Target' })).queryByRole('link'),
    ).toBeNull()
  })

  it('reads the databases when it opens, not before', async () => {
    const user = userEvent.setup()
    const world = fleet()
    mountApp('/t/shop/platform/staging', world)
    await trigger()
    await screen.findByRole('navigation', { name: 'Target sections' })
    await waitFor(() => expect(world.requests.some((r) => r.includes('product=shop'))).toBe(true))
    expect(world.requests).not.toContain(LIST_REQUEST)
    await openSwitcher(user)
    await waitFor(() => expect(world.requests).toContain(LIST_REQUEST))
  })

  it('lists the databases grouped by product and project, each with the chip of its tier field', async () => {
    const user = userEvent.setup()
    mountApp('/t/shop/platform/staging', fleet())
    const popover = await openSwitcher(user)
    await waitFor(() => expect(listed(popover)).toHaveLength(5))
    // The recent group (this database, opened just now) comes first, then one group per project.
    const groups = within(popover).getAllByRole('group')
    expect(groups).toHaveLength(3)
    expect(within(popover).getByText('billing / api')).toBeInTheDocument()
    expect(within(popover).getByText('shop / platform')).toBeInTheDocument()
    const shop = within(groups[2] as HTMLElement).getAllByRole('option')
    // Nonproduction first, then production; the current one is marked and says so.
    expect(shop.map((o) => o.textContent)).toEqual([
      'developmentNon-production',
      'stagingNon-productionCurrent database',
      'productionProduction',
    ])
    const billing = within(groups[1] as HTMLElement).getAllByRole('option')
    expect(billing.map((o) => o.textContent)).toEqual(['stagingNon-production', 'liveProduction'])
  })

  it('takes the tier from the field, not from the name', async () => {
    const user = userEvent.setup()
    const world = new World()
    world.add('shop/platform/staging')
    world.add('shop/platform/prod', { tier: 'nonprod' })
    mountApp('/t/shop/platform/staging', world)
    const popover = await openSwitcher(user)
    const option = await within(popover).findByRole('option', { name: /^prod/ })
    expect(option).toHaveTextContent('Non-production')
    expect(within(option).queryByText('Production')).toBeNull()
  })

  it('goes to the same section of the chosen database', async () => {
    const user = userEvent.setup()
    const { router } = mountApp('/t/shop/platform/staging/locks', fleet())
    const popover = await openSwitcher(user)
    await user.click(await within(popover).findByRole('option', { name: /^live/ }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/t/billing/api/live/locks'))
    expect(screen.queryByRole('dialog')).toBeNull()
    // The bar now names the database the person is on.
    expect(await trigger()).toHaveAccessibleName('Switch database: billing / api')
  })

  it('keeps a schema kind and drops an object name', async () => {
    const user = userEvent.setup()
    const { router } = mountApp('/t/shop/platform/staging/schema/indexes', fleet())
    const popover = await openSwitcher(user)
    await user.click(await within(popover).findByRole('option', { name: /^live/ }))
    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/t/billing/api/live/schema/indexes'),
    )
  })

  it('only closes when the chosen database is the one the person is on', async () => {
    const user = userEvent.setup()
    const { router } = mountApp('/t/shop/platform/staging/locks', fleet())
    const popover = await openSwitcher(user)
    await user.click(await within(popover).findByRole('option', { name: /^staging.*Current/ }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(router.state.location.pathname).toBe('/t/shop/platform/staging/locks')
  })

  it('filters the databases by what is typed, and says when none match', async () => {
    const user = userEvent.setup()
    mountApp('/t/shop/platform/staging', fleet())
    const popover = await openSwitcher(user)
    await waitFor(() => expect(listed(popover)).toHaveLength(5))
    await user.type(within(popover).getByRole('combobox', { name: 'Search databases' }), 'billing')
    await waitFor(() => expect(listed(popover)).toHaveLength(2))
    expect(listed(popover).every((text) => /staging|live/.test(text))).toBe(true)
    await user.clear(within(popover).getByRole('combobox'))
    await user.type(within(popover).getByRole('combobox'), 'zzzz')
    expect(await within(popover).findByText('No database matches your search.')).toBeInTheDocument()
  })

  it('works with the keyboard: open, search, choose with Enter, and Escape closes it and returns focus', async () => {
    const user = userEvent.setup()
    const { router } = mountApp('/t/shop/platform/staging/locks', fleet())
    const button = await trigger()
    button.focus()
    await user.keyboard('{Enter}')
    const popover = await screen.findByRole('dialog')
    await waitFor(() => expect(listed(popover)).toHaveLength(5))
    expect(within(popover).getByRole('combobox')).toHaveFocus()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(button).toHaveFocus()

    await user.keyboard('{Enter}')
    await screen.findByRole('dialog')
    await user.keyboard('live')
    await waitFor(() => expect(listed(screen.getByRole('dialog'))).toHaveLength(1))
    await user.keyboard('{Enter}')
    await waitFor(() => expect(router.state.location.pathname).toBe('/t/billing/api/live/locks'))
  })

  it('has no accessibility violations with the list open', async () => {
    const user = userEvent.setup()
    mountApp('/t/shop/platform/staging', fleet())
    const popover = await openSwitcher(user)
    await waitFor(() => expect(listed(popover)).toHaveLength(5))
    expect(await axeViolations()).toEqual([])
  })
})

describe('the recent databases', () => {
  it('remembers the databases that were opened and lists them first, newest first', async () => {
    const user = userEvent.setup()
    const world = fleet()
    const { router } = mountApp('/t/shop/platform/staging', world)
    // A database is remembered once the server has answered for it.
    await waitFor(() =>
      expect(window.localStorage.getItem(`${RECENT_TARGETS_PREFIX}${IDENTITY}`)).toBe(
        '["shop/platform/staging"]',
      ),
    )
    await router.navigate({ href: '/t/billing/api/live/locks' })
    await screen.findByRole('heading', { level: 1, name: 'Locks' })
    await waitFor(() =>
      expect(window.localStorage.getItem(`${RECENT_TARGETS_PREFIX}${IDENTITY}`)).toBe(
        '["billing/api/live","shop/platform/staging"]',
      ),
    )
    const popover = await openSwitcher(user)
    await waitFor(() => expect(listed(popover)).toHaveLength(5))
    const recent = within(popover).getByRole('group', { name: 'Recent' })
    expect(
      within(recent)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['billing/api/liveProductionCurrent database', 'shop/platform/stagingNon-production'])
    // The recent group comes before the products.
    expect(within(popover).getAllByRole('group')[0]).toBe(recent)
  })

  it('goes to a recent database like to any other, and hides the group while searching', async () => {
    const user = userEvent.setup()
    window.localStorage.setItem(
      `${RECENT_TARGETS_PREFIX}${IDENTITY}`,
      JSON.stringify(['billing/api/live']),
    )
    const { router } = mountApp('/t/shop/platform/staging/locks', fleet())
    const popover = await openSwitcher(user)
    const recent = await within(popover).findByRole('group', { name: 'Recent' })
    await user.type(within(popover).getByRole('combobox'), 'live')
    await waitFor(() => expect(within(popover).queryByRole('group', { name: 'Recent' })).toBeNull())
    expect(listed(popover)).toHaveLength(1)
    await user.clear(within(popover).getByRole('combobox'))
    await user.click(
      within(await within(popover).findByRole('group', { name: 'Recent' })).getByRole('option', {
        name: /^billing\/api\/live/,
      }),
    )
    await waitFor(() => expect(router.state.location.pathname).toBe('/t/billing/api/live/locks'))
    expect(recent).toBeDefined()
  })

  it('remembers nothing for a target the server does not know', async () => {
    const world = new World()
    mountApp('/t/shop/platform/ghost', world)
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument()
    expect(window.localStorage.getItem(`${RECENT_TARGETS_PREFIX}${IDENTITY}`)).toBeNull()
  })

  it("drops a recent database the complete list no longer holds, and shows no other person's list", async () => {
    const user = userEvent.setup()
    window.localStorage.setItem(
      `${RECENT_TARGETS_PREFIX}${IDENTITY}`,
      JSON.stringify(['shop/platform/gone']),
    )
    window.localStorage.setItem(
      `${RECENT_TARGETS_PREFIX}idn_00000000000000000000000002`,
      JSON.stringify(['billing/api/live']),
    )
    mountApp('/t/shop/platform/staging', fleet())
    const popover = await openSwitcher(user)
    await waitFor(() => expect(listed(popover)).toHaveLength(5))
    // Only the database just opened is recent: the one the complete list lacks is gone from it,
    // and the list of another person is not read.
    const recent = within(popover).getByRole('group', { name: 'Recent' })
    expect(
      within(recent)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['shop/platform/stagingNon-productionCurrent database'])
    expect(popover.textContent).not.toContain('shop/platform/gone')
  })

  it('keeps a recent database the list did not reach, with its tier said to be unknown', async () => {
    const user = userEvent.setup()
    window.localStorage.setItem(
      `${RECENT_TARGETS_PREFIX}${IDENTITY}`,
      JSON.stringify(['legacy/old/archive']),
    )
    const world = fleet()
    // A cursor behind every page: the read stops at its bound and the list is only part of the databases.
    world.listPage = (cursor) => ({
      items: cursor === null ? summaries(world) : [],
      nextCursor: 'more',
    })
    mountApp('/t/shop/platform/staging', world)
    const popover = await openSwitcher(user)
    const recent = await within(popover).findByRole('group', { name: 'Recent' })
    expect(
      await within(recent).findByRole('option', { name: /^legacy\/old\/archive/ }),
    ).toHaveTextContent('legacy/old/archiveTier unknown')
  })
})

function summaries(world: World) {
  return [...world.targets.values()].map((target) => ({
    id: target.id,
    path: target.path,
    productId: target.productId,
    projectId: target.projectId,
    environmentId: target.environmentId,
    tier: target.tier,
    state: target.state,
    generation: target.generation,
    health: target.health,
  }))
}

describe('the list of databases is a truthful read', () => {
  it('shows a failed read as failed with a retry, never as an empty list', async () => {
    const user = userEvent.setup()
    const world = fleet()
    world.failures.set(LIST_REQUEST, {
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'The control store did not answer.',
    })
    mountApp('/t/shop/platform/staging', world)
    const popover = await openSwitcher(user)
    expect(await within(popover).findByRole('alert')).toHaveTextContent(
      'Could not read the databases: The control store did not answer. (INTERNAL_ERROR) This does not mean there are no other databases.',
    )
    expect(within(popover).queryAllByRole('option')).toHaveLength(0)
    expect(popover.textContent).not.toContain('found no databases')

    world.failures.clear()
    await user.click(within(popover).getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(listed(popover)).toHaveLength(5))
    expect(within(popover).queryByRole('alert')).toBeNull()
  })

  it('shows a loading state while the list is read', async () => {
    const user = userEvent.setup()
    const world = fleet()
    let release: () => void = () => undefined
    world.delays.set(
      LIST_REQUEST,
      new Promise<void>((resolve) => {
        release = resolve
      }),
    )
    mountApp('/t/shop/platform/staging', world)
    const popover = await openSwitcher(user)
    expect(await within(popover).findByText('Loading databases')).toBeInTheDocument()
    expect(within(popover).queryAllByRole('option')).toHaveLength(0)
    release()
    await waitFor(() => expect(listed(popover)).toHaveLength(5))
  })

  it('shows an earlier read with its age and a refresh when the list cannot be refreshed', async () => {
    const user = userEvent.setup()
    const world = fleet()
    const { queryClient } = mountApp('/t/shop/platform/staging', world)
    let popover = await openSwitcher(user)
    await waitFor(() => expect(listed(popover)).toHaveLength(5))
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    world.failures.set(LIST_REQUEST, { status: 500, code: 'INTERNAL_ERROR' })
    await queryClient.refetchQueries({ queryKey: ['targets', 'list'] })
    popover = await openSwitcher(user)
    expect(
      await within(popover).findByText(/Showing an earlier read of the databases/),
    ).toBeInTheDocument()
    // The earlier list is still there, and a refresh is offered.
    expect(listed(popover)).toHaveLength(5)
    world.failures.clear()
    await user.click(within(popover).getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(within(popover).queryByText(/Showing an earlier read/)).toBeNull())
  })

  it('says the list is partial when more databases exist than one read follows, and lists what it has', async () => {
    const user = userEvent.setup()
    const world = fleet()
    let page = 0
    world.listPage = () => {
      page += 1
      // Five pages of the same two databases and a cursor behind the last one.
      return {
        items: summaries(world).slice((page - 1) % 2 === 0 ? 0 : 2, (page - 1) % 2 === 0 ? 2 : 4),
        nextCursor: `page${page}`,
      }
    }
    mountApp('/t/shop/platform/staging', world)
    const popover = await openSwitcher(user)
    expect(
      await within(popover).findByText(/Showing part of the databases\. More databases exist/),
    ).toBeInTheDocument()
    expect(listed(popover).length).toBeGreaterThan(0)
  })

  it('does not offer a database whose path is not three slugs, and says so', async () => {
    const user = userEvent.setup()
    const world = fleet()
    world.listOverride = {
      items: [
        ...summaries(world),
        {
          ...summaries(world)[0],
          id: 'tgt_00000000000000000000000099',
          path: `Shop/<script>alert(1)</script>/evil‮​`,
        },
      ],
      nextCursor: null,
    }
    mountApp('/t/shop/platform/staging', world)
    const popover = await openSwitcher(user)
    await waitFor(() => expect(listed(popover)).toHaveLength(5))
    expect(
      within(popover).getByText(/Some databases have a path the page cannot show\./),
    ).toBeInTheDocument()
    expect(popover.innerHTML).not.toContain('<script')
    expect(popover.textContent).not.toContain('alert(1)')
    expect(popover.textContent).not.toContain('‮')
  })

  it('says "found no databases" only after a read that succeeded', async () => {
    const user = userEvent.setup()
    const world = fleet()
    world.listOverride = { items: [], nextCursor: null }
    mountApp('/t/shop/platform/staging', world)
    const popover = await openSwitcher(user)
    expect(
      await within(popover).findByText('The read succeeded and found no databases.'),
    ).toBeInTheDocument()
    expect(within(popover).queryByRole('alert')).toBeNull()
  })
})
