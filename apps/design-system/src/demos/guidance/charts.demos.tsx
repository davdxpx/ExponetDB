import { CHART_SLOTS, chartColor } from '@exponetdb/ui'
import {
  type BreakdownBar,
  type BreakdownSegment,
  StackedBreakdown,
  TimeSeriesChart,
  type TimeSeriesPoint,
  type TimeSeriesSeries,
} from '@exponetdb/ui-patterns'
import type { ReactNode } from 'react'
import type { DemoDefinition } from '../types.ts'
import { Labeled, NOW, OBSERVED } from './support.tsx'

const CLOCK = Date.parse(NOW)
const START = Date.parse('2026-10-13T10:00:00.000Z')
const FIVE_MINUTES = 5 * 60_000
const OFFLINE = 'no samples: node agent offline'

const SERIES: readonly TimeSeriesSeries[] = [
  { key: 'p50', label: 'p50 latency (ms)' },
  { key: 'p95', label: 'p95 latency (ms)' },
]

/** Two hours of five-minute samples; the node agent was offline for three of them. */
const POINTS: readonly TimeSeriesPoint[] = Array.from({ length: 24 }, (_, index) => {
  const offline = index >= 10 && index <= 12
  return {
    time: new Date(START + index * FIVE_MINUTES).toISOString(),
    values: {
      p50: offline ? null : 18 + ((index * 7) % 9),
      p95: offline ? null : 44 + ((index * 13) % 17) + (index === 16 ? 28 : 0),
    },
    ...(offline ? { gaps: { p50: OFFLINE, p95: OFFLINE } } : {}),
  }
})

function GapChart(): ReactNode {
  return (
    <TimeSeriesChart
      name="query latency of shop/platform/production"
      data={{ state: 'ready', value: POINTS, source: 'sampled', observedAt: OBSERVED }}
      series={SERIES}
      height={180}
      now={CLOCK}
    />
  )
}

function ChartStates(): ReactNode {
  return (
    <div className="flex flex-col gap-6">
      <Labeled label="A read that failed">
        <TimeSeriesChart
          name="query latency"
          data={{
            state: 'failed',
            error: { code: 'TARGET_UNAVAILABLE', message: 'ExponetDB could not reach the target.' },
          }}
          series={SERIES}
          height={96}
          now={CLOCK}
          onRetry={() => undefined}
        />
      </Labeled>
      <Labeled label="A read that is older than it should be">
        <TimeSeriesChart
          name="query latency"
          data={{
            state: 'stale',
            value: POINTS,
            source: 'cached',
            observedAt: '2026-10-13T11:20:00.000Z',
            error: { code: 'TARGET_UNAVAILABLE', message: 'ExponetDB could not reach the target.' },
          }}
          series={SERIES}
          height={140}
          now={CLOCK}
          onRefresh={() => undefined}
        />
      </Labeled>
      <Labeled label="A read that succeeded and found nothing">
        <TimeSeriesChart
          name="query latency"
          data={{ state: 'ready', value: [], source: 'sampled', observedAt: OBSERVED }}
          series={SERIES}
          height={96}
          now={CLOCK}
          emptyTitle="No samples in this period"
          emptyDescription="The read succeeded. The target was not sampled between 10:00 and 12:00 UTC."
        />
      </Labeled>
    </div>
  )
}

const SEGMENTS: readonly BreakdownSegment[] = [
  { key: 'applied', label: 'Applied' },
  { key: 'failed', label: 'Failed' },
  { key: 'canceled', label: 'Canceled' },
]

const BARS: readonly BreakdownBar[] = [
  { id: 'mon', label: 'Mon', values: { applied: 12, failed: 1, canceled: 2 } },
  { id: 'tue', label: 'Tue', values: { applied: 9, failed: 0, canceled: 1 } },
  {
    id: 'wed',
    label: 'Wed',
    values: { applied: 11, failed: null, canceled: 0 },
    notRead: { failed: 'not read: the Control Store did not answer' },
  },
]

function Breakdown(): ReactNode {
  return (
    <StackedBreakdown
      name="operations by outcome"
      data={{ state: 'ready', value: BARS, source: 'live', observedAt: OBSERVED }}
      segments={SEGMENTS}
      height={200}
      now={CLOCK}
    />
  )
}

function Palette(): ReactNode {
  return (
    <ul
      aria-label="Chart color slots"
      className="m-0 grid list-none grid-cols-2 gap-x-6 gap-y-2 p-0 sm:grid-cols-4"
    >
      {CHART_SLOTS.map((slot) => (
        <li key={slot} className="flex items-center gap-2 text-sm text-foreground-light">
          <svg aria-hidden="true" focusable="false" width="28" height="12" className="shrink-0">
            <rect width="28" height="12" rx="2" fill={chartColor(slot)} />
          </svg>
          <span>Slot {slot}</span>
        </li>
      ))}
    </ul>
  )
}

export const demos: readonly DemoDefinition[] = [
  {
    id: 'guidance/charts/gaps',
    title: 'A time series with gaps: no line across them, the cause named, a table as text',
    render: () => <GapChart />,
  },
  {
    id: 'guidance/charts/states',
    title: 'A chart that failed, one that is stale and one that is empty look different',
    render: () => <ChartStates />,
  },
  {
    id: 'guidance/charts/unread-values',
    title: 'A value that was not read makes the total a lower bound',
    render: () => <Breakdown />,
  },
  {
    id: 'guidance/charts/color-slots',
    title: 'Eight color slots, assigned in order and never cycled',
    render: () => <Palette />,
  },
]
