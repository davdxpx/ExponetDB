import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { WarningConfirmDialog } from '../../src/confirmations/warning-confirm-dialog.tsx'
import { axeViolations } from '../support/axe.ts'

afterEach(cleanup)

const CHECKLIST = [
  'No backup of this target is verified.',
  'Sessions on this target are disconnected.',
]

const base = {
  title: 'Restart the cluster',
  description: 'Every database on the cluster is unavailable while it restarts.',
  actionLabel: 'Restart cluster',
  checklist: CHECKLIST,
}

describe('WarningConfirmDialog', () => {
  it('keeps the action unavailable, with its reason, until every statement is ticked', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()
    render(<WarningConfirmDialog {...base} defaultOpen onConfirm={onConfirm} />)

    const group = screen.getByRole('group', { name: 'Confirm each statement' })
    const boxes = within(group).getAllByRole('checkbox')
    expect(boxes).toHaveLength(2)
    expect(within(group).getByRole('checkbox', { name: CHECKLIST[0] })).not.toBeChecked()

    const action = screen.getByRole('button', { name: 'Restart cluster' })
    expect(action).toHaveAttribute('aria-disabled', 'true')
    expect(action).toHaveAccessibleDescription('Tick each statement to continue (0 of 2 ticked).')
    await user.click(action)
    expect(onConfirm).not.toHaveBeenCalled()
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()

    // The label ticks its box too.
    await user.click(screen.getByText(CHECKLIST[0] ?? ''))
    expect(action).toHaveAccessibleDescription('Tick each statement to continue (1 of 2 ticked).')
    await user.click(within(group).getByRole('checkbox', { name: CHECKLIST[1] }))
    expect(action).not.toHaveAttribute('aria-disabled')
    expect(action).not.toHaveAccessibleDescription()

    // Unticking takes it away again.
    await user.click(within(group).getByRole('checkbox', { name: CHECKLIST[1] }))
    expect(action).toHaveAttribute('aria-disabled', 'true')
    await user.click(within(group).getByRole('checkbox', { name: CHECKLIST[1] }))

    await user.click(action)
    expect(onConfirm).toHaveBeenCalledOnce()
  })

  it('keeps the unavailable action focusable and ignores Enter on it', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()
    render(<WarningConfirmDialog {...base} defaultOpen onConfirm={onConfirm} />)
    const action = screen.getByRole('button', { name: 'Restart cluster' })
    action.focus()
    expect(action).toHaveFocus()
    await user.keyboard('{Enter}')
    await user.keyboard(' ')
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('clears the ticks when the checklist, the tier or the reset key changes', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()
    const { rerender } = render(
      <WarningConfirmDialog {...base} open tier="nonprod" resetKey="op_1" onConfirm={onConfirm} />,
    )
    const tickAll = async () => {
      for (const box of screen.getAllByRole('checkbox')) await user.click(box)
      expect(screen.getByRole('button', { name: 'Restart cluster' })).not.toHaveAttribute(
        'aria-disabled',
      )
    }
    const expectCleared = () => {
      for (const box of screen.getAllByRole('checkbox')) expect(box).not.toBeChecked()
      expect(screen.getByRole('button', { name: 'Restart cluster' })).toHaveAttribute(
        'aria-disabled',
        'true',
      )
    }

    await tickAll()
    rerender(
      <WarningConfirmDialog
        {...base}
        checklist={[...CHECKLIST.slice(0, 1), 'The restart takes about a minute.']}
        open
        tier="nonprod"
        resetKey="op_1"
        onConfirm={onConfirm}
      />,
    )
    expectCleared()

    rerender(
      <WarningConfirmDialog {...base} open tier="nonprod" resetKey="op_1" onConfirm={onConfirm} />,
    )
    await tickAll()
    rerender(
      <WarningConfirmDialog {...base} open tier="prod" resetKey="op_1" onConfirm={onConfirm} />,
    )
    expectCleared()

    await tickAll()
    rerender(
      <WarningConfirmDialog {...base} open tier="prod" resetKey="op_2" onConfirm={onConfirm} />,
    )
    expectCleared()
    await user.click(screen.getByRole('button', { name: 'Restart cluster' }))
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('starts with no ticks each time it opens', async () => {
    const user = userEvent.setup()
    render(
      <WarningConfirmDialog
        {...base}
        trigger={<button type="button">Restart</button>}
        onConfirm={vi.fn()}
      />,
    )
    await user.click(screen.getByRole('button', { name: 'Restart' }))
    for (const box of screen.getAllByRole('checkbox')) await user.click(box)
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())

    await user.click(screen.getByRole('button', { name: 'Restart' }))
    for (const box of screen.getAllByRole('checkbox')) expect(box).not.toBeChecked()
    expect(screen.getByRole('button', { name: 'Restart cluster' })).toHaveAttribute(
      'aria-disabled',
      'true',
    )
  })

  it('fails closed with an empty checklist', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()
    render(<WarningConfirmDialog {...base} checklist={[]} defaultOpen onConfirm={onConfirm} />)
    const action = screen.getByRole('button', { name: 'Restart cluster' })
    expect(action).toHaveAttribute('aria-disabled', 'true')
    expect(action).toHaveAccessibleDescription(
      'There is nothing to confirm, so this action is not available.',
    )
    await user.click(action)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('locks the checklist while pending and keeps focus on the action', async () => {
    const user = userEvent.setup()
    let settle: () => void = () => {}
    const pending = new Promise<void>((resolve) => {
      settle = resolve
    })
    render(<WarningConfirmDialog {...base} defaultOpen onConfirm={() => pending} />)
    for (const box of screen.getAllByRole('checkbox')) await user.click(box)
    const action = screen.getByRole('button', { name: 'Restart cluster' })
    await user.click(action)

    for (const box of screen.getAllByRole('checkbox')) expect(box).toBeDisabled()
    expect(action).toHaveFocus()
    expect(action).toHaveAttribute('aria-busy', 'true')
    await user.keyboard('{Escape}')
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()

    await act(async () => {
      settle()
      await pending
    })
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
  })

  it('shows the production frame for production and has no axe violations', async () => {
    const user = userEvent.setup()
    render(
      <WarningConfirmDialog {...base} tier="prod" destructive defaultOpen onConfirm={vi.fn()} />,
    )
    const dialog = screen.getByRole('alertdialog')
    expect(within(dialog).getByText('This changes a production target.')).toBeInTheDocument()
    expect(await axeViolations()).toEqual([])
    for (const box of screen.getAllByRole('checkbox')) await user.click(box)
    expect(await axeViolations()).toEqual([])
  })
})
