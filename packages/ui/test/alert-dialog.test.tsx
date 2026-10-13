// Derived from supabase/supabase packages/ui/src/components/shadcn/ui/alert-dialog.test.tsx @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogBody,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '../src/alert-dialog.tsx'
import { axeViolations } from './support/axe.ts'

afterEach(cleanup)

const createDeferred = <T,>() => {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })

  return { promise, reject, resolve }
}

const TestAlertDialog = ({
  action,
  actionLabel = 'Continue',
  actionLoading,
  onActionError,
}: {
  action?: () => void | Promise<void>
  actionLabel?: string
  actionLoading?: boolean
  onActionError?: (error: unknown) => void
}) => (
  <AlertDialog defaultOpen>
    <AlertDialogTrigger>Open</AlertDialogTrigger>
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>Confirm action</AlertDialogTitle>
        <AlertDialogDescription>This action needs confirmation.</AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel>Cancel</AlertDialogCancel>
        <AlertDialogAction
          loading={actionLoading}
          onClick={action}
          {...(onActionError ? { onActionError } : {})}
        >
          {actionLabel}
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
)

describe('#AlertDialog', () => {
  it('closes after a synchronous action', async () => {
    const onAction = vi.fn()

    render(<TestAlertDialog action={onAction} />)

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

    expect(onAction).toHaveBeenCalledTimes(1)
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    })
  })

  it('keeps the dialog open and shows loading while an async action is pending', async () => {
    const deferred = createDeferred<void>()
    render(<TestAlertDialog action={() => deferred.promise} />)

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
    const action = screen.getByRole('button', { name: 'Continue' })
    // Pending: the action cannot be pressed again but keeps keyboard focus (aria-disabled).
    expect(action).toHaveAttribute('aria-disabled', 'true')
    expect(action).toHaveAttribute('aria-busy', 'true')
    expect(document.querySelector('.animate-spin')).toBeInTheDocument()
  })

  it('closes after an async action resolves', async () => {
    const deferred = createDeferred<void>()

    render(<TestAlertDialog action={() => deferred.promise} />)

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

    await act(async () => {
      deferred.resolve()
      await deferred.promise
    })

    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    })
  })

  it('keeps the dialog open after an async action rejects', async () => {
    const deferred = createDeferred<void>()

    render(<TestAlertDialog action={() => deferred.promise} />)

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

    await act(async () => {
      deferred.reject(new Error('Unable to complete action'))
      await deferred.promise.catch(() => undefined)
    })

    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Continue' })).not.toHaveAttribute('aria-disabled')
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled()
  })

  it('blocks cancel, Escape, and outside interaction while an async action is pending', () => {
    const deferred = createDeferred<void>()

    render(<TestAlertDialog action={() => deferred.promise} />)

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()

    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' })
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()

    fireEvent.pointerDown(document.body)
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
  })

  it('disables action and cancel when loading is controlled by a parent', () => {
    render(<TestAlertDialog actionLoading />)

    expect(screen.getByRole('button', { name: 'Continue' })).toHaveAttribute(
      'aria-disabled',
      'true',
    )
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
  })

  it('uses the latest onOpenChange callback after a rerender', () => {
    const firstOnOpenChange = vi.fn()
    const secondOnOpenChange = vi.fn()

    const InlineCallbackDialog = ({ label }: { label: string }) => {
      const onOpenChange = (open: boolean) => {
        if (label === 'first') firstOnOpenChange(label, open)
        else secondOnOpenChange(label, open)
      }

      return (
        <AlertDialog defaultOpen onOpenChange={onOpenChange}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Confirm action</AlertDialogTitle>
              <AlertDialogDescription>This action needs confirmation.</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )
    }

    const { rerender } = render(<InlineCallbackDialog label="first" />)

    rerender(<InlineCallbackDialog label="latest" />)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(firstOnOpenChange).not.toHaveBeenCalled()
    expect(secondOnOpenChange).toHaveBeenCalledWith('latest', false)
  })
})

