import '@testing-library/jest-dom/vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { RadioGroupCard, RadioGroupCardItem } from '../src/radio-group-card.tsx'
import { axeViolations } from './support/axe.ts'

describe('RadioGroupCard', () => {
  it('is a named group of cards named by their labels', async () => {
    const onValueChange = vi.fn()
    render(
      <RadioGroupCard aria-label="Restore mode" onValueChange={onValueChange}>
        <RadioGroupCardItem value="full" label="Full restore" />
        <RadioGroupCardItem value="pitr" label={<strong>Point in time</strong>} />
      </RadioGroupCard>,
    )

    expect(screen.getByRole('radiogroup', { name: 'Restore mode' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('radio', { name: 'Point in time' }))
    expect(onValueChange).toHaveBeenCalledWith('pitr')
    expect(screen.getByRole('radio', { name: 'Point in time' })).toBeChecked()
    expect(await axeViolations()).toEqual([])
  })

  it('moves the selection with the arrow keys and shows a visible focus ring', async () => {
    render(
      <RadioGroupCard aria-label="Restore mode" defaultValue="full">
        <RadioGroupCardItem value="full" label="Full restore" />
        <RadioGroupCardItem value="pitr" label="Point in time" />
      </RadioGroupCard>,
    )

    await userEvent.tab()
    expect(screen.getByRole('radio', { name: 'Full restore' })).toHaveFocus()
    expect(screen.getByRole('radio', { name: 'Full restore' })).toHaveClass('focus-ring')
    // Hold the key: Radix selects the item that takes focus only while an arrow key is down.
    await userEvent.keyboard('{ArrowDown>}')
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Point in time' })).toBeChecked())
    await userEvent.keyboard('{/ArrowDown}')
  })

  it('uses the given id for the label reference and renders children above the label', () => {
    render(
      <RadioGroupCard aria-label="Restore mode">
        <RadioGroupCardItem id="full" value="full" label="Full restore">
          <span data-testid="above" />
        </RadioGroupCardItem>
      </RadioGroupCard>,
    )

    const radio = screen.getByRole('radio', { name: 'Full restore' })
    expect(radio).toHaveAttribute('id', 'full')
    expect(radio).toHaveAttribute('aria-labelledby', 'full-label')
    expect(radio).toContainElement(screen.getByTestId('above'))
  })

  it('can omit the indicator and is inert when disabled', async () => {
    const onValueChange = vi.fn()
    render(
      <RadioGroupCard aria-label="Restore mode" onValueChange={onValueChange}>
        <RadioGroupCardItem value="full" label="Full restore" showIndicator={false} disabled />
      </RadioGroupCard>,
    )

    const radio = screen.getByRole('radio', { name: 'Full restore' })
    expect(radio.querySelector('svg')).toBeNull()
    expect(radio).toBeDisabled()
    await userEvent.click(radio)
    expect(onValueChange).not.toHaveBeenCalled()
  })

  it('does not nest a div inside the button', () => {
    render(
      <RadioGroupCard aria-label="Restore mode">
        <RadioGroupCardItem value="full" label="Full restore" />
      </RadioGroupCard>,
    )

    expect(screen.getByRole('radio').querySelector('div')).toBeNull()
  })
})
