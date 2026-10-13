import '@testing-library/jest-dom/vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import type { DateRange } from 'react-day-picker'
import { describe, expect, it, vi } from 'vitest'

import { Calendar } from '../src/calendar.tsx'
import { axeViolations } from './support/axe.ts'

// October 2026 starts on a Thursday and has 31 days.
const month = new Date(2026, 9, 1)

/** The day of the month that `onSelect` was last called with. */
const dayOfLastSelection = (onSelect: ReturnType<typeof vi.fn>): number | undefined => {
  const date: unknown = onSelect.mock.calls.at(-1)?.[0]
  return date instanceof Date ? date.getDate() : undefined
}

/** The cell of a day: react-day-picker 9 puts the selection state and the modifiers on the cell. */
const cell = (day: number): HTMLElement => {
  const element = document.querySelector<HTMLElement>(
    `td[data-day="2026-10-${String(day).padStart(2, '0')}"]`,
  )
  if (!element) throw new Error(`No cell for October ${day}`)
  return element
}

describe('Calendar', () => {
  it('renders one month as a labelled grid with named day buttons and no violations', async () => {
    render(<Calendar mode="single" defaultMonth={month} />)

    expect(screen.getByRole('grid', { name: 'October 2026' })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('October 2026')
    const day = screen.getByRole('button', { name: /October 14th, 2026/ })
    expect(day).toHaveTextContent('14')
    expect(await axeViolations()).toEqual([])
  })

  it('selects a day with a click and marks its cell selected', async () => {
    const onSelect = vi.fn()
    const Controlled = () => {
      const [selected, setSelected] = useState<Date | undefined>()
      return (
        <Calendar
          mode="single"
          defaultMonth={month}
          selected={selected}
          onSelect={(date) => {
            onSelect(date)
            setSelected(date)
          }}
        />
      )
    }
    render(<Controlled />)

    await userEvent.click(screen.getByRole('button', { name: /October 14th, 2026/ }))

    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(dayOfLastSelection(onSelect)).toBe(14)
    // react-day-picker 9 puts aria-selected on the cell, not on the button.
    expect(cell(14)).toHaveAttribute('aria-selected', 'true')
    expect(cell(14)).toHaveClass('rounded-md')
  })

  it('selects a day with the keyboard', async () => {
    const onSelect = vi.fn()
    render(
      <Calendar
        mode="single"
        defaultMonth={month}
        selected={new Date(2026, 9, 14)}
        onSelect={onSelect}
      />,
    )

    screen.getByRole('button', { name: /October 14th, 2026/ }).focus()
    await userEvent.keyboard('{ArrowRight}')
    expect(screen.getByRole('button', { name: /October 15th, 2026/ })).toHaveFocus()
    await userEvent.keyboard('{Enter}')
    expect(dayOfLastSelection(onSelect)).toBe(15)
  })

  it('goes to the next and the previous month with named buttons', async () => {
    render(<Calendar mode="single" defaultMonth={month} />)

    const next = screen.getByRole('button', { name: /next month/i })
    const previous = screen.getByRole('button', { name: /previous month/i })
    expect(next).toHaveClass('absolute', 'right-0')
    expect(previous).toHaveClass('absolute', 'left-0')
    expect(next.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')

    await userEvent.click(next)
    expect(screen.getByRole('grid', { name: 'November 2026' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /previous month/i }))
    await userEvent.click(screen.getByRole('button', { name: /previous month/i }))
    expect(screen.getByRole('grid', { name: 'September 2026' })).toBeInTheDocument()
  })

  it('styles the navigation with the outline Button variant', () => {
    render(<Calendar mode="single" defaultMonth={month} />)

    const next = screen.getByRole('button', { name: /next month/i })
    expect(next).toHaveClass('border-strong', 'focus-ring')
  })

  it('styles the day buttons with the text Button variant, not a missing ghost variant', () => {
    render(<Calendar mode="single" defaultMonth={month} />)

    const day = screen.getByRole('button', { name: /October 14th, 2026/ })
    expect(day).toHaveClass('hover:bg-accent', 'h-9', 'w-9', 'text-sm')
  })

  it('does not select a disabled day', async () => {
    const onSelect = vi.fn()
    render(
      <Calendar
        mode="single"
        defaultMonth={month}
        disabled={{ before: new Date(2026, 9, 10) }}
        onSelect={onSelect}
      />,
    )

    const blocked = screen.getByRole('button', { name: /October 5th, 2026/ })
    expect(blocked).toBeDisabled()
    await userEvent.click(blocked)
    expect(onSelect).not.toHaveBeenCalled()
    expect(await axeViolations()).toEqual([])
  })

  it('selects a range and marks start, middle and end', async () => {
    const onSelect = vi.fn()
    const selected: DateRange = { from: new Date(2026, 9, 12), to: new Date(2026, 9, 14) }
    render(<Calendar mode="range" defaultMonth={month} selected={selected} onSelect={onSelect} />)

    expect(cell(12)).toHaveClass('rounded-l-md')
    expect(cell(13)).toHaveClass('rounded-none')
    expect(cell(14)).toHaveClass('rounded-r-md')
    expect(cell(12)).toHaveAttribute('aria-selected', 'true')
    expect(cell(15)).not.toHaveAttribute('aria-selected')
    expect(await axeViolations()).toEqual([])

    await userEvent.click(within(cell(20)).getByRole('button'))
    expect(onSelect).toHaveBeenCalled()
  })

  it('shows the days of the neighbor months unless told not to', () => {
    const { rerender } = render(<Calendar mode="single" defaultMonth={month} />)
    // The first row starts with the Sunday before October 1.
    expect(screen.getByRole('button', { name: /September 27th, 2026/ })).toBeInTheDocument()

    rerender(<Calendar mode="single" defaultMonth={month} showOutsideDays={false} />)
    expect(screen.queryByRole('button', { name: /September 27th, 2026/ })).not.toBeInTheDocument()
  })

  it('keeps a className of its own on the picker and merges class names of the caller', () => {
    const { container } = render(
      <Calendar
        mode="single"
        defaultMonth={month}
        className="p-6"
        classNames={{ caption_label: 'text-base' }}
      />,
    )

    expect(container.firstElementChild).toHaveClass('p-6')
    expect(container.firstElementChild).not.toHaveClass('p-3')
    expect(screen.getByText('October 2026', { selector: 'span' })).toHaveClass('text-base')
  })

  it('injects no <style> element', () => {
    render(<Calendar mode="single" defaultMonth={month} />)

    expect(document.querySelectorAll('style')).toHaveLength(0)
  })
})
