import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Button } from '../src/button.tsx'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../src/tooltip.tsx'
import { axeViolations } from './support/axe.ts'

afterEach(cleanup)

describe('Tooltip', () => {
  const Example = () => (
    <TooltipProvider delayDuration={0}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button>Copy path</Button>
        </TooltipTrigger>
        <TooltipContent>Copy the target path to the clipboard</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )

  it('opens on keyboard focus, describes the trigger and closes with Escape', async () => {
    const user = userEvent.setup()
    render(<Example />)
    const button = screen.getByRole('button', { name: 'Copy path' })
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()

    await user.tab()

    expect(button).toHaveFocus()
    const tooltip = await screen.findByRole('tooltip')
    expect(tooltip).toHaveTextContent('Copy the target path to the clipboard')
    expect(button).toHaveAccessibleDescription('Copy the target path to the clipboard')

    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument())
    expect(button).toHaveFocus()
  })

  it('opens on pointer hover and closes when the pointer leaves', async () => {
    const user = userEvent.setup()
    // jsdom has no layout, so the grace area between trigger and tooltip (which keeps a
    // hoverable tooltip open) cannot be computed there; turn it off for the leave step.
    render(
      <TooltipProvider delayDuration={0}>
        <Tooltip disableHoverableContent>
          <TooltipTrigger asChild>
            <Button>Copy path</Button>
          </TooltipTrigger>
          <TooltipContent>Copy the target path to the clipboard</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    )
    const button = screen.getByRole('button', { name: 'Copy path' })

    await user.hover(button)
    expect(await screen.findByRole('tooltip')).toBeInTheDocument()

    await user.unhover(button)
    await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument())
  })

  it('shows its reason on a button that is unavailable but focusable', async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()
    render(
      <TooltipProvider delayDuration={0}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button disabled focusableWhenDisabled onClick={onClick}>
              Apply plan
            </Button>
          </TooltipTrigger>
          <TooltipContent>Apply is unavailable: the plan has expired</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    )
    const button = screen.getByRole('button', { name: 'Apply plan' })

    // Unavailable, yet in the tab order, so a keyboard user reaches the reason.
    expect(button).toHaveAttribute('aria-disabled', 'true')
    expect(button).not.toBeDisabled()
    await user.tab()
    expect(button).toHaveFocus()
    const tooltip = await screen.findByRole('tooltip')
    expect(tooltip).toHaveTextContent('Apply is unavailable: the plan has expired')
    expect(button).toHaveAccessibleDescription('Apply is unavailable: the plan has expired')

    // Pressing Enter or Space does nothing, and the reason stays on screen.
    await user.keyboard('{Enter}')
    await user.keyboard(' ')
    expect(onClick).not.toHaveBeenCalled()
    expect(screen.getByRole('tooltip')).toBeInTheDocument()

    // A click does nothing either.
    await user.click(button)
    expect(onClick).not.toHaveBeenCalled()
  })

  it('shows the reason on hover too', async () => {
    const user = userEvent.setup()
    render(
      <TooltipProvider delayDuration={0}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button disabled focusableWhenDisabled>
              Apply plan
            </Button>
          </TooltipTrigger>
          <TooltipContent>The plan has expired</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    )

    await user.hover(screen.getByRole('button', { name: 'Apply plan' }))

    expect(await screen.findByRole('tooltip')).toHaveTextContent('The plan has expired')
  })

  it('has no axe violations closed and open', async () => {
    const user = userEvent.setup()
    render(<Example />)
    expect(await axeViolations()).toEqual([])

    await user.tab()
    await screen.findByRole('tooltip')
    expect(await axeViolations()).toEqual([])
  })
})
