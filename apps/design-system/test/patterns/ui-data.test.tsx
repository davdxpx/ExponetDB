import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  installAdoptedSheets,
  installLayoutStubs,
  shadowOf,
  viewOf,
} from '../../../../packages/ui-data/test/editor/support.ts'
import { renderDemo } from './support.tsx'

afterEach(cleanup)

const SLOW = { timeout: 4000 } as const

function cellAt(row: number, col: number): HTMLElement {
  const element = document.querySelector<HTMLElement>(
    `[data-exdb-r="${row}"][data-exdb-c="${col}"]`,
  )
  if (element === null) throw new Error(`no cell at ${row}:${col}`)
  return element
}

describe('data grid', () => {
  it('draws NULL, empty, masked and cut values differently and marks a hostile value', () => {
    const { container } = renderDemo('ui-data/data-grid/result')
    const grid = screen.getByRole('grid', { name: 'Result of the last query' })
    expect(grid).toHaveAttribute('aria-readonly', 'true')
    // The header row counts: 6 data rows and the header.
    expect(grid).toHaveAttribute('aria-rowcount', '7')
    expect(container).toHaveTextContent('6 rows, 7 columns')
    // Row 3 has no customer (NULL), row 4 has an empty string, row 6 was cut by the server.
    expect(cellAt(3, 1).querySelector('[data-cell="null"]')).not.toBeNull()
    expect(cellAt(4, 1).querySelector('[data-cell="empty"]')).not.toBeNull()
    expect(cellAt(4, 1).querySelector('[data-cell="null"]')).toBeNull()
    expect(cellAt(6, 1)).toHaveTextContent('cut, 48,210 characters')
    expect(cellAt(5, 1)).toHaveTextContent('⟨U+202E⟩')
    expect(cellAt(5, 1).textContent).not.toContain('\u{202E}')
    // Integers and numerics are right-aligned text.
    expect(cellAt(1, 3)).toHaveAttribute('data-align', 'end')
  })

  it('says a column is masked in its header', () => {
    renderDemo('ui-data/data-grid/result')
    const headers = screen.getAllByRole('columnheader')
    expect(headers.some((header) => header.textContent?.includes('masked'))).toBe(true)
  })

  it('shows a failed read as a failure and never as "No rows"', () => {
    renderDemo('ui-data/data-grid/failed')
    expect(screen.getByText('Could not read result rows')).toBeInTheDocument()
    expect(screen.getByText('QUERY_TIMEOUT')).toBeInTheDocument()
    expect(screen.queryByRole('grid')).toBeNull()
    expect(screen.queryByText(/No rows/)).toBeNull()
  })

  it('says the server cut the result', () => {
    renderDemo('ui-data/data-grid/server-cut')
    expect(screen.getByText('The server cut this result')).toBeInTheDocument()
    expect(document.body).toHaveTextContent('Reason: the 5,000 row limit')
  })

  it('has one tab stop and moves with the arrow keys, and opens the full value from the keyboard', async () => {
    const user = userEvent.setup()
    renderDemo('ui-data/data-grid/result')
    expect(document.querySelectorAll('[data-exdb-r][tabindex="0"]')).toHaveLength(1)
    cellAt(1, 0).focus()
    await user.keyboard('{ArrowRight}{ArrowDown}')
    expect(cellAt(2, 1)).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull(), SLOW)
  })

  it('asks the server to read in another order when a header is pressed', async () => {
    const user = userEvent.setup()
    renderDemo('ui-data/data-grid/sortable')
    const header = screen.getByRole('columnheader', { name: /^customer/ })
    expect(header).toHaveAttribute('aria-sort', 'none')
    await user.click(within(header).getByRole('button'))
    await waitFor(() =>
      expect(screen.getByRole('columnheader', { name: /^customer/ })).toHaveAttribute(
        'aria-sort',
        'ascending',
      ),
    )
  })

  it('loads more rows only when the button is pressed', async () => {
    const user = userEvent.setup()
    renderDemo('ui-data/data-grid/paged')
    expect(document.body).toHaveTextContent('3 rows loaded, 7 columns')
    expect(document.body).toHaveTextContent('More rows are available.')
    await user.click(screen.getByRole('button', { name: 'Load more rows' }))
    await waitFor(() => expect(document.body).toHaveTextContent('6 rows loaded, 7 columns'), SLOW)
    expect(document.body).toHaveTextContent('All rows are loaded.')
    expect(screen.queryByRole('button', { name: 'Load more rows' })).toBeNull()
  })
})

