import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DirtyGuardDialog, useDirtyGuard } from '../../src/form/dirty-guard.tsx'
import { axeViolations } from '../support/axe.ts'

afterEach(cleanup)

function Harness({
  when,
  proceed,
  onStay,
}: {
  when: boolean
  proceed: () => void
  onStay?: () => void
}) {
  const guard = useDirtyGuard({ when })
  return (
    <div>
      <button type="button" onClick={() => guard.requestLeave(proceed, onStay)}>
        Leave form
      </button>
      <span data-testid="pending">{String(guard.pending)}</span>
      {guard.dialog}
    </div>
  )
}

function dispatchBeforeUnload(): Event {
  const event = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(event)
  return event
}

describe('useDirtyGuard', () => {
  it('lets a clean form go at once, without a dialog', async () => {
    const user = userEvent.setup()
    const proceed = vi.fn()
    render(<Harness when={false} proceed={proceed} />)

    await user.click(screen.getByRole('button', { name: 'Leave form' }))

    expect(proceed).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })

  it('asks before a dirty form is left, in an in-app dialog', async () => {
    const user = userEvent.setup()
    const proceed = vi.fn()
    const confirm = vi.spyOn(window, 'confirm')
    render(<Harness when proceed={proceed} />)

    await user.click(screen.getByRole('button', { name: 'Leave form' }))

    const dialog = await screen.findByRole('alertdialog', { name: 'Discard changes?' })
    expect(dialog).toHaveAccessibleDescription(
      'You have changes that are not saved. If you leave now, they are lost.',
    )
    expect(proceed).not.toHaveBeenCalled()
    expect(confirm).not.toHaveBeenCalled()
    expect(screen.getByTestId('pending')).toHaveTextContent('true')
    confirm.mockRestore()
  })

  it('puts focus on the least destructive answer and names the actions for their outcome', async () => {
    const user = userEvent.setup()
    render(<Harness when proceed={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: 'Leave form' }))

    expect(await screen.findByRole('button', { name: 'Keep editing' })).toHaveFocus()
    expect(screen.getByRole('button', { name: 'Discard changes' })).toBeInTheDocument()
  })

  it('stays on the form when the person keeps editing', async () => {
    const user = userEvent.setup()
    const proceed = vi.fn()
    const onStay = vi.fn()
    render(<Harness when proceed={proceed} onStay={onStay} />)

    await user.click(screen.getByRole('button', { name: 'Leave form' }))
    await user.click(await screen.findByRole('button', { name: 'Keep editing' }))

    expect(proceed).not.toHaveBeenCalled()
    expect(onStay).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(screen.getByTestId('pending')).toHaveTextContent('false')
  })

  it('treats Escape as keep editing and returns focus to where it was', async () => {
    const user = userEvent.setup()
    const proceed = vi.fn()
    const onStay = vi.fn()
    render(<Harness when proceed={proceed} onStay={onStay} />)

    const leave = screen.getByRole('button', { name: 'Leave form' })
    await user.click(leave)
    await screen.findByRole('alertdialog')
    await user.keyboard('{Escape}')

    expect(proceed).not.toHaveBeenCalled()
    expect(onStay).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    await waitFor(() => expect(leave).toHaveFocus())
  })

  it('leaves exactly once when the person discards the changes', async () => {
    const user = userEvent.setup()
    const proceed = vi.fn()
    const onStay = vi.fn()
    render(<Harness when proceed={proceed} onStay={onStay} />)

    await user.click(screen.getByRole('button', { name: 'Leave form' }))
    await user.click(await screen.findByRole('button', { name: 'Discard changes' }))

    expect(proceed).toHaveBeenCalledTimes(1)
    expect(onStay).not.toHaveBeenCalled()
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })

  it('goes on at once when the form becomes clean while the dialog is open', async () => {
    const user = userEvent.setup()
    const proceed = vi.fn()
    const { rerender } = render(<Harness when proceed={proceed} />)

    await user.click(screen.getByRole('button', { name: 'Leave form' }))
    await screen.findByRole('alertdialog')
    rerender(<Harness when={false} proceed={proceed} />)

    expect(proceed).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })

  it('registers beforeunload only while the form is dirty', () => {
    const { rerender, unmount } = render(<Harness when={false} proceed={vi.fn()} />)
    expect(dispatchBeforeUnload().defaultPrevented).toBe(false)

    rerender(<Harness when proceed={vi.fn()} />)
    expect(dispatchBeforeUnload().defaultPrevented).toBe(true)

    rerender(<Harness when={false} proceed={vi.fn()} />)
    expect(dispatchBeforeUnload().defaultPrevented).toBe(false)

    rerender(<Harness when proceed={vi.fn()} />)
    unmount()
    expect(dispatchBeforeUnload().defaultPrevented).toBe(false)
  })

  it('has no accessibility violations with the dialog open', async () => {
    const user = userEvent.setup()
    render(<Harness when proceed={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: 'Leave form' }))
    await screen.findByRole('alertdialog')

    expect(await axeViolations(document.body)).toEqual([])
  })
})

describe('DirtyGuardDialog', () => {
  it('renders nothing while closed', () => {
    render(<DirtyGuardDialog open={false} onKeepEditing={vi.fn()} onDiscard={vi.fn()} />)

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })

  it('reports each answer once', async () => {
    const user = userEvent.setup()
    const onKeepEditing = vi.fn()
    const onDiscard = vi.fn()
    render(<DirtyGuardDialog open onKeepEditing={onKeepEditing} onDiscard={onDiscard} />)

    await user.click(await screen.findByRole('button', { name: 'Discard changes' }))

    expect(onDiscard).toHaveBeenCalledTimes(1)
  })
})
