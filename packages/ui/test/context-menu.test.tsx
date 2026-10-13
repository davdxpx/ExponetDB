import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '../src/context-menu.tsx'
import { axeViolations } from './support/axe.ts'

afterEach(cleanup)

const Example = ({ onOpenPlan = () => {} }: { onOpenPlan?: () => void }) => (
  <ContextMenu>
    <ContextMenuTrigger>
      <div>Row: billing/api/production</div>
    </ContextMenuTrigger>
    <ContextMenuContent aria-label="Row actions">
      <ContextMenuLabel>Target</ContextMenuLabel>
      <ContextMenuItem onSelect={onOpenPlan}>
        Open plan
        <ContextMenuShortcut>Enter</ContextMenuShortcut>
      </ContextMenuItem>
      <ContextMenuItem disabled>Delete target</ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuCheckboxItem checked>Pin row</ContextMenuCheckboxItem>
      <ContextMenuRadioGroup value="a">
        <ContextMenuRadioItem value="a">Compact</ContextMenuRadioItem>
        <ContextMenuRadioItem value="b">Comfortable</ContextMenuRadioItem>
      </ContextMenuRadioGroup>
      <ContextMenuSub>
        <ContextMenuSubTrigger>Copy as</ContextMenuSubTrigger>
        <ContextMenuSubContent>
          <ContextMenuItem>Path</ContextMenuItem>
        </ContextMenuSubContent>
      </ContextMenuSub>
    </ContextMenuContent>
  </ContextMenu>
)

describe('ContextMenu', () => {
  it('opens on the context-menu event and exposes typed menu items', async () => {
    render(<Example />)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()

    fireEvent.contextMenu(screen.getByText('Row: billing/api/production'))

    expect(await screen.findByRole('menu', { name: 'Row actions' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: /Open plan/ })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Delete target' })).toHaveAttribute(
      'aria-disabled',
      'true',
    )
    expect(screen.getByRole('menuitemcheckbox', { name: 'Pin row' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    expect(screen.getByRole('menuitemradio', { name: 'Compact' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    expect(screen.getByRole('menuitem', { name: 'Copy as' })).toHaveAttribute(
      'aria-haspopup',
      'menu',
    )
    expect(screen.getByText('Enter')).toBeInTheDocument()
  })

  it('is modal: it locks page scrolling while open', async () => {
    render(<Example />)

    fireEvent.contextMenu(screen.getByText('Row: billing/api/production'))
    await screen.findByRole('menu')

    expect(document.body).toHaveAttribute('data-scroll-locked')
  })

  it('runs onSelect and closes; Escape closes without selecting', async () => {
    const user = userEvent.setup()
    const onOpenPlan = vi.fn()
    render(<Example onOpenPlan={onOpenPlan} />)

    fireEvent.contextMenu(screen.getByText('Row: billing/api/production'))
    await user.click(await screen.findByRole('menuitem', { name: /Open plan/ }))
    expect(onOpenPlan).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())

    fireEvent.contextMenu(screen.getByText('Row: billing/api/production'))
    await screen.findByRole('menu')
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
    expect(onOpenPlan).toHaveBeenCalledTimes(1)
  })

  it('has no axe violations open', async () => {
    render(<Example />)
    expect(await axeViolations()).toEqual([])

    fireEvent.contextMenu(screen.getByText('Row: billing/api/production'))
    await screen.findByRole('menu')
    expect(await axeViolations()).toEqual([])
  })
})
