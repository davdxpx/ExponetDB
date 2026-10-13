import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '../src/select.tsx'
import { axeViolations } from './support/axe.ts'

// The listbox is portaled to <body>: unmount before the shared setup clears the document.
afterEach(cleanup)

const renderSelect = (
  props: { onValueChange?: (value: string) => void; defaultValue?: string } = {},
) =>
  render(
    <Select {...props}>
      <SelectTrigger aria-label="Environment">
        <SelectValue placeholder="Choose an environment" />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectLabel>Tiers</SelectLabel>
          <SelectItem value="staging">Staging</SelectItem>
          <SelectItem value="production">Production</SelectItem>
          <SelectSeparator />
          <SelectItem value="archived" disabled>
            Archived
          </SelectItem>
        </SelectGroup>
      </SelectContent>
    </Select>,
  )

describe('Select', () => {
  it('shows the placeholder, opens a listbox on click and selects an option', async () => {
    const onValueChange = vi.fn()
    renderSelect({ onValueChange })

    const trigger = screen.getByRole('combobox', { name: 'Environment' })
    expect(trigger).toHaveTextContent('Choose an environment')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(await axeViolations()).toEqual([])

    await userEvent.click(trigger)
    const listbox = await screen.findByRole('listbox')
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(
      within(listbox)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Staging', 'Production', 'Archived'])
    expect(await axeViolations()).toEqual([])

    await userEvent.click(within(listbox).getByRole('option', { name: 'Production' }))
    expect(onValueChange).toHaveBeenCalledWith('production')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(trigger).toHaveTextContent('Production')
  })

  it('opens and selects with the keyboard', async () => {
    const onValueChange = vi.fn()
    renderSelect({ onValueChange })

    await userEvent.tab()
    expect(screen.getByRole('combobox', { name: 'Environment' })).toHaveFocus()
    await userEvent.keyboard('{Enter}')
    await screen.findByRole('listbox')
    await userEvent.keyboard('{ArrowDown}{Enter}')
    expect(onValueChange).toHaveBeenCalledWith('production')
  })

  it('marks the selected option and does not select a disabled one', async () => {
    const onValueChange = vi.fn()
    renderSelect({ defaultValue: 'staging', onValueChange })

    await userEvent.click(screen.getByRole('combobox', { name: 'Environment' }))
    const listbox = await screen.findByRole('listbox')
    expect(within(listbox).getByRole('option', { name: 'Staging' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    const archived = within(listbox).getByRole('option', { name: 'Archived' })
    expect(archived).toHaveAttribute('aria-disabled', 'true')
    await userEvent.click(archived)
    expect(onValueChange).not.toHaveBeenCalled()
  })

  it('closes on Escape without changing the value', async () => {
    const onValueChange = vi.fn()
    renderSelect({ onValueChange })

    await userEvent.click(screen.getByRole('combobox', { name: 'Environment' }))
    await screen.findByRole('listbox')
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(onValueChange).not.toHaveBeenCalled()
  })

  it('does not open when the trigger is disabled', async () => {
    render(
      <Select>
        <SelectTrigger aria-label="Environment" disabled>
          <SelectValue placeholder="Choose" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="a">A</SelectItem>
        </SelectContent>
      </Select>,
    )

    const trigger = screen.getByRole('combobox', { name: 'Environment' })
    expect(trigger).toBeDisabled()
    await userEvent.click(trigger)
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(await axeViolations()).toEqual([])
  })

  it('wraps string children and placeholders in a span against translation crashes', async () => {
    renderSelect()

    const trigger = screen.getByRole('combobox', { name: 'Environment' })
    expect(trigger.querySelector('span')?.textContent).toBe('Choose an environment')
    await userEvent.click(trigger)
    const option = await screen.findByRole('option', { name: 'Staging' })
    expect(option.querySelector('span > span')).not.toBeNull()
  })

  it('takes the size of the trigger', () => {
    render(
      <Select>
        <SelectTrigger aria-label="Small" size="small">
          <SelectValue />
        </SelectTrigger>
      </Select>,
    )

    expect(screen.getByRole('combobox')).toHaveClass('h-[34px]')
  })

  it('keeps the listbox scrollbar hidden through the Radix rule that the static stylesheet repeats', async () => {
    renderSelect()

    await userEvent.click(screen.getByRole('combobox', { name: 'Environment' }))
    await screen.findByRole('listbox')
    // Radix renders this <style> itself and the CSP blocks it; the static stylesheet must carry
    // exactly these rules (the report to the orchestrator quotes them).
    const viewportStyle = Array.from(document.querySelectorAll('style'))
      .map((style) => style.textContent)
      .filter((text) => text?.includes('[data-radix-select-viewport]'))
    expect(viewportStyle).toEqual([
      '[data-radix-select-viewport]{scrollbar-width:none;-ms-overflow-style:none;-webkit-overflow-scrolling:touch;}[data-radix-select-viewport]::-webkit-scrollbar{display:none}',
    ])
  })
})
