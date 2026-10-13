import {
  CHART_SLOTS,
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  chartColor,
  GapArea,
  GapLine,
} from '@exponetdb/ui'
import type { ReactNode } from 'react'
import { AreaChart, CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts'
import type { DemoDefinition } from '../types.ts'
import { Stack } from './support.tsx'

const config = {
  connections: { label: 'Connections', color: chartColor(1) },
  waiting: { label: 'Waiting', color: chartColor(2) },
} satisfies ChartConfig

// A missing sample is `null`: the line breaks there and never reads as zero.
const DATA = [
  { t: '12:00', connections: 12, waiting: 1 },
  { t: '12:05', connections: 18, waiting: 3 },
  { t: '12:10', connections: null, waiting: null },
  { t: '12:15', connections: 21, waiting: 2 },
  { t: '12:20', connections: 16, waiting: 0 },
  { t: '12:25', connections: 19, waiting: 1 },
]

function Lines(): ReactNode {
  return (
    <Stack>
      <ChartContainer config={config} className="h-60 w-full max-w-xl">
        <LineChart data={DATA} accessibilityLayer margin={{ left: 4, right: 12, top: 8 }}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="t" tickLine={false} axisLine={false} />
          <YAxis width={32} tickLine={false} axisLine={false} />
          <ChartTooltip active defaultIndex={3} content={<ChartTooltipContent />} />
          <ChartLegend content={<ChartLegendContent />} />
          <GapLine
            dataKey="connections"
            stroke="var(--color-connections)"
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
          <GapLine
            dataKey="waiting"
            stroke="var(--color-waiting)"
            strokeWidth={2}
            strokeDasharray="6 3"
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ChartContainer>
      <p className="text-sm text-foreground-light">
        Connections peaked at 21 at 12:15. There are no samples at 12:10, and the lines stop there.
      </p>
    </Stack>
  )
}

function Areas(): ReactNode {
  return (
    <ChartContainer config={config} className="h-52 w-full max-w-xl">
      <AreaChart data={DATA} accessibilityLayer margin={{ left: 4, right: 12, top: 8 }}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="t" tickLine={false} axisLine={false} />
        <YAxis width={32} tickLine={false} axisLine={false} />
        <GapArea
          dataKey="connections"
          stroke="var(--color-connections)"
          fill="var(--color-connections)"
          fillOpacity={0.25}
          isAnimationActive={false}
        />
      </AreaChart>
    </ChartContainer>
  )
}

// Series also differ in dash style, so color is never the only signal.
const DASHES = ['', '6 3', '2 2', '8 3 2 3', '1 3', '10 4', '3 3 1 3', '5 5'] as const

const ALL_SLOTS = Object.fromEntries(
  CHART_SLOTS.map((slot) => [`slot${slot}`, { label: `Slot ${slot}`, color: chartColor(slot) }]),
) satisfies ChartConfig

const SLOT_DATA = [
  { t: 'a', ...Object.fromEntries(CHART_SLOTS.map((slot) => [`slot${slot}`, slot * 2 + 2])) },
  { t: 'b', ...Object.fromEntries(CHART_SLOTS.map((slot) => [`slot${slot}`, slot * 2 + 5])) },
  { t: 'c', ...Object.fromEntries(CHART_SLOTS.map((slot) => [`slot${slot}`, slot * 2 + 3])) },
]

function Slots(): ReactNode {
  return (
    <ChartContainer config={ALL_SLOTS} className="h-52 w-full max-w-xl">
      <LineChart data={SLOT_DATA} accessibilityLayer margin={{ left: 4, right: 12, top: 8 }}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="t" tickLine={false} axisLine={false} />
        <YAxis width={32} tickLine={false} axisLine={false} />
        <ChartLegend content={<ChartLegendContent />} />
        {CHART_SLOTS.map((slot) => (
          <Line
            key={slot}
            dataKey={`slot${slot}`}
            stroke={`var(--color-slot${slot})`}
            strokeWidth={2}
            strokeDasharray={DASHES[slot - 1]}
            dot={false}
            isAnimationActive={false}
          />
        ))}
      </LineChart>
    </ChartContainer>
  )
}

export const demos: readonly DemoDefinition[] = [
  {
    id: 'ui/chart/lines',
    title: 'Two series with a gap, a tooltip and a legend',
    render: () => <Lines />,
  },
  {
    id: 'ui/chart/area',
    title: 'An area that breaks at a missing sample',
    render: () => <Areas />,
  },
  { id: 'ui/chart/slots', title: 'The eight color slots', render: () => <Slots /> },
]