describe('editors', () => {
  beforeAll(() => {
    installLayoutStubs()
    installAdoptedSheets()
  })

  function viewIn(container: HTMLElement): ReturnType<typeof viewOf> {
    return viewOf(shadowOf(container))
  }

  it('mounts the query editor in a shadow root and calls the page on Control+Enter', () => {
    const { container } = renderDemo('ui-data/sql-editor/query')
    const view = viewIn(container)
    expect(container.querySelector('.cm-editor')).toBeNull()
    expect(view.contentDOM).toHaveAttribute('aria-label', 'Query')
    fireEvent.keyDown(view.contentDOM, { key: 'Enter', ctrlKey: true })
    expect(screen.getByRole('status')).toHaveTextContent('The page would ask the server')
    // The editor itself ran nothing and kept the text.
    expect(view.state.doc.toString()).toContain('select id, status, total')
  })

  it('lists the findings of the server under the draft and marks the lines', () => {
    const { container } = renderDemo('ui-data/sql-editor/draft')
    const view = viewIn(container)
    const root = shadowOf(container)
    const group = root.querySelector('[aria-label="Problems"]')
    expect(group).not.toBeNull()
    expect(group).toHaveTextContent('3 problems: 1 error, 1 warning, 1 info')
    expect(group).toHaveTextContent('CREATE INDEX blocks writes to orders.')
    expect(view.contentDOM).toHaveAttribute('aria-invalid', 'true')
  })

  it('shows hidden characters of a read-only statement by code point and cannot be edited', () => {
    const { container } = renderDemo('ui-data/sql-editor/readonly')
    const view = viewIn(container)
    expect(view.contentDOM).toHaveAttribute('aria-readonly', 'true')
    expect(view.contentDOM).toHaveAttribute('tabindex', '0')
    const root = shadowOf(container)
    expect(root.textContent).toContain('U+202E')
    expect(root.textContent).toContain('U+200B')
    expect(view.state.doc.toString()).toContain('\u{202E}')
  })

  it('compares two read-only sides and names each', () => {
    const { container } = renderDemo('ui-data/text-diff/migration')
    expect(screen.getByRole('group', { name: 'up.sql: draft against applied' })).toBeInTheDocument()
    const root = shadowOf(container)
    const sides = Array.from(root.querySelectorAll('.cm-content'))
    expect(sides.map((side) => side.getAttribute('aria-label'))).toEqual([
      'Applied, read-only text',
      'Draft, read-only text',
    ])
    expect(sides.every((side) => side.getAttribute('contenteditable') === 'false')).toBe(true)
  })

  it('loads the viewer behind a read, and shows a failed read without a comparison', async () => {
    const ready = renderDemo('ui-data/readable-text-diff/ready')
    await waitFor(
      () => expect(ready.container.querySelector('[data-exdb-editor="diff"]')).not.toBeNull(),
      SLOW,
    )
    ready.unmount()
    renderDemo('ui-data/readable-text-diff/failed')
    expect(screen.getByText('Could not read migration text')).toBeInTheDocument()
    expect(document.querySelector('[data-exdb-editor]')).toBeNull()
    expect(screen.queryByText('No differences')).toBeNull()
  })
})

