import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'

import {
  Popover,
  PopoverAnchor,
  PopoverClose,
  PopoverContent,
  PopoverSeparator,
  PopoverTrigger,
} from '../src/popover.tsx'
import { axeViolations } from './support/axe.ts'

afterEach(cleanup)

describe('Popover', () => {
  const Example = ({ sameWidthAsTrigger }: { sameWidthAsTrigger?: boolean }) => (
    <Popover>
      <PopoverTrigger>Filter targets</PopoverTrigger>
      <PopoverContent
        aria-label="Filter targets"
        {...(sameWidthAsTrigger ? { sameWidthAsTrigger } : {})}
      >
        <p>Choose a tier.</p>
        <PopoverSeparator />
        <PopoverClose>Apply filter</PopoverClose>
      </PopoverContent>
    </Popover>
  )

  it('opens from the trigger and reports its state', async () => {
    const user = userEvent.setup()
    render(<Example />)
    const trigger = screen.getByRole('button', { name: 'Filter targets' })

    expect(screen.queryByText('Choose a tier.')).not.toBeInTheDocument()
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(trigger).toHaveAttribute('aria-haspopup', 'dialog')

    await user.click(trigger)

    expect(await screen.findByText('Choose a tier.')).toBeInTheDocument()
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('dialog', { name: 'Filter targets' })).toBeInTheDocument()
  })

  it('opens with the keyboard, closes with Escape and returns focus to the trigger', async () => {
    const user = userEvent.setup()
    render(<Example />)
    const trigger = screen.getByRole('button', { name: 'Filter targets' })

    await user.tab()
    expect(trigger).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(await screen.findByText('Choose a tier.')).toBeInTheDocument()

    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByText('Choose a tier.')).not.toBeInTheDocument())
    expect(trigger).toHaveFocus()
  })

  it('closes from a PopoverClose', async () => {
    const user = userEvent.setup()
    render(<Example />)

    await user.click(screen.getByRole('button', { name: 'Filter targets' }))
    await user.click(await screen.findByRole('button', { name: 'Apply filter' }))

    await waitFor(() => expect(screen.queryByText('Choose a tier.')).not.toBeInTheDocument())
  })

  it('is as wide as the trigger on request, and 18rem wide otherwise', async () => {
    const user = userEvent.setup()
    const { unmount } = render(<Example />)
    await user.click(screen.getByRole('button', { name: 'Filter targets' }))
    const defaultContent = await screen.findByRole('dialog')
    expect(defaultContent).toHaveClass('w-72')
    expect(defaultContent).not.toHaveClass('w-(--radix-popover-trigger-width)')
    unmount()

    render(<Example sameWidthAsTrigger />)
    await user.click(screen.getByRole('button', { name: 'Filter targets' }))
    const wide = await screen.findByRole('dialog')
    // tailwind-merge drops `w-72` in favor of the trigger width: the later class wins.
    expect(wide).toHaveClass('w-(--radix-popover-trigger-width)')
    expect(wide).not.toHaveClass('w-72')
  })

  it('keeps a disabled trigger out of the tab order and closed', async () => {
    const user = userEvent.setup()
    render(
      <Popover>
        <PopoverAnchor>
          <PopoverTrigger disabled>Unavailable</PopoverTrigger>
        </PopoverAnchor>
        <PopoverContent aria-label="Unavailable">Hidden</PopoverContent>
      </Popover>,
    )
    const trigger = screen.getByRole('button', { name: 'Unavailable' })

    expect(trigger).toBeDisabled()
    expect(trigger).toHaveAttribute('tabindex', '-1')
    await user.click(trigger)
    expect(screen.queryByText('Hidden')).not.toBeInTheDocument()
  })

  it('has no axe violations closed and open', async () => {
    const user = userEvent.setup()
    render(<Example />)
    expect(await axeViolations()).toEqual([])

    await user.click(screen.getByRole('button', { name: 'Filter targets' }))
    await screen.findByText('Choose a tier.')
    expect(await axeViolations()).toEqual([])
  })
})
