import '@testing-library/jest-dom/vitest'
import { Form, FormControl, FormField } from '@exponetdb/ui'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DatePicker, type DatePickerRange } from '../../src/date-picker/date-picker.tsx'
import { FormItemLayout } from '../../src/form/form-item-layout/form-item-layout.tsx'
import { axeViolations } from '../support/axe.ts'

afterEach(cleanup)

// October 2026: the 1st is a Thursday, the month has 31 days.
const oct = (day: number) => new Date(2026, 9, day)

function SingleHarness({
  initial,
  onChange = vi.fn(),
  ...rest
}: {
  initial?: Date
  onChange?: (value: Date | undefined) => void
  minDate?: Date
  maxDate?: Date
  invalid?: boolean
  disabled?: boolean
}) {
  const [value, setValue] = useState<Date | undefined>(initial)
  return (
    <DatePicker
      label="Retention until"
      value={value}
      onValueChange={(next) => {
        setValue(next)
        onChange(next)
      }}
      {...rest}
    />
  )
}

function RangeHarness({
  initial,
  onChange = vi.fn(),
}: {
  initial?: DatePickerRange
  onChange?: (value: DatePickerRange | undefined) => void
}) {
  const [value, setValue] = useState<DatePickerRange | undefined>(initial)
  return (
    <DatePicker
      mode="range"
      label="Backup window"
      value={value}
      onValueChange={(next) => {
        setValue(next)
        onChange(next)
      }}
    />
  )
}

describe('DatePicker (day)', () => {
  it('is a labelled button that says what is chosen and that it opens a dialog', async () => {
    const { container } = render(<SingleHarness />)

    const trigger = screen.getByRole('button', { name: 'Retention until: Choose a date' })
    expect(trigger).toHaveAttribute('aria-haspopup', 'dialog')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(await axeViolations(container)).toEqual([])
  })

  it('shows the chosen day as text in a time element and names it in the button', () => {
    render(<SingleHarness initial={oct(14)} />)

    const trigger = screen.getByRole('button', { name: 'Retention until: Oct 14, 2026' })
    const time = within(trigger).getByText('Oct 14, 2026')
    expect(time.tagName).toBe('TIME')
    expect(time).toHaveAttribute('datetime', '2026-10-14')
  })

  it('opens a named dialog with the calendar of the chosen month and focuses the chosen day', async () => {
    const user = userEvent.setup()
    render(<SingleHarness initial={oct(14)} />)

    await user.click(screen.getByRole('button', { name: /Retention until/ }))

    const dialog = await screen.findByRole('dialog', { name: 'Retention until' })
    expect(within(dialog).getByRole('grid', { name: 'October 2026' })).toBeInTheDocument()
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: /October 14th, 2026/ })).toHaveFocus(),
    )
    expect(screen.getByRole('button', { name: /Retention until/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
  })

  it('chooses a day with a click, closes and returns focus to the button', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<SingleHarness initial={oct(14)} onChange={onChange} />)

    await user.click(screen.getByRole('button', { name: /Retention until/ }))
    await user.click(await screen.findByRole('button', { name: /October 20th, 2026/ }))

    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange.mock.calls[0]?.[0]).toEqual(oct(20))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    const trigger = screen.getByRole('button', { name: 'Retention until: Oct 20, 2026' })
    await waitFor(() => expect(trigger).toHaveFocus())
  })

  it('works with the keyboard alone', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<SingleHarness initial={oct(14)} onChange={onChange} />)

    await user.tab()
    expect(screen.getByRole('button', { name: /Retention until/ })).toHaveFocus()
    await user.keyboard('{Enter}')
    await screen.findByRole('dialog')
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /October 14th, 2026/ })).toHaveFocus(),
    )

    await user.keyboard('{ArrowRight}{ArrowDown}')
    expect(screen.getByRole('button', { name: /October 22nd, 2026/ })).toHaveFocus()
    await user.keyboard('{Enter}')

    expect(onChange.mock.calls[0]?.[0]).toEqual(oct(22))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('closes with Escape without changing the value and returns focus to the button', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<SingleHarness initial={oct(14)} onChange={onChange} />)

    const trigger = screen.getByRole('button', { name: /Retention until/ })
    await user.click(trigger)
    await screen.findByRole('dialog')
    await user.keyboard('{Escape}')

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(onChange).not.toHaveBeenCalled()
    await waitFor(() => expect(trigger).toHaveFocus())
  })

  it('does not offer days before the minimum or after the maximum', async () => {
    const user = userEvent.setup()
    render(<SingleHarness initial={oct(14)} minDate={oct(10)} maxDate={oct(20)} />)

    await user.click(screen.getByRole('button', { name: /Retention until/ }))
    await screen.findByRole('dialog')

    expect(screen.getByRole('button', { name: /October 9th, 2026/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: /October 10th, 2026/ })).toBeEnabled()
    expect(screen.getByRole('button', { name: /October 20th, 2026/ })).toBeEnabled()
    expect(screen.getByRole('button', { name: /October 21st, 2026/ })).toBeDisabled()
  })

  it('marks the button invalid, and forwards the id and description of a form control', () => {
    function Field() {
      const form = useForm<{ until: Date | undefined }>({ defaultValues: { until: undefined } })
      return (
        <Form {...form}>
          <FormField
            control={form.control}
            name="until"
            rules={{ required: 'Choose a date' }}
            render={({ field }) => (
              <FormItemLayout label="Retention until" description="Backups are kept until then.">
                <FormControl>
                  <DatePicker
                    label="Retention until"
                    value={field.value}
                    onValueChange={field.onChange}
                  />
                </FormControl>
              </FormItemLayout>
            )}
          />
        </Form>
      )
    }
    render(<Field />)

    const trigger = screen.getByRole('button', { name: /Retention until/ })
    expect(trigger).toHaveAccessibleDescription('Backups are kept until then.')
    expect(trigger.id).not.toBe('')
  })

  it('marks the button invalid', () => {
    render(<SingleHarness invalid />)

    expect(screen.getByRole('button', { name: /Retention until/ })).toBeInvalid()
  })

  it('does not open when disabled', async () => {
    const user = userEvent.setup()
    render(<SingleHarness disabled />)

    const trigger = screen.getByRole('button', { name: /Retention until/ })
    expect(trigger).toBeDisabled()
    await user.click(trigger)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('has no accessibility violations with the calendar open', async () => {
    const user = userEvent.setup()
    render(<SingleHarness initial={oct(14)} />)
    await user.click(screen.getByRole('button', { name: /Retention until/ }))
    await screen.findByRole('dialog')

    expect(await axeViolations(document.body)).toEqual([])
  })
})

