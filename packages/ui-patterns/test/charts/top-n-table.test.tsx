import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { describeTrend, type TopNRow, TopNTable } from '../../src/charts/top-n-table.tsx'
import type { Readable } from '../../src/readable.ts'
import { axeViolations } from '../support/axe.ts'

afterEach(cleanup)

const NOW = Date.parse('2026-10-13T10:00:00Z')

const rows: TopNRow[] = [
  { id: 'q1', label: 'SELECT * FROM orders WHERE id = $1', value: 4210, trend: [10, 40, 30, 80] },
  { id: 'q2', label: 'UPDATE stock SET qty = qty - 1', value: 1350, trend: [5, null, 7, 6] },
  {
    id: 'q3',
    label: 'DELETE FROM sessions',
    value: null,
    trend: [null, null, null],
    note: 'no samples: agent offline',
  },
]

function ready(value: readonly TopNRow[]): Readable<readonly TopNRow[]> {
  return { state: 'ready', value, source: 'sampled', observedAt: '2026-10-13T09:58:00Z' }
}

function renderTable(
  data: Readable<readonly TopNRow[]>,
  extra: Partial<React.ComponentProps<typeof TopNTable>> = {},
) {
  return render(
    <TopNTable
      name="slowest statements"
      data={data}
      labelHeader="Statement"
      valueHeader="Total time (ms)"
      trendSpan="over the last hour"
      now={NOW}
      {...extra}
    />,
  )
}

describe('describeTrend', () => {
  const format = (value: number) => `${value} ms`
  it('gives start, end, range and the number of missing samples', () => {
    expect(describeTrend([5, null, 7, 6], 'over the last hour', format)).toBe(
      'Trend over the last hour: from 5 ms to 6 ms, lowest 5 ms, highest 7 ms, 1 of 4 samples missing',
    )
  })

  it('says there were no samples instead of describing a flat line', () => {
    expect(describeTrend([null, null], 'over the last hour', format)).toBe(
      'No samples over the last hour',
    )
    expect(describeTrend([], 'over the last hour', format)).toBe('No samples over the last hour')
  })
})

describe('TopNTable ready', () => {
  it('is a table named by its caption, with a header for every column', () => {
    renderTable(ready(rows))
    const table = screen.getByRole('table', { name: /slowest statements/ })
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((header) => header.textContent),
    ).toEqual(['Rank', 'Statement', 'Total time (ms)', 'Trend'])
  })

  it('puts the numbers in text cells, in rank order', () => {
    renderTable(ready(rows))
    const body = within(screen.getByRole('table')).getAllByRole('row').slice(1)
    expect(body).toHaveLength(3)
    expect(body[0]).toHaveTextContent('1')
    expect(body[0]).toHaveTextContent('SELECT * FROM orders WHERE id = $1')
    expect(body[0]).toHaveTextContent('4,210')
    expect(body[1]).toHaveTextContent('1,350')
  })

  it('makes the label the row header', () => {
    renderTable(ready(rows))
    expect(screen.getByRole('rowheader', { name: /SELECT \* FROM orders/ })).toBeInTheDocument()
  })

  it('shows "Not read" for a value that was not read, never zero, with its note', () => {
    renderTable(ready(rows))
    const row = screen.getByRole('row', { name: /DELETE FROM sessions/ })
    expect(row).toHaveTextContent('Not read')
    expect(row).toHaveTextContent('no samples: agent offline')
    expect(row).not.toHaveTextContent(/\b0\b/)
  })

  it('draws a decorative polyline per row and describes the trend in words', () => {
    const { container } = renderTable(ready(rows))
    const sparklines = container.querySelectorAll('svg[data-slot="sparkline"]')
    expect(sparklines).toHaveLength(3)
    for (const svg of sparklines) expect(svg).toHaveAttribute('aria-hidden', 'true')
    // row 1 and the run of two samples in row 2 are polylines; row 3 has no samples and a dashed baseline
    expect(container.querySelectorAll('svg[data-slot="sparkline"] polyline')).toHaveLength(2)
    expect(sparklines[2]?.querySelector('line')).toHaveAttribute('stroke-dasharray')
    expect(
      screen.getByText(/Trend over the last hour: from 10 to 80, lowest 10, highest 80/),
    ).toBeInTheDocument()
    expect(screen.getByText('No samples over the last hour')).toBeInTheDocument()
  })

  it('breaks the line at a missing sample', () => {
    const { container } = renderTable(ready([rows[1] as TopNRow]))
    // [5, null, 7, 6]: an isolated first sample (a dot) and a run of two (a polyline)
    expect(container.querySelectorAll('polyline')).toHaveLength(1)
    expect(container.querySelectorAll('circle')).toHaveLength(1)
  })

  it('shows at most the limit and says how many rows it left out', () => {
    renderTable(ready(rows), { limit: 2 })
    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(3)
    expect(
      screen.getByText('Showing the top 2 of 3 rows in slowest statements.'),
    ).toBeInTheDocument()
  })

  it('uses the format it is given', () => {
    renderTable(ready(rows), { formatValue: (value) => `${value / 1000} s` })
    expect(screen.getByText('4.21 s')).toBeInTheDocument()
  })

  it('draws every trend on one scale when asked', () => {
    const { container } = renderTable(
      ready([
        { id: 'a', label: 'a', value: 1, trend: [1, 2] },
        { id: 'b', label: 'b', value: 2, trend: [100, 200] },
      ]),
      { sharedScale: true },
    )
    const lines = Array.from(container.querySelectorAll('polyline')).map((line) =>
      line.getAttribute('points'),
    )
    expect(lines[0]).not.toBe(lines[1])
    const first = lines[0]?.split(' ').map((pair) => Number(pair.split(',')[1])) ?? []
    // on a shared scale of 1 to 200 the first row stays near the bottom
    expect(Math.min(...first)).toBeGreaterThan(20)
  })

  it('lets the caller render the label, for example as a link', () => {
    renderTable(ready(rows), {
      renderLabel: (row) => <a href={`/statements/${row.id}`}>{row.id}</a>,
    })
    expect(screen.getByRole('link', { name: 'q1' })).toHaveAttribute('href', '/statements/q1')
  })

  it('truncates a long statement with a control to show all of it', async () => {
    const user = userEvent.setup()
    const long = `SELECT ${'column_name, '.repeat(20)}1`
    renderTable(ready([{ id: 'q', label: long, value: 1, trend: [1, 2] }]))
    expect(screen.queryByText(long)).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Show more' }))
    expect(screen.getByText(long)).toBeInTheDocument()
  })

  it('renders a hostile statement as text and shows hidden characters', () => {
    const { container } = renderTable(
      ready([
        {
          id: 'q',
          label: "'; DROP TABLE users; --‮<script>boom()</script>",
          value: 1,
          trend: [1],
        },
      ]),
    )
    expect(container.querySelector('script')).toBeNull()
    expect(screen.getByRole('rowheader')).toHaveTextContent(
      "'; DROP TABLE users; --⟨U+202E⟩<script>boom()</script>",
    )
  })
})

