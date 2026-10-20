import '@testing-library/jest-dom/vitest'
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { axeViolations } from '../../../../packages/ui/test/support/axe.ts'
import { RECENT_TARGETS_PREFIX } from '../../src/features/target/recent.ts'
import { mountApp, World } from '../target/support.tsx'

/**
 * "Switch database…": a page of the command menu (a component page, requested
 * when it opens) that lists every database wherever the person is, in the
 * real shell. A page without a section menu is used throughout: beside one,
 * jsdom's resizable group takes every pointer-down as the start of a drag.
 */
beforeEach(() => window.localStorage.clear())
afterEach(() => {
  cleanup()
  window.localStorage.clear()
})

const IDENTITY = 'idn_00000000000000000000000001'
const LIST_REQUEST = '/api/v1/targets?limit=200'
const PAGE = '/audit'

function fleet(): World {
  const world = new World()
  world.add('shop/platform/staging')
  world.add('shop/platform/production', { tier: 'prod' })
  world.add('billing/api/live', { tier: 'prod' })
  return world
}

async function openPage(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await screen.findByRole('heading', { level: 1, name: 'Audit' })
  await user.keyboard('{Control>}k{/Control}')
  const dialog = await screen.findByRole('dialog')
  await user.click(await within(dialog).findByRole('option', { name: 'Switch database…' }))
  await within(dialog).findByRole('button', { name: 'Back from Switch database' })
  return dialog
}

const options = (dialog: HTMLElement): string[] =>
  within(dialog)
    .queryAllByRole('option')
    .map((option) => option.textContent ?? '')