describe('#AlertDialog with a user', () => {
  it('ignores Escape while the action is pending, then closes when it resolves', async () => {
    const user = userEvent.setup()
    const deferred = createDeferred<void>()
    render(<TestAlertDialog action={() => deferred.promise} />)

    const action = screen.getByRole('button', { name: 'Continue' })
    await user.click(action)

    // Pending: Escape does nothing and focus stays on the action.
    await user.keyboard('{Escape}')
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
    expect(action).toHaveFocus()

    // Activating the pending action again with the keyboard does nothing either.
    await user.keyboard('{Enter}')
    await user.keyboard(' ')
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()

    await act(async () => {
      deferred.resolve()
      await deferred.promise
    })
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    })
  })

  it('ignores a click on the cancel button and outside the dialog while pending', async () => {
    const user = userEvent.setup()
    const deferred = createDeferred<void>()
    render(<TestAlertDialog action={() => deferred.promise} />)

    await user.click(screen.getByRole('button', { name: 'Continue' }))
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    // The body is outside the dialog (and has pointer-events: none while it is open).
    fireEvent.pointerDown(document.body)
    fireEvent.pointerUp(document.body)
    fireEvent.click(document.body)

    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
    deferred.resolve()
  })

  it('stays open on a rejection and hands the error to onActionError', async () => {
    const user = userEvent.setup()
    const deferred = createDeferred<void>()
    const onActionError = vi.fn()
    const failure = new Error('Unable to complete action')
    render(<TestAlertDialog action={() => deferred.promise} onActionError={onActionError} />)

    await user.click(screen.getByRole('button', { name: 'Continue' }))
    await user.keyboard('{Escape}')
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()

    await act(async () => {
      deferred.reject(failure)
      await deferred.promise.catch(() => undefined)
    })

    expect(onActionError).toHaveBeenCalledExactlyOnceWith(failure)
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()

    // The user can dismiss it again once the action has failed.
    await user.keyboard('{Escape}')
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    })
  })

  it('lets Escape cancel an idle dialog and does not report it as an action', async () => {
    const user = userEvent.setup()
    const onAction = vi.fn()
    const onOpenChange = vi.fn()
    render(
      <AlertDialog defaultOpen onOpenChange={onOpenChange}>
        <AlertDialogContent>
          <AlertDialogTitle>Revoke token</AlertDialogTitle>
          <AlertDialogDescription>The token stops working at once.</AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep token</AlertDialogCancel>
            <AlertDialogAction onClick={onAction}>Revoke token</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>,
    )

    await user.keyboard('{Escape}')

    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    })
    expect(onAction).not.toHaveBeenCalled()
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false)
  })

  it('works controlled: a resolved action reports the close to the owner', async () => {
    const user = userEvent.setup()
    const deferred = createDeferred<void>()

    const Controlled = () => {
      const [open, setOpen] = useState(true)
      return (
        <>
          <output>{open ? 'open' : 'closed'}</output>
          <AlertDialog open={open} onOpenChange={setOpen}>
            <AlertDialogContent>
              <AlertDialogTitle>Apply plan</AlertDialogTitle>
              <AlertDialogDescription>The plan changes the target.</AlertDialogDescription>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={() => deferred.promise}>Apply plan</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      )
    }
    render(<Controlled />)

    await user.click(screen.getByRole('button', { name: 'Apply plan' }))
    expect(screen.getByText('open', { selector: 'output' })).toBeInTheDocument()

    await act(async () => {
      deferred.resolve()
      await deferred.promise
    })
    await waitFor(() =>
      expect(screen.getByText('closed', { selector: 'output' })).toBeInTheDocument(),
    )
  })

  it('has no accessibility violations: idle, pending and failed', async () => {
    const user = userEvent.setup()
    const deferred = createDeferred<void>()
    render(
      <AlertDialog defaultOpen>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm action</AlertDialogTitle>
            <AlertDialogDescription>This action needs confirmation.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogBody>
            <p>Extra detail</p>
          </AlertDialogBody>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => deferred.promise}>Continue</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>,
    )

    expect(await axeViolations()).toEqual([])
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    expect(await axeViolations()).toEqual([])
    await act(async () => {
      deferred.reject(new Error('failed'))
      await deferred.promise.catch(() => undefined)
    })
    expect(await axeViolations()).toEqual([])
  })
})
