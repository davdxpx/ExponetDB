import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  describeGapRun,
  findGapRuns,
  prepareTimeSeries,
  TimeSeriesChart,
  type TimeSeriesPoint,
  type TimeSeriesSeries,
  TimeSeriesTooltip,
} from '../../src/charts/time-series-chart.tsx'
import type { Readable } from '../../src/readable.ts'
import { axeViolations } from '../support/axe.ts'
import { mockChartLayout } from './layout.ts'

afterEach(cleanup)
mockChartLayout()

const NOW = Date.parse('2026-10-13T10:00:00Z')
const OFFLINE = 'no samples: agent offline'

const series: TimeSeriesSeries[] = [{ key: 'p95', label: 'p95 latency (ms)' }]

const points: TimeSeriesPoint[] = [
  { time: '2026-10-13T09:00:00Z', values: { p95: 12 } },
  { time: '2026-10-13T09:05:00Z', values: { p95: 14 } },
  { time: '2026-10-13T09:10:00Z', values: { p95: null }, gaps: { p95: OFFLINE } },
  { time: '2026-10-13T09:15:00Z', values: { p95: null }, gaps: { p95: OFFLINE } },
  { time: '2026-10-13T09:20:00Z', values: { p95: 20 } },
  { time: '2026-10-13T09:25:00Z', values: { p95: 22 } },
]

function ready(value: readonly TimeSeriesPoint[]): Readable<readonly TimeSeriesPoint[]> {
  return { state: 'ready', value, source: 'sampled', observedAt: '2026-10-13T09:59:00Z' }
}

function renderChart(
  data: Readable<readonly TimeSeriesPoint[]>,
  extra: Partial<React.ComponentProps<typeof TimeSeriesChart>> = {},
) {
  return render(
    <TimeSeriesChart name="query latency" data={data} series={series} now={NOW} {...extra} />,
  )
}

// A path with a gap has several sub-paths: each `M` starts one.
const subPaths = (d: string | null | undefined) => (d?.match(/M/g) ?? []).length

describe('prepareTimeSeries', () => {
  it('sorts by time and turns a value that is not a finite number into a gap', () => {
    const { prepared, dropped } = prepareTimeSeries(
      [
        { time: '2026-10-13T09:10:00Z', values: { p95: Number.NaN } },
        { time: '2026-10-13T09:00:00Z', values: { p95: 5 } },
        { time: '2026-10-13T09:05:00Z', values: {} },
      ],
      series,
    )
    expect(dropped).toBe(0)
    expect(prepared.map((point) => point.values[0])).toEqual([5, null, null])
  })

  it('leaves out and counts a point whose time cannot be read', () => {
    const { prepared, dropped } = prepareTimeSeries(
      [
        { time: '2026-10-13T09:00:00', values: { p95: 1 } },
        { time: '2026-10-13T09:05:00Z', values: { p95: 2 } },
      ],
      series,
    )
    expect(prepared).toHaveLength(1)
    expect(dropped).toBe(1)
  })

  it('treats zero as a value, not as a gap', () => {
    const { prepared } = prepareTimeSeries(
      [{ time: '2026-10-13T09:00:00Z', values: { p95: 0 } }],
      series,
    )
    expect(prepared[0]?.values[0]).toBe(0)
  })
})

describe('gap runs', () => {
  it('finds each run of missing values with its cause', () => {
    const { prepared } = prepareTimeSeries(points, series)
    const runs = findGapRuns(prepared, 1)
    expect(runs).toEqual([
      {
        seriesIndex: 0,
        fromMs: Date.parse('2026-10-13T09:10:00Z'),
        toMs: Date.parse('2026-10-13T09:15:00Z'),
        count: 2,
        causes: [OFFLINE],
      },
    ])
  })

  it('says so when no cause was reported instead of inventing one', () => {
    const { prepared } = prepareTimeSeries(
      [
        { time: '2026-10-13T09:00:00Z', values: { p95: null } },
        { time: '2026-10-13T09:05:00Z', values: { p95: 1 } },
      ],
      series,
    )
    const [run] = findGapRuns(prepared, 1)
    expect(run?.causes).toEqual([])
    expect(run && describeGapRun(run, 'p95', 'UTC')).toBe(
      'p95: no data, cause not reported (at Oct 13, 09:00 UTC, 1 point)',
    )
  })

  it('joins different causes inside one run', () => {
    const { prepared } = prepareTimeSeries(
      [
        { time: '2026-10-13T09:00:00Z', values: { p95: null }, gaps: { p95: 'agent offline' } },
        { time: '2026-10-13T09:05:00Z', values: { p95: null }, gaps: { p95: 'collector paused' } },
      ],
      series,
    )
    const [run] = findGapRuns(prepared, 1)
    expect(run?.causes).toEqual(['agent offline', 'collector paused'])
  })
})

