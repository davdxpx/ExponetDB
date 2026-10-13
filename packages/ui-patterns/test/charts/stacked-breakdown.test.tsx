import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import {
  type BreakdownBar,
  type BreakdownSegment,
  describeTotal,
  prepareBreakdown,
  StackedBreakdown,
  StackedBreakdownTooltip,
} from '../../src/charts/stacked-breakdown.tsx'
import type { Readable } from '../../src/readable.ts'
import { axeViolations } from '../support/axe.ts'
import { mockChartLayout } from './layout.ts'

afterEach(cleanup)
mockChartLayout()

const NOW = Date.parse('2026-10-13T10:00:00Z')

const segments: BreakdownSegment[] = [
  { key: 'active', label: 'Active' },
  { key: 'idle', label: 'Idle' },
  { key: 'waiting', label: 'Waiting on lock' },
]

const bars: BreakdownBar[] = [
  { id: 'orders', label: 'orders_db', values: { active: 40, idle: 70, waiting: 10 } },
  {
    id: 'billing',
    label: 'billing_db',
    values: { active: 20, idle: 30, waiting: null },
    notRead: { waiting: 'pg_locks needs a role that was not granted' },
  },
]

function ready(value: readonly BreakdownBar[]): Readable<readonly BreakdownBar[]> {
  return { state: 'ready', value, source: 'live', observedAt: '2026-10-13T10:00:00Z' }
}

function renderChart(
  data: Readable<readonly BreakdownBar[]>,
  extra: Partial<React.ComponentProps<typeof StackedBreakdown>> = {},
) {
  return render(
    <StackedBreakdown
      name="connections by state"
      data={data}
      segments={segments}
      now={NOW}
      {...extra}
    />,
  )
}

describe('prepareBreakdown', () => {
  it('sums the values that were read and counts the ones that were not', () => {
    const [orders, billing] = prepareBreakdown(bars, segments)
    expect(orders).toMatchObject({ total: 120, unread: 0 })
    expect(billing).toMatchObject({ total: 50, unread: 1 })
    expect(billing?.values).toEqual([20, 30, null])
  })

  it('treats a negative or non-finite value as not read, never as zero', () => {
    const [bar] = prepareBreakdown(
      [{ id: 'a', label: 'a', values: { active: -5, idle: Number.NaN, waiting: 3 } }],
      segments,
    )
    expect(bar).toMatchObject({ total: 3, unread: 2 })
  })

  it('treats a segment missing from the bar as not read', () => {
    const [bar] = prepareBreakdown([{ id: 'a', label: 'a', values: { active: 1 } }], segments)
    expect(bar?.unread).toBe(2)
  })

  it('counts a value of zero as read', () => {
    const [bar] = prepareBreakdown(
      [{ id: 'a', label: 'a', values: { active: 0, idle: 0, waiting: 0 } }],
      segments,
    )
    expect(bar).toMatchObject({ total: 0, unread: 0 })
  })
})

describe('describeTotal', () => {
  const format = (value: number) => String(value)
  it('states a complete total plainly and an incomplete one as a lower bound', () => {
    const [orders, billing] = prepareBreakdown(bars, segments)
    expect(orders && describeTotal(orders, format)).toBe('120')
    expect(billing && describeTotal(billing, format)).toBe('at least 50 (1 value not read)')
  })
})

