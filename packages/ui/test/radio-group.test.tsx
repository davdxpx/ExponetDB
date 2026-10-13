import '@testing-library/jest-dom/vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { RadioGroup, RadioGroupItem, RadioGroupLargeItem } from '../src/radio-group.tsx'
import { axeViolations } from './support/axe.ts'

describe('RadioGroup', () => {
  it('is a named radio group whose items are labelled and selectable', async () => {
    const onValueChange = vi.fn()
    render(
      <RadioGroup aria-label="Environment" onValueChange={onValueChange}>
        <div>
          <RadioGroupItem id="env-staging" value="staging" />
          <label htmlFor="env-staging">Staging</label>
        </div>
        <div>
          <RadioGroupItem id="env-prod" value="production" />
          <label htmlFor="env-prod">Production</label>
        </div>
      </RadioGroup>,
    )

    expect(screen.getByRole('radiogroup', { name: 'Environment' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('radio', { name: 'Production' }))
    expect(onValueChange).toHaveBeenCalledWith('production')
    expect(screen.getByRole('radio', { name: 'Production' })).toBeChecked()
    expect(screen.getByRole('radio', { name: 'Staging' })).not.toBeChecked()
    expect(await axeViolations()).toEqual([])
  })

  it('moves the selection with the arrow keys', async () => {
    render(
      <RadioGroup aria-label="Tier" defaultValue="a">
        <RadioGroupItem value="a" aria-label="Nonprod" />
        <RadioGroupItem value="b" aria-label="Prod" />
      </RadioGroup>,
    )

    await userEvent.tab()
    expect(screen.getByRole('radio', { name: 'Nonprod' })).toHaveFocus()
    // Hold the key: Radix selects the item that takes focus only while an arrow key is down.
    await userEvent.keyboard('{ArrowDown>}')
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Prod' })).toBeChecked())
    await userEvent.keyboard('{/ArrowDown}')
    expect(screen.getByRole('radio', { name: 'Prod' })).toHaveFocus()
  })

  it('shows the indicator only for the selected item', () => {
    render(
      <RadioGroup aria-label="Tier" defaultValue="a">
        <RadioGroupItem value="a" aria-label="Nonprod" />
        <RadioGroupItem value="b" aria-label="Prod" />
      </RadioGroup>,
    )

    expect(screen.getByRole('radio', { name: 'Nonprod' }).querySelector('svg')).not.toBeNull()
    expect(screen.getByRole('radio', { name: 'Prod' }).querySelector('svg')).toBeNull()
  })

  it('skips a disabled item', async () => {
    const onValueChange = vi.fn()
    render(
      <RadioGroup aria-label="Tier" onValueChange={onValueChange}>
        <RadioGroupItem value="a" aria-label="Nonprod" disabled />
        <RadioGroupItem value="b" aria-label="Prod" />
      </RadioGroup>,
    )

    expect(screen.getByRole('radio', { name: 'Nonprod' })).toBeDisabled()
    await userEvent.click(screen.getByRole('radio', { name: 'Nonprod' }))
    expect(onValueChange).not.toHaveBeenCalled()
    expect(await axeViolations()).toEqual([])
  })
})

describe('RadioGroupLargeItem', () => {
  it('is named by its label text and shows the content above it', async () => {
    const onValueChange = vi.fn()
    render(
      <RadioGroup aria-label="Backup method" onValueChange={onValueChange}>
        <RadioGroupLargeItem value="physical" label="Physical backup">
          <span data-testid="picture" />
        </RadioGroupLargeItem>
        <RadioGroupLargeItem value="logical" label="Logical backup" showIndicator={false} />
      </RadioGroup>,
    )

    const physical = screen.getByRole('radio', { name: 'Physical backup' })
    expect(physical).toContainElement(screen.getByTestId('picture'))
    expect(physical).toHaveClass('focus-ring')

    await userEvent.click(screen.getByRole('radio', { name: 'Logical backup' }))
    expect(onValueChange).toHaveBeenCalledWith('logical')
    expect(await axeViolations()).toEqual([])
  })

  it('hides the indicator from assistive technology and omits it on request', () => {
    render(
      <RadioGroup aria-label="Backup method">
        <RadioGroupLargeItem value="physical" label="Physical backup" />
        <RadioGroupLargeItem value="logical" label="Logical backup" showIndicator={false} />
      </RadioGroup>,
    )

    const withIndicator = screen.getByRole('radio', { name: 'Physical backup' })
    expect(withIndicator.querySelector('[aria-hidden="true"]')).not.toBeNull()
    expect(
      screen.getByRole('radio', { name: 'Logical backup' }).querySelector('[aria-hidden]'),
    ).toBeNull()
  })

  it('does not nest a label or a div inside the button', () => {
    render(
      <RadioGroup aria-label="Backup method">
        <RadioGroupLargeItem value="physical" label="Physical backup" />
      </RadioGroup>,
    )

    const radio = screen.getByRole('radio')
    expect(radio.querySelector('label, div')).toBeNull()
  })
})
