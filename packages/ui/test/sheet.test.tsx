// Derived from supabase/supabase packages/ui/src/components/shadcn/ui/sheet.test.tsx @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '../src/sheet.tsx'
import { axeViolations } from './support/axe.ts'

afterEach(cleanup)

const TestSheet = ({ tabIndex }: { tabIndex?: number }) => {
  const tabIndexProps = tabIndex === undefined ? {} : { tabIndex }

  return (
    <Sheet open>
      <SheetContent {...tabIndexProps}>
        <SheetTitle>Sheet title</SheetTitle>
        <SheetDescription>Sheet description</SheetDescription>
        <input aria-label="First field" />
      </SheetContent>
    </Sheet>
  )
}

describe('SheetContent', () => {
  it('focuses its first interactive child without making the sheet focusable', async () => {
    render(<TestSheet />)

    const sheet = screen.getByRole('dialog')
    const input = screen.getByRole('textbox', { name: 'First field' })

    await waitFor(() => expect(input).toHaveFocus())
    expect(sheet).not.toHaveAttribute('tabindex')
  })

  it('allows the sheet to be made programmatically focusable explicitly', () => {
    render(<TestSheet tabIndex={-1} />)

    expect(screen.getByRole('dialog')).toHaveAttribute('tabindex', '-1')
  })

  it('does not move focus to the sheet when a focused child is removed', async () => {
    const renderSheet = (showFirstButton: boolean) => (
      <Sheet open>
        <SheetContent>
          <SheetTitle>Sheet title</SheetTitle>
          <SheetDescription>Sheet description</SheetDescription>
          {showFirstButton && <button type="button">Remove me</button>}
          <input aria-label="Remaining field" />
        </SheetContent>
      </Sheet>
    )
    const { rerender } = render(renderSheet(true))
    const button = screen.getByRole('button', { name: 'Remove me' })

    await waitFor(() => expect(button).toHaveFocus())
    rerender(renderSheet(false))

    await waitFor(() => expect(button).not.toBeInTheDocument())
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    expect(screen.getByRole('dialog')).not.toHaveFocus()
  })
})

