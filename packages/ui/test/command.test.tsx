import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from '../src/command.tsx'
import { axeViolations } from './support/axe.ts'

afterEach(cleanup)

const Palette = ({ onSelect = () => {} }: { onSelect?: (value: string) => void }) => (
  <Command label="Search targets">
    <CommandInput placeholder="Search targets" />
    <CommandList>
      <CommandEmpty>No targets found.</CommandEmpty>
      <CommandGroup heading="Targets">
        <CommandItem value="billing" onSelect={onSelect}>
          billing/api/production
          <CommandShortcut>G B</CommandShortcut>
        </CommandItem>
        <CommandItem value="reports" onSelect={onSelect}>
          reports/api/staging
        </CommandItem>
        <CommandItem value="archive" disabled onSelect={onSelect}>
          archive/api/production
        </CommandItem>
      </CommandGroup>
      <CommandSeparator />
      <CommandGroup heading="Pages">
        <CommandItem value="audit" onSelect={onSelect}>
          Audit log
        </CommandItem>
      </CommandGroup>
    </CommandList>
  </Command>
)

describe('Command', () => {
  it('is a named search field over a listbox of options', () => {
    render(<Palette />)

    const input = screen.getByRole('combobox', { name: 'Search targets' })
    expect(input).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('listbox')).toBeInTheDocument()
    expect(screen.getAllByRole('option')).toHaveLength(4)
    expect(screen.getByRole('option', { name: /archive\/api\/production/ })).toHaveAttribute(
      'aria-disabled',
      'true',
    )
  })

  it('filters while typing and shows the empty message when nothing matches', async () => {
    const user = userEvent.setup()
    render(<Palette />)
    const input = screen.getByRole('combobox')

    await user.type(input, 'reports')
    expect(screen.getAllByRole('option')).toHaveLength(1)
    expect(screen.getByRole('option', { name: 'reports/api/staging' })).toBeInTheDocument()

    await user.clear(input)
    await user.type(input, 'zzz')
    expect(screen.queryAllByRole('option')).toHaveLength(0)
    expect(screen.getByText('No targets found.')).toBeInTheDocument()
  })

  it('moves with the arrow keys, skips disabled options and selects with Enter', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    render(<Palette onSelect={onSelect} />)
    const input = screen.getByRole('combobox')
    input.focus()

    // The first option is highlighted from the start.
    expect(screen.getByRole('option', { name: /billing/ })).toHaveAttribute('aria-selected', 'true')

    await user.keyboard('{ArrowDown}')
    const reports = screen.getByRole('option', { name: 'reports/api/staging' })
    expect(reports).toHaveAttribute('aria-selected', 'true')
    // Focus stays in the field; the highlighted option is announced through it.
    await waitFor(() => expect(input).toHaveAttribute('aria-activedescendant', reports.id))
    expect(input).toHaveFocus()

    // The disabled option in between is skipped.
    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('option', { name: 'Audit log' })).toHaveAttribute(
      'aria-selected',
      'true',
    )

    await user.keyboard('{Enter}')
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('audit')
  })

  it('selects with a click and ignores a click on a disabled option', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    render(<Palette onSelect={onSelect} />)

    await user.click(screen.getByRole('option', { name: /archive\/api\/production/ }))
    expect(onSelect).not.toHaveBeenCalled()

    await user.click(screen.getByRole('option', { name: 'reports/api/staging' }))
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('reports')
  })

  it('clears the search from the reset button', async () => {
    const user = userEvent.setup()
    const Controlled = () => {
      const [value, setValue] = useState('')
      return (
        <Command label="Search targets">
          <CommandInput
            showResetIcon
            handleReset={() => setValue('')}
            value={value}
            onValueChange={setValue}
            placeholder="Search targets"
          />
          <CommandList>
            <CommandItem value="billing">billing/api/production</CommandItem>
          </CommandList>
        </Command>
      )
    }
    render(<Controlled />)
    const input = screen.getByRole('combobox')
    expect(screen.getByRole('button', { name: 'Clear search' })).toBeDisabled()

    await user.type(input, 'bill')
    await user.click(screen.getByRole('button', { name: 'Clear search' }))

    expect(input).toHaveValue('')
  })

  it('has no axe violations', async () => {
    render(<Palette />)
    expect(await axeViolations()).toEqual([])
  })
})

describe('CommandDialog', () => {
  it('opens as a named modal dialog around the palette and closes with Escape', async () => {
    const user = userEvent.setup()
    const Host = () => {
      const [open, setOpen] = useState(false)
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open command menu
          </button>
          <CommandDialog open={open} onOpenChange={setOpen} title="Command menu">
            <CommandInput placeholder="Type a command" />
            <CommandList>
              <CommandItem value="targets">Go to targets</CommandItem>
            </CommandList>
          </CommandDialog>
        </>
      )
    }
    render(<Host />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Open command menu' }))

    const dialog = await screen.findByRole('dialog', { name: 'Command menu' })
    expect(dialog).toHaveAccessibleDescription(/Type to search/)
    expect(screen.getByRole('combobox', { name: 'Command menu' })).toBeInTheDocument()
    expect(await axeViolations()).toEqual([])

    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })
})
