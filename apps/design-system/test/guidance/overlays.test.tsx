import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { axeViolations } from '../../../../packages/ui/test/support/axe.ts'
import { renderDemo } from './support.tsx'

afterEach(cleanup)

const change = (element: HTMLElement, value: string) =>
  fireEvent.change(element, { target: { value } })
const pressEscape = () =>
  fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
const gone = (role: 'dialog' | 'alertdialog') =>
  waitFor(() => expect(screen.queryByRole(role)).not.toBeInTheDocument())

describe('the sheet with a form', () => {
  it('closes at once when the form is clean', async () => {
    renderDemo('guidance/modality/sheet-with-form')
    fireEvent.click(screen.getByRole('button', { name: 'Register product' }))
    await screen.findByRole('dialog', { name: 'Register a product' })
    pressEscape()
    await gone('dialog')
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })

  it('asks before Escape discards a dirty form, and keeps the typed text', async () => {
    renderDemo('guidance/modality/sheet-with-form')
    fireEvent.click(screen.getByRole('button', { name: 'Register product' }))
    const sheet = await screen.findByRole('dialog', { name: 'Register a product' })
    expect(await axeViolations(document.body)).toEqual([])

    const slug = within(sheet).getByRole('textbox', { name: 'Product slug' })
    slug.focus()
    change(slug, 'shop')
    pressEscape()

    const confirmation = await screen.findByRole('alertdialog', { name: 'Discard changes?' })
    // The sheet stays open behind the confirmation; the confirmation hides it from assistive technology.
    const behind = screen.getByRole('dialog', { hidden: true })
    expect(behind).toHaveAttribute('data-state', 'open')
    expect(behind).toHaveTextContent('Register a product')
    expect(within(confirmation).getByRole('button', { name: 'Keep editing' })).toHaveFocus()

    fireEvent.click(within(confirmation).getByRole('button', { name: 'Keep editing' }))
    await gone('alertdialog')
    expect(screen.getByRole('dialog', { name: 'Register a product' })).toBeInTheDocument()
    expect(slug).toHaveValue('shop')
    await waitFor(() => expect(slug).toHaveFocus())
  })

  it('sends Cancel through the same guard, and a discarded form reopens empty', async () => {
    renderDemo('guidance/modality/sheet-with-form')
    fireEvent.click(screen.getByRole('button', { name: 'Register product' }))
    const sheet = await screen.findByRole('dialog', { name: 'Register a product' })
    change(within(sheet).getByRole('textbox', { name: 'Product slug' }), 'shop')
    fireEvent.click(within(sheet).getByRole('button', { name: 'Cancel' }))

    const confirmation = await screen.findByRole('alertdialog', { name: 'Discard changes?' })
    fireEvent.click(within(confirmation).getByRole('button', { name: 'Discard changes' }))
    await gone('alertdialog')
    await gone('dialog')

    fireEvent.click(screen.getByRole('button', { name: 'Register product' }))
    const reopened = await screen.findByRole('dialog', { name: 'Register a product' })
    expect(within(reopened).getByRole('textbox', { name: 'Product slug' })).toHaveValue('')
  })

  it('closes without asking after a save, and says that nothing changed yet', async () => {
    renderDemo('guidance/modality/sheet-with-form')
    fireEvent.click(screen.getByRole('button', { name: 'Register product' }))
    const sheet = await screen.findByRole('dialog', { name: 'Register a product' })
    change(within(sheet).getByRole('textbox', { name: 'Product slug' }), 'shop')
    fireEvent.click(within(sheet).getByRole('button', { name: 'Create plan' }))
    await gone('dialog')
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent(
      'Plan created for the product shop. Nothing changes until it is applied.',
    )
  })
})

describe('the dialog with a field', () => {
  it('guards Escape the same way, and discards back to the saved name', async () => {
    renderDemo('guidance/modality/dialog-with-field')
    fireEvent.click(screen.getByRole('button', { name: 'Rename project' }))
    const dialog = await screen.findByRole('dialog', { name: 'Rename the project' })
    const field = within(dialog).getByRole('textbox', { name: 'Display name' })
    expect(within(dialog).getByRole('button', { name: 'Save display name' })).toBeDisabled()
    change(field, 'Shop checkout')
    pressEscape()

    const confirmation = await screen.findByRole('alertdialog', { name: 'Discard changes?' })
    fireEvent.click(within(confirmation).getByRole('button', { name: 'Discard changes' }))
    await gone('alertdialog')
    await gone('dialog')

    fireEvent.click(screen.getByRole('button', { name: 'Rename project' }))
    const reopened = await screen.findByRole('dialog', { name: 'Rename the project' })
    expect(within(reopened).getByRole('textbox', { name: 'Display name' })).toHaveValue(
      'Shop platform',
    )
  })
})

