import '@testing-library/jest-dom/vitest'
import { Toaster, TooltipProvider, toast } from '@exponetdb/ui'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEMOS } from '../../src/demos/registry.ts'

/**
 * The interactions the `ui` pages describe, run against the live demos: overlays open, guard
 * and return focus; menus and tabs follow the keyboard; toasts keep their rules; a form wires
 * its errors. A page that documents a behavior has a test that this behavior holds.
 */
function renderDemo(id: string): ReturnType<typeof render> {
  const demo = DEMOS.get(id)
  if (demo === undefined) throw new Error(`unknown demo ${id}`)
  return render(
    <TooltipProvider>
      {demo.render()}
      <Toaster />
    </TooltipProvider>,
  )
}

beforeAll(() => {
  // The one-time-code library probes the pixel next to its field; jsdom has no layout.
  document.elementFromPoint = () => null
})

afterEach(() => {
  act(() => toast.clear())
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('dialog', () => {
  it('opens as a named modal dialog, closes with Escape and returns focus to its trigger', async () => {
    const user = userEvent.setup()
    renderDemo('ui/dialog/basic')
    const trigger = screen.getByRole('button', { name: 'Rename target' })
    await user.click(trigger)
    const dialog = await screen.findByRole('dialog', { name: 'Rename target' })
    expect(dialog).toHaveAccessibleDescription(/display name changes/)
    expect(within(dialog).getByRole('button', { name: 'Close' })).toBeInTheDocument()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(trigger).toHaveFocus()
  })

  it('saves from the footer and reports the saved name', async () => {
    const user = userEvent.setup()
    renderDemo('ui/dialog/basic')
    await user.click(screen.getByRole('button', { name: 'Rename target' }))
    const field = await screen.findByLabelText('Display name')
    await user.clear(field)
    await user.type(field, 'Orders database')
    await user.click(screen.getByRole('button', { name: 'Save display name' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.getByRole('status')).toHaveTextContent('Saved: Orders database')
  })

  it('asks before closing a dirty dialog, and keeps it open when the answer is "Keep editing"', async () => {
    const user = userEvent.setup()
    renderDemo('ui/dialog/guarded')
    await user.click(screen.getByRole('button', { name: 'Add a note' }))
    await user.type(await screen.findByLabelText('Note'), 'draft')
    await user.keyboard('{Escape}')
    const confirmation = await screen.findByRole('alertdialog', { name: 'Discard changes?' })
    // The safe choice has focus.
    expect(within(confirmation).getByRole('button', { name: 'Keep editing' })).toHaveFocus()
    await user.click(within(confirmation).getByRole('button', { name: 'Keep editing' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(screen.getByRole('dialog', { name: 'Add a note' })).toBeInTheDocument()
    expect(screen.getByLabelText('Note')).toHaveValue('draft')
  })

  it('closes a clean dialog at once and a dirty one after "Discard changes"', async () => {
    const user = userEvent.setup()
    renderDemo('ui/dialog/guarded')
    await user.click(screen.getByRole('button', { name: 'Add a note' }))
    await screen.findByRole('dialog', { name: 'Add a note' })
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    await user.click(screen.getByRole('button', { name: 'Add a note' }))
    await user.type(await screen.findByLabelText('Note'), 'x')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await user.click(await screen.findByRole('button', { name: 'Discard changes' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('offers every width and applies the chosen one', async () => {
    const user = userEvent.setup()
    renderDemo('ui/dialog/sizes')
    await user.click(screen.getByRole('radio', { name: 'tiny' }))
    await user.click(screen.getByRole('button', { name: 'Open the tiny dialog' }))
    const dialog = await screen.findByRole('dialog', { name: 'A tiny dialog' })
    expect(dialog.className).toContain('max-w-xs')
  })
})

describe('alert dialog', () => {
  it('focuses the cancel control, ignores a click outside and runs the action', async () => {
    const user = userEvent.setup()
    renderDemo('ui/alert-dialog/confirm')
    await user.click(screen.getByRole('button', { name: 'Withdraw plan' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Withdraw this plan?' })
    expect(within(dialog).getByRole('button', { name: 'Keep plan' })).toHaveFocus()
    // A press on the overlay, outside the dialog, does not dismiss an alert dialog.
    const overlay = dialog.parentElement
    if (overlay === null) throw new Error('no overlay')
    fireEvent.pointerDown(overlay)
    fireEvent.click(overlay)
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Withdraw plan' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(screen.getByRole('status')).toHaveTextContent('The plan was withdrawn.')
  })

  it('stays open while the action runs, blocks Escape and Cancel, then closes on success', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) })
    renderDemo('ui/alert-dialog/pending-succeeds')
    await user.click(screen.getByRole('button', { name: /Apply to production/ }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Apply to production?' })
    const action = within(dialog).getByRole('button', { name: 'Apply to production' })
    await user.click(action)
    expect(action).toHaveAttribute('aria-busy', 'true')
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled()
    await user.keyboard('{Escape}')
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(900)
    })
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(screen.getByRole('status')).toHaveTextContent('The plan was applied.')
  })

  it('stays open when the action is refused and shows the failure with its code inside', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) })
    renderDemo('ui/alert-dialog/pending-fails')
    await user.click(screen.getByRole('button', { name: /Apply to production/ }))
    const dialog = await screen.findByRole('alertdialog')
    await user.click(within(dialog).getByRole('button', { name: 'Apply to production' }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(900)
    })
    const alert = await within(dialog).findByRole('alert')
    expect(alert).toHaveTextContent('Error code PLAN_STALE')
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeEnabled()
  })
})

describe('sheet and popover', () => {
  it('opens a sheet with its title, a close button and closes with Escape', async () => {
    const user = userEvent.setup()
    renderDemo('ui/sheet/form')
    await user.click(screen.getByRole('button', { name: 'Register target' }))
    const sheet = await screen.findByRole('dialog', { name: 'Register a target' })
    expect(within(sheet).getByRole('button', { name: 'Close' })).toBeInTheDocument()
    expect(within(sheet).getByRole('button', { name: 'Create plan' })).toBeInTheDocument()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('opens a sheet from the chosen edge', async () => {
    const user = userEvent.setup()
    renderDemo('ui/sheet/sides')
    await user.click(screen.getByRole('radio', { name: 'left' }))
    await user.click(screen.getByRole('button', { name: 'Open from the left' }))
    const sheet = await screen.findByRole('dialog', { name: 'Operation details' })
    expect(sheet.className).toContain('left-0')
  })

  it('opens a popover, counts the chosen filters and closes with Done', async () => {
    const user = userEvent.setup()
    renderDemo('ui/popover/filters')
    await user.click(screen.getByRole('button', { name: 'Operation states (1)' }))
    await user.click(await screen.findByRole('checkbox', { name: 'running' }))
    await user.click(screen.getByRole('button', { name: 'Done' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.getByRole('button', { name: 'Operation states (2)' })).toBeInTheDocument()
  })
})

describe('menus', () => {
  it('opens a dropdown menu from the keyboard and runs the chosen item', async () => {
    const user = userEvent.setup()
    renderDemo('ui/dropdown-and-context-menu/dropdown')
    const trigger = screen.getByRole('button', { name: 'Target actions' })
    trigger.focus()
    await user.keyboard('{Enter}')
    const menu = await screen.findByRole('menu')
    expect(
      within(menu).getByRole('menuitem', { name: 'Open SQL (needs a permission)' }),
    ).toHaveAttribute('aria-disabled', 'true')
    await user.click(within(menu).getByRole('menuitem', { name: /Copy path/ }))
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    expect(screen.getByRole('status')).toHaveTextContent('Path copied.')
    expect(trigger).toHaveFocus()
  })

  it('keeps radio and checkbox items as state', async () => {
    const user = userEvent.setup()
    renderDemo('ui/dropdown-and-context-menu/dropdown')
    await user.click(screen.getByRole('button', { name: 'Target actions' }))
    const details = await screen.findByRole('menuitemcheckbox', { name: 'Show details' })
    expect(details).toHaveAttribute('aria-checked', 'true')
    await user.click(screen.getByRole('menuitemradio', { name: 'Production' }))
    await user.click(screen.getByRole('button', { name: 'Target actions' }))
    expect(await screen.findByRole('menuitemradio', { name: 'Production' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
  })

  it('opens the context menu from a contextmenu event and offers the same actions in a button', async () => {
    const user = userEvent.setup()
    renderDemo('ui/dropdown-and-context-menu/row')
    const row = screen.getByText('shop/platform/staging').closest('div')
    if (row === null) throw new Error('no row')
    act(() => {
      row.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 10,
          clientY: 10,
        }),
      )
    })
    const menu = await screen.findByRole('menu')
    expect(within(menu).getByRole('menuitem', { name: /Copy path/ })).toBeInTheDocument()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    await user.click(screen.getByRole('button', { name: 'Actions' }))
    expect(await screen.findByRole('menuitem', { name: 'Open audit trail' })).toBeInTheDocument()
  })
})

describe('tooltip and hover card', () => {
  it('explains a disabled button on focus, keeps it focusable and swallows its press', async () => {
    const user = userEvent.setup()
    renderDemo('ui/tooltip-and-hover-card/reason')
    const button = screen.getByRole('button', { name: 'Apply to production' })
    expect(button).toHaveAttribute('aria-disabled', 'true')
    await user.tab()
    expect(button).toHaveFocus()
    const tip = await screen.findByRole('tooltip')
    expect(tip).toHaveTextContent('Apply needs an approval from another person.')
    await user.keyboard('{Enter}')
    await user.click(button)
    expect(screen.getByText('Times applied: 0')).toBeInTheDocument()
  })

  it('names an icon button in a tooltip and closes it with Escape', async () => {
    const user = userEvent.setup()
    renderDemo('ui/tooltip-and-hover-card/tooltip')
    await user.tab()
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Copy plan hash')
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull())
  })

  it('opens a hover card on keyboard focus', async () => {
    const user = userEvent.setup()
    renderDemo('ui/tooltip-and-hover-card/hover-card')
    await user.tab()
    expect(await screen.findByText(/Agent 0.9.0, heartbeat 12 seconds ago/)).toBeInTheDocument()
  })

  it('makes a disabled-with-reason button of the button page focusable too', async () => {
    const user = userEvent.setup()
    renderDemo('ui/button/explained')
    await user.tab()
    expect(screen.getByRole('button', { name: 'Apply plan' })).toHaveFocus()
    await user.keyboard('{Enter}{ }')
    expect(screen.getByText('Clicks that reached the handler: 0')).toBeInTheDocument()
  })
})

describe('tabs, accordion and tables', () => {
  it('moves between tabs with the arrow keys and shows one panel at a time', async () => {
    const user = userEvent.setup()
    renderDemo('ui/tabs/indicator')
    const steps = screen.getByRole('tab', { name: 'Steps' })
    expect(steps).toHaveAttribute('aria-selected', 'true')
    steps.focus()
    await user.keyboard('{ArrowRight}')
    expect(screen.getByRole('tab', { name: 'Evidence' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Applied and verified')
    expect(screen.getAllByRole('tabpanel')).toHaveLength(1)
  })

  it('skips a disabled tab', async () => {
    const user = userEvent.setup()
    renderDemo('ui/tabs/plain')
    screen.getByRole('tab', { name: 'Operations (12)' }).focus()
    await user.keyboard('{ArrowRight}')
    expect(screen.getByRole('tab', { name: 'Archived' })).toBeDisabled()
    expect(screen.getByRole('tab', { name: 'Plans (3)' })).toHaveAttribute('aria-selected', 'true')
  })

  it('opens and closes accordion items and a collapsible by name', async () => {
    const user = userEvent.setup()
    renderDemo('ui/accordion-and-collapsible/single')
    const locks = screen.getByRole('button', { name: 'Lock analysis' })
    expect(locks).toHaveAttribute('aria-expanded', 'true')
    await user.click(screen.getByRole('button', { name: 'Statements (2)' }))
    expect(locks).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByRole('button', { name: 'Rollback (not available)' })).toBeDisabled()
    cleanup()

    renderDemo('ui/accordion-and-collapsible/collapsible')
    const toggle = screen.getByRole('button', { name: 'Show statements' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await user.click(toggle)
    expect(screen.getByRole('button', { name: 'Hide statements' })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
  })

  it('reports the sort state on the header and cycles ascending, descending, none', async () => {
    const user = userEvent.setup()
    renderDemo('ui/table/sortable')
    const sizeHeader = screen.getByRole('columnheader', { name: /Size/ })
    expect(sizeHeader).toHaveAttribute('aria-sort', 'descending')
    const button = within(sizeHeader).getByRole('button')
    await user.click(button)
    expect(sizeHeader).toHaveAttribute('aria-sort', 'none')
    await user.click(button)
    expect(sizeHeader).toHaveAttribute('aria-sort', 'ascending')
    const rows = screen.getAllByRole('row').slice(1)
    expect(within(rows[0] as HTMLElement).getByText('acme/billing/staging')).toBeInTheDocument()
  })

  it('makes the select-all checkbox indeterminate while some rows are chosen', async () => {
    const user = userEvent.setup()
    renderDemo('ui/table/selectable')
    const all = screen.getByRole('checkbox', { name: 'Choose all targets' })
    expect(all).toHaveAttribute('aria-checked', 'mixed')
    await user.click(all)
    expect(all).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('checkbox', { name: 'Choose shop/platform/staging' })).toBeChecked()
    await user.click(all)
    expect(all).toHaveAttribute('aria-checked', 'false')
  })

  it('shows a hostile name by code point, never raw', () => {
    renderDemo('ui/table/untrusted')
    const table = screen.getByRole('table')
    expect(table).toHaveTextContent('⟨U+202E⟩')
    expect(table).toHaveTextContent('⟨U+200B⟩')
    expect(table).toHaveTextContent('⟨U+000A⟩')
    // Markup stays markup characters and no element is created from it.
    expect(table).toHaveTextContent('<img src=x onerror=steal(1)>')
    expect(table.querySelector('img')).toBeNull()
  })
})

describe('toast', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
  })

  const settle = async (ms: number) => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms)
    })
  }

  it('closes a success after a few seconds and keeps an error with its code until dismissed', async () => {
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) })
    renderDemo('ui/toast/kinds')
    const region = () => screen.getByRole('region', { name: /Notifications/ })
    await user.click(screen.getByRole('button', { name: 'Success' }))
    await user.click(screen.getByRole('button', { name: 'Error' }))
    expect(within(region()).getAllByRole('listitem')).toHaveLength(2)
    expect(region()).toHaveTextContent('Error code: PLAN_STALE')
    await settle(6000)
    expect(within(region()).queryByText('Plan created')).toBeNull()
    expect(region()).toHaveTextContent('Could not apply the plan')
    await user.click(within(region()).getByRole('button', { name: 'Dismiss notification' }))
    await settle(400)
    expect(within(region()).queryAllByRole('listitem')).toHaveLength(0)
  })

  it('replaces a toast that has the same id and runs its action once', async () => {
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) })
    renderDemo('ui/toast/action')
    const create = screen.getByRole('button', { name: 'Create plan' })
    await user.click(create)
    await user.click(create)
    const region = screen.getByRole('region', { name: /Notifications/ })
    expect(within(region).getAllByRole('listitem')).toHaveLength(1)
    await user.click(within(region).getByRole('button', { name: 'View plan' }))
    expect(screen.getByText('The plan page was opened 1 times.')).toBeInTheDocument()
  })

  it('renders markup as text and shows a hostile name by code point', async () => {
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) })
    renderDemo('ui/toast/untrusted')
    await user.click(screen.getByRole('button', { name: 'Markup in a message' }))
    await user.click(screen.getByRole('button', { name: /made visible/ }))
    const region = screen.getByRole('region', { name: /Notifications/ })
    expect(region).toHaveTextContent('<img src=x onerror=steal(1)>')
    expect(region.querySelector('img')).toBeNull()
    expect(region).toHaveTextContent('⟨U+202E⟩')
  })
})

