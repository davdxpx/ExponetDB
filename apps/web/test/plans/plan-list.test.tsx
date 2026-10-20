import '@testing-library/jest-dom/vitest'
import { act, cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { axeViolations } from '../../../../packages/ui/test/support/axe.ts'
import { BIDI, hostilePlan, mountApp, OP, operationFor, PLAN, World } from './support.tsx'

afterEach(cleanup)

const OTHER = 'pln_01M4S9000000000000000000BB'

describe('the plan list', () => {
  it('lists the plans with a link to each review page, built from a plan id only', async () => {
    const world = new World()
    world.plans.set(PLAN, hostilePlan())
    world.plans.set(`../admin${BIDI}`, hostilePlan({ id: `../admin${BIDI}` }))
    mountApp('/changes/plans', world)
    const table = await screen.findByRole('table', { name: 'Plans, newest first' })
    expect(within(table).getByRole('link', { name: PLAN })).toHaveAttribute(
      'href',
      `/changes/plans/${PLAN}`,
    )
    // A server value that is not a plan id is shown as marked text, never as a link.
    expect(within(table).getAllByRole('link')).toHaveLength(1)
    expect(table.textContent).toContain('../admin⟨U+202E⟩')
    expect(table.textContent).not.toContain(BIDI)
  })

  it('shows a partial list as partial: more plans exist than one read returns', async () => {
    const world = new World()
    world.plans.set(OTHER, hostilePlan({ id: OTHER }))
    world.plansNextCursor = 'next'
    mountApp('/changes/plans', world)
    expect(
      await screen.findByText(/More plans exist than one read returns\. The newest are shown\./),
    ).toBeInTheDocument()
  })

  it('shows a failed read as failed, never as an empty list', async () => {
    const world = new World()
    world.failures.set('GET /api/v1/plans', {
      status: 403,
      code: 'PERMISSION_DENIED',
      message: 'You may not list plans.',
    })
    mountApp('/changes/plans', world)
    expect(await screen.findByText('You may not list plans.')).toBeInTheDocument()
    expect(screen.queryByText(/found no Plans/)).toBeNull()
  })

  it('shows an old read as stale with its age and a refresh, keeping the plans', async () => {
    const world = new World()
    world.plans.set(PLAN, hostilePlan())
    const { queryClient } = mountApp('/changes/plans', world)
    await screen.findByRole('table', { name: 'Plans, newest first' })
    world.failures.set('GET /api/v1/plans', { status: 500, code: 'INTERNAL', message: 'Boom.' })
    await act(async () => {
      await queryClient.refetchQueries()
    })
    await waitFor(() =>
      expect(document.querySelector('[data-state="stale"]')?.textContent).toMatch(
        /Showing an earlier read of Plans.*Observed/,
      ),
    )
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeInTheDocument()
    expect(screen.getByRole('table', { name: 'Plans, newest first' })).toBeInTheDocument()
  })

  it('is empty only after a successful read', async () => {
    const world = new World()
    mountApp('/changes/plans', world)
    expect(await screen.findByText(/found no plans/i)).toBeInTheDocument()
    expect(screen.queryByText(/Could not read/)).toBeNull()
  })

  it('has no accessibility violations', async () => {
    const world = new World()
    world.plans.set(PLAN, hostilePlan())
    mountApp('/changes/plans', world)
    await screen.findByRole('table', { name: 'Plans, newest first' })
    expect(await axeViolations(document.body)).toEqual([])
  })
})

/** The query of the plan list reads, without the cursor. */
function listQueries(world: World): URLSearchParams[] {
  return world
    .gets('/api/v1/plans?')
    .map((sent) => new URL(sent.path, 'http://localhost').searchParams)
}

describe('the plan list: filters and paging', () => {
  it('sends the filters of the address, each checked against its allowlist or grammar', async () => {
    const world = new World()
    world.plans.set(PLAN, hostilePlan())
    mountApp(
      '/changes/plans?state=active&kind=migration.apply&actor=self&target=shop%2Fplatform%2Fstaging',
      world,
    )
    await screen.findByRole('table', { name: 'Plans, newest first' })
    const query = listQueries(world)[0]
    expect(query?.get('state')).toBe('active')
    expect(query?.get('kind')).toBe('migration.apply')
    expect(query?.get('actor')).toBe('self')
    expect(query?.get('target')).toBe('shop/platform/staging')
    expect(screen.getByLabelText('State')).toHaveValue('active')
    expect(screen.getByRole('button', { name: 'My plans' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('ignores hostile parameters: none reaches the server and the list is unfiltered', async () => {
    const world = new World()
    world.plans.set(PLAN, hostilePlan())
    const { router } = mountApp(
      `/changes/plans?state=evil&kind=${encodeURIComponent('../x<script>')}&actor=root&target=${encodeURIComponent('<img src=x>')}&awaiting=yes`,
      world,
    )
    await screen.findByRole('table', { name: 'Plans, newest first' })
    const query = listQueries(world)[0]
    expect([...(query?.keys() ?? [])].sort()).toEqual(['actor', 'limit'])
    expect(query?.get('actor')).toBe('any')
    expect(world.gets('/api/v1/operations')).toHaveLength(0)
    expect(router.state.location.search).toEqual({})
    expect(document.querySelector('script')).toBeNull()
    expect(screen.getByRole('button', { name: 'All plans' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  })

  it('"My plans" puts actor=self in the address and the request', async () => {
    const user = userEvent.setup()
    const world = new World()
    world.plans.set(PLAN, hostilePlan())
    const { router } = mountApp('/changes/plans', world)
    await screen.findByRole('table', { name: 'Plans, newest first' })
    await user.click(screen.getByRole('button', { name: 'My plans' }))
    await waitFor(() => expect(router.state.location.search).toEqual({ actor: 'self' }))
    await waitFor(() =>
      expect(listQueries(world).some((q) => q.get('actor') === 'self')).toBe(true),
    )
  })

  it('"Awaiting approval" lists the plans whose operation waits, from the operations list', async () => {
    const user = userEvent.setup()
    const world = new World()
    world.plans.set(PLAN, hostilePlan())
    world.listedOperations = [operationFor(OP, { state: 'awaiting_approval' })]
    const { router } = mountApp('/changes/plans?state=active', world)
    await screen.findByRole('table', { name: 'Plans, newest first' })
    await user.click(screen.getByRole('button', { name: 'Awaiting approval' }))
    await waitFor(() => expect(router.state.location.search).toEqual({ awaiting: 'approval' }))
    const table = await screen.findByRole('table', {
      name: 'Plans whose operation awaits approval, newest first',
    })
    expect(within(table).getByRole('link', { name: PLAN })).toHaveAttribute(
      'href',
      `/changes/plans/${PLAN}`,
    )
    expect(within(table).getByRole('link', { name: 'View operation' })).toHaveAttribute(
      'href',
      `/changes/operations/${OP}`,
    )
    const query = new URL(world.gets('/api/v1/operations')[0]?.path ?? '', 'http://localhost')
      .searchParams
    expect(query.get('state')).toBe('awaiting_approval')
    // A plan state does not combine with "awaiting approval".
    expect(screen.getByLabelText('State')).toBeDisabled()
  })

  it('follows the cursor with "Load more"; the partial list says more exist until the last page', async () => {
    const user = userEvent.setup()
    const world = new World()
    world.planPages.set('', { items: [hostilePlan()], nextCursor: 'page2' })
    world.planPages.set('page2', { items: [hostilePlan({ id: OTHER })], nextCursor: null })
    mountApp('/changes/plans', world)
    const table = await screen.findByRole('table', { name: 'Plans, newest first' })
    expect(within(table).getAllByRole('link')).toHaveLength(1)
    expect(screen.getByText(/More plans exist than one read returns/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Load more plans' }))
    await waitFor(() =>
      expect(
        within(screen.getByRole('table', { name: 'Plans, newest first' })).getAllByRole('link'),
      ).toHaveLength(2),
    )
    expect(listQueries(world).at(-1)?.get('cursor')).toBe('page2')
    expect(screen.getByText('All 2 plans are shown.')).toBeInTheDocument()
    expect(screen.queryByText(/More plans exist than one read returns/)).toBeNull()
  })

  it('says no plan matches the filters (none found) and offers to clear them', async () => {
    const user = userEvent.setup()
    const world = new World()
    const { router } = mountApp('/changes/plans?state=withdrawn', world)
    expect(await screen.findByText('No plan matches')).toBeInTheDocument()
    expect(screen.queryByText(/Could not read/)).toBeNull()
    // The toolbar and the empty state both offer it; the empty state's is the last.
    const clear = screen.getAllByRole('button', { name: 'Clear filters' })
    expect(clear).toHaveLength(2)
    await user.click(clear[1] as HTMLElement)
    await waitFor(() => expect(router.state.location.search).toEqual({}))
  })
})