describe('StackedBreakdown ready', () => {
  it('is a figure named after the chart, described by the bar count and the largest total', () => {
    renderChart(ready(bars))
    const figure = screen.getByRole('figure', { name: 'connections by state' })
    expect(figure).toHaveAccessibleDescription(
      'connections by state, stacked bar chart, 2 bars with 3 segments. Largest total: orders_db, 120. 1 value was not read; those totals are lower bounds.',
    )
  })

  it('hides the picture from assistive technology', () => {
    const { container } = renderChart(ready(bars))
    expect(container.querySelector('[data-slot="plot"]')).toHaveAttribute('aria-hidden', 'true')
  })

  it('draws one stack of bars per segment and a total label above every bar, marking a lower bound', () => {
    const { container } = renderChart(ready(bars))
    expect(container.querySelectorAll('.recharts-bar')).toHaveLength(segments.length)
    const labels = Array.from(container.querySelectorAll('.recharts-label-list text')).map(
      (text) => text.textContent,
    )
    expect(labels).toEqual(['120', '≥ 50'])
  })

  it('does not draw a rectangle for a value that was not read', () => {
    const { container } = renderChart(ready(bars))
    const waiting = container.querySelectorAll('.recharts-bar')[2]
    expect(waiting?.querySelectorAll('.recharts-bar-rectangle')).toHaveLength(1)
  })

  it('colors segments only through chart slots', () => {
    const { container } = renderChart(ready(bars))
    const chart = container.querySelector<HTMLElement>('[data-chart^="chart-"]')
    expect(chart?.style.getPropertyValue('--color-s0')).toBe('var(--chart-1)')
    expect(chart?.style.getPropertyValue('--color-s1')).toBe('var(--chart-2)')
    expect(chart?.style.getPropertyValue('--color-s2')).toBe('var(--chart-3)')
    const paints = Array.from(container.querySelectorAll('[data-slot="plot"] [fill]'))
      .map((element) => element.getAttribute('fill'))
      .filter((value): value is string => value !== null)
    for (const paint of paints) expect(paint).toMatch(/^(none|var\(--[a-z0-9-]+\)|url\(#.+\))$/)
  })

  it('names every segment in a legend', () => {
    renderChart(ready(bars))
    const legend = screen.getByRole('list', { name: 'Legend' })
    expect(
      within(legend)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['Active', 'Idle', 'Waiting on lock'])
  })

  it('lists what was not read and why', () => {
    renderChart(ready(bars))
    const list = document.querySelector('[data-slot="not-read"]')
    expect(list).toHaveTextContent('lower bounds')
    expect(list).toHaveTextContent(
      'billing_db: Waiting on lock not read (pg_locks needs a role that was not granted)',
    )
  })

  it('says the cause was not reported when none was given', () => {
    renderChart(ready([{ id: 'a', label: 'a_db', values: { active: 1, idle: 1, waiting: null } }]))
    expect(document.querySelector('[data-slot="not-read"]')).toHaveTextContent(
      'a_db: Waiting on lock not read (cause not reported)',
    )
  })

  it('has no not-read list when every value was read', () => {
    renderChart(ready([bars[0] as BreakdownBar]))
    expect(document.querySelector('[data-slot="not-read"]')).toBeNull()
    expect(screen.getByRole('figure')).toHaveAccessibleDescription(/Every value was read\./)
  })

  it('renders hostile category and segment names as text', () => {
    const { container } = renderChart(
      ready([{ id: 'x', label: '<img src=x onerror=boom()>‮', values: { active: 1 } }]),
      { segments: [{ key: 'active', label: '<script>boom()</script>' }] },
    )
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('script')).toBeNull()
    expect(screen.getByRole('figure')).toHaveAccessibleDescription(
      /Largest total: <img src=x onerror=boom\(\)>⟨U\+202E⟩, 1\./,
    )
  })
})

describe('data table', () => {
  it('shows every number, the reason and the total as words', async () => {
    const user = userEvent.setup()
    renderChart(ready(bars))
    await user.click(screen.getByRole('button', { name: 'Show data as table' }))
    const table = screen.getByRole('table', { name: 'connections by state' })
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((header) => header.textContent),
    ).toEqual(['Category', 'Active', 'Idle', 'Waiting on lock', 'Total'])
    const [, orders, billing] = within(table).getAllByRole('row')
    expect(orders).toHaveTextContent('orders_db407010120')
    expect(billing).toHaveTextContent('Not read: pg_locks needs a role that was not granted')
    expect(billing).toHaveTextContent('at least 50 (1 value not read)')
  })
})

describe('StackedBreakdownTooltip', () => {
  const resolved = [
    { id: 's0', label: 'Active', slot: 1 as const },
    { id: 's1', label: 'Idle', slot: 2 as const },
    { id: 's2', label: 'Waiting on lock', slot: 3 as const },
  ]
  const format = (value: number) => `${value}`

  it('shows each segment, the reason for an unread one and the total', () => {
    const [, billing] = prepareBreakdown(bars, segments)
    render(
      <StackedBreakdownTooltip active bar={billing} segments={resolved} formatValue={format} />,
    )
    const tooltip = document.querySelector('[data-slot="tooltip"]')
    expect(tooltip).toHaveTextContent('billing_db')
    expect(tooltip).toHaveTextContent('Active20')
    expect(tooltip).toHaveTextContent('Not read: pg_locks needs a role that was not granted')
    expect(tooltip).toHaveTextContent('Total: at least 50 (1 value not read)')
  })

  it('renders nothing when inactive or without a bar', () => {
    const { container } = render(
      <StackedBreakdownTooltip
        active={false}
        bar={undefined}
        segments={resolved}
        formatValue={format}
      />,
    )
    expect(container).toBeEmptyDOMElement()
  })
})

describe('truthful states', () => {
  it('shows a skeleton while loading', () => {
    const { container } = renderChart({ state: 'loading' })
    expect(screen.getByRole('status')).toHaveTextContent('Loading connections by state')
    expect(container.querySelector('svg.recharts-surface')).toBeNull()
  })

  it('shows the failure, never an empty chart or the empty state', () => {
    const { container } = renderChart({
      state: 'failed',
      error: { code: 'TARGET_UNREACHABLE', message: 'The target did not answer.' },
    })
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Could not read connections by state: The target did not answer. This does not mean there is no data.',
    )
    expect(container.querySelector('svg.recharts-surface')).toBeNull()
    expect(container.querySelector('[data-state="empty"]')).toBeNull()
  })

  it('shows the empty state only after a successful read of nothing', () => {
    renderChart(ready([]), { emptyTitle: 'No connections' })
    expect(screen.getByText('No connections')).toBeInTheDocument()
  })

  it('draws a stale chart with its age and a partial chart with what is missing', () => {
    const stale = renderChart({
      state: 'stale',
      value: bars,
      source: 'cached',
      observedAt: '2026-10-13T09:30:00Z',
    })
    expect(document.querySelector('[data-slot="stale-note"]')).toHaveTextContent(
      'observed 30 minutes ago',
    )
    stale.unmount()

    renderChart({
      state: 'partial',
      value: bars,
      source: 'agent_reported',
      observedAt: '2026-10-13T09:59:00Z',
      missing: ['analytics_db: not readable'],
    })
    expect(document.querySelector('[data-slot="partial-note"]')).toHaveTextContent(
      'analytics_db: not readable',
    )
  })
})

describe('accessibility', () => {
  it('has no violations in the ready, table, loading, failed and empty states', async () => {
    const user = userEvent.setup()
    const { container } = render(
      <div>
        <StackedBreakdown
          name="connections by state"
          data={ready(bars)}
          segments={segments}
          now={NOW}
        />
        <StackedBreakdown name="locks" data={{ state: 'loading' }} segments={segments} now={NOW} />
        <StackedBreakdown
          name="sessions"
          data={{ state: 'failed', error: { code: 'X', message: 'Could not connect.' } }}
          segments={segments}
          now={NOW}
        />
        <StackedBreakdown name="waits" data={ready([])} segments={segments} now={NOW} />
      </div>,
    )
    expect(await axeViolations(container)).toEqual([])
    await user.click(
      screen.getAllByRole('button', { name: 'Show data as table' })[0] as HTMLElement,
    )
    expect(await axeViolations(container)).toEqual([])
  })
})