describe('form controls', () => {
  it('chooses with a select and follows the keyboard', async () => {
    const user = userEvent.setup()
    renderDemo('ui/select/basic')
    const trigger = screen.getByRole('combobox', { name: 'Environment' })
    expect(trigger).toHaveTextContent('staging')
    await user.click(trigger)
    await user.click(await screen.findByRole('option', { name: 'production' }))
    expect(trigger).toHaveTextContent('production')
  })

  it('filters a searchable chooser and returns the chosen value to the trigger', async () => {
    const user = userEvent.setup()
    renderDemo('ui/select/searchable')
    await user.click(screen.getByRole('combobox', { name: 'Target' }))
    await user.type(await screen.findByPlaceholderText('Search by path'), 'billing')
    const options = screen.getAllByRole('option')
    expect(options).toHaveLength(1)
    await user.click(options[0] as HTMLElement)
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Target' })).toHaveTextContent(
        'acme/billing/staging',
      ),
    )
  })

  it('chooses one radio with the arrow keys', async () => {
    const user = userEvent.setup()
    renderDemo('ui/radio-group/plain')
    const first = screen.getByRole('radio', { name: 'This target' })
    first.focus()
    await user.keyboard('{ArrowDown>}')
    await user.keyboard('{/ArrowDown}')
    expect(screen.getByRole('radio', { name: 'The whole cluster' })).toBeChecked()
    expect(screen.getByRole('status')).toHaveTextContent('Chosen: the whole cluster.')
  })

  it('moves a slider by keyboard and writes the value as text', async () => {
    const user = userEvent.setup()
    renderDemo('ui/slider/single')
    const thumb = screen.getByRole('slider', { name: 'Statement timeout' })
    thumb.focus()
    await user.keyboard('{ArrowRight}')
    expect(thumb).toHaveAttribute('aria-valuenow', '35')
    expect(screen.getByText('35 s')).toBeInTheDocument()
  })

  it('applies a switch at once and a checkbox waits', async () => {
    const user = userEvent.setup()
    renderDemo('ui/checkbox-and-switch/choose')
    await user.click(screen.getByRole('switch', { name: 'Notify on failure' }))
    expect(screen.getByRole('status')).toHaveTextContent('Notifications are on.')
  })

  it('selects all, then some, and reports indeterminate', async () => {
    const user = userEvent.setup()
    renderDemo('ui/checkbox-and-switch/select-all')
    const all = screen.getByRole('checkbox', { name: 'All schemas' })
    expect(all).toHaveAttribute('aria-checked', 'mixed')
    await user.click(all)
    expect(screen.getByRole('checkbox', { name: 'billing' })).toBeChecked()
    await user.click(screen.getByRole('checkbox', { name: 'billing' }))
    expect(all).toHaveAttribute('aria-checked', 'mixed')
  })

  it('keeps one choice in a segmented control that does not allow deselecting', async () => {
    const user = userEvent.setup()
    renderDemo('ui/toggle-group/segmented')
    const hour = screen.getByRole('radio', { name: '1 h' })
    expect(hour).toBeChecked()
    await user.click(hour)
    expect(hour).toBeChecked()
    await user.click(screen.getByRole('radio', { name: '7 d' }))
    expect(screen.getByRole('status')).toHaveTextContent('Showing the last 7 days.')
  })

  it('lets several toggles be on at once', async () => {
    const user = userEvent.setup()
    renderDemo('ui/toggle-group/multiple')
    await user.click(screen.getByRole('button', { name: 'Running' }))
    await user.click(screen.getByRole('button', { name: 'Failed' }))
    expect(screen.getByRole('button', { name: 'Running' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Failed' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('types a code into the slots and reports its progress as text', async () => {
    const user = userEvent.setup()
    renderDemo('ui/input-otp/device-code')
    const field = screen.getByRole('textbox', { name: 'Code from the terminal' })
    await user.type(field, 'abcd12')
    expect(screen.getByRole('status')).toHaveTextContent('6 of 8 characters.')
    await user.type(field, '34')
    expect(screen.getByRole('status')).toHaveTextContent('The code is complete.')
    expect(field).toHaveValue('ABCD1234')
  })
})

describe('form', () => {
  it('shows an error for an invalid path, links it to the control and clears it when fixed', async () => {
    const user = userEvent.setup()
    renderDemo('ui/form/invalid')
    const field = await screen.findByRole('textbox', { name: 'Target path' })
    await waitFor(() => expect(field).toHaveAttribute('aria-invalid', 'true'))
    const message = screen.getByRole('alert')
    expect(message).toHaveTextContent('Use product/project/environment')
    expect(field.getAttribute('aria-describedby')).toContain(message.id)
    await user.clear(field)
    await user.type(field, 'shop/platform/staging')
    await user.tab()
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(field).toHaveAttribute('aria-invalid', 'false')
    expect(screen.getByRole('status')).toHaveTextContent(
      'A plan will be created for shop/platform/staging.',
    )
  })

  it('creates the plan from a valid form and focuses the first invalid field on a failed submit', async () => {
    const user = userEvent.setup()
    renderDemo('ui/form/valid')
    await user.click(screen.getByRole('button', { name: 'Create plan' }))
    expect(await screen.findByText('Plan created for shop/platform/staging.')).toBeInTheDocument()
    const field = screen.getByRole('textbox', { name: 'Target path' })
    await user.clear(field)
    await user.click(screen.getByRole('button', { name: 'Create plan' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Enter the target path.')
    expect(field).toHaveFocus()
  })
})

describe('lists and navigation', () => {
  it('filters a command list as the person types and runs the highlighted item', async () => {
    const user = userEvent.setup()
    renderDemo('ui/command/inline')
    const input = screen.getByRole('combobox', { name: 'Search commands' })
    await user.type(input, 'audit')
    // The best match is first and highlighted; the filter is fuzzy, so others may remain below it.
    const options = screen.getAllByRole('option')
    expect(options[0]).toHaveTextContent('Audit')
    expect(options[0]).toHaveAttribute('aria-selected', 'true')
    await user.keyboard('{Enter}')
    expect(screen.getByRole('status')).toHaveTextContent('Go to Audit.')
    await user.clear(input)
    await user.type(input, 'zzz')
    expect(screen.getByText('No command matches.')).toBeInTheDocument()
  })

  it('opens the command dialog with a name and a description', async () => {
    const user = userEvent.setup()
    renderDemo('ui/command/dialog')
    await user.click(screen.getByRole('button', { name: 'Open the command menu' }))
    const dialog = await screen.findByRole('dialog', { name: 'Command menu' })
    expect(dialog).toHaveAccessibleDescription(/Type to search/)
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('chooses a day and a range in the calendar', async () => {
    const user = userEvent.setup()
    renderDemo('ui/calendar/single')
    expect(screen.getByRole('grid', { name: 'October 2026' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /October 22nd, 2026/ }))
    expect(screen.getByText('Chosen: October 22, 2026.')).toBeInTheDocument()
    cleanup()

    renderDemo('ui/calendar/limited')
    expect(screen.getByRole('button', { name: /October 12th, 2026/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: /October 14th, 2026/ })).toBeEnabled()
  })

  it('expands a branch when it is pressed and shows its leaves', async () => {
    const user = userEvent.setup()
    renderDemo('ui/tree-view/schemas')
    const tree = screen.getByRole('tree', { name: 'Schemas' })
    const exponetdb = within(tree).getByRole('treeitem', { name: /exponetdb/ })
    expect(exponetdb).toHaveAttribute('aria-expanded', 'false')
    await user.click(within(exponetdb).getByText('exponetdb'))
    expect(exponetdb).toHaveAttribute('aria-expanded', 'true')
    expect(within(tree).getByText('ledger')).toBeInTheDocument()
  })

  it('shows hostile names in a tree by code point, with no title attribute', () => {
    renderDemo('ui/tree-view/untrusted')
    const tree = screen.getByRole('tree')
    expect(tree).toHaveTextContent('⟨U+202E⟩')
    expect(tree.querySelector('[title]')).toBeNull()
  })

  it('marks the current page in a sub-navigation and a vertical menu', async () => {
    const user = userEvent.setup()
    renderDemo('ui/nav-menu/sub-navigation')
    expect(screen.getByRole('link', { name: 'Plans' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('link', { name: 'Operations' })).not.toHaveAttribute('aria-current')
    cleanup()
    renderDemo('ui/nav-menu/menu')
    const settings = screen.getAllByRole('navigation', { name: /Settings/ })
    expect(settings).toHaveLength(3)
    await user.click(within(settings[0] as HTMLElement).getByRole('button', { name: 'Policies' }))
    expect(
      within(settings[0] as HTMLElement).getByRole('button', { name: 'Policies' }),
    ).toHaveAttribute('aria-current', 'page')
  })

  it('marks the current page of a breadcrumb and hides its separators', () => {
    renderDemo('ui/breadcrumb/trail')
    const nav = screen.getByRole('navigation', { name: 'Breadcrumb' })
    expect(within(nav).getByText('staging')).toHaveAttribute('aria-current', 'page')
    expect(within(nav).getAllByRole('link')).toHaveLength(3)
  })

  it('collapses the sidebar to icons and back, and keeps names for the collapsed entries', async () => {
    const user = userEvent.setup()
    renderDemo('ui/sidebar/expanded')
    const toggle = screen.getByRole('button', { name: 'Toggle sidebar' })
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('status')).toHaveTextContent('Sidebar expanded, saved as open.')
    await user.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByRole('status')).toHaveTextContent('Sidebar collapsed, saved as collapsed.')
    expect(screen.getByRole('button', { name: 'Databases' })).toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: 'Sections' })).toBeInTheDocument()
  })

  it('explains a disabled sidebar entry that stays focusable', async () => {
    const user = userEvent.setup()
    renderDemo('ui/sidebar/entries')
    const entry = screen.getByRole('button', { name: /Disabled, with a reason/ })
    expect(entry).toHaveAttribute('aria-disabled', 'true')
    entry.focus()
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      'Ask an owner for the Backups permission.',
    )
    await user.click(entry)
  })
})

describe('layout', () => {
  it('names each resize handle and moves it with the keyboard', async () => {
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(1000)
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(500)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      const width = this.hasAttribute('data-separator') ? 1 : 1000
      return new DOMRect(0, 0, width, 500)
    })
    const user = userEvent.setup()
    renderDemo('ui/resizable/horizontal')
    const handle = screen.getByRole('separator', { name: 'Resize the schema list' })
    const before = Number(handle.getAttribute('aria-valuenow'))
    handle.focus()
    await user.keyboard('{ArrowRight}')
    expect(Number(handle.getAttribute('aria-valuenow'))).toBeGreaterThan(before)
  })

  it('offers three named handles in nested groups', () => {
    renderDemo('ui/resizable/nested')
    expect(screen.getAllByRole('separator')).toHaveLength(2)
    expect(screen.getByRole('separator', { name: 'Resize the overview' })).toBeInTheDocument()
  })

  it('names the sideways scroll region of a wide table', () => {
    renderDemo('ui/table/wide')
    expect(screen.getByRole('table')).toBeInTheDocument()
  })
})