describe('the confirmation ladder', () => {
  it('plain: starts on Cancel, runs the action once and closes', async () => {
    renderDemo('guidance/confirmation-ladder/plain')
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw plan' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Withdraw this plan?' })
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus()
    expect(await axeViolations(document.body)).toEqual([])

    const action = within(dialog).getByRole('button', { name: 'Withdraw plan' })
    fireEvent.click(action)
    fireEvent.click(action)
    await waitFor(() => expect(screen.getByText('Plan withdrawn.')).toBeInTheDocument(), {
      timeout: 3000,
    })
    await gone('alertdialog')
  })

  it('warning: stays unavailable until every statement is ticked', async () => {
    renderDemo('guidance/confirmation-ladder/warning')
    fireEvent.click(screen.getByRole('button', { name: 'Revoke API key' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Revoke this API key?' })
    const action = within(dialog).getByRole('button', { name: 'Revoke API key' })
    expect(action).toHaveAttribute('aria-disabled', 'true')
    expect(action).toHaveAccessibleDescription('Tick each statement to continue (0 of 2 ticked).')
    expect(await axeViolations(document.body)).toEqual([])

    fireEvent.click(within(dialog).getByRole('checkbox', { name: /I know which services/ }))
    expect(action).toHaveAttribute('aria-disabled', 'true')
    expect(action).toHaveAccessibleDescription('Tick each statement to continue (1 of 2 ticked).')
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /replacement key/ }))
    expect(action).not.toHaveAttribute('aria-disabled', 'true')

    fireEvent.click(action)
    await waitFor(() => expect(screen.getByText('API key revoked.')).toBeInTheDocument(), {
      timeout: 3000,
    })
  })

  it('typed: matches exactly, with no trimming and no case folding', async () => {
    renderDemo('guidance/confirmation-ladder/typed')
    fireEvent.click(screen.getByRole('button', { name: 'Decommission target' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Decommission this target?' })
    const field = within(dialog).getByRole('textbox')
    expect(field).toHaveFocus()
    const action = within(dialog).getByRole('button', { name: 'Decommission target' })
    expect(action).toHaveAttribute('aria-disabled', 'true')

    change(field, 'shop/platform/Staging')
    fireEvent.click(action)
    expect(
      within(dialog).getByText('The text must match exactly, including upper and lower case.'),
    ).toBeInTheDocument()
    expect(action).toHaveAttribute('aria-disabled', 'true')

    change(field, 'shop/platform/staging ')
    fireEvent.click(action)
    expect(
      within(dialog).getByText('Remove the space before or after the text.'),
    ).toBeInTheDocument()
    expect(action).toHaveAttribute('aria-disabled', 'true')

    change(field, 'shop/platform/staging')
    expect(action).not.toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(action)
    await waitFor(
      () =>
        expect(
          screen.getByText('Decommission requested for shop/platform/staging.'),
        ).toBeInTheDocument(),
      { timeout: 3000 },
    )
  })

  it('typed: shows a name that hides characters by code point and needs every one of them', async () => {
    renderDemo('guidance/confirmation-ladder/hostile-name')
    fireEvent.click(screen.getByRole('button', { name: 'Create plan to drop table' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Drop this table?' })
    expect(within(dialog).getByText('⟨U+200B⟩')).toBeInTheDocument()
    expect(within(dialog).getByText(/2 characters are marked/)).toBeInTheDocument()
    expect(dialog.textContent).not.toContain('\u{200B}')
    expect(await axeViolations(document.body)).toEqual([])

    const field = within(dialog).getByRole('textbox')
    const action = within(dialog).getByRole('button', { name: 'Create plan' })
    change(field, 'orders')
    expect(action).toHaveAttribute('aria-disabled', 'true')
    change(field, 'ord\u{0435}rs')
    expect(action).toHaveAttribute('aria-disabled', 'true')
    change(field, 'ord\u{0435}rs\u{200B}')
    expect(action).not.toHaveAttribute('aria-disabled', 'true')
  })

  it('plan, standard class on non-production: the action alone, with the full hash', async () => {
    renderDemo('guidance/confirmation-ladder/plan-standard')
    fireEvent.click(screen.getByRole('button', { name: 'Apply to staging' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Apply to staging?' })
    expect(within(dialog).queryByRole('textbox')).not.toBeInTheDocument()
    expect(within(dialog).getByText('Non-production')).toBeInTheDocument()
    expect(within(dialog).queryByText('This changes a production target.')).not.toBeInTheDocument()
    expect(dialog.textContent).toContain(`sha256:${'9f2c1ab04e7d5c3b'.repeat(4)}`)
    const action = within(dialog).getByRole('button', { name: 'Apply to staging' })
    expect(action).not.toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(action)
    await waitFor(
      () => expect(screen.getByText(/Apply accepted for plan sha256:9f2c1ab0/)).toBeInTheDocument(),
      { timeout: 3000 },
    )
    expect(screen.getByText(/its verification comes after it finishes/)).toBeInTheDocument()
  })

  it('plan, high class on production: framed, and the target path is typed', async () => {
    renderDemo('guidance/confirmation-ladder/plan-high')
    fireEvent.click(screen.getByRole('button', { name: 'Apply to production' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Apply to production?' })
    // The word is said twice: in the cue at the top and as the tier among the facts.
    expect(within(dialog).getAllByText('Production')).toHaveLength(2)
    expect(within(dialog).getByText('This changes a production target.')).toBeInTheDocument()
    expect(dialog.querySelector('[data-slot="confirm-frame"]')).toHaveAttribute('data-tier', 'prod')
    expect(await axeViolations(document.body)).toEqual([])

    const action = within(dialog).getByRole('button', { name: 'Apply to production' })
    expect(action).toHaveAttribute('aria-disabled', 'true')
    change(within(dialog).getByRole('textbox'), 'shop/platform/production')
    expect(action).not.toHaveAttribute('aria-disabled', 'true')
  })

  it('plan, critical class: the target path and the effect are both typed', async () => {
    renderDemo('guidance/confirmation-ladder/plan-critical')
    fireEvent.click(screen.getByRole('button', { name: 'Replace placement' }))
    const dialog = await screen.findByRole('alertdialog', {
      name: 'Replace the placement of shop/platform/production?',
    })
    const [path, effect] = within(dialog).getAllByRole('textbox')
    const action = within(dialog).getByRole('button', { name: 'Replace placement' })
    expect(path).toBeDefined()
    expect(effect).toBeDefined()
    if (path === undefined || effect === undefined) return

    change(path, 'shop/platform/production')
    expect(action).toHaveAttribute('aria-disabled', 'true')
    change(effect, 'replaces placement of shop/platform/production')
    expect(action).not.toHaveAttribute('aria-disabled', 'true')
    change(path, 'shop/platform/staging')
    expect(action).toHaveAttribute('aria-disabled', 'true')
  })
})

describe('a failed action in a dialog', () => {
  it('shows the catalog message with its code, and fixed text for an unexpected exception', async () => {
    renderDemo('guidance/error-handling/dialog-failure')

    fireEvent.click(screen.getByRole('button', { name: 'Apply, plan is stale' }))
    let dialog = await screen.findByRole('alertdialog', { name: 'Apply to staging?' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply to staging' }))
    await waitFor(
      () =>
        expect(
          within(dialog).getByText('The plan no longer matches the target. Create a new plan.'),
        ).toBeInTheDocument(),
      { timeout: 3000 },
    )
    expect(within(dialog).getByText('PLAN_STALE')).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await gone('alertdialog')

    fireEvent.click(screen.getByRole('button', { name: 'Apply, unexpected error' }))
    dialog = await screen.findByRole('alertdialog', { name: 'Apply to staging?' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply to staging' }))
    await waitFor(() => expect(within(dialog).getByText('UNKNOWN')).toBeInTheDocument(), {
      timeout: 3000,
    })
    expect(
      within(dialog).getByText(
        'The request did not complete. Check the current state before you try again.',
      ),
    ).toBeInTheDocument()
    expect(dialog.textContent).not.toContain('relation "orders"')
    expect(dialog.textContent).not.toContain('42P01')
  })
})
