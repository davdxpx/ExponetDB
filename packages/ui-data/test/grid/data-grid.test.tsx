import '@testing-library/jest-dom/vitest'
import { toast } from '@exponetdb/ui'
import type { Readable } from '@exponetdb/ui-patterns'
import { act, cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { StrictMode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DataGrid } from '../../src/grid/data-grid.tsx'
import type { CellValue, DataGridProps, GridColumn } from '../../src/grid/types.ts'
import { axeViolations } from '../support/axe.ts'

afterEach(() => {
  cleanup()
  toast.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const OBSERVED = '2026-10-13T10:00:00Z'
const NOW = '2026-10-13T10:05:00Z'

type Rows = readonly (readonly CellValue[])[]

function ready(value: Rows): Readable<Rows> {
  return { state: 'ready', value, source: 'live', observedAt: OBSERVED }
}

const COLUMNS: GridColumn[] = [
  { name: 'id', type: 'int8' },
  { name: 'name', type: 'text' },
  { name: 'active', type: 'bool' },
]

const ROWS: Rows = [
  [1, 'Ada', true],
  [2, 'Grace', false],
  [3, null, true],
]

function renderGrid(props: Partial<DataGridProps> = {}) {
  return render(
    <DataGrid label="Query result" columns={COLUMNS} rows={ready(ROWS)} now={NOW} {...props} />,
  )
}

function bigRows(count: number): Rows {
  return Array.from({ length: count }, (_, i): readonly CellValue[] => [
    i + 1,
    `name ${i + 1}`,
    i % 2 === 0,
  ])
}

function cellAt(row: number, col: number): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-exdb-r="${row}"][data-exdb-c="${col}"]`)
  if (el === null) throw new Error(`no cell at ${row}:${col}`)
  return el
}

function bodyRows(): HTMLElement[] {
  return screen.getAllByRole('row').filter((row) => row.getAttribute('aria-rowindex') !== '1')
}

describe('DataGrid: structure', () => {
  it('is a read-only ARIA grid with a name and counts that include the header row', () => {
    renderGrid()
    const grid = screen.getByRole('grid', { name: 'Query result' })

    expect(grid).toHaveAttribute('aria-readonly', 'true')
    expect(grid).toHaveAttribute('aria-rowcount', '4')
    expect(grid).toHaveAttribute('aria-colcount', '3')
  })

  it('numbers the rows and the columns from 1, the header being row 1', () => {
    renderGrid()
    const rows = screen.getAllByRole('row')

    expect(rows.map((row) => row.getAttribute('aria-rowindex'))).toEqual(['1', '2', '3', '4'])
    const headers = within(rows[0] as HTMLElement).getAllByRole('columnheader')
    expect(headers.map((h) => h.getAttribute('aria-colindex'))).toEqual(['1', '2', '3'])
    const cells = within(rows[1] as HTMLElement).getAllByRole('gridcell')
    expect(cells.map((c) => c.getAttribute('aria-colindex'))).toEqual(['1', '2', '3'])
  })

  it('names each column and its type in the header', () => {
    renderGrid()
    const [first] = screen.getAllByRole('columnheader')

    expect(first).toHaveTextContent('id')
    expect(first).toHaveTextContent('int8')
  })

  it('summarizes the rows and columns', () => {
    renderGrid()
    expect(screen.getByText('3 rows, 3 columns')).toBeInTheDocument()
  })

  it('has one tab stop: the first data cell', () => {
    renderGrid()
    const stops = Array.from(document.querySelectorAll('[data-exdb-r][tabindex="0"]'))

    expect(stops).toHaveLength(1)
    expect(stops[0]).toBe(cellAt(1, 0))
  })
})

describe('DataGrid: values by type', () => {
  const columns: GridColumn[] = [
    { name: 'id', type: 'int8' },
    { name: 'price', type: 'numeric' },
    { name: 'ok', type: 'bool' },
    { name: 'doc', type: 'jsonb' },
    { name: 'blob', type: 'bytea' },
    { name: 'at', type: 'timestamptz' },
    { name: 'tags', type: '_text' },
    { name: 'note', type: 'text' },
  ]
  const row: readonly CellValue[] = [
    '9007199254740993',
    '12.50',
    false,
    '{\n  "a": [1, 2]\n}',
    '\\x48656c6c6f',
    '2026-10-13T08:00:00.123456Z',
    '{a,"b c",NULL}',
    'hello',
  ]

  it('shows each type the way a database person reads it', () => {
    renderGrid({ columns, rows: ready([row]) })

    expect(cellAt(1, 0)).toHaveTextContent('9007199254740993')
    expect(cellAt(1, 0)).toHaveAttribute('data-align', 'end')
    expect(cellAt(1, 1)).toHaveTextContent('12.50')
    expect(cellAt(1, 1)).toHaveAttribute('data-align', 'end')
    expect(cellAt(1, 2)).toHaveTextContent('false')
    expect(cellAt(1, 2)).toHaveAttribute('data-align', 'start')
    expect(cellAt(1, 3)).toHaveTextContent('{"a":[1,2]}')
    expect(cellAt(1, 4)).toHaveTextContent('\\x48656c6c6f')
    expect(cellAt(1, 4)).toHaveTextContent('5 bytes')
    expect(cellAt(1, 5)).toHaveTextContent('2026-10-13T08:00:00.123456Z')
    expect(cellAt(1, 6)).toHaveTextContent('{a,"b c",NULL}')
    expect(cellAt(1, 7)).toHaveTextContent('hello')
  })

  it('shows true and false as text', () => {
    renderGrid()
    expect(cellAt(1, 2)).toHaveTextContent('true')
    expect(cellAt(2, 2)).toHaveTextContent('false')
  })

  it('shows NULL, an empty string and the text NULL as three different things', () => {
    renderGrid({
      columns: [{ name: 'v', type: 'text' }],
      rows: ready([[null], [''], ['NULL'], ['(empty)']]),
    })

    const nullCell = cellAt(1, 0)
    expect(nullCell.querySelector('[data-cell="null"]')).toHaveTextContent('NULL')
    expect(nullCell).toHaveTextContent('null value')

    const emptyCell = cellAt(2, 0)
    expect(emptyCell.querySelector('[data-cell="empty"]')).toHaveTextContent('(empty)')
    expect(emptyCell.querySelector('[data-cell="null"]')).toBeNull()
    expect(emptyCell).toHaveTextContent('empty string')

    for (const row of [3, 4]) {
      expect(cellAt(row, 0).querySelector('[data-cell]')).toBeNull()
    }
    expect(cellAt(3, 0)).toHaveTextContent('NULL')
  })

  it('says "masked" for a masked column, never NULL', () => {
    renderGrid({
      columns: [
        { name: 'email', type: 'text', masked: true },
        { name: 'id', type: 'int4' },
      ],
      rows: ready([[null, 1]]),
    })

    expect(cellAt(1, 0).querySelector('[data-cell="masked"]')).toHaveTextContent('masked')
    expect(cellAt(1, 0).querySelector('[data-cell="null"]')).toBeNull()
    expect(
      within(screen.getAllByRole('columnheader')[0] as HTMLElement).getByText('masked'),
    ).toBeInTheDocument()
  })

  it('says a row has no value rather than showing NULL when it is short', () => {
    renderGrid({ rows: ready([[1, 'Ada']]) })
    expect(cellAt(1, 2).querySelector('[data-cell="missing"]')).not.toBeNull()
    expect(cellAt(1, 2).querySelector('[data-cell="null"]')).toBeNull()
  })

  it('shows a value the server cut with the size of the whole', () => {
    renderGrid({
      columns: [{ name: 'doc', type: 'text' }],
      rows: ready([
        [{ truncated: true, preview: 'The beginning', bytes: 123_456, unit: 'characters' }],
      ]),
    })

    expect(cellAt(1, 0)).toHaveTextContent('The beginning')
    expect(cellAt(1, 0)).toHaveTextContent('cut, 123,456 characters')
    expect(
      within(cellAt(1, 0)).getByRole('button', { name: 'Show full value' }),
    ).toBeInTheDocument()
  })
})

describe('DataGrid: untrusted values', () => {
  it('renders markup as text and creates no element from it', () => {
    const hostile =
      '<script>alert(1)</script><img src=x onerror=alert(1)><a href="javascript:alert(1)">x</a>'
    const { container } = renderGrid({
      columns: [{ name: hostile, type: 'text' }],
      rows: ready([[hostile]]),
    })

    expect(cellAt(1, 0)).toHaveTextContent(hostile)
    expect(container.querySelector('script, img, a')).toBeNull()
    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.getByRole('columnheader')).toHaveTextContent(hostile)
  })

  it('shows a right-to-left override, zero-width characters and controls by code point', () => {
    renderGrid({
      columns: [{ name: 'v', type: 'text' }],
      rows: ready([['admin\u{202E}gnp.exe'], ['a\u{200B}b\u{200D}c'], ['x\u{0}y\u{1B}[31mz']]),
    })

    expect(within(cellAt(1, 0)).getByText('⟨U+202E⟩')).toBeInTheDocument()
    expect(cellAt(1, 0).textContent).not.toContain('\u{202E}')
    expect(within(cellAt(2, 0)).getByText('⟨U+200B⟩')).toBeInTheDocument()
    expect(within(cellAt(2, 0)).getByText('⟨U+200D⟩')).toBeInTheDocument()
    expect(cellAt(2, 0).textContent).not.toContain('\u{200B}')
    expect(within(cellAt(3, 0)).getByText('⟨U+0000⟩')).toBeInTheDocument()
    expect(within(cellAt(3, 0)).getByText('⟨U+001B⟩')).toBeInTheDocument()
  })

  it('shows invisible characters in a column name too', () => {
    renderGrid({
      columns: [{ name: 'na\u{202E}me', type: 'te\u{200B}xt' }],
      rows: ready([['x']]),
    })
    const header = screen.getByRole('columnheader')

    expect(within(header).getByText('⟨U+202E⟩')).toBeInTheDocument()
    expect(within(header).getByText('⟨U+200B⟩')).toBeInTheDocument()
    expect(header.textContent).not.toContain('\u{202E}')
  })

  it('shows a line break inside a value as a code point, so a cell stays one line', () => {
    renderGrid({ columns: [{ name: 'v', type: 'text' }], rows: ready([['first\nsecond']]) })
    expect(within(cellAt(1, 0)).getByText('⟨U+000A⟩')).toBeInTheDocument()
  })

  it('marks a look-alike letter', () => {
    renderGrid({ columns: [{ name: 'v', type: 'text' }], rows: ready([['pаypal']]) })
    expect(cellAt(1, 0).querySelector('[data-segment="non-ascii"]')).toHaveAttribute(
      'data-code-point',
      'U+0430',
    )
  })

  it('names an empty column name instead of leaving the header blank', () => {
    renderGrid({ columns: [{ name: '', type: 'int4' }], rows: ready([[1]]) })
    expect(screen.getByRole('columnheader')).toHaveTextContent('(unnamed)')
  })
})

describe('DataGrid: truthful states', () => {
  it('shows a skeleton and announces the load while loading', () => {
    const { container } = renderGrid({ rows: { state: 'loading' } })

    expect(screen.getByRole('status')).toHaveTextContent('Loading result rows')
    expect(screen.queryByRole('grid')).toBeNull()
    expect(container.querySelector('[data-slot="grid-skeleton"]')).not.toBeNull()
  })

  it('never shows "No rows" for a failed read', () => {
    const retry = vi.fn()
    renderGrid({
      rows: {
        state: 'failed',
        error: { code: 'TARGET_UNREACHABLE', message: 'The target did not answer.' },
      },
      onRetry: retry,
    })

    expect(screen.getByText('Could not read result rows')).toBeInTheDocument()
    expect(screen.getByText('TARGET_UNREACHABLE')).toBeInTheDocument()
    expect(screen.getByText('This does not mean there is no result rows.')).toBeInTheDocument()
    expect(screen.queryByText('No rows')).toBeNull()
    expect(screen.queryByRole('grid')).toBeNull()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })

  it('shows "No rows" only after a successful read with zero rows', () => {
    renderGrid({ rows: ready([]) })

    expect(screen.getByText('No rows')).toBeInTheDocument()
    expect(screen.getByText('The read succeeded and returned no rows.')).toBeInTheDocument()
    expect(screen.queryByRole('grid')).toBeNull()
  })

  it('keeps the rows under a banner with the source and age when the read is stale', () => {
    const refresh = vi.fn()
    renderGrid({
      rows: {
        state: 'stale',
        value: ROWS,
        source: 'cached',
        observedAt: OBSERVED,
        error: { code: 'TARGET_UNREACHABLE', message: 'The target did not answer.' },
      },
      onRefresh: refresh,
    })

    expect(screen.getByText('Showing an earlier read of result rows')).toBeInTheDocument()
    expect(screen.getByText(/5 min ago/)).toBeInTheDocument()
    expect(screen.getByText(/Could not refresh: The target did not answer\./)).toBeInTheDocument()
    expect(screen.getByRole('grid')).toBeInTheDocument()
    expect(cellAt(1, 1)).toHaveTextContent('Ada')
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeInTheDocument()
  })

  it('says a stale read of zero rows is the last successful read', () => {
    renderGrid({
      rows: { state: 'stale', value: [], source: 'cached', observedAt: OBSERVED },
    })
    expect(screen.getByText('The last successful read returned no rows.')).toBeInTheDocument()
  })

  it('shows what is missing above a partial read and never calls it empty', () => {
    renderGrid({
      rows: {
        state: 'partial',
        value: ROWS,
        source: 'live',
        observedAt: OBSERVED,
        missing: ['Column "secret" needs the data.read_sensitive scope.'],
      },
    })

    expect(screen.getByText('Showing part of result rows')).toBeInTheDocument()
    expect(
      screen.getByText('Column "secret" needs the data.read_sensitive scope.'),
    ).toBeInTheDocument()
    expect(screen.getByRole('grid')).toBeInTheDocument()
  })

  it('never shows "No rows" for a partial read with no rows', () => {
    renderGrid({
      rows: {
        state: 'partial',
        value: [],
        source: 'live',
        observedAt: OBSERVED,
        missing: ['Part of the result.'],
      },
    })

    expect(screen.queryByText('No rows')).toBeNull()
    expect(screen.getByText(/Rows may be among what is missing/)).toBeInTheDocument()
  })

  it('says a statement that returns rows but no columns has nothing to show', () => {
    renderGrid({ columns: [], rows: ready([[], []]) })
    expect(screen.getByText('No columns')).toBeInTheDocument()
    expect(screen.getByText(/returned 2 rows but no columns/)).toBeInTheDocument()
    expect(screen.queryByText('No rows')).toBeNull()
  })

  it('uses the noun the caller gives', () => {
    renderGrid({ rows: { state: 'loading' }, what: 'query results' })
    expect(screen.getByRole('status')).toHaveTextContent('Loading query results')
  })
})

describe('DataGrid: virtualization', () => {
  it('puts only the visible rows in the document', () => {
    renderGrid({ rows: ready(bigRows(5_000)) })

    expect(screen.getByRole('grid')).toHaveAttribute('aria-rowcount', '5001')
    const rows = bodyRows()
    expect(rows.length).toBeGreaterThan(10)
    expect(rows.length).toBeLessThan(60)
    expect(rows[0]).toHaveAttribute('aria-rowindex', '2')
    expect(screen.queryByText('name 4000')).toBeNull()
  })

  it('renders the rows at the scroll position and gives each its index', () => {
    renderGrid({ rows: ready(bigRows(5_000)) })
    const grid = screen.getByRole('grid')

    act(() => {
      grid.scrollTop = 36 + 32 * 2_000
      grid.dispatchEvent(new Event('scroll'))
    })

    expect(screen.getByText('name 2001')).toBeInTheDocument()
    // Only the active row (the first, the grid's tab stop) is kept from the top.
    expect(screen.queryByText('name 2')).toBeNull()
    expect(screen.queryByText('name 100')).toBeNull()
    expect(bodyRows().length).toBeLessThan(60)
    const row = screen.getByText('name 2001').closest('[role="row"]')
    expect(row).toHaveAttribute('aria-rowindex', '2002')
  })
})

describe('DataGrid: keyboard', () => {
  it('moves the one tab stop with the arrow keys and focuses the cell', async () => {
    const user = userEvent.setup()
    renderGrid()

    await user.tab()
    // The toolbar buttons come first in the page; tab to the grid.
    cellAt(1, 0).focus()
    expect(cellAt(1, 0)).toHaveFocus()

    await user.keyboard('{ArrowRight}')
    expect(cellAt(1, 1)).toHaveFocus()
    expect(cellAt(1, 1)).toHaveAttribute('tabindex', '0')
    expect(cellAt(1, 0)).toHaveAttribute('tabindex', '-1')

    await user.keyboard('{ArrowDown}')
    expect(cellAt(2, 1)).toHaveFocus()

    await user.keyboard('{ArrowLeft}')
    expect(cellAt(2, 0)).toHaveFocus()

    await user.keyboard('{ArrowUp}')
    expect(cellAt(1, 0)).toHaveFocus()
  })

  it('stops at the edges', async () => {
    const user = userEvent.setup()
    renderGrid()
    cellAt(3, 2).focus()

    await user.keyboard('{ArrowDown}{ArrowRight}')
    expect(cellAt(3, 2)).toHaveFocus()
  })

  it('reaches the column headers with ArrowUp and leaves them alone when sorting is off', async () => {
    const user = userEvent.setup()
    renderGrid()
    cellAt(1, 1).focus()

    await user.keyboard('{ArrowUp}')
    expect(cellAt(0, 1)).toHaveFocus()
    expect(cellAt(0, 1)).toHaveAttribute('role', 'columnheader')
    expect(screen.getAllByRole('columnheader')[1]).not.toHaveAttribute('aria-sort')
  })

  it('goes to the first and last column with Home and End', async () => {
    const user = userEvent.setup()
    renderGrid()
    cellAt(2, 1).focus()

    await user.keyboard('{End}')
    expect(cellAt(2, 2)).toHaveFocus()
    await user.keyboard('{Home}')
    expect(cellAt(2, 0)).toHaveFocus()
  })

  it('goes to the first and last cell with Control+Home and Control+End', async () => {
    const user = userEvent.setup()
    renderGrid()
    cellAt(2, 1).focus()

    await user.keyboard('{Control>}{End}{/Control}')
    expect(cellAt(3, 2)).toHaveFocus()
    await user.keyboard('{Control>}{Home}{/Control}')
    expect(cellAt(0, 0)).toHaveFocus()
  })

  it('moves by pages with PageDown and PageUp', async () => {
    const user = userEvent.setup()
    renderGrid({ rows: ready(bigRows(100)) })
    cellAt(1, 0).focus()

    await user.keyboard('{PageDown}')
    expect(cellAt(11, 0)).toHaveFocus()
    expect(screen.getByRole('grid').querySelector('[tabindex="0"]')).toBe(cellAt(11, 0))
    await user.keyboard('{PageUp}')
    expect(cellAt(1, 0)).toHaveFocus()
  })

  it('reaches a row that was not in the document with Control+End and keeps the tab stop in the grid', async () => {
    const user = userEvent.setup()
    renderGrid({ rows: ready(bigRows(5_000)) })
    cellAt(1, 0).focus()

    await user.keyboard('{Control>}{End}{/Control}')

    expect(cellAt(5_000, 2)).toHaveFocus()
    expect(cellAt(5_000, 2).closest('[role="row"]')).toHaveAttribute('aria-rowindex', '5001')
    expect(bodyRows().length).toBeLessThan(60)

    await user.keyboard('{Control>}{Home}{/Control}')
    expect(cellAt(0, 0)).toHaveFocus()
    // The tab stop is in the document again at the top; the far row is gone.
    expect(document.querySelector('[data-exdb-r="5000"]')).toBeNull()
  })

  it('keeps a tab stop in the grid when the active row scrolls out of view', () => {
    renderGrid({ rows: ready(bigRows(5_000)) })
    cellAt(1, 0).focus()
    const grid = screen.getByRole('grid')

    act(() => {
      grid.scrollTop = 36 + 32 * 3_000
      grid.dispatchEvent(new Event('scroll'))
    })

    const stops = grid.querySelectorAll('[data-exdb-r][tabindex="0"]')
    expect(stops).toHaveLength(1)
    expect(stops[0]).toBe(cellAt(1, 0))
  })

  it('does not grab Tab: Tab leaves the grid', async () => {
    const user = userEvent.setup()
    renderGrid()
    cellAt(1, 0).focus()

    await user.tab()
    expect(screen.getByRole('grid').contains(document.activeElement)).toBe(false)
  })

  it('makes a cell the active one when it is clicked', async () => {
    const user = userEvent.setup()
    renderGrid()

    await user.click(cellAt(2, 1))
    expect(cellAt(2, 1)).toHaveAttribute('tabindex', '0')
    expect(cellAt(2, 1)).toHaveAttribute('data-active', 'true')
    expect(cellAt(1, 0)).toHaveAttribute('tabindex', '-1')
  })

  it('has a visible way to tell which cell the copy actions act on', async () => {
    const user = userEvent.setup()
    renderGrid()
    await user.click(cellAt(3, 0))

    expect(document.querySelectorAll('[data-active="true"]')).toHaveLength(1)
    expect(cellAt(3, 0)).toHaveAttribute('data-active', 'true')
  })
})

describe('DataGrid: sorting', () => {
  it('has no sort controls and no aria-sort unless the caller passes sort', () => {
    renderGrid()

    expect(screen.queryAllByRole('button', { name: /sort/i })).toHaveLength(0)
    for (const header of screen.getAllByRole('columnheader')) {
      expect(header).not.toHaveAttribute('aria-sort')
      expect(within(header).queryByRole('button')).toBeNull()
    }
  })

  it('makes headers sortable with aria-sort when sort is passed', () => {
    renderGrid({ sort: { column: 1, direction: 'desc', onSortChange: vi.fn() } })
    const headers = screen.getAllByRole('columnheader')

    expect(headers[0]).toHaveAttribute('aria-sort', 'none')
    expect(headers[1]).toHaveAttribute('aria-sort', 'descending')
    expect(headers[2]).toHaveAttribute('aria-sort', 'none')
  })

  it('asks the caller for ascending, then descending, then unsorted — and never reorders rows itself', async () => {
    const user = userEvent.setup()
    const onSortChange = vi.fn()
    const { rerender } = renderGrid({ sort: { column: null, direction: 'asc', onSortChange } })
    const button = () =>
      within(screen.getAllByRole('columnheader')[1] as HTMLElement).getByRole('button')

    await user.click(button())
    expect(onSortChange).toHaveBeenLastCalledWith({ column: 1, direction: 'asc' })
    // The caller has not re-read: nothing is reordered, nothing is marked sorted.
    expect(screen.getAllByRole('columnheader')[1]).toHaveAttribute('aria-sort', 'none')
    expect(cellAt(1, 1)).toHaveTextContent('Ada')

    rerender(
      <DataGrid
        label="Query result"
        columns={COLUMNS}
        rows={ready(ROWS)}
        now={NOW}
        sort={{ column: 1, direction: 'asc', onSortChange }}
      />,
    )
    expect(screen.getAllByRole('columnheader')[1]).toHaveAttribute('aria-sort', 'ascending')
    await user.click(button())
    expect(onSortChange).toHaveBeenLastCalledWith({ column: 1, direction: 'desc' })

    rerender(
      <DataGrid
        label="Query result"
        columns={COLUMNS}
        rows={ready(ROWS)}
        now={NOW}
        sort={{ column: 1, direction: 'desc', onSortChange }}
      />,
    )
    await user.click(button())
    expect(onSortChange).toHaveBeenLastCalledWith(null)
    expect(onSortChange).toHaveBeenCalledTimes(3)
  })

  it('sorts from the keyboard: the header is reached with the arrows and Enter sorts', async () => {
    const user = userEvent.setup()
    const onSortChange = vi.fn()
    renderGrid({ sort: { column: null, direction: 'asc', onSortChange } })
    cellAt(1, 2).focus()

    await user.keyboard('{ArrowUp}')
    expect(cellAt(0, 2)).toHaveFocus()
    expect(cellAt(0, 2).tagName).toBe('BUTTON')
    await user.keyboard('{Enter}')
    expect(onSortChange).toHaveBeenCalledWith({ column: 2, direction: 'asc' })
  })

  it('tells sorted columns apart by the sort arrow and not by color alone', () => {
    renderGrid({ sort: { column: 0, direction: 'asc', onSortChange: vi.fn() } })
    const header = screen.getAllByRole('columnheader')[0] as HTMLElement
    expect(header).toHaveAttribute('aria-sort', 'ascending')
    expect(header.querySelector('svg')).not.toBeNull()
  })
})

describe('DataGrid: paging', () => {
  it('shows no paging controls without a page prop', () => {
    renderGrid()
    expect(screen.queryByRole('button', { name: 'Load more rows' })).toBeNull()
  })

  it('asks for more only when the person presses the button', async () => {
    const user = userEvent.setup()
    const onLoadMore = vi.fn()
    renderGrid({
      rows: ready(bigRows(200)),
      page: { hasMore: true, onLoadMore, loading: false },
    })
    const grid = screen.getByRole('grid')

    act(() => {
      grid.scrollTop = 36 + 32 * 200
      grid.dispatchEvent(new Event('scroll'))
    })
    expect(onLoadMore).not.toHaveBeenCalled()
    expect(grid).toHaveAttribute('aria-rowcount', '-1')
    expect(screen.getByText('More rows are available.')).toBeInTheDocument()
    expect(screen.getByText('200 rows loaded, 3 columns')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Load more rows' }))
    expect(onLoadMore).toHaveBeenCalledTimes(1)
  })

  it('shows the button busy and unclickable while the next page loads', async () => {
    const user = userEvent.setup()
    const onLoadMore = vi.fn()
    renderGrid({ page: { hasMore: true, onLoadMore, loading: true } })
    const button = screen.getByRole('button', { name: 'Load more rows' })

    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByRole('grid')).toHaveAttribute('aria-busy', 'true')
    await user.click(button)
    expect(onLoadMore).not.toHaveBeenCalled()
  })

  it('says all rows are loaded when there are no more pages', () => {
    renderGrid({ page: { hasMore: false, onLoadMore: vi.fn(), loading: false } })
    expect(screen.getByText('All rows are loaded.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Load more rows' })).toBeNull()
    expect(screen.getByRole('grid')).toHaveAttribute('aria-rowcount', '4')
  })

  it('does not claim all rows are loaded when the server cut the result', () => {
    renderGrid({
      page: { hasMore: false, onLoadMore: vi.fn(), loading: false },
      truncated: { reason: 'the 5,000 row limit' },
    })
    expect(screen.queryByText('All rows are loaded.')).toBeNull()
    expect(
      screen.getByText('The server cut this result; more rows exist than shown.'),
    ).toBeInTheDocument()
  })
})

describe('DataGrid: server cut', () => {
  it('says the server cut the result and why', () => {
    renderGrid({ truncated: { reason: 'the 5,000 row limit' } })

    const alert = screen
      .getByText('The server cut this result')
      .closest('[data-slot="grid-truncated"]')
    expect(alert).toHaveTextContent('the 5,000 row limit')
    expect(alert).toHaveTextContent('not loaded and are not in exports')
  })

  it('shows the reason as text', () => {
    const { container } = renderGrid({ truncated: { reason: '<b>x</b>\u{202E}' } })
    expect(container.querySelector('b')).toBeNull()
    expect(screen.getByText('⟨U+202E⟩')).toBeInTheDocument()
  })
})

describe('DataGrid: accessibility', () => {
  it('has no axe violations', async () => {
    renderGrid({
      columns: [
        { name: 'id', type: 'int8' },
        { name: 'name', type: 'text' },
        { name: 'doc', type: 'jsonb' },
        { name: 'secret', type: 'text', masked: true },
      ],
      rows: ready([
        [1, 'Ada', '{"a":1}', null],
        [2, null, null, null],
        [3, '', '[]', null],
        [4, 'x'.repeat(400), '{"k":"v"}', null],
      ]),
      sort: { column: 0, direction: 'asc', onSortChange: vi.fn() },
      page: { hasMore: true, onLoadMore: vi.fn(), loading: false },
      truncated: { reason: 'the row limit' },
    })
    expect(await axeViolations()).toEqual([])
  })

  it('has no axe violations in the failed, loading, empty, stale and partial states', async () => {
    for (const rows of [
      { state: 'loading' },
      { state: 'failed', error: { code: 'UNKNOWN', message: 'Something failed.' } },
      ready([]),
      { state: 'stale', value: ROWS, source: 'cached', observedAt: OBSERVED },
      {
        state: 'partial',
        value: ROWS,
        source: 'live',
        observedAt: OBSERVED,
        missing: ['a column'],
      },
    ] satisfies Readable<Rows>[]) {
      const { unmount } = renderGrid({ rows })
      expect(await axeViolations()).toEqual([])
      unmount()
    }
  })
})

describe('DataGrid: layout and robustness', () => {
  it('positions the rows by the row height the caller gives', () => {
    renderGrid({ rowHeight: 40 })
    const rows = screen.getAllByRole('row')

    expect(rows[1]).toHaveStyle({ height: '40px', transform: 'translateY(0px)' })
    expect(rows[2]).toHaveStyle({ height: '40px', transform: 'translateY(40px)' })
    expect(rows[3]).toHaveStyle({ transform: 'translateY(80px)' })
  })

  it('lays the columns out with variables, not with markup styles', () => {
    renderGrid()
    const grid = screen.getByRole('grid')

    expect(grid.style.getPropertyValue('--exdb-grid-cols')).toMatch(/^\d+px \d+px \d+px$/)
    expect(grid.style.getPropertyValue('--exdb-grid-width')).toMatch(/^\d+px$/)
    expect(grid.style.maxHeight).toBe('560px')
  })

  it('renders a wide result and reaches its last column from the keyboard', async () => {
    const user = userEvent.setup()
    const columns = Array.from(
      { length: 300 },
      (_, i): GridColumn => ({ name: `col_${i}`, type: i % 2 === 0 ? 'int4' : 'text' }),
    )
    const rows = Array.from({ length: 40 }, (_, r): readonly CellValue[] =>
      columns.map((_, c) => (c % 2 === 0 ? r * c : `v${r}:${c}`)),
    )
    renderGrid({ columns, rows: ready(rows) })

    expect(screen.getByRole('grid')).toHaveAttribute('aria-colcount', '300')
    // Only the columns in view are in the document, each numbered by its place in the grid.
    const headers = screen.getAllByRole('columnheader')
    expect(headers.length).toBeGreaterThan(5)
    expect(headers.length).toBeLessThan(40)
    expect(headers[0]).toHaveAttribute('aria-colindex', '1')
    expect(document.querySelectorAll('[role="gridcell"]').length).toBeLessThan(40 * 30)

    cellAt(1, 0).focus()
    await user.keyboard('{End}')
    expect(cellAt(1, 299)).toHaveFocus()
    expect(cellAt(1, 299)).toHaveAttribute('aria-colindex', '300')
    expect(cellAt(1, 299)).toHaveTextContent('v0:299')
    expect(cellAt(0, 299)).toBeInTheDocument()
    expect(document.querySelectorAll('[data-exdb-r][tabindex="0"]')).toHaveLength(1)

    await user.keyboard('{Home}')
    expect(cellAt(1, 0)).toHaveFocus()
    expect(document.querySelector('[data-exdb-r="1"][data-exdb-c="299"]')).toBeNull()
  }, 20_000)

  it('renders the columns in view at their own position in the grid', () => {
    const columns = Array.from(
      { length: 50 },
      (_, i): GridColumn => ({ name: `c${i}`, type: 'text' }),
    )
    renderGrid({ columns, rows: ready([columns.map((_, i): CellValue => `v${i}`)]) })
    const grid = screen.getByRole('grid')

    act(() => {
      grid.scrollLeft = 240 * 30
      grid.dispatchEvent(new Event('scroll'))
    })

    expect(cellAt(1, 30)).toHaveStyle({ gridColumnStart: '31' })
    expect(cellAt(0, 30)).toHaveStyle({ gridColumnStart: '31' })
    expect(document.querySelector('[data-exdb-r="1"][data-exdb-c="10"]')).toBeNull()
  })

  it('keeps the active cell when equal columns are passed again', async () => {
    const user = userEvent.setup()
    const { rerender } = renderGrid()
    await user.click(cellAt(2, 1))

    rerender(
      <DataGrid
        label="Query result"
        columns={COLUMNS.map((column) => ({ ...column }))}
        rows={ready(ROWS)}
        now={NOW}
      />,
    )

    expect(cellAt(2, 1)).toHaveAttribute('tabindex', '0')
  })

  it('keeps the active cell inside the grid when a new result has fewer rows and columns', async () => {
    const user = userEvent.setup()
    const { rerender } = renderGrid()
    await user.click(cellAt(3, 2))

    rerender(
      <DataGrid
        label="Query result"
        columns={[{ name: 'id', type: 'int8' }]}
        rows={ready([[1]])}
        now={NOW}
      />,
    )

    expect(document.querySelectorAll('[data-exdb-r][tabindex="0"]')).toHaveLength(1)
    expect(cellAt(1, 0)).toHaveAttribute('tabindex', '0')
  })

  it('starts a new result without the notice of the old one', async () => {
    const user = userEvent.setup()
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    Object.assign(URL, { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} })
    const { rerender } = renderGrid()

    await user.click(screen.getByRole('button', { name: 'Export CSV' }))
    expect(screen.getByText('Exported 3 rows.')).toBeInTheDocument()

    rerender(<DataGrid label="Query result" columns={COLUMNS} rows={ready([...ROWS])} now={NOW} />)
    expect(screen.queryByText('Exported 3 rows.')).toBeNull()
  })

  it('works under React strict mode', async () => {
    const user = userEvent.setup()
    render(
      <StrictMode>
        <DataGrid label="Query result" columns={COLUMNS} rows={ready(bigRows(100))} now={NOW} />
      </StrictMode>,
    )
    cellAt(1, 0).focus()

    await user.keyboard('{ArrowDown}{ArrowRight}')
    expect(cellAt(2, 1)).toHaveFocus()
    await user.keyboard('{Control>}{End}{/Control}')
    expect(cellAt(100, 2)).toHaveFocus()
  })
})
