import '@testing-library/jest-dom/vitest'
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { mockChartLayout } from '../../../../packages/ui-patterns/test/charts/layout.ts'
import { renderDemo } from './support.tsx'

afterEach(cleanup)
mockChartLayout()

const SLOW = { timeout: 4000 } as const

describe('the confirmation ladder', () => {
  it('opens a plain confirmation on its safe answer, runs the action once and closes', async () => {
    const user = userEvent.setup()
    renderDemo('ui-patterns/confirm-dialog/plain')
    await user.click(screen.getByRole('button', { name: 'Withdraw plan' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Withdraw this plan?' })
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus()
    const action = within(dialog).getByRole('button', { name: 'Withdraw plan' })
    await user.dblClick(action)
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull(), SLOW)
    expect(screen.getByRole('status')).toHaveTextContent('The plan was withdrawn.')
  })

  it('offers the milder action first and frames a production dialog', async () => {
    const user = userEvent.setup()
    renderDemo('ui-patterns/confirm-dialog/alternative')
    await user.click(screen.getByRole('button', { name: 'Stop session 4182' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Terminate session 4182?' })
    expect(dialog).toHaveAccessibleDescription(/Production/)
    expect(dialog).toHaveAccessibleDescription(/This changes a production target/)
    const buttons = within(dialog)
      .getAllByRole('button')
      .map((button) => button.textContent)
    expect(buttons).toEqual(['Close', 'Cancel the query', 'Terminate session'])
    await user.click(within(dialog).getByRole('button', { name: 'Cancel the query' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull(), SLOW)
    expect(screen.getByRole('status')).toHaveTextContent('The query of session 4182 was cancelled.')
  })

  it('keeps the dialog open with the message and the stable code when the server refuses', async () => {
    const user = userEvent.setup()
    renderDemo('ui-patterns/confirm-dialog/failure')
    await user.click(screen.getByRole('button', { name: 'Withdraw stale plan' }))
    const dialog = await screen.findByRole('alertdialog')
    await user.click(within(dialog).getByRole('button', { name: 'Withdraw plan' }))
    const failure = await within(dialog).findByText('The request failed', undefined, SLOW)
    expect(failure).toBeInTheDocument()
    expect(dialog).toHaveTextContent(
      'The target changed since the plan was made. Create a new plan.',
    )
    expect(within(dialog).getByText('PLAN_STALE')).toBeInTheDocument()
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
  })

  it('keeps a warning confirmation unavailable until every statement is ticked', async () => {
    const user = userEvent.setup()
    renderDemo('ui-patterns/warning-confirm-dialog/checklist')
    await user.click(screen.getByRole('button', { name: 'Revoke API key' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Revoke the API key ci-deploy?' })
    const action = within(dialog).getByRole('button', { name: 'Revoke API key' })
    expect(action).toHaveAttribute('aria-disabled', 'true')
    expect(action).toHaveAccessibleDescription('Tick each statement to continue (0 of 2 ticked).')
    const boxes = within(dialog).getAllByRole('checkbox')
    expect(boxes).toHaveLength(2)
    await user.click(boxes[0] as HTMLElement)
    expect(action).toHaveAttribute('aria-disabled', 'true')
    expect(action).toHaveAccessibleDescription('Tick each statement to continue (1 of 2 ticked).')
    await user.click(boxes[1] as HTMLElement)
    expect(action).not.toHaveAttribute('aria-disabled', 'true')
    await user.click(action)
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull(), SLOW)
    expect(screen.getByRole('status')).toHaveTextContent('The API key ci-deploy was revoked.')
  })

  it('needs the target path typed exactly, and says what is wrong', async () => {
    const user = userEvent.setup()
    renderDemo('ui-patterns/typed-confirm-dialog/target-path')
    await user.click(screen.getByRole('button', { name: 'Remove target' }))
    const dialog = await screen.findByRole('alertdialog')
    const field = within(dialog).getByRole('textbox')
    expect(field).toHaveFocus()
    const action = within(dialog).getByRole('button', { name: 'Remove target' })
    expect(action).toHaveAttribute('aria-disabled', 'true')

    await user.type(field, 'Shop/platform/production')
    await user.click(action)
    expect(dialog).toHaveTextContent('The text must match exactly, including upper and lower case.')
    expect(action).toHaveAttribute('aria-disabled', 'true')

    await user.clear(field)
    await user.type(field, 'shop/platform/production ')
    await user.click(action)
    expect(dialog).toHaveTextContent('Remove the space before or after the text.')

    await user.clear(field)
    await user.type(field, 'shop/platform/production{Enter}')
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull(), SLOW)
    expect(screen.getByRole('status')).toHaveTextContent('The registration was removed.')
  })

  it('marks a look-alike letter and does not accept the Latin text for it', async () => {
    const user = userEvent.setup()
    renderDemo('ui-patterns/typed-confirm-dialog/look-alike')
    await user.click(screen.getByRole('button', { name: 'Remove target with a look-alike path' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog).toHaveTextContent('1 character is marked')
    expect(dialog.querySelector('[data-marked="non-ascii"]')).toHaveTextContent('U+0430')
    const field = within(dialog).getByRole('textbox')
    await user.type(field, 'shop/platform/production')
    await user.click(within(dialog).getByRole('button', { name: 'Remove target' }))
    expect(dialog).toHaveTextContent('The text does not match. Type it exactly as shown.')
  })

  it('applies a standard plan on staging with the action alone', async () => {
    const user = userEvent.setup()
    renderDemo('ui-patterns/plan-confirm-dialog/standard')
    await user.click(screen.getByRole('button', { name: 'Apply to staging' }))
    const dialog = await screen.findByRole('alertdialog', {
      name: 'Apply this plan to shop/platform/staging?',
    })
    expect(within(dialog).queryByRole('textbox')).toBeNull()
    expect(dialog).toHaveTextContent('Non-production')
    expect(dialog).not.toHaveTextContent('This changes a production target')
    expect(dialog.querySelector('[data-tier="prod"]')).toBeNull()
    const action = within(dialog).getByRole('button', { name: 'Apply to staging' })
    expect(action).not.toHaveAttribute('aria-disabled', 'true')
    await user.click(action)
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull(), SLOW)
    expect(screen.getByRole('status')).toHaveTextContent(
      'Applied plan sha256:9b1e9b1e… to shop/platform/staging.',
    )
  })

  it('needs the target path for a high plan and shows the full hash', async () => {
    const user = userEvent.setup()
    renderDemo('ui-patterns/plan-confirm-dialog/high')
    await user.click(screen.getByRole('button', { name: 'Apply to production' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog).toHaveTextContent('This changes a production target')
    expect(dialog.querySelector('[data-tier="prod"]')).not.toBeNull()
    expect(dialog).toHaveTextContent(`sha256:${'9b1e'.repeat(16)}`)
    const action = within(dialog).getByRole('button', { name: 'Apply to production' })
    expect(action).toHaveAttribute('aria-disabled', 'true')
    expect(within(dialog).getAllByRole('textbox')).toHaveLength(1)
    await user.type(within(dialog).getByRole('textbox'), 'shop/platform/production')
    expect(action).not.toHaveAttribute('aria-disabled', 'true')
  })

  it('needs the path and the effect for a critical plan', async () => {
    const user = userEvent.setup()
    renderDemo('ui-patterns/plan-confirm-dialog/critical')
    await user.click(screen.getByRole('button', { name: 'Apply critical plan' }))
    const dialog = await screen.findByRole('alertdialog')
    const [path, effect] = within(dialog).getAllByRole('textbox') as HTMLElement[]
    expect(within(dialog).getAllByRole('textbox')).toHaveLength(2)
    const action = within(dialog).getByRole('button', { name: 'Apply to production' })
    await user.type(path as HTMLElement, 'shop/platform/production')
    expect(action).toHaveAttribute('aria-disabled', 'true')
    await user.type(effect as HTMLElement, 'replaces placement of shop/platform/production')
    expect(action).not.toHaveAttribute('aria-disabled', 'true')
  })
})

describe('charts', () => {
  it('lists a gap with its cause and draws no value for it', () => {
    renderDemo('ui-patterns/time-series-chart/line-with-gap')
    const figure = screen.getByRole('figure', { name: 'query latency' })
    expect(figure).toHaveTextContent('Gaps: nothing was sampled, so no line is drawn across them')
    expect(figure).toHaveTextContent('p95 latency (ms): no samples: node agent offline')
    expect(figure).toHaveAccessibleDescription(/2 series, 24 points/)
    expect(figure).toHaveAccessibleDescription(/1 gap where nothing was sampled/)
  })

  it('opens the data table with the same numbers and the cause of a missing one', async () => {
    const user = userEvent.setup()
    renderDemo('ui-patterns/time-series-chart/line-with-gap')
    await user.click(screen.getByRole('button', { name: 'Show data as table' }))
    const region = screen.getByRole('region', { name: 'query latency, data table' })
    expect(within(region).getAllByRole('row')).toHaveLength(25)
    expect(region).toHaveTextContent('No data: no samples: node agent offline')
  })

  it('shows a failed chart as a failure and never as an empty chart', () => {
    renderDemo('ui-patterns/time-series-chart/failed')
    expect(screen.getByRole('alert')).toHaveTextContent('query latency could not be read')
    expect(screen.getByRole('alert')).toHaveTextContent('This does not mean there is no data.')
    expect(screen.queryByRole('figure')).toBeNull()
    expect(screen.queryByText('No data in this period')).toBeNull()
  })

  it('says stale, loading and empty in their own words', () => {
    const stale = renderDemo('ui-patterns/time-series-chart/stale')
    expect(screen.getByText('Stale data')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeInTheDocument()
    stale.unmount()
    const loading = renderDemo('ui-patterns/time-series-chart/loading')
    expect(screen.getByRole('status')).toHaveTextContent('Loading query latency')
    loading.unmount()
    renderDemo('ui-patterns/time-series-chart/empty')
    expect(screen.getByText('No samples in this period')).toBeInTheDocument()
  })

  it('shows a series label with hidden characters as code points', () => {
    const { container } = renderDemo('ui-patterns/time-series-chart/hostile-label')
    expect(container.textContent).toContain('U+202E')
    expect(container.textContent).toContain('U+200B')
  })

  it('marks the total of a bar with an unread value as "at least"', () => {
    renderDemo('ui-patterns/stacked-breakdown/connections')
    const figure = screen.getByRole('figure', { name: 'connections by database' })
    expect(figure).toHaveTextContent('Not read: these totals are lower bounds, marked with ≥')
    expect(figure).toHaveTextContent(
      'reporting: Idle not read (the node agent did not report idle sessions)',
    )
    expect(figure).toHaveAccessibleDescription(
      /1 value was not read; those totals are lower bounds/,
    )
  })

  it('ranks the rows, shows "Not read" for a value that was not read and describes each trend', () => {
    renderDemo('ui-patterns/top-n-table/statements')
    const rows = screen.getAllByRole('row')
    expect(rows).toHaveLength(5)
    expect(within(rows[4] as HTMLElement).getByText('Not read')).toBeInTheDocument()
    expect(document.body).toHaveTextContent('2 of 8 samples missing')
    expect(document.body.textContent).toContain('U+202E')
  })

  it('opens the data table behind a chart from a button', async () => {
    const user = userEvent.setup()
    renderDemo('ui-patterns/chart-data-table/toggle')
    const toggle = screen.getByRole('button', { name: 'Show data as table' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await user.click(toggle)
    expect(screen.getByRole('button', { name: 'Hide data table' })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
    expect(
      screen.getByRole('region', { name: 'Connections by state, data table' }),
    ).toBeInTheDocument()
  })
})

describe('infrastructure cards and callouts', () => {
  it('names both versions in the skew warning and says when no heartbeat was received', () => {
    const skew = renderDemo('ui-patterns/node-card/version-skew')
    expect(screen.getByText('Version skew.').closest('[data-skew]')).toHaveAttribute(
      'data-skew',
      'older',
    )
    expect(document.body).toHaveTextContent(
      'The agent runs 1.3.9, which is older than the expected 1.4.2.',
    )
    skew.unmount()
    renderDemo('ui-patterns/node-card/no-heartbeat')
    expect(document.body).toHaveTextContent('No heartbeat received')
    expect(document.body).toHaveTextContent('No capabilities reported')
    expect(screen.getByText('Unknown')).toBeInTheDocument()
  })

  it('cuts the capability list and opens it with an explicit control', async () => {
    const user = userEvent.setup()
    renderDemo('ui-patterns/node-card/healthy')
    expect(
      within(screen.getByRole('list', { name: 'Capabilities' })).getAllByRole('listitem'),
    ).toHaveLength(5)
    await user.click(screen.getByRole('button', { name: 'Show all (10 capabilities)' }))
    expect(
      within(screen.getByRole('list', { name: 'Capabilities' })).getAllByRole('listitem'),
    ).toHaveLength(10)
  })

  it('shows what a node said about itself as marked text', () => {
    const { container } = renderDemo('ui-patterns/node-card/hostile')
    expect(container.textContent).toContain('⟨U+202E⟩')
    expect(container.textContent).toContain('⟨U+200B⟩')
  })

  it('announces only the destructive callout at once', () => {
    renderDemo('ui-patterns/admonition/types')
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(screen.getByRole('alert')).toHaveTextContent('This plan drops a table')
  })

  it('shows markup in an error reason as text', () => {
    const { container } = renderDemo('ui-patterns/error-display/hostile-reason')
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('script')).toBeNull()
    expect(container.textContent).toContain('<img src=x onerror=exfiltrate()>')
  })
})
