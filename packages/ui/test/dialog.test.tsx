import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogSection,
  DialogSectionSeparator,
  DialogTitle,
  DialogTrigger,
} from '../src/dialog.tsx'
import { axeViolations } from './support/axe.ts'

afterEach(cleanup)

const Example = ({
  size,
  hideClose,
}: {
  size?: 'tiny' | 'small' | 'medium' | 'large' | 'xlarge' | 'xxlarge' | 'xxxlarge'
  hideClose?: boolean
}) => (
  <Dialog>
    <DialogTrigger>Open dialog</DialogTrigger>
    <DialogContent {...(size ? { size } : {})} {...(hideClose ? { hideClose } : {})}>
      <DialogHeader>
        <DialogTitle>Register target</DialogTitle>
        <DialogDescription>Choose the cluster that hosts the database.</DialogDescription>
      </DialogHeader>
      <DialogSection>
        <input aria-label="Target name" />
      </DialogSection>
      <DialogSectionSeparator />
      <DialogFooter>
        <DialogClose>Cancel</DialogClose>
        <button type="button">Register target</button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
)

describe('Dialog', () => {
  it('is closed until the trigger is used, then a named and described modal dialog', async () => {
    const user = userEvent.setup()
    render(<Example />)

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Open dialog' }))

    const dialog = await screen.findByRole('dialog', { name: 'Register target' })
    expect(dialog).toHaveAccessibleDescription('Choose the cluster that hosts the database.')
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument()
  })

  it('moves focus into the dialog and gives it back to the trigger on close', async () => {
    const user = userEvent.setup()
    render(<Example />)
    const trigger = screen.getByRole('button', { name: 'Open dialog' })

    await user.click(trigger)
    const dialog = await screen.findByRole('dialog')
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true))

    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(trigger).toHaveFocus()
  })

  it('keeps Tab inside the dialog', async () => {
    const user = userEvent.setup()
    render(<Example />)
    await user.click(screen.getByRole('button', { name: 'Open dialog' }))
    const dialog = await screen.findByRole('dialog')

    for (let i = 0; i < 6; i += 1) {
      await user.tab()
      expect(dialog.contains(document.activeElement)).toBe(true)
    }
  })

  it('closes from the close button and from a DialogClose', async () => {
    const user = userEvent.setup()
    render(<Example />)
    const trigger = screen.getByRole('button', { name: 'Open dialog' })

    await user.click(trigger)
    await user.click(await screen.findByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    await user.click(trigger)
    await user.click(await screen.findByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('can hide the close button', async () => {
    const user = userEvent.setup()
    render(<Example hideClose />)
    await user.click(screen.getByRole('button', { name: 'Open dialog' }))
    await screen.findByRole('dialog')

    expect(screen.queryByRole('button', { name: 'Close' })).not.toBeInTheDocument()
  })

  it.each([
    ['tiny', 'sm:max-w-xs'],
    ['medium', 'sm:max-w-lg'],
    ['xxxlarge', 'md:max-w-7xl'],
  ] as const)('applies the %s size', async (size, widthClass) => {
    const user = userEvent.setup()
    render(<Example size={size} />)
    await user.click(screen.getByRole('button', { name: 'Open dialog' }))

    expect(await screen.findByRole('dialog')).toHaveClass(widthClass)
  })

  it('has no axe violations when open', async () => {
    const user = userEvent.setup()
    render(<Example />)
    expect(await axeViolations()).toEqual([])

    await user.click(screen.getByRole('button', { name: 'Open dialog' }))
    await screen.findByRole('dialog')
    expect(await axeViolations()).toEqual([])
  })
})

describe('Dialog onRequestClose (dirty-form guard)', () => {
  const Guarded = ({
    onRequestClose,
    onOpenChange,
    defaultOpen = true,
  }: {
    onRequestClose: () => boolean | undefined
    onOpenChange?: (open: boolean) => void
    defaultOpen?: boolean
  }) => (
    <Dialog
      defaultOpen={defaultOpen}
      onRequestClose={onRequestClose}
      {...(onOpenChange ? { onOpenChange } : {})}
    >
      <DialogTrigger>Open dialog</DialogTrigger>
      <DialogContent>
        <DialogTitle>Edit target</DialogTitle>
        <DialogDescription>Unsaved changes are lost.</DialogDescription>
        <DialogClose>Discard changes</DialogClose>
      </DialogContent>
    </Dialog>
  )

  it('keeps an uncontrolled dialog open when the guard returns false, however it is closed', async () => {
    const user = userEvent.setup()
    const onRequestClose = vi.fn(() => false)
    const onOpenChange = vi.fn()
    render(<Guarded onRequestClose={onRequestClose} onOpenChange={onOpenChange} />)

    await user.keyboard('{Escape}')
    expect(onRequestClose).toHaveBeenCalledTimes(1)

    await user.click(screen.getByRole('button', { name: 'Close' }))
    expect(onRequestClose).toHaveBeenCalledTimes(2)

    await user.click(screen.getByRole('button', { name: 'Discard changes' }))
    expect(onRequestClose).toHaveBeenCalledTimes(3)

    // A press on the backdrop (outside the content) asks the guard as well.
    const overlay = document.querySelector('.fixed.inset-0[data-state="open"]')
    expect(overlay).not.toBeNull()
    if (overlay) await user.pointer({ keys: '[MouseLeft]', target: overlay })
    await waitFor(() => expect(onRequestClose).toHaveBeenCalledTimes(4))

    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it('closes an uncontrolled dialog when the guard lets it', async () => {
    const user = userEvent.setup()
    const onRequestClose = vi.fn(() => undefined)
    const onOpenChange = vi.fn()
    render(<Guarded onRequestClose={onRequestClose} onOpenChange={onOpenChange} />)

    await user.keyboard('{Escape}')

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false)
  })

  it('supports the in-app confirmation flow: block, ask, then close through open', async () => {
    const user = userEvent.setup()
    const Flow = () => {
      const [open, setOpen] = useState(true)
      const [asking, setAsking] = useState(false)
      return (
        <>
          <Dialog
            open={open}
            onOpenChange={setOpen}
            onRequestClose={() => {
              setAsking(true)
              return false
            }}
          >
            <DialogContent>
              <DialogTitle>Edit target</DialogTitle>
              <DialogDescription>Unsaved changes are lost.</DialogDescription>
            </DialogContent>
          </Dialog>
          <Dialog open={asking} onOpenChange={setAsking}>
            <DialogContent>
              <DialogTitle>Discard changes?</DialogTitle>
              <DialogDescription>Your edits to the target are lost.</DialogDescription>
              <button
                type="button"
                onClick={() => {
                  setAsking(false)
                  setOpen(false)
                }}
              >
                Discard changes
              </button>
            </DialogContent>
          </Dialog>
        </>
      )
    }
    render(<Flow />)

    await user.keyboard('{Escape}')
    expect(await screen.findByRole('dialog', { name: 'Discard changes?' })).toBeInTheDocument()
    expect(screen.getAllByRole('dialog', { hidden: true })).toHaveLength(2)

    await user.click(screen.getByRole('button', { name: 'Discard changes' }))
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { hidden: true })).not.toBeInTheDocument(),
    )
  })

  it('does not ask the guard when the owner closes it through open, nor when opening', async () => {
    const user = userEvent.setup()
    const onRequestClose = vi.fn(() => false)
    const { rerender } = render(
      <Dialog open onRequestClose={onRequestClose}>
        <DialogContent>
          <DialogTitle>Edit target</DialogTitle>
          <DialogDescription>Unsaved changes are lost.</DialogDescription>
        </DialogContent>
      </Dialog>,
    )
    expect(screen.getByRole('dialog')).toBeInTheDocument()

    rerender(
      <Dialog open={false} onRequestClose={onRequestClose}>
        <DialogContent>
          <DialogTitle>Edit target</DialogTitle>
          <DialogDescription>Unsaved changes are lost.</DialogDescription>
        </DialogContent>
      </Dialog>,
    )
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    cleanup()
    render(<Guarded onRequestClose={onRequestClose} defaultOpen={false} />)
    await user.click(screen.getByRole('button', { name: 'Open dialog' }))
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(onRequestClose).not.toHaveBeenCalled()
  })

  it('uses the latest guard after a rerender', async () => {
    const user = userEvent.setup()
    const first = vi.fn(() => false)
    const latest = vi.fn(() => false)
    const { rerender } = render(<Guarded onRequestClose={first} />)
    rerender(<Guarded onRequestClose={latest} />)

    await user.keyboard('{Escape}')

    expect(first).not.toHaveBeenCalled()
    expect(latest).toHaveBeenCalledTimes(1)
  })
})

describe('Dialog scroll lock', () => {
  it('marks the body as scroll-locked while open and clears it on close', async () => {
    const user = userEvent.setup()
    render(<Example />)
    expect(document.body).not.toHaveAttribute('data-scroll-locked')

    await user.click(screen.getByRole('button', { name: 'Open dialog' }))
    await screen.findByRole('dialog')
    // The attribute is what the static rule `body[data-scroll-locked]` in the global
    // stylesheet keys on (react-remove-scroll sets it from script, never from CSS).
    expect(document.body).toHaveAttribute('data-scroll-locked')

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    await waitFor(() => expect(document.body).not.toHaveAttribute('data-scroll-locked'))
  })
})
