import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'

import { HoverCard, HoverCardContent, HoverCardTrigger } from '../src/hover-card.tsx'
import { axeViolations } from './support/axe.ts'

afterEach(cleanup)

const Example = () => (
  <HoverCard openDelay={0} closeDelay={0}>
    <HoverCardTrigger asChild>
      <a href="#target">billing/api/production</a>
    </HoverCardTrigger>
    <HoverCardContent>Last verified 3 minutes ago.</HoverCardContent>
  </HoverCard>
)

describe('HoverCard', () => {
  it('stays closed until the trigger is hovered', async () => {
    const user = userEvent.setup()
    render(<Example />)

    expect(screen.queryByText('Last verified 3 minutes ago.')).not.toBeInTheDocument()
    await user.hover(screen.getByRole('link', { name: 'billing/api/production' }))

    expect(await screen.findByText('Last verified 3 minutes ago.')).toBeInTheDocument()

    await user.unhover(screen.getByRole('link', { name: 'billing/api/production' }))
    await waitFor(() =>
      expect(screen.queryByText('Last verified 3 minutes ago.')).not.toBeInTheDocument(),
    )
  })

  it('also opens on keyboard focus and closes with Escape', async () => {
    const user = userEvent.setup()
    render(<Example />)

    await user.tab()
    expect(screen.getByRole('link', { name: 'billing/api/production' })).toHaveFocus()
    expect(await screen.findByText('Last verified 3 minutes ago.')).toBeInTheDocument()

    await user.keyboard('{Escape}')
    await waitFor(() =>
      expect(screen.queryByText('Last verified 3 minutes ago.')).not.toBeInTheDocument(),
    )
  })

  it('has no axe violations open', async () => {
    const user = userEvent.setup()
    render(<Example />)
    expect(await axeViolations()).toEqual([])

    await user.tab()
    await screen.findByText('Last verified 3 minutes ago.')
    expect(await axeViolations()).toEqual([])
  })
})