describe('truthful states', () => {
  it('shows a skeleton while loading, with no table', () => {
    renderTable({ state: 'loading' })
    expect(screen.getByRole('status')).toHaveTextContent('Loading slowest statements')
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('shows the failure and its code, never an empty table or the empty state', async () => {
    const user = userEvent.setup()
    const onRetry = vi.fn()
    const { container } = renderTable(
      {
        state: 'failed',
        error: { code: 'STATS_UNAVAILABLE', message: 'pg_stat_statements is not readable.' },
      },
      { onRetry },
    )
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Could not read slowest statements: pg_stat_statements is not readable. This does not mean there is no data.',
    )
    expect(screen.getByRole('alert')).toHaveTextContent('STATS_UNAVAILABLE')
    expect(screen.queryByRole('table')).toBeNull()
    expect(container.querySelector('[data-state="empty"]')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('shows the empty state only after a successful read of nothing', () => {
    renderTable(ready([]), { emptyTitle: 'No statements recorded' })
    expect(screen.getByText('No statements recorded')).toBeInTheDocument()
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('shows a stale table with its age and a refresh, and a partial one with what is missing', async () => {
    const user = userEvent.setup()
    const onRefresh = vi.fn()
    const stale = renderTable(
      {
        state: 'stale',
        value: rows,
        source: 'cached',
        observedAt: '2026-10-13T09:00:00Z',
      },
      { onRefresh },
    )
    expect(screen.getByRole('table')).toBeInTheDocument()
    expect(document.querySelector('[data-slot="stale-note"]')).toHaveTextContent(
      'observed 1 hour ago',
    )
    await user.click(screen.getByRole('button', { name: 'Refresh' }))
    expect(onRefresh).toHaveBeenCalledTimes(1)
    stale.unmount()

    renderTable({
      state: 'partial',
      value: rows,
      source: 'agent_reported',
      observedAt: '2026-10-13T09:59:00Z',
      missing: ['replica-2: the node agent is offline'],
    })
    expect(document.querySelector('[data-slot="partial-note"]')).toHaveTextContent(
      'replica-2: the node agent is offline',
    )
  })
})

describe('accessibility', () => {
  it('has no violations in the ready, loading, failed and empty states', async () => {
    const { container } = render(
      <div>
        <TopNTable
          name="slowest statements"
          data={ready(rows)}
          labelHeader="Statement"
          valueHeader="Total time (ms)"
          now={NOW}
        />
        <TopNTable
          name="largest tables"
          data={{ state: 'loading' }}
          labelHeader="Table"
          valueHeader="Size"
          now={NOW}
        />
        <TopNTable
          name="busiest roles"
          data={{ state: 'failed', error: { code: 'X', message: 'Could not connect.' } }}
          labelHeader="Role"
          valueHeader="Calls"
          now={NOW}
        />
        <TopNTable name="locks" data={ready([])} labelHeader="Lock" valueHeader="Waits" now={NOW} />
      </div>,
    )
    expect(await axeViolations(container)).toEqual([])
  })
})
