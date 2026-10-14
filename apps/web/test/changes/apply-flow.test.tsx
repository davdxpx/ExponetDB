import '@testing-library/jest-dom/vitest'
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { ChangesWorld, hostilePlan, mountChanges, OP, operationFor, PLAN } from './support.tsx'

afterEach(cleanup)

/**
 * The plan review page's apply, end to end: the typed confirmation of the
 * ladder, the operation it creates shown with apply and verification apart,
 * the link to the operation page, and the approval link of MCP and the CLI.
 */
function activePlanWorld(planClass: 'high' | 'critical'): ChangesWorld {
  const world = new ChangesWorld()
  world.plans.set(PLAN, hostilePlan({ state: 'active', operationId: null, class: planClass }))
  // Once applied, the server answers the operation and the plan names it.
  world.onRequest = (sent) => {
    if (sent.method === 'POST' && sent.path.endsWith(`/plans/${PLAN}/apply`)) {
      world.operations.set(
        OP,
        operationFor(OP, { state: 'running', applyOutcome: 'not_started', approvalUrl: null }),
      )
      world.plans.set(PLAN, hostilePlan({ state: 'consumed', operationId: OP, class: planClass }))
    }
  }
  return world
}

describe('applying a plan from its review page', () => {
  it('needs the typed target path and the typed effect for a critical plan, then shows the operation', async () => {
    const user = userEvent.setup()
    const world = activePlanWorld('critical')
    mountChanges(`/changes/plans/${PLAN}`, world)
    await user.click(await screen.findByRole('button', { name: 'Apply' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Apply this plan?' })
    const action = within(dialog).getByRole('button', { name: 'Apply plan' })
    await user.type(
      within(dialog).getByLabelText(/To confirm, type the target path/),
      'shop/platform/production',
    )
    // The target path alone does not confirm a critical plan.
    expect(action).toHaveAttribute('aria-disabled', 'true')
    await user.click(action)
    expect(world.posts(`/plans/${PLAN}/apply`)).toHaveLength(0)
    await user.type(
      within(dialog).getByLabelText(/type the effect/i),
      'migration.apply shop/platform/production',
    )
    await user.dblClick(action)
    await waitFor(() => expect(world.posts(`/plans/${PLAN}/apply`)).toHaveLength(1))
    expect(world.posts(`/plans/${PLAN}/apply`)[0]?.body).toEqual({})
    // The page shows the operation's apply and verification apart and links its page.
    const outcome = await waitFor(() => {
      const element = document.querySelector(`[data-operation-id="${OP}"]`)
      if (!(element instanceof HTMLElement)) throw new Error('no operation yet')
      return element
    })
    expect(outcome.querySelector('[data-indicator="apply"]')).toHaveAttribute(
      'data-outcome',
      'running',
    )
    expect(outcome.querySelector('[data-indicator="verification"]')).toHaveAttribute(
      'data-outcome',
      'pending',
    )
    expect(outcome.querySelector('[data-tone="done"]')).toBeNull()
    expect(within(outcome).getByRole('link', { name: 'Open the operation page' })).toHaveAttribute(
      'href',
      `/changes/operations/${OP}`,
    )
    expect(world.posts(`/plans/${PLAN}/apply`)).toHaveLength(1)
  })

  it('needs the typed target path for a high plan', async () => {
    const user = userEvent.setup()
    const world = activePlanWorld('high')
    mountChanges(`/changes/plans/${PLAN}`, world)
    await user.click(await screen.findByRole('button', { name: 'Apply' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Apply this plan?' })
    expect(within(dialog).queryByLabelText(/type the effect/i)).toBeNull()
    await user.type(
      within(dialog).getByLabelText(/To confirm, type the target path/),
      'shop/platform/staging',
    )
    await user.click(within(dialog).getByRole('button', { name: 'Apply plan' }))
    expect(world.posts(`/plans/${PLAN}/apply`)).toHaveLength(0)
  })

  it('keeps the approval link of MCP and the CLI as a redirect to the plan review page', async () => {
    const world = new ChangesWorld()
    world.plans.set(PLAN, hostilePlan())
    world.operations.set(OP, operationFor(OP, { state: 'running' }))
    const { router } = mountChanges(`/approvals#operation=${OP}`, world)
    await waitFor(() => expect(router.state.location.pathname).toBe(`/changes/plans/${PLAN}`))
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 1, name: /Plan review/ })).toBeInTheDocument(),
    )
  })
})
