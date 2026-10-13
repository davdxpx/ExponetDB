import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '../src/dropdown-menu.tsx'
import { axeViolations } from './support/axe.ts'

afterEach(cleanup)

const Example = ({
  onCopy = () => {},
  onDelete = () => {},
}: {
  onCopy?: () => void
  onDelete?: () => void
}) => {
  const [showDetails, setShowDetails] = useState(true)
  const [tier, setTier] = useState('nonprod')

  return (
    <DropdownMenu>
      <DropdownMenuTrigger>Target actions</DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuLabel>Target</DropdownMenuLabel>
        <DropdownMenuGroup>
          <DropdownMenuItem onSelect={onCopy}>
            Copy path
            <DropdownMenuShortcut>Ctrl+C</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem disabled onSelect={onDelete}>
            Delete target
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem checked={showDetails} onCheckedChange={setShowDetails}>
          Show details
        </DropdownMenuCheckboxItem>
        <DropdownMenuRadioGroup value={tier} onValueChange={setTier}>
          <DropdownMenuRadioItem value="nonprod">Nonproduction</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="prod">Production</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>Export</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuItem>As JSON</DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

describe('DropdownMenu', () => {
  it('opens from the trigger with a menu of typed items', async () => {
    const user = userEvent.setup()
    render(<Example />)
    const trigger = screen.getByRole('button', { name: 'Target actions' })

    expect(trigger).toHaveAttribute('aria-haspopup', 'menu')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    await user.click(trigger)

    const menu = await screen.findByRole('menu', { name: 'Target actions' })
    expect(menu).toBeInTheDocument()
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('menuitem', { name: /Copy path/ })).toBeInTheDocument()
    expect(screen.getByRole('menuitemcheckbox', { name: 'Show details' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    expect(screen.getByRole('menuitemradio', { name: 'Nonproduction' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    expect(screen.getByRole('menuitemradio', { name: 'Production' })).toHaveAttribute(
      'aria-checked',
      'false',
    )
    expect(screen.getByRole('menuitem', { name: 'Export' })).toHaveAttribute(
      'aria-haspopup',
      'menu',
    )
    expect(screen.getByRole('separator')).toBeInTheDocument()
    expect(screen.getByText('Ctrl+C')).toBeInTheDocument()
  })

  it('does not lock page scrolling by default (non-modal)', async () => {
    const user = userEvent.setup()
    render(<Example />)

    await user.click(screen.getByRole('button', { name: 'Target actions' }))
    await screen.findByRole('menu')

    expect(document.body).not.toHaveAttribute('data-scroll-locked')
  })

  it('runs onSelect, closes and returns focus to the trigger', async () => {
    const user = userEvent.setup()
    const onCopy = vi.fn()
    render(<Example onCopy={onCopy} />)
    const trigger = screen.getByRole('button', { name: 'Target actions' })

    await user.click(trigger)
    await user.click(await screen.findByRole('menuitem', { name: /Copy path/ }))

    expect(onCopy).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
    expect(trigger).toHaveFocus()
  })

  it('does not run a disabled item and announces it as disabled', async () => {
    const user = userEvent.setup()
    const onDelete = vi.fn()
    render(<Example onDelete={onDelete} />)

    await user.click(screen.getByRole('button', { name: 'Target actions' }))
    const item = await screen.findByRole('menuitem', { name: 'Delete target' })
    expect(item).toHaveAttribute('aria-disabled', 'true')
    expect(item).toHaveAttribute('data-disabled')

    await user.click(item)
    expect(onDelete).not.toHaveBeenCalled()
    expect(screen.getByRole('menu')).toBeInTheDocument()
  })

  it('works with the keyboard: open, move, toggle, close with Escape', async () => {
    const user = userEvent.setup()
    render(<Example />)
    const trigger = screen.getByRole('button', { name: 'Target actions' })

    await user.tab()
    expect(trigger).toHaveFocus()
    await user.keyboard('{Enter}')
    await screen.findByRole('menu')

    // Opened with the keyboard, the first item is focused.
    await waitFor(() => expect(screen.getByRole('menuitem', { name: /Copy path/ })).toHaveFocus())
    // The disabled item is skipped.
    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('menuitemcheckbox', { name: 'Show details' })).toHaveFocus()

    await user.keyboard('{Enter}')
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())

    await user.keyboard('{Enter}')
    const reopened = await screen.findByRole('menuitemcheckbox', { name: 'Show details' })
    // Toggled off by the previous Enter.
    expect(reopened).toHaveAttribute('aria-checked', 'false')

    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
    expect(trigger).toHaveFocus()
  })

  it('opens a submenu with the right arrow key', async () => {
    const user = userEvent.setup()
    render(<Example />)

    await user.click(screen.getByRole('button', { name: 'Target actions' }))
    const sub = await screen.findByRole('menuitem', { name: 'Export' })
    sub.focus()
    await user.keyboard('{ArrowRight}')

    expect(await screen.findByRole('menuitem', { name: 'As JSON' })).toBeInTheDocument()
  })

  it('has no axe violations open', async () => {
    const user = userEvent.setup()
    render(<Example />)
    expect(await axeViolations()).toEqual([])

    await user.click(screen.getByRole('button', { name: 'Target actions' }))
    await screen.findByRole('menu')
    expect(await axeViolations()).toEqual([])
  })
})
