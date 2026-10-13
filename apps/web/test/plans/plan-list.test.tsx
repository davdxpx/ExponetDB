import '@testing-library/jest-dom/vitest'
import { cleanup, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { axeViolations } from '../../../../packages/ui/test/support/axe.ts'
import { BIDI, hostilePlan, mountApp, PLAN, World } from './support.tsx'

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

  it('says when more plans exist than one read returns', async () => {
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

  it('has no accessibility violations', async () => {
    const world = new World()
    world.plans.set(PLAN, hostilePlan())
    mountApp('/changes/plans', world)
    await screen.findByRole('table', { name: 'Plans, newest first' })
    expect(await axeViolations(document.body)).toEqual([])
  })
})
