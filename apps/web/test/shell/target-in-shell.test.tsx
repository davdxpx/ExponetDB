import '@testing-library/jest-dom/vitest'
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { axeViolations } from '../../../../packages/ui/test/support/axe.ts'
import { mountApp, project, World } from '../target/support.tsx'

afterEach(cleanup)

/**
 * The target layout inside the real shell (the target tests use a stand-in
 * shell): the context bar sits in the header once, the target sections once,
 * the Databases rail item is current, and E then a letter switches the
 * environment through the shell's shortcut provider.
 */
describe('a target page inside the shell', () => {
  it('shows the context bar in the header and the target sections once', async () => {
    const world = new World()
    project(world)
    mountApp('/t/shop/platform/staging/locks', world)
    const header = (await screen.findAllByRole('banner'))[0]
    if (header === undefined) throw new Error('no header')
    expect(await within(header).findByRole('navigation', { name: 'Target' })).toBeInTheDocument()
    expect(screen.getAllByRole('navigation', { name: 'Target' })).toHaveLength(1)
    expect(screen.getAllByRole('navigation', { name: 'Target sections' })).toHaveLength(1)
    const rail = screen.getByRole('navigation', { name: 'Main navigation' })
    expect(within(rail).getByRole('link', { name: 'Databases' })).toHaveAttribute(
      'aria-current',
      'true',
    )
    expect(await axeViolations()).toEqual([])
  })

  it('switches the environment with E then S and keeps the section', async () => {
    const user = userEvent.setup()
    const world = new World()
    project(world)
    const { router } = mountApp('/t/shop/platform/development/locks', world)
    await screen.findAllByRole('navigation', { name: 'Target sections' })
    // The environment list is read before the shortcut is bound.
    await waitFor(() => expect(world.requests.some((r) => r.includes('/targets?'))).toBe(true))
    await new Promise((resolve) => setTimeout(resolve, 50))
    await user.keyboard('es')
    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/t/shop/platform/staging/locks'),
    )
  })
})
