import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { TypedConfirmDialog } from '../../src/confirmations/typed-confirm-dialog.tsx'
import { axeViolations } from '../support/axe.ts'

afterEach(cleanup)

const PATH = 'shop/platform/production'

const base = {
  title: 'Decommission the target',
  description: 'The target is removed from the registry; its database is not touched.',
  actionLabel: 'Decommission target',
  destructive: true,
  expectedText: PATH,
  expectedTextName: 'the target path',
}

function field(): HTMLInputElement {
  const input = screen.getByRole('textbox')
  if (!(input instanceof HTMLInputElement)) throw new Error('not an input')
  return input
}

function action(): HTMLElement {
  return screen.getByRole('button', { name: 'Decommission target' })
}

describe('TypedConfirmDialog', () => {
  it('labels the field with the text to type, starts in it and has no axe violations', async () => {
    render(<TypedConfirmDialog {...base} defaultOpen onConfirm={vi.fn()} />)
    const input = screen.getByRole('textbox', {
      name: `To confirm, type the target path ${PATH}`,
    })
    await waitFor(() => expect(input).toHaveFocus())
    const code = screen.getByText(PATH, { selector: 'code *' }).closest('code')
    expect(code).not.toBeNull()
    expect(await axeViolations()).toEqual([])
  })

  it('turns off autocomplete, spelling and capitalization help and has no placeholder', () => {
    render(<TypedConfirmDialog {...base} defaultOpen onConfirm={vi.fn()} />)
    const input = field()
    expect(input).toHaveAttribute('autocomplete', 'off')
    expect(input).toHaveAttribute('autocorrect', 'off')
    expect(input).toHaveAttribute('autocapitalize', 'off')
    expect(input).toHaveAttribute('spellcheck', 'false')
    expect(input).not.toHaveAttribute('placeholder')
    expect(input).toHaveValue('')
  })

  it('keeps the action unavailable until the exact text is typed', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()
    render(<TypedConfirmDialog {...base} defaultOpen onConfirm={onConfirm} />)

    expect(action()).toHaveAttribute('aria-disabled', 'true')
    expect(action()).toHaveAccessibleDescription('Type the text exactly as shown to continue.')

    await user.type(field(), 'shop/platform/productio')
    expect(action()).toHaveAttribute('aria-disabled', 'true')
    await user.type(field(), 'n')
    expect(action()).not.toHaveAttribute('aria-disabled')
    expect(action()).not.toHaveAccessibleDescription()

    await user.click(action())
    expect(onConfirm).toHaveBeenCalledOnce()
  })

  it.each([
    ['upper case', 'Shop/platform/production'],
    ['a trailing space', `${PATH} `],
    ['a leading space', ` ${PATH}`],
    ['a space inside', 'shop/platform /production'],
    ['a zero-width space', `${PATH}\u200b`],
    ['a Cyrillic look-alike', 'sh\u043ep/platform/production'],
    ['a fullwidth look-alike', '\uff53hop/platform/production'],
  ])('does not accept %s', async (_, typed) => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()
    render(<TypedConfirmDialog {...base} defaultOpen onConfirm={onConfirm} />)
    await user.click(field())
    await user.paste(typed)
    expect(field()).toHaveValue(typed)
    expect(action()).toHaveAttribute('aria-disabled', 'true')
    await user.click(action())
    await user.keyboard('{Enter}')
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('accepts pasted text and the decomposed form of the same characters (NFC)', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()
    render(
      <TypedConfirmDialog
        {...base}
        expectedText={'caf\u00e9_orders'}
        expectedTextName="the table name"
        defaultOpen
        onConfirm={onConfirm}
      />,
    )
    await user.click(field())
    await user.paste('cafe\u0301_orders')
    expect(action()).not.toHaveAttribute('aria-disabled')
    await user.click(action())
    expect(onConfirm).toHaveBeenCalledOnce()
  })

  it('shows a mismatch only after the person tried, and names what is wrong', async () => {
    const user = userEvent.setup()
    render(<TypedConfirmDialog {...base} defaultOpen onConfirm={vi.fn()} />)

    await user.type(field(), 'SHOP/platform/production')
    expect(field()).not.toHaveAttribute('aria-invalid')
    expect(screen.queryByText(/must match exactly/)).toBeNull()

    // Enter in the field is an attempt.
    await user.keyboard('{Enter}')
    expect(field()).toHaveAttribute('aria-invalid', 'true')
    expect(field()).toHaveAccessibleDescription(
      'The text must match exactly, including upper and lower case.',
    )

    await user.clear(field())
    await user.paste(`${PATH} `)
    expect(field()).toHaveAccessibleDescription('Remove the space before or after the text.')

    await user.clear(field())
    await user.paste(PATH)
    expect(field()).not.toHaveAttribute('aria-invalid')
    expect(field()).not.toHaveAccessibleDescription()
  })

  it('counts a press of the unavailable action as an attempt', async () => {
    const user = userEvent.setup()
    render(<TypedConfirmDialog {...base} defaultOpen onConfirm={vi.fn()} />)
    await user.click(action())
    expect(field()).toHaveAccessibleDescription('Type the text shown above to continue.')
  })

  it('confirms with Enter once the text matches, through the guarded action', async () => {
    const user = userEvent.setup()
    let settle: () => void = () => {}
    const pending = new Promise<void>((resolve) => {
      settle = resolve
    })
    const onConfirm = vi.fn(() => pending)
    render(<TypedConfirmDialog {...base} defaultOpen onConfirm={onConfirm} />)

    await user.type(field(), `${PATH}{Enter}`)
    expect(onConfirm).toHaveBeenCalledOnce()
    // Pending: the field keeps focus but is read-only; Enter again does nothing.
    expect(field()).toHaveFocus()
    expect(field()).toHaveAttribute('readonly')
    await user.keyboard('{Enter}')
    await user.type(field(), 'x')
    expect(field()).toHaveValue(PATH)
    expect(onConfirm).toHaveBeenCalledOnce()
    await user.keyboard('{Escape}')
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()

    await act(async () => {
      settle()
      await pending
    })
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
  })

  it('does not confirm with Enter while an input method is composing', () => {
    const onConfirm = vi.fn()
    render(<TypedConfirmDialog {...base} defaultOpen onConfirm={onConfirm} />)
    fireEvent.change(field(), { target: { value: PATH } })
    fireEvent.keyDown(field(), { key: 'Enter', isComposing: true })
    expect(onConfirm).not.toHaveBeenCalled()
    fireEvent.keyDown(field(), { key: 'Enter' })
    expect(onConfirm).toHaveBeenCalledOnce()
  })

  it('makes invisible and direction characters in the expected text visible', () => {
    render(
      <TypedConfirmDialog
        {...base}
        expectedText={'orders\u200b\u202e'}
        expectedTextName="the table name"
        defaultOpen
        onConfirm={vi.fn()}
      />,
    )
    const label = screen.getByText((_, node) => node?.tagName === 'LABEL')
    const code = label.querySelector('code')
    expect(code).toHaveTextContent('orders⟨U+200B⟩⟨U+202E⟩')
    expect(code?.textContent).not.toContain('\u202e')
    expect(field()).toHaveAccessibleName('To confirm, type the table name orders⟨U+200B⟩⟨U+202E⟩')
    expect(screen.getByText(/2 characters are marked/)).toBeInTheDocument()
  })

  it('never accepts anything for an empty expected text', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()
    render(<TypedConfirmDialog {...base} expectedText="" defaultOpen onConfirm={onConfirm} />)
    await user.click(field())
    await user.keyboard('{Enter}')
    await user.click(action())
    expect(action()).toHaveAttribute('aria-disabled', 'true')
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('clears the typed text when the expected text, the tier or the reset key changes', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()
    const { rerender } = render(
      <TypedConfirmDialog {...base} open tier="prod" resetKey="tgt_1" onConfirm={onConfirm} />,
    )
    const expectCleared = () => {
      expect(field()).toHaveValue('')
      expect(action()).toHaveAttribute('aria-disabled', 'true')
    }

    await user.type(field(), PATH)
    expect(action()).not.toHaveAttribute('aria-disabled')
    rerender(
      <TypedConfirmDialog
        {...base}
        expectedText="shop/platform/staging"
        open
        tier="prod"
        resetKey="tgt_1"
        onConfirm={onConfirm}
      />,
    )
    expectCleared()
    expect(
      screen.getByRole('textbox', {
        name: 'To confirm, type the target path shop/platform/staging',
      }),
    ).toBeInTheDocument()

    rerender(
      <TypedConfirmDialog {...base} open tier="prod" resetKey="tgt_1" onConfirm={onConfirm} />,
    )
    await user.type(field(), PATH)
    rerender(
      <TypedConfirmDialog {...base} open tier="nonprod" resetKey="tgt_1" onConfirm={onConfirm} />,
    )
    expectCleared()

    await user.type(field(), PATH)
    rerender(
      <TypedConfirmDialog {...base} open tier="nonprod" resetKey="tgt_2" onConfirm={onConfirm} />,
    )
    expectCleared()
    await user.click(action())
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('starts empty each time it opens', async () => {
    const user = userEvent.setup()
    render(
      <TypedConfirmDialog
        {...base}
        trigger={<button type="button">Decommission</button>}
        onConfirm={vi.fn()}
      />,
    )
    await user.click(screen.getByRole('button', { name: 'Decommission' }))
    await user.type(field(), PATH)
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: 'Decommission' }))
    expect(field()).toHaveValue('')
    expect(action()).toHaveAttribute('aria-disabled', 'true')
  })

  it('keeps the dialog and the typed text after a rejection, so the person can try again', async () => {
    const user = userEvent.setup()
    const onConfirm = vi
      .fn()
      .mockRejectedValueOnce({ code: 'TARGET_BUSY', message: 'Another change holds the lock.' })
      .mockResolvedValueOnce(undefined)
    render(<TypedConfirmDialog {...base} tier="prod" defaultOpen onConfirm={onConfirm} />)
    await user.type(field(), PATH)
    await user.click(action())

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Another change holds the lock.')
    expect(alert).toHaveTextContent('TARGET_BUSY')
    expect(field()).toHaveValue(PATH)
    expect(field()).not.toHaveAttribute('readonly')
    expect(await axeViolations()).toEqual([])

    await user.click(action())
    expect(onConfirm).toHaveBeenCalledTimes(2)
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
  })

  it('shows the production cue for production only', () => {
    const { rerender } = render(
      <TypedConfirmDialog {...base} open tier="prod" onConfirm={vi.fn()} />,
    )
    const dialog = screen.getByRole('alertdialog')
    expect(within(dialog).getByText('This changes a production target.')).toBeInTheDocument()
    rerender(<TypedConfirmDialog {...base} open tier="nonprod" onConfirm={vi.fn()} />)
    expect(
      within(screen.getByRole('alertdialog')).queryByText('This changes a production target.'),
    ).toBeNull()
  })
})
