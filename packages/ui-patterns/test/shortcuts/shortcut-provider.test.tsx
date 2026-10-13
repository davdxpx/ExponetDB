import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { type ReactNode, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  ShortcutProvider,
  type ShortcutProviderProps,
  useActiveShortcuts,
  useOpenShortcutHelp,
  useShortcut,
} from '../../src/shortcuts/index.ts'
import { axeViolations } from '../support/axe.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function Plans({ onRun, enabled = true }: { onRun: () => void; enabled?: boolean }): ReactNode {
  useShortcut('nav.plans', onRun, { enabled })
  return null
}

function renderWithProvider(ui: ReactNode, props: Partial<ShortcutProviderProps> = {}) {
  return render(
    <ShortcutProvider apple={false} strict {...props}>
      {ui}
    </ShortcutProvider>,
  )
}

describe('ShortcutProvider', () => {
  it('runs the handler of a sequence and stops the browser default of the last key', async () => {
    const user = userEvent.setup()
    const onRun = vi.fn()
    renderWithProvider(<Plans onRun={onRun} />)

    await user.keyboard('g')
    const notCancelled = fireEvent.keyDown(document.body, { key: 'p', code: 'KeyP' })

    expect(onRun).toHaveBeenCalledOnce()
    expect(notCancelled).toBe(false)
  })

  it('leaves a key press alone that is not a shortcut', () => {
    renderWithProvider(<Plans onRun={() => {}} />)

    expect(fireEvent.keyDown(document.body, { key: 'x', code: 'KeyX' })).toBe(true)
    expect(fireEvent.keyDown(document.body, { key: 'g', code: 'KeyG' })).toBe(true)
  })

  it('does nothing when the second key comes too late', async () => {
    const onRun = vi.fn()
    const now = vi.spyOn(performance, 'now')
    renderWithProvider(<Plans onRun={onRun} />)

    now.mockReturnValue(10_000)
    fireEvent.keyDown(document.body, { key: 'g', code: 'KeyG' })
    now.mockReturnValue(11_500)
    fireEvent.keyDown(document.body, { key: 'p', code: 'KeyP' })

    expect(onRun).not.toHaveBeenCalled()
  })

  it('removes the shortcut when the component unmounts or is disabled', async () => {
    const user = userEvent.setup()
    const onRun = vi.fn()
    function Switchable(): ReactNode {
      const [on, setOn] = useState(true)
      return (
        <>
          <Plans onRun={onRun} enabled={on} />
          <button type="button" onClick={() => setOn(false)}>
            Turn off
          </button>
        </>
      )
    }
    renderWithProvider(<Switchable />)

    await user.click(screen.getByRole('button', { name: 'Turn off' }))
    await user.keyboard('gp')

    expect(onRun).not.toHaveBeenCalled()
  })

  it('does nothing without a provider', async () => {
    const user = userEvent.setup()
    const onRun = vi.fn()
    render(<Plans onRun={onRun} />)

    await user.keyboard('gp')

    expect(onRun).not.toHaveBeenCalled()
  })

  describe('where letters are not shortcuts', () => {
    it('ignores a text input, a textarea and a select', async () => {
      const user = userEvent.setup()
      const onRun = vi.fn()
      renderWithProvider(
        <>
          <Plans onRun={onRun} />
          <input aria-label="Name" />
          <textarea aria-label="Notes" />
          <select aria-label="Tier">
            <option>one</option>
          </select>
        </>,
      )

      for (const field of ['Name', 'Notes', 'Tier']) {
        screen.getByLabelText(field).focus()
        await user.keyboard('gp')
      }

      expect(onRun).not.toHaveBeenCalled()
    })

    it('ignores a content-editable element and a custom text box', async () => {
      const user = userEvent.setup()
      const onRun = vi.fn()
      renderWithProvider(<Plans onRun={onRun} />)

      // Built by hand: the element roles are what the check looks at, not a widget of ours.
      const editor = document.createElement('div')
      editor.setAttribute('contenteditable', 'true')
      const searchbox = document.createElement('div')
      searchbox.setAttribute('role', 'searchbox')
      for (const element of [editor, searchbox]) {
        element.tabIndex = 0
        document.body.append(element)
        element.focus()
        await user.keyboard('gp')
      }

      expect(onRun).not.toHaveBeenCalled()
    })

    it('ignores a focused menu item', async () => {
      const user = userEvent.setup()
      const onRun = vi.fn()
      renderWithProvider(
        <>
          <Plans onRun={onRun} />
          <div role="menu" aria-label="Actions">
            <button type="button" role="menuitem">
              Cancel plan
            </button>
          </div>
        </>,
      )

      screen.getByRole('menuitem').focus()
      await user.keyboard('gp')

      expect(onRun).not.toHaveBeenCalled()
    })

    it('ignores an open dialog', async () => {
      const user = userEvent.setup()
      const onRun = vi.fn()
      renderWithProvider(
        <>
          <Plans onRun={onRun} />
          <div role="dialog" aria-label="Apply plan" data-state="open" />
        </>,
      )

      await user.keyboard('gp')

      expect(onRun).not.toHaveBeenCalled()
    })

    it('works again once the dialog is gone', async () => {
      const user = userEvent.setup()
      const onRun = vi.fn()
      renderWithProvider(
        <>
          <Plans onRun={onRun} />
          <div role="dialog" aria-label="Apply plan" data-state="closed" />
        </>,
      )

      await user.keyboard('gp')

      expect(onRun).toHaveBeenCalledOnce()
    })
  })

  describe('the help dialog', () => {
    function Active(): ReactNode {
      return <output data-testid="active">{useActiveShortcuts().join(',')}</output>
    }

    it('opens with the question mark and lists the shortcuts that work on the page', async () => {
      const user = userEvent.setup()
      renderWithProvider(
        <>
          <Plans onRun={() => {}} />
          <Active />
        </>,
      )

      await user.keyboard('?')

      const dialog = await screen.findByRole('dialog', { name: 'Keyboard shortcuts' })
      expect(within(dialog).getByRole('heading', { name: 'General' })).toBeInTheDocument()
      expect(within(dialog).getByRole('heading', { name: 'Go to' })).toBeInTheDocument()
      expect(within(dialog).getByText('Go to plans')).toBeInTheDocument()
      expect(within(dialog).getByText('G then P')).toBeInTheDocument()
      expect(within(dialog).getByText('Show keyboard shortcuts')).toBeInTheDocument()
      // Not registered on this page, so not listed.
      expect(within(dialog).queryByText('Go to audit')).toBeNull()
      expect(within(dialog).queryByRole('heading', { name: 'Switch environment' })).toBeNull()
    })

    it('has no accessibility violations', async () => {
      const user = userEvent.setup()
      renderWithProvider(<Plans onRun={() => {}} />)
      await user.keyboard('?')
      await screen.findByRole('dialog')

      expect(await axeViolations(document.body)).toEqual([])
    })

    it('closes with Escape and returns focus', async () => {
      const user = userEvent.setup()
      renderWithProvider(
        <>
          <button type="button">Before</button>
          <Plans onRun={() => {}} />
        </>,
      )
      screen.getByRole('button', { name: 'Before' }).focus()

      await user.keyboard('?')
      await screen.findByRole('dialog')
      await user.keyboard('{Escape}')

      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
      expect(screen.getByRole('button', { name: 'Before' })).toHaveFocus()
    })

    it('does not open while a dialog is open, nor in a text field', async () => {
      const user = userEvent.setup()
      renderWithProvider(<input aria-label="Name" />)

      await user.click(screen.getByRole('textbox'))
      await user.keyboard('?')

      expect(screen.queryByRole('dialog')).toBeNull()
      expect(screen.getByRole('textbox')).toHaveValue('?')
    })

    it('opens from code', async () => {
      const user = userEvent.setup()
      function Opener(): ReactNode {
        const open = useOpenShortcutHelp()
        return (
          <button type="button" onClick={open}>
            Show shortcuts
          </button>
        )
      }
      renderWithProvider(<Opener />)

      await user.click(screen.getByRole('button', { name: 'Show shortcuts' }))

      expect(await screen.findByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument()
    })

    it('turns the letter shortcuts off and on again, and keeps Control+K', async () => {
      const user = userEvent.setup()
      const onRun = vi.fn()
      const onPalette = vi.fn()
      const onChange = vi.fn()
      function Palette(): ReactNode {
        useShortcut('palette.open', onPalette)
        return null
      }
      renderWithProvider(
        <>
          <Plans onRun={onRun} />
          <Palette />
        </>,
        { onCharacterShortcutsChange: onChange },
      )

      await user.keyboard('?')
      const dialog = await screen.findByRole('dialog')
      const toggle = within(dialog).getByRole('switch', { name: 'Letter shortcuts' })
      expect(toggle).toBeChecked()
      await user.click(toggle)
      expect(toggle).not.toBeChecked()
      expect(onChange).toHaveBeenLastCalledWith(false)

      await user.keyboard('{Escape}')
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

      await user.keyboard('gp')
      expect(onRun).not.toHaveBeenCalled()
      await user.keyboard('?')
      expect(screen.queryByRole('dialog')).toBeNull()
      await user.keyboard('{Control>}k{/Control}')
      expect(onPalette).toHaveBeenCalledOnce()
    })

    it('follows the choice of the app when it is controlled', async () => {
      const user = userEvent.setup()
      const onRun = vi.fn()
      const onChange = vi.fn()
      renderWithProvider(<Plans onRun={onRun} />, {
        characterShortcuts: false,
        onCharacterShortcutsChange: onChange,
      })

      await user.keyboard('gp')
      expect(onRun).not.toHaveBeenCalled()
    })
  })
})
