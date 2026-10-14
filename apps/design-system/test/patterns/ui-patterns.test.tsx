import '@testing-library/jest-dom/vitest'
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { renderDemo } from './support.tsx'

afterEach(cleanup)

describe('states', () => {
  it('shows a failed read as a failure, never as an empty list', () => {
    const { container } = renderDemo('ui-patterns/readable-view/failed')
    expect(screen.getByText('Could not read targets')).toBeInTheDocument()
    expect(screen.getByText('This does not mean there is no targets.')).toBeInTheDocument()
    expect(screen.getByText('TARGET_UNREACHABLE')).toBeInTheDocument()
    expect(screen.queryByText('Nothing to show')).toBeNull()
    expect(container.querySelector('[data-state="failed"]')).not.toBeNull()
  })

  it('shows empty only after a successful read, and never for a partial one', () => {
    const empty = renderDemo('ui-patterns/readable-view/empty')
    expect(screen.getByText('Nothing to show')).toBeInTheDocument()
    expect(screen.getByText('The read succeeded and found no targets.')).toBeInTheDocument()
    empty.unmount()
    renderDemo('ui-patterns/readable-view/partial')
    expect(screen.getByText('Showing part of targets')).toBeInTheDocument()
    expect(screen.queryByText('Nothing to show')).toBeNull()
    expect(screen.getByText(/the node agent did not answer/)).toBeInTheDocument()
  })

  it('keeps the value of a stale read under a banner that names the reason and the code', () => {
    renderDemo('ui-patterns/readable-view/stale-refresh-failed')
    expect(screen.getByText('Showing an earlier read of targets')).toBeInTheDocument()
    expect(
      screen.getByText(/Could not refresh: The target did not answer in time/),
    ).toBeInTheDocument()
    expect(screen.getByText('shop/platform/staging')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeInTheDocument()
  })

  it('announces loading as one status', () => {
    renderDemo('ui-patterns/readable-view/loading')
    expect(screen.getByRole('status')).toHaveTextContent('Loading targets')
  })

  it('never invents a time: a bad value reads "time unknown" and a future one is named', () => {
    renderDemo('ui-patterns/observed-time/ages')
    expect(screen.getByText('time unknown')).toBeInTheDocument()
    expect(screen.getByText('dated in the future')).toBeInTheDocument()
    expect(screen.getByText('just now')).toBeInTheDocument()
    expect(screen.getByText('8 min ago (2026-10-13 11:52 UTC)')).toBeInTheDocument()
  })

  it('names what is missing in a state that is neither an error nor empty', () => {
    renderDemo('ui-patterns/named-states/not-permitted')
    expect(screen.getByText('You do not have access to the backup inventory')).toBeInTheDocument()
    expect(screen.getByText('backups.read')).toBeInTheDocument()
    expect(screen.getByText('data.read:prod')).toBeInTheDocument()
  })
})

describe('badges', () => {
  it('treats anything but nonprod as production, and never lets a name decide', () => {
    renderDemo('ui-patterns/tier-chip/tiers')
    const chips = Array.from(document.querySelectorAll('[data-tier]'))
    // prod, prod+production, prod+live, nonprod, nonprod+staging, nonprod+prod, unknown tier
    expect(chips.map((chip) => chip.getAttribute('data-tier'))).toEqual([
      'production',
      'production',
      'production',
      'nonprod',
      'nonprod',
      'nonprod',
      'production',
    ])
    expect(chips[5]).toHaveTextContent('prod')
    expect(chips[5]).not.toHaveTextContent('Production')
  })

  it('shows a hidden character of an environment name by its code point', () => {
    renderDemo('ui-patterns/tier-chip/hostile-name')
    const chip = document.querySelector('[data-tier]')
    expect(chip).toHaveTextContent('⟨U+202E⟩')
    expect(chip).toHaveTextContent('⟨U+200B⟩')
  })

  it('explains a state badge with its source and age on focus', async () => {
    const user = userEvent.setup()
    renderDemo('ui-patterns/state-badge/with-source')
    await user.tab()
    expect(await screen.findByRole('tooltip')).toHaveTextContent('live, 4 min ago')
  })

  it('shows a class this version does not know by its name', () => {
    renderDemo('ui-patterns/classification-badge/classes')
    expect(screen.getByText('partition_move')).toBeInTheDocument()
    expect(screen.getByText('Destructive')).toBeInTheDocument()
  })
})

describe('untrusted content', () => {
  it('shows hidden characters of SQL by code point and keeps everything as text', () => {
    const { container } = renderDemo('ui-patterns/untrusted-text/hostile-sql')
    const text = container.textContent ?? ''
    expect(text).toContain('⟨U+202E⟩')
    expect(text).toContain('⟨U+200B⟩')
    expect(text).toContain('⟨U+2066⟩')
    expect(text).toMatch(/hidden characters shown as code points/)
    expect(container.querySelector('[data-segment="tab"]')).not.toBeNull()
  })

  it('cuts a long value and opens it with an explicit control', async () => {
    const user = userEvent.setup()
    const { container } = renderDemo('ui-patterns/untrusted-text/long-value')
    expect((container.textContent ?? '').match(/insert into/g)).toHaveLength(6)
    await user.click(
      screen.getByRole('button', { name: /Show all \([\d,]+ characters\) of SQL text/ }),
    )
    expect((container.textContent ?? '').match(/insert into/g)).toHaveLength(24)
  })

  it('renders markup as text and creates no element from it', () => {
    const { container } = renderDemo('ui-patterns/untrusted-text/markup')
    expect(container.textContent).toContain('<a href="/targets">click</a>')
    expect(container.querySelector('a')).toBeNull()
    expect(container.querySelector('b')).toBeNull()
  })

  it('marks a look-alike letter of a target path', () => {
    const { container } = renderDemo('ui-patterns/marked-code/target-path')
    const marked = container.querySelectorAll('[data-marked="non-ascii"]')
    expect(marked).toHaveLength(1)
    expect(marked[0]).toHaveTextContent('U+0430')
    expect(container.querySelectorAll('[data-marked="hidden"]')).toHaveLength(1)
  })

  it('shows a marker on a client name nobody checked', () => {
    renderDemo('ui-patterns/untrusted-name/names')
    expect(screen.getByText('name not verified')).toBeInTheDocument()
    expect(screen.getByText('(empty)')).toBeInTheDocument()
  })
})

describe('records', () => {
  it('gives each outcome a word and shows the stable code of a failure', () => {
    renderDemo('ui-patterns/event-row/outcomes')
    const rows = screen.getAllByRole('listitem')
    expect(rows.map((row) => row.getAttribute('data-outcome'))).toEqual([
      'succeeded',
      'failed',
      'denied',
      'pending',
    ])
    expect(rows[1]).toHaveTextContent('PLAN_STALE')
    expect(rows[2]).toHaveTextContent('AGENT_CANNOT_APPROVE')
    expect(within(rows[0] as HTMLElement).getAllByRole('link')).toHaveLength(2)
  })

  it('leaves out a link that is not an app path and marks the client', () => {
    const { container } = renderDemo('ui-patterns/event-row/hostile-names')
    expect(screen.queryAllByRole('link')).toHaveLength(0)
    expect(container).toHaveTextContent('name not verified')
    expect(container).toHaveTextContent('⟨U+202E⟩')
  })

  it('announces a broken chain as an alert and a failed read as neither intact nor broken', () => {
    const broken = renderDemo('ui-patterns/chain-verification/broken')
    expect(screen.getByRole('alert')).toHaveTextContent('Chain broken at sequence 9,120')
    broken.unmount()
    renderDemo('ui-patterns/chain-verification/failed-read')
    expect(screen.getByRole('alert')).toHaveTextContent(
      'This does not mean the chain is intact or broken.',
    )
  })
})

describe('forms', () => {
  it('links the error to its control and exposes it only while the field has one', async () => {
    renderDemo('ui-patterns/form-layout/error')
    const input = screen.getByRole('textbox', { name: 'Target name' })
    expect(input).toBeInvalid()
    expect(input).toHaveAccessibleDescription(/Lowercase letters, digits and dashes\./)
    expect(input).toHaveAccessibleDescription(/starting with a letter/)
    expect(screen.getByRole('alert')).toHaveTextContent('Use lowercase letters')
  })

  it('shows the error of the schema on the field of a react-hook-form form', async () => {
    renderDemo('ui-patterns/form-item-layout/error')
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(
      'Use lowercase letters, digits and dashes, starting with a letter.',
    )
    expect(screen.getByRole('textbox', { name: 'Environment name' })).toBeInvalid()
  })

  it('saves a valid form and says so', async () => {
    const user = userEvent.setup()
    renderDemo('ui-patterns/form-item-layout/valid')
    expect(screen.queryByRole('alert')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Save environment' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Saved staging.'))
  })

  it('names every row control by its number and moves focus to a new row', async () => {
    const user = userEvent.setup()
    renderDemo('ui-patterns/key-value-field-array/labels')
    expect(screen.getByRole('list', { name: 'Labels' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Label name 2' })).toHaveValue('owner')
    expect(screen.getByRole('button', { name: 'Remove label 2' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Add label' }))
    expect(screen.getByRole('textbox', { name: 'Label name 3' })).toHaveFocus()
    await user.click(screen.getByRole('button', { name: 'Remove label 3' }))
    // The row above takes the focus; with no row left it goes to the add button.
    expect(screen.getByRole('textbox', { name: 'Label name 2' })).toHaveFocus()
    await user.click(screen.getByRole('button', { name: 'Remove label 2' }))
    await user.click(screen.getByRole('button', { name: 'Remove label 1' }))
    expect(screen.getByRole('button', { name: 'Add label' })).toHaveFocus()
  })

  it('shows a cell error for a missing and for a repeated name', async () => {
    renderDemo('ui-patterns/key-value-field-array/errors')
    await waitFor(() => expect(screen.getAllByRole('alert').length).toBeGreaterThan(0))
    const messages = screen.getAllByRole('alert').map((alert) => alert.textContent)
    expect(messages).toContain('Enter a label name.')
    expect(messages.filter((message) => message === 'Label names must be unique.')).toHaveLength(2)
  })

  it('keeps the last range and makes a row for each pasted value', async () => {
    const user = userEvent.setup()
    renderDemo('ui-patterns/single-value-field-array/ranges')
    await user.click(screen.getByRole('button', { name: 'Remove range 2' }))
    expect(screen.getByRole('button', { name: 'Remove range 1' })).toBeDisabled()
    await user.click(screen.getByRole('textbox', { name: 'Allowed range 1' }))
    await user.clear(screen.getByRole('textbox', { name: 'Allowed range 1' }))
    await user.paste('10.1.0.0/16, 10.2.0.0/16 10.3.0.0/16')
    expect(screen.getAllByRole('textbox')).toHaveLength(3)
  })

  it('asks before a changed form is left, with the safe answer in focus', async () => {
    const user = userEvent.setup()
    renderDemo('ui-patterns/dirty-guard/leave')
    await user.click(screen.getByRole('button', { name: 'Leave the form' }))
    // A clean form lets go at once.
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(screen.getByRole('status')).toHaveTextContent('You left the form')

    await user.type(screen.getByRole('textbox', { name: 'Project description' }), ' and more')
    await user.click(screen.getByRole('button', { name: 'Leave the form' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Discard changes?' })
    expect(within(dialog).getByRole('button', { name: 'Keep editing' })).toHaveFocus()
    await user.click(within(dialog).getByRole('button', { name: 'Keep editing' }))
    expect(screen.getByRole('status')).toHaveTextContent('You kept editing.')
    expect(screen.getByRole('textbox', { name: 'Project description' })).toHaveValue(
      'Orders and payments and more',
    )

    await user.click(screen.getByRole('button', { name: 'Leave the form' }))
    await user.click(await screen.findByRole('button', { name: 'Discard changes' }))
    expect(screen.getByRole('status')).toHaveTextContent('The changes were discarded.')
    expect(screen.getByRole('textbox', { name: 'Project description' })).toHaveValue(
      'Orders and payments',
    )
  })
})

describe('filter bar', () => {
  it('shows each condition as a chip with its own named remove button, and removes one', async () => {
    const user = userEvent.setup()
    renderDemo('ui-patterns/filter-bar/with-conditions')
    expect(screen.getByRole('group', { name: 'Filter targets' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Remove Tier filter' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Remove Tier filter' }))
    expect(screen.queryByRole('button', { name: 'Remove Tier filter' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Remove Health filter' })).toBeInTheDocument()
    expect(document.body).toHaveTextContent('health = degraded')
  })

  it('builds a condition from typed text and hands the page a structured value', async () => {
    const user = userEvent.setup()
    renderDemo('ui-patterns/filter-bar/empty')
    const search = screen.getByRole('combobox', { name: 'Add filter' })
    expect(search).toHaveAttribute('aria-expanded', 'false')
    await user.click(search)
    await user.keyboard('shop{Enter}')
    expect(document.body).toHaveTextContent('name = shop')
  })

  it('says "Could not load suggestions" when the page fails to load them', async () => {
    const user = userEvent.setup()
    renderDemo('ui-patterns/filter-bar/loaded-suggestions')
    await user.click(screen.getByRole('combobox', { name: 'Add filter' }))
    await user.keyboard('Node{Enter}{Enter}')
    await waitFor(() => expect(document.body).toHaveTextContent('Could not load suggestions'), {
      timeout: 3000,
    })
  })
})

describe('command menu and shortcuts', () => {
  it('opens with Control+K as a named dialog, filters, and hides a command the person may not run', async () => {
    const user = userEvent.setup()
    renderDemo('ui-patterns/command-menu/menu')
    await user.keyboard('{Control>}k{/Control}')
    const dialog = await screen.findByRole('dialog', { name: 'Command menu' })
    expect(within(dialog).getAllByRole('option').length).toBeGreaterThanOrEqual(5)
    expect(within(dialog).getByRole('option', { name: /Approve plan/ })).toBeInTheDocument()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    await user.click(screen.getByRole('switch', { name: 'This person may approve plans' }))
    await user.keyboard('{Control>}k{/Control}')
    const again = await screen.findByRole('dialog', { name: 'Command menu' })
    expect(within(again).queryByRole('option', { name: /Approve plan/ })).toBeNull()
    await user.keyboard('zzqqxx')
    expect(within(again).queryAllByRole('option')).toHaveLength(0)
    await user.clear(within(again).getByRole('combobox'))
    await user.keyboard('sha256')
    expect(within(again).getAllByRole('option')).toHaveLength(1)
    expect(within(again).getByRole('option', { name: /Copy plan hash/ })).toBeInTheDocument()
  })

  it('navigates through the seam and goes by the sequence G then P', async () => {
    const user = userEvent.setup()
    renderDemo('ui-patterns/command-menu/menu')
    await user.keyboard('gp')
    expect(screen.getByRole('status')).toHaveTextContent('The app would go to /changes/plans.')
    await user.keyboard('gt')
    expect(screen.getByRole('status')).toHaveTextContent('The app would go to /targets.')
  })

  it('lists the shortcuts that work on the page in the help, and can switch letters off', async () => {
    const user = userEvent.setup()
    renderDemo('ui-patterns/command-menu/menu')
    await user.keyboard('?')
    const dialog = await screen.findByRole('dialog', { name: 'Keyboard shortcuts' })
    expect(within(dialog).getByText('Go to plans')).toBeInTheDocument()
    expect(within(dialog).getByText('Open the command menu')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('switch', { name: 'Letter shortcuts' }))
    await user.keyboard('{Escape}')
    await user.keyboard('gp')
    expect(screen.getByRole('status')).not.toHaveTextContent('/changes/plans')
  })

  it('lists every shortcut with the words a screen reader hears', () => {
    renderDemo('ui-patterns/shortcuts/all')
    expect(screen.getByText('Control K')).toBeInTheDocument()
    expect(screen.getByText('G then P')).toBeInTheDocument()
    expect(
      screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent),
    ).toEqual(['General', 'Go to', 'Switch environment', 'SQL editor'])
  })
})
