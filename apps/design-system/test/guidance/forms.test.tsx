import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { axeViolations } from '../../../../packages/ui/test/support/axe.ts'
import { renderDemo } from './support.tsx'

afterEach(cleanup)

const change = (element: HTMLElement, value: string) =>
  fireEvent.change(element, { target: { value } })

describe('the settings card', () => {
  it('offers Save only while the form is dirty, and re-baselines after a save', async () => {
    const { container } = renderDemo('guidance/forms/settings-card')
    const save = screen.getByRole('button', { name: 'Save policy' })
    expect(save).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Discard changes' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('switch', { name: 'Require approval for agent plans' }))
    expect(save).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Discard changes' })).toBeInTheDocument()

    fireEvent.click(save)
    expect(screen.getByRole('status')).toHaveTextContent('Policy saved.')
    expect(save).toBeDisabled()
    expect(await axeViolations(container)).toEqual([])
  })

  it('restores the saved values when the changes are discarded', () => {
    renderDemo('guidance/forms/settings-card')
    const approval = screen.getByRole('switch', { name: 'Require approval for agent plans' })
    expect(approval).toBeChecked()
    fireEvent.click(approval)
    expect(approval).not.toBeChecked()
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }))
    expect(approval).toBeChecked()
  })

  it('links the error to its field, and a failed save moves focus there', () => {
    renderDemo('guidance/forms/settings-card')
    const field = screen.getByRole('textbox', { name: 'Approval window (hours)' })
    expect(field).not.toBeInvalid()
    change(field, '30')
    expect(field).toBeInvalid()
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a whole number from 1 to 24.')
    expect(field).toHaveAccessibleDescription(/Enter a whole number from 1 to 24\./)
    screen.getByRole('switch', { name: 'Require approval for agent plans' }).focus()
    fireEvent.click(screen.getByRole('button', { name: 'Save policy' }))
    expect(field).toHaveFocus()
    expect(screen.queryByText('Policy saved.')).not.toBeInTheDocument()
  })
})

describe('the validation form', () => {
  it('shows the rule and the fix once the field was left, and a failed submit focuses it', () => {
    renderDemo('guidance/forms/validation')
    const field = screen.getByRole('textbox', { name: 'Environment name' })
    expect(field).toBeInvalid()
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Use lowercase letters, digits and hyphens only.',
    )
    screen.getByRole('button', { name: 'Add environment' }).focus()
    fireEvent.click(screen.getByRole('button', { name: 'Add environment' }))
    expect(field).toHaveFocus()

    change(field, 'a')
    expect(screen.getByRole('alert')).toHaveTextContent('Use 2 to 32 characters.')
    change(field, 'staging-2')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Add environment' }))
    expect(screen.getByRole('status')).toHaveTextContent('this demo changes nothing')
  })
})

describe('the write-only password', () => {
  it('checks the length and the repeat, and never keeps the password', async () => {
    const { container } = renderDemo('guidance/forms/write-only-password')
    const password = screen.getByLabelText('Password', { selector: 'input' })
    const repeat = screen.getByLabelText('Repeat the password')
    expect(password).toHaveAttribute('type', 'password')
    expect(password).toHaveAttribute('autocomplete', 'new-password')
    const send = screen.getByRole('button', { name: 'Send password' })
    expect(send).toBeDisabled()

    change(password, 'short')
    expect(screen.getByRole('alert')).toHaveTextContent('Use at least 16 characters.')
    change(password, 'correct horse battery staple')
    change(repeat, 'correct horse battery stapl')
    expect(screen.getByText('The two passwords differ.')).toBeInTheDocument()
    expect(send).toBeDisabled()

    change(repeat, 'correct horse battery staple')
    expect(send).toBeEnabled()
    fireEvent.click(send)

    // Both fields are empty at once, before the request finishes.
    expect(password).toHaveValue('')
    expect(repeat).toHaveValue('')
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Password sent.'))
    expect(container.textContent).not.toContain('correct horse battery staple')
    expect(container.innerHTML).not.toContain('correct horse')
    expect(screen.getByText('Pending verification')).toBeInTheDocument()
    expect(await axeViolations(container)).toEqual([])
  })
})

describe('the dirty guard', () => {
  it('lets a clean form go at once', () => {
    renderDemo('guidance/forms/dirty-guard')
    fireEvent.click(screen.getByRole('button', { name: 'Back to databases' }))
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Left the form.')
  })

  it('asks before a dirty form is left, with the least destructive answer focused', async () => {
    renderDemo('guidance/forms/dirty-guard')
    const field = screen.getByRole('textbox', { name: 'Display name' })
    change(field, 'Shop platform (new)')
    fireEvent.click(screen.getByRole('button', { name: 'Back to databases' }))

    const dialog = await screen.findByRole('alertdialog', { name: 'Discard changes?' })
    expect(within(dialog).getByRole('button', { name: 'Keep editing' })).toHaveFocus()
    expect(await axeViolations(document.body)).toEqual([])

    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep editing' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    expect(field).toHaveValue('Shop platform (new)')

    fireEvent.click(screen.getByRole('button', { name: 'Back to databases' }))
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Discard changes',
      }),
    )
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(
        'Left the form. The unsaved change was discarded.',
      ),
    )
    expect(field).toHaveValue('Shop platform')
  })

  it('registers the reload prompt only while the form is dirty', () => {
    renderDemo('guidance/forms/dirty-guard')
    const clean = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(clean)
    expect(clean.defaultPrevented).toBe(false)

    change(screen.getByRole('textbox', { name: 'Display name' }), 'Changed')
    const dirty = new Event('beforeunload', { cancelable: true })
    act(() => {
      window.dispatchEvent(dirty)
    })
    expect(dirty.defaultPrevented).toBe(true)
  })
})
