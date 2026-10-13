import '@testing-library/jest-dom/vitest'
import { act, cleanup, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { axeViolations } from '../../../../packages/ui/test/support/axe.ts'
import { pageReload } from '../../src/features/approvals/fragment-binding.ts'
import {
  BIDI,
  hostileItem,
  hostilePlan,
  mountApp,
  OP,
  operationFor,
  PLAN,
  World,
} from '../plans/support.tsx'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const OTHER_OP = 'op_01M4S9000000000000000000BB'
const OTHER_PLAN = 'pln_01M4S9000000000000000000BB'

describe('the approvals queue', () => {
  it('lists each waiting operation as a card with a link to its plan review', async () => {
    const world = new World()
    world.queue = [
      hostileItem(),
      hostileItem({ operationId: OTHER_OP, planId: OTHER_PLAN, actorClient: 'web', ownPlan: true }),
    ]
    mountApp('/approvals', world)
    const list = await screen.findByRole('list', { name: 'Operations waiting for approval' })
    expect(list).toHaveAttribute('id', 'approval-list')
    const cards = list.querySelectorAll('li.card[data-operation]')
    expect([...cards].map((c) => c.getAttribute('data-operation'))).toEqual([OP, OTHER_OP])
    expect(list.querySelectorAll('li.focused')).toHaveLength(0)
    const first = cards[0] as HTMLElement
    expect(within(first).getByRole('link', { name: 'Review the plan' })).toHaveAttribute(
      'href',
      `/changes/plans/${PLAN}`,
    )
    expect(within(first).getByText(/An agent proposed this plan through MCP/)).toBeInTheDocument()
    expect(within(cards[1] as HTMLElement).getByText(/Your own plan/)).toBeInTheDocument()
    expect(within(first).getByText('0 of 1 given')).toBeInTheDocument()
  })

  it('says nothing waits only after a successful read, and a failed read is never empty', async () => {
    const world = new World()
    mountApp('/approvals', world)
    expect(await screen.findByText('Nothing is waiting for your approval.')).toHaveAttribute(
      'id',
      'no-approvals',
    )
    cleanup()
    const failing = new World()
    failing.failures.set('GET /api/v1/approvals', {
      status: 503,
      code: 'UNAVAILABLE',
      message: 'The queue is unavailable.',
    })
    mountApp('/approvals', failing)
    expect(
      await screen.findByText('The queue is unavailable.', {}, { timeout: 10_000 }),
    ).toBeInTheDocument()
    expect(screen.queryByText('Nothing is waiting for your approval.')).toBeNull()
  }, 20_000)

  it('shows an old read of the queue as stale with its age and a refresh, keeping the cards', async () => {
    const world = new World()
    world.queue = [hostileItem()]
    const { queryClient } = mountApp('/approvals', world)
    await screen.findByRole('list', { name: 'Operations waiting for approval' })
    world.failures.set('GET /api/v1/approvals', { status: 500, code: 'INTERNAL', message: 'Boom.' })
    await act(async () => {
      await queryClient.refetchQueries()
    })
    await waitFor(() =>
      expect(document.querySelector('[data-state="stale"]')?.textContent).toMatch(
        /Showing an earlier read of Approvals queue.*Observed/,
      ),
    )
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeInTheDocument()
    expect(
      screen.getByRole('list', { name: 'Operations waiting for approval' }),
    ).toBeInTheDocument()
    expect(screen.queryByText('Nothing is waiting for your approval.')).toBeNull()
  })

  it('turns /approvals#operation=op_… into the review page of that operation’s plan', async () => {
    const world = new World()
    world.queue = [hostileItem()]
    world.plans.set(PLAN, hostilePlan())
    world.operations.set(OP, operationFor(OP))
    const { router } = mountApp(`/approvals#operation=${OP}`, world)
    await waitFor(() => expect(router.state.location.pathname).toBe(`/changes/plans/${PLAN}`))
    expect(
      await screen.findByRole('heading', { level: 1, name: /Plan review/ }),
    ).toBeInTheDocument()
    expect(await screen.findByText(`${PLAN}`)).toBeInTheDocument()
    // The queue named the plan: the operation itself was not needed for the redirect.
    expect(world.gets(`/api/v1/operations/${OP}`).length).toBeLessThanOrEqual(1)
  })

  it('asks the operation for its plan when it is not in the person’s queue', async () => {
    const world = new World()
    world.operations.set(OTHER_OP, operationFor(OTHER_OP, { planId: OTHER_PLAN, state: 'queued' }))
    const { router } = mountApp(`/approvals#operation=${OTHER_OP}`, world)
    await waitFor(() => expect(router.state.location.pathname).toBe(`/changes/plans/${OTHER_PLAN}`))
    expect(world.gets(`/api/v1/operations/${OTHER_OP}`)).toHaveLength(1)
  })

  it('stays on the queue and says why when the operation of the link cannot be read', async () => {
    const world = new World()
    world.queue = [hostileItem()]
    const { router } = mountApp(`/approvals#operation=${OTHER_OP}`, world)
    expect(
      await screen.findByText(
        /Could not read the operation of this link: Not found\. \(OPERATION_NOT_FOUND\)/,
      ),
    ).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/approvals')
    expect(document.querySelector(`li.card[data-operation="${OP}"]`)).not.toHaveClass('focused')
  })

  it('never builds a path from a plan id the server sent that is not one', async () => {
    const world = new World()
    world.queue = [hostileItem({ planId: `../../admin${BIDI}` as typeof PLAN })]
    const { router } = mountApp(`/approvals#operation=${OP}`, world)
    const card = await waitFor(() => {
      const element = document.querySelector(`li.card[data-operation="${OP}"]`)
      if (!(element instanceof HTMLElement)) throw new Error('no card yet')
      return element
    })
    expect(card).toHaveClass('focused')
    expect(within(card).queryByRole('link')).toBeNull()
    expect(
      within(card).getByText('The plan of this operation cannot be opened here.'),
    ).toBeInTheDocument()
    await act(async () => {})
    expect(router.state.location.pathname).toBe('/approvals')
  })

  it('ignores a fragment that is not exactly an operation id, and requests nothing for it', async () => {
    for (const fragment of [
      '#operation=op_x',
      `#operation=${OP}&x=1`,
      `#operation=${OP.toLowerCase()}`,
      '#operation=../../admin',
      `#OPERATION=${OP}`,
      `#operation=${OP}%0A`,
      `#operation=//evil.example`,
    ]) {
      const world = new World()
      world.queue = [hostileItem()]
      const { router } = mountApp(`/approvals${fragment}`, world)
      await screen.findByRole('list', { name: 'Operations waiting for approval' })
      expect(router.state.location.pathname, fragment).toBe('/approvals')
      expect(world.gets('/api/v1/operations'), fragment).toEqual([])
      expect(document.querySelectorAll('li.focused'), fragment).toHaveLength(0)
      cleanup()
    }
  })

  it('reloads the page when the fragment changes, so nothing acts on the previous link', async () => {
    const reload = vi.spyOn(pageReload, 'reload').mockImplementation(() => {})
    const world = new World()
    mountApp('/approvals', world)
    await screen.findByText('Nothing is waiting for your approval.')
    window.dispatchEvent(new HashChangeEvent('hashchange'))
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('has no accessibility violations', async () => {
    const world = new World()
    world.queue = [hostileItem()]
    mountApp('/approvals', world)
    await screen.findByRole('list', { name: 'Operations waiting for approval' })
    expect(await axeViolations(document.body)).toEqual([])
  })
})
