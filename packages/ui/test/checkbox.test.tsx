import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { Checkbox } from '../src/checkbox.tsx'
import { axeViolations } from './support/axe.ts'

describe('Checkbox', () => {
  it('is a labelled checkbox that toggles with a click and the Space key', async () => {
    const onCheckedChange = vi.fn()
    render(
      <>
        <Checkbox id="confirm" onCheckedChange={onCheckedChange} />
        <label htmlFor="confirm">I understand this changes production</label>
      </>,
    )

    const checkbox = screen.getByRole('checkbox', { name: 'I understand this changes production' })
    expect(checkbox).toHaveAttribute('aria-checked', 'false')
    expect(checkbox).toHaveAttribute('data-state', 'unchecked')

    await userEvent.click(checkbox)
    expect(checkbox).toHaveAttribute('aria-checked', 'true')
    expect(onCheckedChange).toHaveBeenLastCalledWith(true)

    await userEvent.tab()
    await userEvent.tab({ shift: true })
    expect(checkbox).toHaveFocus()
    await userEvent.keyboard(' ')
    expect(checkbox).toHaveAttribute('aria-checked', 'false')
    expect(onCheckedChange).toHaveBeenLastCalledWith(false)
    expect(await axeViolations()).toEqual([])
  })

  it('toggles from its label', async () => {
    render(
      <>
        <Checkbox id="confirm" />
        <label htmlFor="confirm">Confirm</label>
      </>,
    )

    await userEvent.click(screen.getByText('Confirm'))
    expect(screen.getByRole('checkbox', { name: 'Confirm' })).toBeChecked()
  })

  it('shows a check mark when checked', () => {
    render(<Checkbox aria-label="Selected" checked />)

    const checkbox = screen.getByRole('checkbox', { name: 'Selected' })
    expect(checkbox).toBeChecked()
    expect(checkbox.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
  })

  it('is partially checked with checked="indeterminate" and shows a dash, not a check', async () => {
    render(<Checkbox aria-label="Select all" checked="indeterminate" />)

    const checkbox = screen.getByRole('checkbox', { name: 'Select all' })
    expect(checkbox).toHaveAttribute('aria-checked', 'mixed')
    expect(checkbox).toHaveAttribute('data-state', 'indeterminate')
    expect(checkbox).toHaveClass('data-[state=indeterminate]:bg-foreground')
    expect(checkbox.querySelector('svg')).toHaveClass(
      'group-data-[state=indeterminate]/indicator:hidden',
    )
    expect(checkbox.querySelector('span span, button > span > span')).not.toBeNull()
    expect(await axeViolations()).toEqual([])
  })

  it('moves from indeterminate to checked on a click when controlled', async () => {
    const Controlled = () => {
      const [checked, setChecked] = useState<boolean | 'indeterminate'>('indeterminate')
      return (
        <Checkbox
          aria-label="Select all"
          checked={checked}
          onCheckedChange={(value) => setChecked(value)}
        />
      )
    }
    render(<Controlled />)

    await userEvent.click(screen.getByRole('checkbox'))
    expect(screen.getByRole('checkbox')).toHaveAttribute('aria-checked', 'true')
  })

  it('leaves the tab order and ignores clicks when disabled', async () => {
    const onCheckedChange = vi.fn()
    render(<Checkbox aria-label="Locked" disabled onCheckedChange={onCheckedChange} />)

    const checkbox = screen.getByRole('checkbox', { name: 'Locked' })
    expect(checkbox).toBeDisabled()
    expect(checkbox).toHaveAttribute('tabindex', '-1')
    await userEvent.click(checkbox)
    expect(onCheckedChange).not.toHaveBeenCalled()
    expect(await axeViolations()).toEqual([])
  })

  it('keeps an explicit tabIndex', () => {
    render(<Checkbox aria-label="Row" tabIndex={-1} />)

    expect(screen.getByRole('checkbox')).toHaveAttribute('tabindex', '-1')
  })
})
