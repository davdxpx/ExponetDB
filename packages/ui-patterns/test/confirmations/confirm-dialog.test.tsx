import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ConfirmDialog } from '../../src/confirmations/confirm-dialog.tsx'
import { actionFailureOf } from '../../src/confirmations/confirm-shell.tsx'
import { axeViolations } from '../support/axe.ts'

afterEach(cleanup)

function deferred<T = void>() {
  let resolve: (value: T) => void = () => {}
  let reject: (reason: unknown) => void = () => {}
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function frameOf(dialog: HTMLElement): HTMLElement {
  const frame = dialog.querySelector<HTMLElement>('[data-slot="confirm-frame"]')
  if (frame === null) throw new Error('no frame')
  return frame
}

const base = {
  title: 'Restart the health sampler',
  description: 'The sampler starts again; nothing in the target changes.',
  actionLabel: 'Restart sampler',
}

describe('ConfirmDialog', () => {
  it('names the action, focuses Cancel first and has no axe violations', async () => {
    render(<ConfirmDialog {...base} defaultOpen onConfirm={vi.fn()} />)
    const dialog = screen.getByRole('alertdialog', { name: 'Restart the health sampler' })
    expect(dialog).toHaveAccessibleDescription(
      'The sampler starts again; nothing in the target changes.',
    )
    expect(within(dialog).getByRole('button', { name: 'Restart sampler' })).toBeEnabled()
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus(),
    )
    expect(await axeViolations()).toEqual([])
  })

  it('opens from its trigger and returns focus to it when canceled', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()
    render(
      <ConfirmDialog
        {...base}
        trigger={<button type="button">Restart</button>}
        onConfirm={onConfirm}
      />,
    )

    const trigger = screen.getByRole('button', { name: 'Restart' })
    await user.click(trigger)
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    expect(trigger).toHaveFocus()
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('closes after a synchronous action', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()
    render(<ConfirmDialog {...base} defaultOpen onConfirm={onConfirm} />)

    await user.click(screen.getByRole('button', { name: 'Restart sampler' }))
    expect(onConfirm).toHaveBeenCalledOnce()
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
  })

  it('stays pending without closing, keeps focus and ignores Escape, Cancel and outside clicks', async () => {
    const user = userEvent.setup()
    const pending = deferred()
    const onOpenChange = vi.fn()
    render(
      <ConfirmDialog
        {...base}
        defaultOpen
        onOpenChange={onOpenChange}
        onConfirm={() => pending.promise}
      />,
    )
    const dialog = screen.getByRole('alertdialog')
    const action = screen.getByRole('button', { name: 'Restart sampler' })

    await user.click(action)
    expect(action).toHaveAttribute('aria-disabled', 'true')
    expect(action).toHaveAttribute('aria-busy', 'true')
    expect(action).toHaveFocus()
    expect(screen.getByRole('status')).toHaveTextContent('In progress.')

    await user.keyboard('{Escape}')
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
    expect(action).toHaveFocus()

    const cancel = screen.getByRole('button', { name: 'Cancel' })
    expect(cancel).toBeDisabled()
    await user.click(cancel)
    const overlay = dialog.parentElement
    if (overlay === null) throw new Error('no overlay')
    await user.pointer({ keys: '[MouseLeft]', target: overlay })
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()

    // Tab stays inside the dialog.
    await user.tab()
    expect(dialog.contains(document.activeElement)).toBe(true)
    expect(onOpenChange).not.toHaveBeenCalled()

    await act(async () => {
      pending.resolve()
      await pending.promise
    })
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false)
  })

  it('runs the action once for a double press, also when both presses come before a render', async () => {
    const user = userEvent.setup()
    const pending = deferred()
    const onConfirm = vi.fn(() => pending.promise)
    render(<ConfirmDialog {...base} defaultOpen onConfirm={onConfirm} />)
    const action = screen.getByRole('button', { name: 'Restart sampler' })

    act(() => {
      action.click()
      action.click()
    })
    expect(onConfirm).toHaveBeenCalledOnce()

    await user.dblClick(action)
    await user.keyboard('{Enter}')
    expect(onConfirm).toHaveBeenCalledOnce()
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()

    await act(async () => {
      pending.resolve()
      await pending.promise
    })
    expect(onConfirm).toHaveBeenCalledOnce()
  })

  it('keeps the dialog open on a rejection and shows the code and catalog text', async () => {
    const user = userEvent.setup()
    const pending = deferred()
    render(<ConfirmDialog {...base} defaultOpen onConfirm={() => pending.promise} />)
    const action = screen.getByRole('button', { name: 'Restart sampler' })

    await user.click(action)
    await act(async () => {
      pending.reject({ code: 'PLAN_STALE', message: 'The plan no longer matches the target.' })
      await pending.promise.catch(() => undefined)
    })

    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('The request failed')
    expect(alert).toHaveTextContent('The plan no longer matches the target.')
    expect(alert).toHaveTextContent('Error code PLAN_STALE')
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
    // The person can try again or leave.
    expect(action).not.toHaveAttribute('aria-disabled')
    expect(action).toHaveFocus()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled()
    expect(await axeViolations()).toEqual([])
  })

  it('shows fixed text for an error without a code, never the exception text', async () => {
    const user = userEvent.setup()
    render(
      <ConfirmDialog
        {...base}
        defaultOpen
        onConfirm={() => {
          throw new Error('<b>stack trace with internals</b>')
        }}
      />,
    )
    await user.click(screen.getByRole('button', { name: 'Restart sampler' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(
      'The request did not complete. Check the current state before you try again.',
    )
    expect(alert).toHaveTextContent('Error code UNKNOWN')
    expect(alert).not.toHaveTextContent('stack trace')
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
  })

  it('offers the least destructive alternative before the action', async () => {
    const user = userEvent.setup()
    const cancelQuery = deferred()
    const onAlternative = vi.fn(() => cancelQuery.promise)
    const onConfirm = vi.fn()
    render(
      <ConfirmDialog
        title="Terminate the session"
        description="The session's connection closes and its open transaction rolls back."
        actionLabel="Terminate session"
        destructive
        alternative={{ label: 'Cancel the query', onSelect: onAlternative }}
        defaultOpen
        onConfirm={onConfirm}
      />,
    )
    const buttons = within(screen.getByRole('alertdialog')).getAllByRole('button')
    expect(buttons.map((button) => button.textContent)).toEqual([
      'Close',
      'Cancel the query',
      'Terminate session',
    ])

    const alternative = screen.getByRole('button', { name: 'Cancel the query' })
    await user.click(alternative)
    expect(onAlternative).toHaveBeenCalledOnce()
    // While the alternative runs, nothing else can start.
    expect(alternative).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByRole('button', { name: 'Terminate session' })).toHaveAttribute(
      'aria-disabled',
      'true',
    )
    await user.click(screen.getByRole('button', { name: 'Terminate session' }))
    expect(onConfirm).not.toHaveBeenCalled()

    await act(async () => {
      cancelQuery.resolve()
      await cancelQuery.promise
    })
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('shows the production frame and cue for production only', () => {
    const { rerender } = render(<ConfirmDialog {...base} open tier="prod" onConfirm={vi.fn()} />)
    let dialog = screen.getByRole('alertdialog')
    expect(frameOf(dialog)).toHaveAttribute('data-tier', 'prod')
    expect(within(dialog).getByText('Production')).toBeInTheDocument()
    expect(within(dialog).getByText('This changes a production target.')).toBeInTheDocument()
    // Announced with the dialog, before its own description.
    expect(dialog).toHaveAccessibleDescription(
      'Production This changes a production target. The sampler starts again; nothing in the target changes.',
    )

    rerender(<ConfirmDialog {...base} open tier="nonprod" onConfirm={vi.fn()} />)
    dialog = screen.getByRole('alertdialog')
    expect(frameOf(dialog)).toHaveAttribute('data-tier', 'nonprod')
    expect(within(dialog).queryByText('Production')).toBeNull()

    rerender(<ConfirmDialog {...base} open onConfirm={vi.fn()} />)
    dialog = screen.getByRole('alertdialog')
    expect(frameOf(dialog)).not.toHaveAttribute('data-tier')
    expect(within(dialog).queryByText('This changes a production target.')).toBeNull()
  })

  it('works controlled: the owner closes it after the action resolved', async () => {
    const user = userEvent.setup()
    const pending = deferred()
    function Owner() {
      const [open, setOpen] = useState(true)
      return (
        <>
          <output>{open ? 'open' : 'closed'}</output>
          <ConfirmDialog
            {...base}
            open={open}
            onOpenChange={setOpen}
            onConfirm={() => pending.promise}
          />
        </>
      )
    }
    render(<Owner />)
    await user.click(screen.getByRole('button', { name: 'Restart sampler' }))
    expect(screen.getByText('open', { selector: 'output' })).toBeInTheDocument()
    await act(async () => {
      pending.resolve()
      await pending.promise
    })
    await waitFor(() =>
      expect(screen.getByText('closed', { selector: 'output' })).toBeInTheDocument(),
    )
  })
})

describe('ConfirmDialog with an owner that keeps it open', () => {
  it('does not run the action again after it succeeded', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn(() => Promise.resolve())
    render(<ConfirmDialog {...base} open onOpenChange={() => {}} onConfirm={onConfirm} />)
    const button = screen.getByRole('button', { name: 'Restart sampler' })
    await user.click(button)
    await waitFor(() => expect(button).toHaveAttribute('aria-disabled', 'true'))
    expect(screen.getByRole('status')).toHaveTextContent('Done.')

    await user.click(button)
    act(() => button.click())
    expect(onConfirm).toHaveBeenCalledOnce()
    // Leaving still works.
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled()
  })
})

describe('actionFailureOf', () => {
  it('keeps a stable code with its text and replaces anything else', () => {
    expect(actionFailureOf({ code: 'PLAN_EXPIRED', message: 'The plan expired.' })).toEqual({
      code: 'PLAN_EXPIRED',
      message: 'The plan expired.',
    })
    const fallback = {
      code: 'UNKNOWN',
      message: 'The request did not complete. Check the current state before you try again.',
    }
    expect(actionFailureOf(new Error('boom'))).toEqual(fallback)
    expect(actionFailureOf({ code: 'lower_case', message: 'x' })).toEqual(fallback)
    expect(actionFailureOf({ code: 'PLAN_STALE', message: '  ' })).toEqual(fallback)
    expect(actionFailureOf('PLAN_STALE')).toEqual(fallback)
    expect(actionFailureOf(null)).toEqual(fallback)
  })
})
