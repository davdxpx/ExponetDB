import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MAX_VISIBLE_TOASTS, Toaster, toast } from '../src/toast.tsx'
import { axeViolations } from './support/axe.ts'

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false })
})

afterEach(() => {
  act(() => toast.clear())
  cleanup()
  vi.useRealTimers()
})

/** Runs a store call and lets React render it. */
function show<T>(call: () => T): T {
  let result!: T
  act(() => {
    result = call()
  })
  return result
}

/** Moves the fake clock forward and lets React and Radix react to it. */
async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

const region = () => screen.getByRole('region', { name: /Notifications/ })

describe('Toaster', () => {
  it('renders a labeled notifications region that is empty until a toast is shown', () => {
    render(<Toaster />)

    expect(region()).toBeInTheDocument()
    expect(within(region()).queryAllByRole('listitem')).toHaveLength(0)
  })

  it('shows a toast with the kind spoken and the message as text', async () => {
    render(<Toaster />)

    show(() => toast.success('Plan approved', { description: 'Apply it before it expires.' }))
    await advance(0)

    const item = within(region()).getByRole('listitem')
    expect(item).toHaveTextContent('Success: Plan approved')
    expect(item).toHaveTextContent('Apply it before it expires.')
    expect(item).toHaveAttribute('data-kind', 'success')
    expect(within(item).getByRole('button', { name: 'Dismiss notification' })).toBeInTheDocument()
  })

  it('shows the stable error code of an error toast', async () => {
    render(<Toaster />)

    show(() => toast.error('Apply failed', { code: 'PLAN_STALE' }))
    await advance(0)

    const item = within(region()).getByRole('listitem')
    expect(item).toHaveTextContent('Error: Apply failed')
    expect(item).toHaveTextContent('Error code: PLAN_STALE')
  })

  it('closes success and info toasts by itself and warnings later', async () => {
    render(<Toaster />)

    show(() => toast.success('Saved'))
    show(() => toast.info('Heads up'))
    show(() => toast.warning('Check the tier'))
    await advance(0)
    expect(within(region()).getAllByRole('listitem')).toHaveLength(3)

    await advance(4_000 + 300)
    expect(screen.queryByText('Saved')).not.toBeInTheDocument()
    expect(screen.getByText('Heads up')).toBeInTheDocument()

    await advance(1_000 + 300)
    expect(screen.queryByText('Heads up')).not.toBeInTheDocument()
    expect(screen.getByText('Check the tier')).toBeInTheDocument()

    await advance(3_000 + 300)
    expect(within(region()).queryAllByRole('listitem')).toHaveLength(0)
  })

  it('honors a custom duration for non-error toasts', async () => {
    render(<Toaster />)

    show(() => toast.info('Quick note', { duration: 1_000 }))
    await advance(0)
    expect(screen.getByText('Quick note')).toBeInTheDocument()

    await advance(1_000 + 300)
    expect(screen.queryByText('Quick note')).not.toBeInTheDocument()
  })

  it('keeps an error toast until it is dismissed, whatever duration is passed', async () => {
    render(<Toaster />)

    show(() => toast.error('Apply failed', { duration: 500 }))
    await advance(0)

    await advance(10 * 60_000)
    expect(screen.getByText('Apply failed')).toBeInTheDocument()
  })

  it('dismisses a toast from its close button', async () => {
    render(<Toaster />)
    show(() => toast.error('Apply failed', { code: 'PLAN_STALE' }))
    await advance(0)

    // (user-event waits on a timer of its own, which the fake clock would never fire.)
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss notification' }))
    await advance(300)

    expect(screen.queryByText('Apply failed')).not.toBeInTheDocument()
  })

  it('dismisses a toast by id and all toasts without one', async () => {
    render(<Toaster />)
    const first = show(() => toast.error('First failure'))
    show(() => toast.error('Second failure'))
    show(() => toast.error('Third failure'))
    await advance(0)

    act(() => toast.dismiss(first))
    await advance(300)
    expect(screen.queryByText('First failure')).not.toBeInTheDocument()
    expect(screen.getByText('Second failure')).toBeInTheDocument()

    act(() => toast.dismiss())
    await advance(300)
    expect(within(region()).queryAllByRole('listitem')).toHaveLength(0)
  })

  it('shows at most three toasts: a new one closes the oldest', async () => {
    render(<Toaster />)
    expect(MAX_VISIBLE_TOASTS).toBe(3)

    for (const name of ['One', 'Two', 'Three', 'Four']) {
      show(() => toast.error(`Failure ${name}`))
    }
    await advance(300)

    expect(within(region()).getAllByRole('listitem')).toHaveLength(3)
    expect(screen.queryByText('Failure One')).not.toBeInTheDocument()
    expect(screen.getByText('Failure Four')).toBeInTheDocument()
  })

  it('replaces a visible toast that has the same id instead of stacking it', async () => {
    render(<Toaster />)

    show(() => toast.info('Uploading 10%', { id: 'upload' }))
    show(() => toast.info('Uploading 60%', { id: 'upload' }))
    await advance(0)

    expect(within(region()).getAllByRole('listitem')).toHaveLength(1)
    expect(screen.getByText('Uploading 60%')).toBeInTheDocument()
  })

  it('runs the action callback once and closes the toast', async () => {
    const onUndo = vi.fn()
    render(<Toaster />)
    show(() => toast.success('Target archived', { action: { label: 'Undo', onClick: onUndo } }))
    await advance(0)

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    await advance(300)

    expect(onUndo).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('Target archived')).not.toBeInTheDocument()
  })

  it('renders text as text: markup in a message is shown literally and never parsed', async () => {
    render(<Toaster />)

    show(() =>
      toast.info('<b>bold</b> <img src=x onerror=alert(1)>', {
        description: '<a href="https://example.test">link</a>',
      }),
    )
    await advance(0)

    const item = within(region()).getByRole('listitem')
    expect(item).toHaveTextContent('<b>bold</b> <img src=x onerror=alert(1)>')
    expect(item).toHaveTextContent('<a href="https://example.test">link</a>')
    expect(item.querySelector('b')).toBeNull()
    expect(item.querySelector('img')).toBeNull()
    expect(item.querySelector('a')).toBeNull()
  })

  it('turns whatever it is given into text, even a value that is not a string', async () => {
    render(<Toaster />)

    // A caller outside the type system (plain JavaScript) cannot smuggle a node in.
    show(() => toast.info({ toString: () => 'plain text' } as unknown as string))
    await advance(0)

    expect(within(region()).getByRole('listitem')).toHaveTextContent('plain text')
  })

  it('does not create any <style> element', async () => {
    const before = document.querySelectorAll('style').length
    render(<Toaster />)
    show(() => toast.success('Saved'))
    show(() => toast.error('Apply failed', { code: 'PLAN_STALE' }))
    await advance(0)

    expect(document.querySelectorAll('style')).toHaveLength(before)
  })

  it('removes every toast at once on clear', async () => {
    render(<Toaster />)
    show(() => toast.error('Apply failed'))
    await advance(0)

    act(() => toast.clear())

    expect(within(region()).queryAllByRole('listitem')).toHaveLength(0)
  })

  it('has no axe violations empty, with every kind, and with an action', async () => {
    // axe-core schedules its own timers: it runs on the real clock.
    vi.useRealTimers()
    render(<Toaster />)
    expect(await axeViolations()).toEqual([])

    show(() => toast.success('Plan approved', { description: 'Apply it before it expires.' }))
    show(() => toast.warning('Production tier'))
    show(() =>
      toast.error('Apply failed', {
        code: 'PLAN_STALE',
        action: { label: 'View plan', onClick: () => {} },
      }),
    )

    expect(await within(region()).findAllByRole('listitem')).toHaveLength(3)
    expect(await axeViolations()).toEqual([])
  })
})