describe('plan review', () => {
  it('frames a production plan and repeats the cue on every block, in the order of the page', () => {
    const { container } = renderDemo('ui-data/plan-frame/production-page')
    const frame = container.querySelector('[data-plan-frame]')
    expect(frame).toHaveAttribute('data-tier', 'production')
    const titles = Array.from(frame?.querySelectorAll('[data-plan-block]') ?? []).map((block) =>
      block.getAttribute('data-plan-block'),
    )
    expect(titles).toEqual([
      'summary',
      'steps',
      'analysis',
      'evidence',
      'policy',
      'approvals',
      'outcome',
      'raw',
    ])
    // The server's facts come first and the raw text last.
    const computed = container.querySelector('[data-review-part="computed"]')
    expect(computed).not.toBeNull()
    expect(computed?.nextElementSibling).toHaveTextContent('What the plan runs')
    for (const block of frame?.querySelectorAll('[data-plan-block]') ?? []) {
      expect(
        block.querySelector('[data-production-cue]'),
        block.getAttribute('data-plan-block') ?? '',
      ).not.toBeNull()
    }
  })

  it('adds no frame and no cue to a non-production plan', () => {
    const { container } = renderDemo('ui-data/plan-frame/nonproduction')
    expect(container.querySelector('[data-plan-frame]')).toHaveAttribute('data-tier', 'nonprod')
    expect(container.querySelector('[data-production-cue]')).toBeNull()
  })

  it('counts down to the expiry of an active plan and offers the actions', () => {
    renderDemo('ui-data/plan-summary/active')
    expect(screen.getByText(/Expires in 10 min 00 s/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Apply to production' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Withdraw plan' })).toBeInTheDocument()
    expect(screen.getByText('Coding assistant')).toBeInTheDocument()
    expect(screen.getByText('name not verified')).toBeInTheDocument()
  })

  it('says "Expired" for an expired plan and offers no action', () => {
    renderDemo('ui-data/plan-summary/expired')
    expect(screen.getByText('Expired')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Apply to production' })).toBeNull()
    expect(document.body).toHaveTextContent(
      'This plan expired. Create a new plan to make this change.',
    )
  })

  it('says "not known" for every missing fact and offers no action', () => {
    const { container } = renderDemo('ui-data/plan-summary/unknown-values')
    expect(container.querySelectorAll('[data-not-known]').length).toBeGreaterThanOrEqual(9)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('distinguishes steps that are not known from a plan with no steps', () => {
    renderDemo('ui-data/plan-steps/not-known')
    expect(document.body).toHaveTextContent('not known')
    expect(screen.queryAllByRole('listitem')).toHaveLength(0)
  })

  it('names the disagreement between declared and observed compatibility and what is dropped', () => {
    renderDemo('ui-data/plan-analysis/migrations')
    expect(document.body).toHaveTextContent('(they disagree)')
    expect(document.body).toHaveTextContent('public.orders_archive')
    expect(document.body).toHaveTextContent('None: a failure is not undone automatically')
  })

  it('says what evidence is missing and what a break-glass grant overrides', () => {
    renderDemo('ui-data/plan-evidence/break-glass')
    expect(document.body).toHaveTextContent(
      'Missing: not applied and verified with the same checksum',
    )
    expect(document.body).toHaveTextContent('prod.requires-staging-evidence')
    expect(document.body).toHaveTextContent('(not verified by a restore test)')
  })

  it('shows requirements, and a rule that could not be evaluated as such', () => {
    renderDemo('ui-data/policy-decision/require')
    expect(document.body).toHaveTextContent('Allow with requirements')
    expect(document.body).toHaveTextContent('1 approval by a person with plans.approve')
    expect(document.body).toHaveTextContent('could not be evaluated')
  })

  it('shows a denial as a denial', () => {
    renderDemo('ui-data/policy-decision/deny')
    expect(document.body).toHaveTextContent('The policy denies this plan. It cannot be applied.')
  })

  it('notes that an agent proposed the plan and binds the decision to the hash on screen', () => {
    const { container } = renderDemo('ui-data/approvals/agent-proposed')
    expect(
      screen.getByText('An agent proposed this plan; it cannot approve it.'),
    ).toBeInTheDocument()
    const hash = `sha256:${'5c8d'.repeat(16)}`
    expect(container.querySelector('[data-full-hash]')?.textContent).toBe(hash)
    expect(screen.getByRole('button', { name: 'Approve plan' })).toHaveAttribute(
      'data-plan-hash',
      hash,
    )
  })

  it('offers no decision to a person the server says cannot approve', () => {
    renderDemo('ui-data/approvals/not-eligible')
    expect(document.body).toHaveTextContent('You made this plan; another person approves it.')
    expect(screen.queryByRole('button', { name: 'Approve plan' })).toBeNull()
  })

  it('shows applied and verified as two indicators and never calls applied a success', () => {
    const { container } = renderDemo('ui-data/apply-verify/applied-pending')
    expect(container.querySelector('[data-indicator="apply"]')).toHaveTextContent(
      'Applied is not verified.',
    )
    expect(container.querySelector('[data-indicator="verification"]')).toHaveTextContent(
      'Verifying',
    )
    expect(container.querySelectorAll('[data-tone="done"]')).toHaveLength(0)
  })

  it('shows the only state that is done', () => {
    const { container } = renderDemo('ui-data/apply-verify/verified')
    expect(container.querySelectorAll('[data-tone="done"]')).toHaveLength(1)
    expect(container.querySelector('[data-indicator="verification"]')).toHaveAttribute(
      'data-tone',
      'done',
    )
  })

  it('offers "Verify again" only because the server accepts it', async () => {
    const user = userEvent.setup()
    renderDemo('ui-data/apply-verify/needs-attention')
    expect(document.body).toHaveTextContent(
      'Verify again once the target answers, or plan a recovery.',
    )
    await user.click(screen.getByRole('button', { name: 'Verify again' }))
  })

  it('shows the raw text as data, with hidden characters marked and the server facts before a statement', () => {
    const { container } = renderDemo('ui-data/raw-plan-text/files')
    expect(container.textContent).toContain('⟨U+202E⟩')
    // A visible letter of a right-to-left script is not hidden: it stays where it is stored, underlined.
    expect(container.querySelector('[data-segment="non-ascii"]')).toHaveTextContent('\u{05D0}')
    expect(container.querySelectorAll('[data-statement-start]')).toHaveLength(3)
    expect(container.querySelector('[data-statement-start="1"]')).toHaveTextContent(
      'Statement 2: DROP TABLE, lock ACCESS EXCLUSIVE, destructive',
    )
    expect(container).toHaveTextContent('characters that are not plain ASCII')
  })
})

describe('explain, diffs, tree, diagram and timeline', () => {
  it('names the most expensive node in words and the share of each node', () => {
    renderDemo('ui-data/explain-view/analyzed')
    expect(screen.getByText('Most expensive')).toBeInTheDocument()
    expect(document.body).toHaveTextContent("of the plan's own time")
    expect(document.body).toHaveTextContent('Row estimate is 14x too low.')
    expect(screen.getByRole('tab', { name: 'Raw JSON' })).toBeInTheDocument()
  })

  it('says what a plain EXPLAIN does not report instead of drawing zeros', () => {
    renderDemo('ui-data/explain-view/plain')
    expect(document.body).toHaveTextContent('Not reported: actual rows, loops, time, buffers.')
    expect(document.body).toHaveTextContent('Run EXPLAIN with ANALYZE to see actual rows and time.')
    expect(document.body).toHaveTextContent("Bars show each node's own cost")
  })

  it('shows a result that is not a plan as a failed read with the reason', () => {
    renderDemo('ui-data/explain-view/not-a-plan')
    expect(screen.getByText('INVALID_PLAN')).toBeInTheDocument()
    expect(document.body).toHaveTextContent('it has no "Plan" object')
  })

  it('marks hidden characters of a plan as code points', () => {
    const { container } = renderDemo('ui-data/explain-view/hostile')
    expect(container.textContent).toContain('⟨U+202E⟩')
    expect(container.textContent).toContain('⟨U+200B⟩')
  })

  it('classifies settings rows, folds unchanged ones and says "not set" for an absent value', async () => {
    const user = userEvent.setup()
    const { container } = renderDemo('ui-data/structured-diff/settings')
    expect(container).toHaveTextContent('1 added, 1 changed, 1 removed; 1 unchanged.')
    expect(
      Array.from(container.querySelectorAll('tr[data-change]')).map((row) =>
        row.getAttribute('data-change'),
      ),
    ).toEqual(['changed', 'added', 'removed'])
    expect(container).toHaveTextContent('not set')
    await user.click(screen.getByRole('button', { name: 'Show 1 unchanged row' }))
    expect(container.querySelectorAll('tr[data-change="unchanged"]')).toHaveLength(1)
  })

  it('says "not granted" for an absent grant', () => {
    renderDemo('ui-data/structured-diff/grants')
    expect(document.body).toHaveTextContent('not granted')
  })

  it('says "No differences" only after a successful read, and never for a failed one', () => {
    const same = renderDemo('ui-data/structured-diff/no-differences')
    expect(document.body).toHaveTextContent('No differences: all 1 row is the same.')
    same.unmount()
    renderDemo('ui-data/structured-diff/failed')
    expect(document.body).toHaveTextContent('Could not read settings')
    expect(document.body).not.toHaveTextContent('No differences')
  })

  it('groups the schema diff in dependency order and badges the classes', () => {
    const { container } = renderDemo('ui-data/schema-diff/by-object')
    expect(container).toHaveTextContent('7 objects: 3 added, 1 removed, 3 changed.')
    const order = Array.from(container.querySelectorAll('[data-object-type]')).map((group) =>
      group.getAttribute('data-object-type'),
    )
    expect(order).toEqual(['table', 'column', 'index', 'view', 'policy', 'publication'])
    expect(container.querySelectorAll('[data-classification]').length).toBeGreaterThanOrEqual(4)
    expect(container.textContent).toContain('⟨U+202E⟩')
  })

  it('says what is missing in a partial schema diff and never "No differences"', () => {
    renderDemo('ui-data/schema-diff/partial')
    expect(document.body).toHaveTextContent('Showing part of schema changes')
    expect(document.body).toHaveTextContent('functions: the catalog read for this schema timed out')
  })

  it('shows schemas as branches and a failed schema read as a failure', () => {
    const tree = renderDemo('ui-data/schema-tree/schemas')
    expect(
      screen.getByRole('tree', { name: 'Schemas of shop/platform/staging' }),
    ).toBeInTheDocument()
    expect(screen.getAllByRole('treeitem')).toHaveLength(3)
    tree.unmount()
    renderDemo('ui-data/schema-tree/failed')
    expect(screen.queryByRole('tree')).toBeNull()
    expect(document.body).toHaveTextContent('Could not read')
  })

  it('loads a branch when it opens, keeps a failed branch to itself and reports the selection', async () => {
    const user = userEvent.setup()
    renderDemo('ui-data/schema-tree/browse')
    const tree = screen.getByRole('tree')
    const publicBranch = within(tree).getByRole('treeitem', { name: /public/ })
    publicBranch.focus()
    await user.keyboard('{ArrowRight}')
    const tables = await within(tree).findByRole('treeitem', { name: /^Tables/ }, SLOW)
    await user.click(within(tables).getByText('Tables'))
    const orders = await within(tree).findByRole('treeitem', { name: /^orders$/ }, SLOW)
    await user.click(within(orders).getByText('orders'))
    await waitFor(
      () => expect(document.body).toHaveTextContent('Selected table orders in public.'),
      SLOW,
    )

    // One branch of another schema fails on its own; the rest of the tree keeps working.
    const billing = within(tree).getByRole('treeitem', { name: /^billing/ })
    await user.click(within(billing).getByText('billing'))
    const billingViews = await within(tree).findAllByRole('treeitem', { name: /^Views/ }, SLOW)
    await user.click(
      within(billingViews[billingViews.length - 1] as HTMLElement).getByText('Views'),
    )
    await waitFor(() => expect(document.body).toHaveTextContent('Could not read views'), SLOW)
    expect(within(tree).getByRole('treeitem', { name: /^orders$/ })).toBeInTheDocument()
  })

  it('draws the diagram of the schema with an accessible table view behind a switch', async () => {
    const user = userEvent.setup()
    renderDemo('ui-data/schema-erd/diagram')
    expect(document.body).toHaveTextContent('4 tables, 3 relations')
    await user.click(screen.getByRole('switch', { name: 'Show as table' }))
    expect(document.body).toHaveTextContent('order_items_sku_fkey')
  })

  it('shows only the table view when the schema is over the diagram limit, and says why', () => {
    renderDemo('ui-data/schema-erd/over-the-limit')
    expect(document.body).toHaveTextContent('more than the diagram limit of 2')
    expect(document.body).toHaveTextContent('Only the table view is shown.')
    expect(screen.queryByRole('toolbar', { name: 'Diagram zoom' })).toBeNull()
  })

  it('never draws a failed schema read as an empty diagram', () => {
    renderDemo('ui-data/schema-erd/failed')
    expect(document.body).toHaveTextContent('Could not read schema diagram')
    expect(screen.queryByRole('toolbar', { name: 'Diagram zoom' })).toBeNull()
  })

  it('puts the bundles in dependency order and gives every cell a word', () => {
    const { container } = renderDemo('ui-data/migration-timeline/stream')
    const table = screen.getByRole('table', { name: /Migration bundles in dependency order/ })
    const rows = within(table).getAllByRole('row').slice(1)
    expect(rows.map((row) => row.textContent)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('create_users'),
        expect.stringContaining('create_orders'),
      ]),
    )
    const names = rows.map(
      (row) =>
        /create_users|create_orders|index_orders_customer|add_order_notes|drop/.exec(
          row.textContent ?? '',
        )?.[0],
    )
    expect(names.indexOf('create_users')).toBeLessThan(names.indexOf('create_orders'))
    expect(names.indexOf('create_orders')).toBeLessThan(names.indexOf('index_orders_customer'))
    for (const word of [
      'Verified',
      'Applied',
      'Failed',
      'Drifted',
      'Pending',
      'Unknown',
      'Reverted',
      'Not applied',
    ]) {
      expect(container, word).toHaveTextContent(word)
    }
    expect(container.querySelector('[data-tier="production"]')).not.toBeNull()
  })

  it('lists the eight markers with their meaning', () => {
    renderDemo('ui-data/migration-timeline/markers')
    expect(screen.getAllByRole('term')).toHaveLength(8)
    expect(document.body).toHaveTextContent('This does not mean the bundle is absent.')
  })

  it('names a dependency cycle', () => {
    renderDemo('ui-data/migration-timeline/cycle')
    expect(document.body).toHaveTextContent('dependency cycle')
  })

  it('shows a failed timeline read as a failure', () => {
    renderDemo('ui-data/migration-timeline/failed')
    expect(document.body).toHaveTextContent('Could not read migration timeline')
    expect(screen.queryByRole('table')).toBeNull()
  })
})