describe('Sheet', () => {
  it('is a named, described modal dialog with a labeled close button', () => {
    render(
      <Sheet open>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>Create token</SheetTitle>
            <SheetDescription>The token is shown once.</SheetDescription>
          </SheetHeader>
          <SheetFooter>
            <button type="button">Create token</button>
          </SheetFooter>
        </SheetContent>
      </Sheet>,
    )

    const sheet = screen.getByRole('dialog', { name: 'Create token' })
    expect(sheet).toHaveAccessibleDescription('The token is shown once.')
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument()
  })

  it('can leave out the close button and the overlay', () => {
    const { baseElement } = render(
      <Sheet open>
        <SheetContent showClose={false} hasOverlay={false}>
          <SheetTitle>Details</SheetTitle>
          <SheetDescription>Read only.</SheetDescription>
        </SheetContent>
      </Sheet>,
    )

    expect(screen.queryByRole('button', { name: 'Close' })).not.toBeInTheDocument()
    expect(baseElement.querySelector('[data-state="open"].fixed.inset-0')).toBeNull()
  })

  it.each([
    ['right', 'inset-y-0'],
    ['left', 'inset-y-0'],
    ['top', 'inset-x-0'],
    ['bottom', 'inset-x-0'],
  ] as const)('anchors a %s sheet to its edge', (side, edgeClass) => {
    render(
      <Sheet open>
        <SheetContent side={side}>
          <SheetTitle>Panel</SheetTitle>
          <SheetDescription>Panel description.</SheetDescription>
        </SheetContent>
      </Sheet>,
    )

    expect(screen.getByRole('dialog')).toHaveClass(edgeClass)
  })

  it.each([
    ['w656', 'sm:w-[656px]'],
    ['w800', 'sm:w-[800px]'],
  ] as const)('offers the %s width for token sheets', (size, widthClass) => {
    render(
      <Sheet open>
        <SheetContent size={size}>
          <SheetTitle>Reveal token</SheetTitle>
          <SheetDescription>Copy the token now.</SheetDescription>
        </SheetContent>
      </Sheet>,
    )

    const sheet = screen.getByRole('dialog')
    expect(sheet).toHaveClass(widthClass)
    // Full width on a narrow screen, never wider than the viewport.
    expect(sheet).toHaveClass('w-full', 'max-w-full')
  })

  it('opens from its trigger, closes with Escape and gives focus back to the trigger', async () => {
    const user = userEvent.setup()
    render(
      <Sheet>
        <SheetTrigger>Open details</SheetTrigger>
        <SheetContent>
          <SheetTitle>Details</SheetTitle>
          <SheetDescription>More information.</SheetDescription>
        </SheetContent>
      </Sheet>,
    )

    const trigger = screen.getByRole('button', { name: 'Open details' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(trigger).toHaveAttribute('aria-expanded', 'false')

    await user.click(trigger)
    expect(await screen.findByRole('dialog', { name: 'Details' })).toBeInTheDocument()

    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(trigger).toHaveFocus()
  })
})

describe('Sheet onRequestClose (dirty-form guard)', () => {
  const GuardedSheet = ({
    onRequestClose,
    onOpenChange,
  }: {
    onRequestClose: () => boolean | undefined
    onOpenChange?: (open: boolean) => void
  }) => (
    <Sheet defaultOpen onRequestClose={onRequestClose} {...(onOpenChange ? { onOpenChange } : {})}>
      <SheetContent>
        <SheetTitle>Edit target</SheetTitle>
        <SheetDescription>Unsaved changes are lost.</SheetDescription>
        <SheetClose>Discard changes</SheetClose>
      </SheetContent>
    </Sheet>
  )

  it('keeps the sheet open when the guard returns false, for every way of closing', async () => {
    const user = userEvent.setup()
    const onRequestClose = vi.fn(() => false)
    const onOpenChange = vi.fn()
    render(<GuardedSheet onRequestClose={onRequestClose} onOpenChange={onOpenChange} />)

    await user.keyboard('{Escape}')
    expect(onRequestClose).toHaveBeenCalledTimes(1)

    await user.click(screen.getByRole('button', { name: 'Close' }))
    expect(onRequestClose).toHaveBeenCalledTimes(2)

    await user.click(screen.getByRole('button', { name: 'Discard changes' }))
    expect(onRequestClose).toHaveBeenCalledTimes(3)

    // A pointer press on the overlay (outside the content) asks the guard too.
    const overlay = document.querySelector('[data-state="open"].fixed.inset-0')
    expect(overlay).not.toBeNull()
    if (overlay) await user.pointer({ keys: '[MouseLeft]', target: overlay })
    await waitFor(() => expect(onRequestClose).toHaveBeenCalledTimes(4))

    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it('closes when the guard does not return false', async () => {
    const user = userEvent.setup()
    const onRequestClose = vi.fn(() => undefined)
    const onOpenChange = vi.fn()
    render(<GuardedSheet onRequestClose={onRequestClose} onOpenChange={onOpenChange} />)

    await user.keyboard('{Escape}')

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(onRequestClose).toHaveBeenCalledTimes(1)
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false)
  })

  it('lets the owner close it afterwards through open, without asking the guard again', async () => {
    const user = userEvent.setup()
    const onRequestClose = vi.fn(() => false)

    const Owner = () => {
      const [open, setOpen] = useState(true)
      return (
        <>
          <button type="button" onClick={() => setOpen(false)}>
            Confirm discard
          </button>
          <Sheet open={open} onOpenChange={setOpen} onRequestClose={onRequestClose}>
            <SheetContent>
              <SheetTitle>Edit target</SheetTitle>
              <SheetDescription>Unsaved changes are lost.</SheetDescription>
            </SheetContent>
          </Sheet>
        </>
      )
    }
    render(<Owner />)

    await user.keyboard('{Escape}')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(onRequestClose).toHaveBeenCalledTimes(1)

    // The owner's own button sits outside the modal sheet: reach it without pointer checks.
    fireEvent.click(screen.getByRole('button', { name: 'Confirm discard', hidden: true }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(onRequestClose).toHaveBeenCalledTimes(1)
  })

  it('does not intercept opening', async () => {
    const user = userEvent.setup()
    const onRequestClose = vi.fn(() => false)
    render(
      <Sheet onRequestClose={onRequestClose}>
        <SheetTrigger>Open</SheetTrigger>
        <SheetContent>
          <SheetTitle>Panel</SheetTitle>
          <SheetDescription>Panel description.</SheetDescription>
        </SheetContent>
      </Sheet>,
    )

    await user.click(screen.getByRole('button', { name: 'Open' }))

    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(onRequestClose).not.toHaveBeenCalled()
  })
})

describe('Sheet accessibility', () => {
  it('has no axe violations when closed and when open', async () => {
    const user = userEvent.setup()
    render(
      <Sheet>
        <SheetTrigger>Open details</SheetTrigger>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>Details</SheetTitle>
            <SheetDescription>More information.</SheetDescription>
          </SheetHeader>
          <input aria-label="Name" />
        </SheetContent>
      </Sheet>,
    )

    expect(await axeViolations()).toEqual([])
    await user.click(screen.getByRole('button', { name: 'Open details' }))
    await screen.findByRole('dialog')
    expect(await axeViolations()).toEqual([])
  })
})