describe('the command "Switch database…"', () => {
  it('is in the command menu on every page, and searchable by what a person would type', async () => {
    const user = userEvent.setup()
    mountApp(PAGE, fleet())
    await screen.findByRole('heading', { level: 1, name: 'Audit' })
    await user.keyboard('{Control>}k{/Control}')
    const dialog = await screen.findByRole('dialog')
    await user.type(within(dialog).getByRole('combobox'), 'switch data')
    expect(
      await within(dialog).findByRole('option', { name: 'Switch database…' }),
    ).toBeInTheDocument()
  })

  it('reads the databases when the page opens, not when the menu does', async () => {
    const user = userEvent.setup()
    const world = fleet()
    mountApp(PAGE, world)
    await screen.findByRole('heading', { level: 1, name: 'Audit' })
    await user.keyboard('{Control>}k{/Control}')
    const dialog = await screen.findByRole('dialog')
    await within(dialog).findByRole('option', { name: 'Switch database…' })
    expect(world.requests).not.toContain(LIST_REQUEST)
    await user.click(within(dialog).getByRole('option', { name: 'Switch database…' }))
    await waitFor(() => expect(world.requests).toContain(LIST_REQUEST))
  })

  it('lists the databases by project with their tier chips, and goes to the overview of the chosen one', async () => {
    const user = userEvent.setup()
    mountApp(PAGE, fleet())
    const dialog = await openPage(user)
    await waitFor(() => expect(options(dialog)).toHaveLength(3))
    expect(options(dialog)).toEqual([
      'liveProduction',
      'stagingNon-production',
      'productionProduction',
    ])
    expect(within(dialog).getByText('billing / api')).toBeInTheDocument()
    expect(within(dialog).getByText('shop / platform')).toBeInTheDocument()
  })

  it('goes to the overview of the chosen database from a page that is no target page, and closes the menu', async () => {
    const user = userEvent.setup()
    const { router } = mountApp(PAGE, fleet())
    const dialog = await openPage(user)
    await user.click(await within(dialog).findByRole('option', { name: /^live/ }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/t/billing/api/live'))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('goes to the same section of the chosen database from a target page', async () => {
    const user = userEvent.setup()
    const { router } = mountApp('/t/shop/platform/staging/locks', fleet())
    await screen.findByRole('heading', { level: 1, name: 'Locks' })
    await user.keyboard('{Control>}k{/Control}')
    const dialog = await screen.findByRole('dialog')
    await user.click(await within(dialog).findByRole('option', { name: 'Switch database…' }))
    await user.click(await within(dialog).findByRole('option', { name: /^live/ }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/t/billing/api/live/locks'))
  })

  it('filters with the search field of the menu, and Escape clears it, leaves the page, then closes the menu', async () => {
    const user = userEvent.setup()
    mountApp(PAGE, fleet())
    const dialog = await openPage(user)
    await waitFor(() => expect(options(dialog)).toHaveLength(3))
    await user.type(within(dialog).getByRole('combobox', { name: 'Search databases' }), 'prod')
    await waitFor(() => expect(options(dialog)).toHaveLength(1))
    await user.keyboard('{Escape}')
    await waitFor(() => expect(options(dialog)).toHaveLength(3))
    await user.keyboard('{Escape}')
    expect(
      await within(dialog).findByRole('option', { name: 'Switch database…' }),
    ).toBeInTheDocument()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('lists the recent databases of the person first', async () => {
    const user = userEvent.setup()
    window.localStorage.setItem(
      `${RECENT_TARGETS_PREFIX}${IDENTITY}`,
      JSON.stringify(['shop/platform/production', 'billing/api/live']),
    )
    mountApp(PAGE, fleet())
    const dialog = await openPage(user)
    const recent = await within(dialog).findByRole('group', { name: 'Recent' })
    expect(
      within(recent)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['shop/platform/productionProduction', 'billing/api/liveProduction'])
  })

  it('has no accessibility violations with the page open', async () => {
    const user = userEvent.setup()
    mountApp(PAGE, fleet())
    const dialog = await openPage(user)
    await waitFor(() => expect(options(dialog)).toHaveLength(3))
    expect(await axeViolations()).toEqual([])
  })
})

describe('the page of databases is a truthful read', () => {
  it('shows a failed read as failed with a retry, never as an empty list', async () => {
    const user = userEvent.setup()
    const world = fleet()
    world.failures.set(LIST_REQUEST, { status: 500, code: 'INTERNAL_ERROR' })
    mountApp(PAGE, world)
    const dialog = await openPage(user)
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Could not read the databases: INTERNAL_ERROR happened. (INTERNAL_ERROR) This does not mean there are no other databases.',
    )
    expect(options(dialog)).toEqual([])
    world.failures.clear()
    await user.click(within(dialog).getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(options(dialog)).toHaveLength(3))
  })

  it('says the list is partial when more databases exist than one read follows', async () => {
    const user = userEvent.setup()
    const world = fleet()
    world.listPage = (cursor) => ({
      items:
        cursor === null
          ? [...world.targets.values()].map((target) => ({
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
          : [],
      nextCursor: 'more',
    })
    mountApp(PAGE, world)
    const dialog = await openPage(user)
    expect(await within(dialog).findByText(/Showing part of the databases\./)).toBeInTheDocument()
    expect(options(dialog)).toHaveLength(3)
  })

  it('says "found no databases" only after a read that succeeded', async () => {
    const user = userEvent.setup()
    const world = fleet()
    world.listOverride = { items: [], nextCursor: null }
    mountApp(PAGE, world)
    const dialog = await openPage(user)
    expect(
      await within(dialog).findByText('The read succeeded and found no databases.'),
    ).toBeInTheDocument()
  })

  it('shows a loading state while the list is read, then an earlier read as stale when it cannot be refreshed', async () => {
    const user = userEvent.setup()
    const world = fleet()
    let release: () => void = () => undefined
    world.delays.set(
      LIST_REQUEST,
      new Promise<void>((resolve) => {
        release = resolve
      }),
    )
    const { queryClient } = mountApp(PAGE, world)
    const dialog = await openPage(user)
    expect(await within(dialog).findByText('Loading databases')).toBeInTheDocument()
    release()
    await waitFor(() => expect(options(dialog)).toHaveLength(3))
    // The refresh fails: the earlier list stays, marked with its age.
    world.failures.set(LIST_REQUEST, { status: 500, code: 'INTERNAL_ERROR' })
    await queryClient.refetchQueries({ queryKey: ['targets', 'list'] })
    expect(
      await within(dialog).findByText(/Showing an earlier read of the databases/),
    ).toBeInTheDocument()
    expect(options(dialog)).toHaveLength(3)
  })
})
