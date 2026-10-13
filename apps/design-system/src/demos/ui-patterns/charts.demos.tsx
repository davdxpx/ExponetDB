import { CHART_SLOTS, chartColor } from '@exponetdb/ui'
import {
  type BreakdownBar,
  type BreakdownSegment,
  ChartDataTableToggle,
  Sparkline,
  StackedBreakdown,
  TimeSeriesChart,
  type TimeSeriesPoint,
  type TimeSeriesSeries,
  type TopNRow,
  TopNTable,
} from '@exponetdb/ui-patterns'
import type { DemoDefinition } from '../types.ts'
import { minutesAgo, NOW_MS } from './clock.ts'

const OBSERVED = minutesAgo(1)
const OFFLINE = 'no samples: node agent offline'

const LATENCY_SERIES: readonly TimeSeriesSeries[] = [
  { key: 'p50', label: 'p50 latency (ms)' },
  { key: 'p95', label: 'p95 latency (ms)' },
]

/** 24 samples, five minutes apart, ending five minutes before `NOW`; p95 has a gap of four samples. */
const LATENCY_POINTS: readonly TimeSeriesPoint[] = Array.from({ length: 24 }, (_, index) => {
  const time = minutesAgo((24 - index) * 5)
  const p50 = 12 + ((index * 7) % 9)
  const missing = index >= 10 && index <= 13
  return {
    time,
    values: { p50, p95: missing ? null : 38 + ((index * 11) % 23) },
    ...(missing ? { gaps: { p95: OFFLINE } } : {}),
  }
})

const CONNECTION_SERIES: readonly TimeSeriesSeries[] = [
  { key: 'active', label: 'Active connections' },
]
const CONNECTION_POINTS: readonly TimeSeriesPoint[] = Array.from({ length: 24 }, (_, index) => ({
  time: minutesAgo((24 - index) * 5),
  values: { active: 20 + ((index * 5) % 17) },
}))

const SEGMENTS: readonly BreakdownSegment[] = [
  { key: 'active', label: 'Active' },
  { key: 'idle', label: 'Idle' },
  { key: 'waiting', label: 'Waiting on a lock' },
]
const BARS: readonly BreakdownBar[] = [
  { id: 'orders', label: 'orders', values: { active: 14, idle: 22, waiting: 1 } },
  { id: 'payments', label: 'payments', values: { active: 9, idle: 12, waiting: 0 } },
  {
    id: 'reporting',
    label: 'reporting',
    values: { active: 5, idle: null, waiting: 0 },
    notRead: { idle: 'the node agent did not report idle sessions' },
  },
]

const STATEMENTS: readonly TopNRow[] = [
  {
    id: 's1',
    label: 'select * from orders where customer_id = $1',
    value: 18450,
    trend: [12, 14, 15, 18, 17, 20, 22, 21],
  },
  {
    id: 's2',
    label: 'update inventory set stock = stock - $1 where sku = $2',
    value: 9210,
    trend: [8, 9, null, null, 10, 11, 9, 10],
    note: 'No samples while the agent was offline.',
  },
  {
    id: 's4',
    label: 'select \u{202E}name from users where id = $1',
    value: 4020,
    trend: [4, 4, 5, 4, 4, 5, 4, 4],
  },
  {
    id: 's3',
    label: 'select count(*) from payments where created_at > $1',
    value: null,
    trend: [],
    note: 'The value was not read.',
  },
]

const formatMs = (value: number): string => `${value} ms`

function ready<T>(value: T) {
  return { state: 'ready' as const, value, source: 'sampled' as const, observedAt: OBSERVED }
}

function Swatches() {
  return (
    <ul
      aria-label="Chart color slots"
      className="m-0 grid list-none grid-cols-2 gap-2 p-0 sm:grid-cols-4"
    >
      {CHART_SLOTS.map((slot) => (
        <li key={slot} className="flex items-center gap-2 text-sm">
          <svg aria-hidden="true" focusable="false" width="28" height="10" className="shrink-0">
            <rect width="28" height="10" rx="2" fill={chartColor(slot)} />
          </svg>
          <span className="text-foreground-light">Slot {slot}</span>
        </li>
      ))}
    </ul>
  )
}

