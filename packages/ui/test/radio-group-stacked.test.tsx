import '@testing-library/jest-dom/vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { RadioGroupStacked, RadioGroupStackedItem } from '../src/radio-group-stacked.tsx'
import { axeViolations } from './support/axe.ts'

describe('RadioGroupStacked', () => {
  it('names each row by its label and describes it with its description', async () => {
    const onValueChange = vi.fn()
    render(
      <RadioGroupStacked aria-label="Retention" onValueChange={onValueChange}>
        <RadioGroupStackedItem
          value="short"
          label="7 days"
          description="Cheapest. Point-in-time restore for a week."
        />
        <RadioGroupStackedItem value="long" label="30 days" />
      </RadioGroupStacked>,
    )

    const short = screen.getByRole('radio', { name: '7 days' })
    expect(short).toHaveAccessibleDescription('Cheapest. Point-in-time restore for a week.')
    expect(screen.getByRole('radio', { name: '30 days' })).not.toHaveAttribute('aria-describedby')

    await userEvent.click(screen.getByRole('radio', { name: '30 days' }))
    expect(onValueChange).toHaveBeenCalledWith('long')
    expect(await axeViolations()).toEqual([])
  })

  it('does not leak the description onto the DOM element as an attribute', () => {
    render(
      <RadioGroupStacked aria-label="Retention">
        <RadioGroupStackedItem value="short" label="7 days" description="Cheapest." />
      </RadioGroupStacked>,
    )

    expect(screen.getByRole('radio')).not.toHaveAttribute('description')
  })

  it('merges a className on the row and renders extra children below the description', () => {
    render(
      <RadioGroupStacked aria-label="Retention">
        <RadioGroupStackedItem value="short" label="7 days" className="min-h-16">
          <span data-testid="extra" />
        </RadioGroupStackedItem>
      </RadioGroupStacked>,
    )

    const radio = screen.getByRole('radio', { name: '7 days' })
    expect(radio).toHaveClass('min-h-16', 'focus-ring')
    expect(radio).toContainElement(screen.getByTestId('extra'))
  })

  it('moves the selection with the arrow keys', async () => {
    render(
      <RadioGroupStacked aria-label="Retention" defaultValue="short">
        <RadioGroupStackedItem value="short" label="7 days" />
        <RadioGroupStackedItem value="long" label="30 days" />
      </RadioGroupStacked>,
    )

    await userEvent.tab()
    expect(screen.getByRole('radio', { name: '7 days' })).toHaveFocus()
    // Hold the key: Radix selects the item that takes focus only while an arrow key is down.
    await userEvent.keyboard('{ArrowDown>}')
    await waitFor(() => expect(screen.getByRole('radio', { name: '30 days' })).toBeChecked())
    await userEvent.keyboard('{/ArrowDown}')
  })

  it('is inert when disabled and has no div or paragraph inside the button', async () => {
    const onValueChange = vi.fn()
    render(
      <RadioGroupStacked aria-label="Retention" onValueChange={onValueChange}>
        <RadioGroupStackedItem value="short" label="7 days" description="Cheapest." disabled />
      </RadioGroupStacked>,
    )

    const radio = screen.getByRole('radio', { name: '7 days' })
    expect(radio).toBeDisabled()
    expect(radio.querySelector('div, p')).toBeNull()
    await userEvent.click(radio)
    expect(onValueChange).not.toHaveBeenCalled()
  })
})