describe('TimeSeriesChart ready', () => {
  it('is a figure named after the chart, described by a summary of the chart and its gaps', () => {
    renderChart(ready(points))
    const figure = screen.getByRole('figure', { name: 'query latency' })
    expect(figure).toHaveAccessibleDescription(
      'query latency, line chart, 1 series, 6 points from Oct 13, 09:00 UTC to Oct 13, 09:25 UTC. Latest: p95 latency (ms) 22. 1 gap where nothing was sampled.',
    )
  })

  it('hides the picture from assistive technology and leaves no focusable chart behind', () => {
    const { container } = renderChart(ready(points))
    const plot = container.querySelector('[data-slot="plot"]')
    expect(plot).toHaveAttribute('aria-hidden', 'true')
    expect(plot?.querySelector('[tabindex="0"]')).toBeNull()
  })

  it('breaks the line at a missing value instead of connecting across it', () => {
    const { container } = renderChart(ready(points))
    const path = container.querySelector('path.recharts-line-curve')
    expect(subPaths(path?.getAttribute('d'))).toBe(2)
  })

  it('shades a span where every series is missing', () => {
    const { container } = renderChart(ready(points))
    expect(container.querySelectorAll('.recharts-reference-area')).toHaveLength(1)
  })

  it('draws an isolated sample as a dot so it is not lost between two gaps', () => {
    const { container } = renderChart(
      ready([
        { time: '2026-10-13T09:00:00Z', values: { p95: null } },
        { time: '2026-10-13T09:05:00Z', values: { p95: 7 } },
        { time: '2026-10-13T09:10:00Z', values: { p95: null } },
      ]),
    )
    expect(container.querySelectorAll('.recharts-reference-dot')).toHaveLength(1)
  })

  it('draws an area chart with the same gaps', () => {
    const { container } = renderChart(ready(points), { variant: 'area' })
    expect(screen.getByRole('figure')).toHaveAccessibleDescription(/area chart/)
    const curve = container.querySelector('path.recharts-area-curve')
    expect(subPaths(curve?.getAttribute('d'))).toBe(2)
  })

  it('colors lines only through chart slots, with no literal color', () => {
    const { container } = renderChart(ready(points))
    const chart = container.querySelector<HTMLElement>('[data-chart^="chart-"]')
    expect(chart?.style.getPropertyValue('--color-s0')).toBe('var(--chart-1)')
    expect(container.querySelector('path.recharts-line-curve')).toHaveAttribute(
      'stroke',
      'var(--color-s0)',
    )
    const paints = Array.from(
      container.querySelectorAll('[data-slot="plot"] [stroke], [data-slot="plot"] [fill]'),
    )
      .flatMap((element) => [element.getAttribute('stroke'), element.getAttribute('fill')])
      .filter((value): value is string => value !== null)
    expect(paints.length).toBeGreaterThan(0)
    for (const paint of paints) expect(paint).toMatch(/^(none|var\(--[a-z0-9-]+\)|url\(#.+\))$/)
    expect(document.querySelector('style')).toBeNull()
  })

  it('lists the legend and the gaps with their cause as text', () => {
    renderChart(ready(points))
    const legend = screen.getByRole('list', { name: 'Legend' })
    expect(within(legend).getByText('p95 latency (ms)')).toBeInTheDocument()
    const gaps = document.querySelector('[data-slot="gaps"]')
    expect(gaps).toHaveTextContent(
      'p95 latency (ms): no samples: agent offline (Oct 13, 09:10 UTC to Oct 13, 09:15 UTC, 2 points)',
    )
  })

  it('has no gap list when nothing is missing', () => {
    renderChart(ready(points.filter((point) => point.values['p95'] !== null)))
    expect(document.querySelector('[data-slot="gaps"]')).toBeNull()
    expect(screen.getByRole('figure')).toHaveAccessibleDescription(/No gaps\./)
  })

  it('differs the second series from the first by more than color', () => {
    const { container } = renderChart(
      ready([{ time: '2026-10-13T09:00:00Z', values: { a: 1, b: 2 } }]),
      {
        series: [
          { key: 'a', label: 'Primary' },
          { key: 'b', label: 'Replica' },
        ],
      },
    )
    const dashes = Array.from(container.querySelectorAll('[aria-label="Legend"] line')).map(
      (line) => line.getAttribute('stroke-dasharray'),
    )
    expect(dashes).toEqual([null, '6 3'])
  })

  it('notes points whose time could not be read', () => {
    renderChart(
      ready([...points, { time: 'last night', values: { p95: 3 } }, { time: '', values: {} }]),
    )
    expect(screen.getByText('2 points with an unreadable time were left out.')).toBeInTheDocument()
  })

  it('says nothing can be drawn when no point has a readable time', () => {
    const { container } = renderChart(ready([{ time: 'last night', values: { p95: 3 } }]))
    expect(screen.getByText(/None of the 1 point had a readable time/)).toBeInTheDocument()
    expect(container.querySelector('svg.recharts-surface')).toBeNull()
  })

  it('renders hostile labels and causes as text, with hidden characters made visible', () => {
    const { container } = renderChart(
      ready([
        {
          time: '2026-10-13T09:00:00Z',
          values: { p95: null },
          gaps: { p95: '<img src=x onerror=boom()>‮' },
        },
        { time: '2026-10-13T09:05:00Z', values: { p95: 1 } },
      ]),
      { series: [{ key: 'p95', label: '<script>boom()</script>‮db' }] },
    )
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByRole('list', { name: 'Legend' })).toHaveTextContent(
      '<script>boom()</script>⟨U+202E⟩db',
    )
    expect(document.querySelector('[data-slot="gaps"]')).toHaveTextContent(
      '<img src=x onerror=boom()>⟨U+202E⟩',
    )
  })
})

describe('data table', () => {
  it('is offered as the text alternative and shows every value and every gap with its cause', async () => {
    const user = userEvent.setup()
    renderChart(ready(points))
    const toggle = screen.getByRole('button', { name: 'Show data as table' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('table')).toBeNull()

    await user.click(toggle)
    expect(screen.getByRole('button', { name: 'Hide data table' })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
    const table = screen.getByRole('table', { name: 'query latency' })
    const rows = within(table).getAllByRole('row')
    expect(rows).toHaveLength(1 + points.length)
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((header) => header.textContent),
    ).toEqual(['Time (UTC)', 'p95 latency (ms)'])
    expect(rows[1]).toHaveTextContent('Oct 13, 09:00 UTC12')
    expect(rows[3]).toHaveTextContent('No data: no samples: agent offline')
    expect(rows[3]).not.toHaveTextContent(/\b0\b/)
    expect(screen.getByRole('region', { name: 'query latency, data table' })).toHaveAttribute(
      'tabindex',
      '0',
    )
  })

  it('says how many rows it leaves out when there are very many', async () => {
    const user = userEvent.setup()
    const many: TimeSeriesPoint[] = Array.from({ length: 520 }, (_, index) => ({
      time: new Date(Date.UTC(2026, 9, 13, 0, index)).toISOString(),
      values: { p95: index },
    }))
    renderChart(ready(many))
    await user.click(screen.getByRole('button', { name: 'Show data as table' }))
    expect(screen.getByText('Showing the newest 500 of 520 rows.')).toBeInTheDocument()
    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(501)
  })
})

describe('TimeSeriesTooltip', () => {
  const resolved = [
    { id: 's0', label: 'Primary', slot: 1 as const, dash: undefined },
    { id: 's1', label: 'Replica', slot: 2 as const, dash: '6 3' },
  ]
  const format = (value: number) => `${value} ms`

  it('shows the value of each series at the hovered time', () => {
    render(
      <TimeSeriesTooltip
        active
        point={{
          t: Date.parse('2026-10-13T09:05:00Z'),
          values: [12, 0],
          causes: [undefined, undefined],
        }}
        series={resolved}
        formatValue={format}
        timeZone="UTC"
      />,
    )
    const tooltip = document.querySelector('[data-slot="tooltip"]')
    expect(tooltip).toHaveTextContent('Oct 13, 09:05 UTC')
    expect(tooltip).toHaveTextContent('Primary12 ms')
    // zero is a value
    expect(tooltip).toHaveTextContent('Replica0 ms')
  })

  it('shows the cause of a gap on hover, and says when no cause was reported', () => {
    render(
      <TimeSeriesTooltip
        active
        point={{
          t: Date.parse('2026-10-13T09:10:00Z'),
          values: [null, null],
          causes: [OFFLINE, undefined],
        }}
        series={resolved}
        formatValue={format}
        timeZone="UTC"
      />,
    )
    const tooltip = document.querySelector('[data-slot="tooltip"]')
    expect(tooltip).toHaveTextContent(OFFLINE)
    expect(tooltip).toHaveTextContent('No data, cause not reported')
    expect(tooltip).not.toHaveTextContent('0 ms')
  })

  it('renders nothing when inactive or without a point', () => {
    const { container, rerender } = render(
      <TimeSeriesTooltip
        active={false}
        point={undefined}
        series={resolved}
        formatValue={format}
        timeZone="UTC"
      />,
    )
    expect(container).toBeEmptyDOMElement()
    rerender(
      <TimeSeriesTooltip
        active
        point={undefined}
        series={resolved}
        formatValue={format}
        timeZone="UTC"
      />,
    )
    expect(container).toBeEmptyDOMElement()
  })
})

describe('truthful states', () => {
  it('shows a skeleton while loading, with no chart', () => {
    const { container } = renderChart({ state: 'loading' }, { height: 150 })
    expect(screen.getByRole('status')).toHaveTextContent('Loading query latency')
    expect(container.querySelector('svg.recharts-surface')).toBeNull()
  })

  it('shows the failure and its code, never an empty chart or the empty state', () => {
    const onRetry = vi.fn()
    const { container } = renderChart(
      {
        state: 'failed',
        error: { code: 'TARGET_UNREACHABLE', message: 'The target did not answer.' },
      },
      { onRetry },
    )
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Could not read query latency: The target did not answer. This does not mean there is no data.',
    )
    expect(screen.getByRole('alert')).toHaveTextContent('TARGET_UNREACHABLE')
    expect(container.querySelector('svg.recharts-surface')).toBeNull()
    expect(container.querySelector('[data-state="empty"]')).toBeNull()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })

  it('shows the empty state after a successful read of nothing', () => {
    renderChart(ready([]))
    expect(screen.getByText('No data in this period')).toBeInTheDocument()
  })

  it('draws a stale chart with its age', () => {
    const { container } = renderChart({
      state: 'stale',
      value: points,
      source: 'cached',
      observedAt: '2026-10-13T09:40:00Z',
    })
    expect(container.querySelector('svg.recharts-surface')).not.toBeNull()
    expect(document.querySelector('[data-slot="stale-note"]')).toHaveTextContent(
      'observed 20 minutes ago',
    )
  })

  it('draws a partial chart and lists what is missing', () => {
    renderChart({
      state: 'partial',
      value: points,
      source: 'agent_reported',
      observedAt: '2026-10-13T09:59:00Z',
      missing: ['replica-2: the node agent is offline'],
    })
    expect(document.querySelector('[data-slot="partial-note"]')).toHaveTextContent(
      'replica-2: the node agent is offline',
    )
  })

  it('uses the given time zone for every time it shows', () => {
    renderChart(ready(points), { timeZone: 'Europe/Berlin' })
    expect(screen.getByRole('figure')).toHaveAccessibleDescription(/from Oct 13, 11:00 /)
  })
})

describe('accessibility', () => {
  it('has no violations with data, gaps, the table open and the other states', async () => {
    const user = userEvent.setup()
    const { container } = render(
      <div>
        <TimeSeriesChart name="query latency" data={ready(points)} series={series} now={NOW} />
        <TimeSeriesChart
          name="replication lag"
          data={{ state: 'loading' }}
          series={series}
          now={NOW}
        />
        <TimeSeriesChart
          name="connections"
          data={{ state: 'failed', error: { code: 'X', message: 'Could not connect.' } }}
          series={series}
          now={NOW}
        />
        <TimeSeriesChart name="locks" data={ready([])} series={series} now={NOW} />
      </div>,
    )
    expect(await axeViolations(container)).toEqual([])
    await user.click(
      screen.getAllByRole('button', { name: 'Show data as table' })[0] as HTMLElement,
    )
    expect(await axeViolations(container)).toEqual([])
  })
})