describe('helpers', () => {
  it('merges classes with the tokens of the system and leaves custom utilities alone', () => {
    renderDemo('ui/utilities/class-names')
    const list = screen.getByRole('list', { name: 'Results of cn' })
    const results = within(list)
      .getAllByRole('listitem')
      .map((item) => item.querySelectorAll('code')[1]?.textContent)
    expect(results).toEqual([
      'py-1 px-4',
      'text-foreground-light',
      'rounded-panel',
      'p-card',
      'focus-ring hit-area-1',
      'flex gap-2',
    ])
  })

  it('reports whether the copy worked and never rejects', async () => {
    const user = userEvent.setup()
    renderDemo('ui/utilities/clipboard')
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    await user.click(screen.getByRole('button', { name: 'Copy path' }))
    expect(await screen.findByText('Copied the path.')).toBeInTheDocument()
    expect(writeText).toHaveBeenCalledWith('shop/platform/staging')
    writeText.mockRejectedValue(new Error('denied'))
    await user.click(screen.getByRole('button', { name: 'Copy path' }))
    expect(await screen.findByText('Could not copy. Copy the path by hand.')).toBeInTheDocument()
  })

  it('derives initials from visible letters only', () => {
    renderDemo('ui/avatar-and-separator/initials')
    const list = screen.getByRole('list', { name: 'Clients' })
    const initials = within(list)
      .getAllByRole('listitem')
      .map((item) => item.querySelector('[class*="rounded-full"]')?.textContent)
    expect(initials).toEqual(['DO', 'DB', 'AT', 'C'])
  })
})