export const demos: readonly DemoDefinition[] = [
  {
    id: 'ui-patterns/charts/color-slots',
    title: 'Chart color slots: eight numbered tokens that change with the theme',
    render: () => <Swatches />,
  },
  {
    id: 'ui-patterns/sparkline/gaps',
    title: 'Sparkline: a missing sample breaks the line, a single sample is a dot',
    render: () => (
      <div className="flex flex-col gap-3 text-sm">
        <div className="flex items-center gap-3">
          <span className="w-40 text-foreground-light">Complete</span>
          <Sparkline values={[3, 5, 4, 7, 6, 9, 8, 11]} width={160} height={32} />
        </div>
        <div className="flex items-center gap-3">
          <span className="w-40 text-foreground-light">With a gap</span>
          <Sparkline values={[3, 5, null, null, 6, 9, 8, 11]} width={160} height={32} slot={2} />
        </div>
        <div className="flex items-center gap-3">
          <span className="w-40 text-foreground-light">Isolated sample</span>
          <Sparkline values={[null, null, 6, null, null, null]} width={160} height={32} slot={3} />
        </div>
      </div>
    ),
  },
  {
    id: 'ui-patterns/time-series-chart/line-with-gap',
    title: 'Time series: the gap is a break in the line, with its cause under the chart',
    render: () => (
      <TimeSeriesChart
        name="query latency"
        data={ready(LATENCY_POINTS)}
        series={LATENCY_SERIES}
        formatValue={formatMs}
        now={NOW_MS}
      />
    ),
  },
  {
    id: 'ui-patterns/time-series-chart/area',
    title: 'Time series as an area chart with one series',
    render: () => (
      <TimeSeriesChart
        name="active connections"
        data={ready(CONNECTION_POINTS)}
        series={CONNECTION_SERIES}
        variant="area"
        height={160}
        now={NOW_MS}
      />
    ),
  },
  {
    id: 'ui-patterns/time-series-chart/hostile-label',
    title: 'A series label from a collector with a direction override is shown as text',
    render: () => (
      <TimeSeriesChart
        name="statement time"
        data={ready(CONNECTION_POINTS)}
        series={[{ key: 'active', label: 'select 1\u{202E}; drop\u{200B} table' }]}
        height={140}
        now={NOW_MS}
      />
    ),
  },
  {
    id: 'ui-patterns/time-series-chart/loading',
    title: 'Loading: a skeleton of the chart size, announced as one status',
    render: () => (
      <TimeSeriesChart
        name="query latency"
        data={{ state: 'loading' }}
        series={LATENCY_SERIES}
        height={140}
        now={NOW_MS}
      />
    ),
  },
  {
    id: 'ui-patterns/time-series-chart/failed',
    title: 'Failed: the reason and the code, and never an empty chart',
    render: () => (
      <TimeSeriesChart
        name="query latency"
        data={{
          state: 'failed',
          error: {
            code: 'TARGET_UNREACHABLE',
            message: 'The target did not answer within 5 seconds.',
          },
        }}
        series={LATENCY_SERIES}
        onRetry={() => undefined}
        now={NOW_MS}
      />
    ),
  },
  {
    id: 'ui-patterns/time-series-chart/stale',
    title: 'Stale: the chart under a note with its source and age',
    render: () => (
      <TimeSeriesChart
        name="active connections"
        data={{
          state: 'stale',
          value: CONNECTION_POINTS,
          source: 'cached',
          observedAt: minutesAgo(42),
          error: { code: 'TARGET_UNREACHABLE', message: 'The target did not answer.' },
        }}
        series={CONNECTION_SERIES}
        height={140}
        onRefresh={() => undefined}
        now={NOW_MS}
      />
    ),
  },
  {
    id: 'ui-patterns/time-series-chart/empty',
    title: 'Empty: shown only after a read that succeeded and found no points',
    render: () => (
      <TimeSeriesChart
        name="query latency"
        data={ready([])}
        series={LATENCY_SERIES}
        height={140}
        emptyTitle="No samples in this period"
        emptyDescription="The read succeeded and found no samples between 10:00 and 12:00 UTC."
        now={NOW_MS}
      />
    ),
  },
  {
    id: 'ui-patterns/stacked-breakdown/connections',
    title:
      'Stacked breakdown: a value that was not read is not drawn, and the total says "at least"',
    render: () => (
      <StackedBreakdown
        name="connections by database"
        data={ready(BARS)}
        segments={SEGMENTS}
        height={200}
        now={NOW_MS}
      />
    ),
  },
  {
    id: 'ui-patterns/top-n-table/statements',
    title: 'Top-N table: ranked rows with a trend, a gap in a trend and a value that was not read',
    render: () => (
      <TopNTable
        name="slowest statements"
        data={ready(STATEMENTS)}
        labelHeader="Statement"
        valueHeader="Total time (ms)"
        trendSpan="over the last 40 minutes"
        now={NOW_MS}
      />
    ),
  },
  {
    id: 'ui-patterns/chart-data-table/toggle',
    title: 'The data table behind a chart: the same numbers as text, opened by a button',
    render: () => (
      <ChartDataTableToggle
        name="Connections by state"
        columns={[
          { id: 'state', header: 'State' },
          { id: 'count', header: 'Sessions', align: 'right' },
        ]}
        rows={[
          { id: 'active', cells: ['Active', '28'] },
          { id: 'idle', cells: ['Idle', '34'] },
          { id: 'waiting', cells: ['Waiting on a lock', '1'] },
        ]}
      />
    ),
  },
]