describe('DatePicker (range)', () => {
  it('chooses a range with two clicks and closes after the second', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<RangeHarness initial={{ from: oct(1), to: oct(3) }} onChange={onChange} />)

    expect(
      screen.getByRole('button', { name: 'Backup window: Oct 1, 2026 to Oct 3, 2026' }),
    ).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /Backup window/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Backup window' })
    await user.click(within(dialog).getByRole('button', { name: /October 12th, 2026/ }))

    // The first click starts a new range; the dialog stays open for the end day.
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(onChange.mock.calls.at(-1)?.[0]?.from).toEqual(oct(12))
    expect(onChange.mock.calls.at(-1)?.[0]?.to).toBeUndefined()
    expect(
      screen.getByRole('button', { name: 'Backup window: Oct 12, 2026 to end date not chosen' }),
    ).toBeInTheDocument()

    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: /October 16th, 2026/ }),
    )

    expect(onChange.mock.calls.at(-1)?.[0]).toEqual({ from: oct(12), to: oct(16) })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    const trigger = screen.getByRole('button', {
      name: 'Backup window: Oct 12, 2026 to Oct 16, 2026',
    })
    const times = within(trigger).getAllByText(/2026/)
    expect(times.map((time) => time.getAttribute('datetime'))).toEqual(['2026-10-12', '2026-10-16'])
  })

  it('shows two months side by side', async () => {
    const user = userEvent.setup()
    render(<RangeHarness initial={{ from: oct(12), to: oct(13) }} />)

    await user.click(screen.getByRole('button', { name: /Backup window/ }))
    await screen.findByRole('dialog')

    expect(screen.getAllByRole('grid')).toHaveLength(2)
    expect(screen.getByRole('grid', { name: 'November 2026' })).toBeInTheDocument()
  })

  it('has no accessibility violations with the calendar open', async () => {
    const user = userEvent.setup()
    render(<RangeHarness initial={{ from: oct(12), to: oct(16) }} />)
    await user.click(screen.getByRole('button', { name: /Backup window/ }))
    await screen.findByRole('dialog')

    expect(await axeViolations(document.body)).toEqual([])
  })
})
