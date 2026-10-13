import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { Area, AreaChart, Line, LineChart, XAxis } from 'recharts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  CHART_SLOTS,
  type ChartConfig,
  ChartContainer,
  ChartLegendContent,
  ChartTooltipContent,
  chartColor,
  GapArea,
  GapLine,
  getChartStyle,
} from '../src/chart.tsx'
import { axeViolations } from './support/axe.ts'

const config = {
  reads: { label: 'Reads', color: 'var(--chart-1)' },
  writes: { label: 'Writes', color: 'var(--chart-2)' },
  idle: { label: 'Idle' },
} satisfies ChartConfig

// jsdom has no layout: give the responsive container a size so it renders its children.
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    width: 320,
    height: 180,
    top: 0,
    left: 0,
    right: 320,
    bottom: 180,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('getChartStyle', () => {
  it('turns token slot colors into --color-<key> custom properties', () => {
    expect(getChartStyle(config)).toEqual({
      '--color-reads': 'var(--chart-1)',
      '--color-writes': 'var(--chart-2)',
    })
  })

  it('offers all eight slots', () => {
    expect(CHART_SLOTS).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(CHART_SLOTS.map((slot) => chartColor(slot))).toEqual([
      'var(--chart-1)',
      'var(--chart-2)',
      'var(--chart-3)',
      'var(--chart-4)',
      'var(--chart-5)',
      'var(--chart-6)',
      'var(--chart-7)',
      'var(--chart-8)',
    ])
  })

  it('never lets a literal color or an odd key reach the document', () => {
    const untrusted = {
      hex: { color: '#ff0000' },
      url: { color: 'url(https://example.test/x)' },
      outOfRange: { color: 'var(--chart-9)' },
      'bad key;}': { color: 'var(--chart-3)' },
      'a b': { color: 'var(--chart-4)' },
      fine: { color: 'var(--chart-5)' },
    } as unknown as ChartConfig

    expect(getChartStyle(untrusted)).toEqual({ '--color-fine': 'var(--chart-5)' })
  })
})

describe('ChartContainer', () => {
  it('sets the series colors through the style prop and creates no style element', () => {
    const ref = createRef<HTMLDivElement>()
    const { container } = render(
      <ChartContainer ref={ref} config={config} aria-label="Reads and writes">
        <LineChart data={[{ t: 1, reads: 3, writes: 4 }]}>
          <Line dataKey="reads" stroke="var(--color-reads)" />
        </LineChart>
      </ChartContainer>,
    )

    const chart = container.querySelector<HTMLElement>('[data-chart]')
    expect(chart).toBe(ref.current)
    expect(chart?.style.getPropertyValue('--color-reads')).toBe('var(--chart-1)')
    expect(chart?.style.getPropertyValue('--color-writes')).toBe('var(--chart-2)')
    expect(document.querySelector('style')).toBeNull()
    expect(chart?.getAttribute('style')).not.toMatch(/#[0-9a-f]{3,8}/i)
  })

  it('keeps a style given by the caller next to the series colors', () => {
    const { container } = render(
      <ChartContainer config={config} style={{ height: '120px' }}>
        <LineChart data={[{ t: 1, reads: 3 }]}>
          <Line dataKey="reads" />
        </LineChart>
      </ChartContainer>,
    )

    const chart = container.querySelector<HTMLElement>('[data-chart]')
    expect(chart?.style.height).toBe('120px')
    expect(chart?.style.getPropertyValue('--color-reads')).toBe('var(--chart-1)')
  })

  it('renders its chart and has no accessibility violations', async () => {
    const { container } = render(
      <ChartContainer config={config} role="img" aria-label="Reads over time">
        <LineChart data={[{ t: 1, reads: 3 }]}>
          <XAxis dataKey="t" />
          <Line dataKey="reads" stroke="var(--color-reads)" isAnimationActive={false} />
        </LineChart>
      </ChartContainer>,
    )

    expect(container.querySelector('.recharts-line')).not.toBeNull()
    expect(await axeViolations()).toEqual([])
  })
})

const gapData = [
  { t: 1, v: 1 },
  { t: 2, v: null },
  { t: 3, v: 3 },
  { t: 4, v: 4 },
]

// A path with a gap has two sub-paths: each `M` starts one.
const subPaths = (d: string | null) => (d?.match(/M/g) ?? []).length

describe('GapLine and GapArea', () => {
  it('break the line at a null value instead of connecting across it', () => {
    const { container } = render(
      <div>
        <LineChart data={gapData} width={300} height={150}>
          <XAxis dataKey="t" />
          <GapLine dataKey="v" dot={false} isAnimationActive={false} />
        </LineChart>
      </div>,
    )

    const path = container.querySelector('path.recharts-line-curve')
    expect(subPaths(path?.getAttribute('d') ?? null)).toBe(2)
  })

  it('differ from a line that is told to connect nulls', () => {
    const { container } = render(
      <div>
        <LineChart data={gapData} width={300} height={150}>
          <Line dataKey="v" connectNulls dot={false} isAnimationActive={false} />
        </LineChart>
      </div>,
    )

    const path = container.querySelector('path.recharts-line-curve')
    expect(subPaths(path?.getAttribute('d') ?? null)).toBe(1)
  })

  it('cannot be told to connect nulls', () => {
    // connectNulls is not part of the props of GapLine; a caller that forces it anyway is ignored
    const forced: Record<string, unknown> = { connectNulls: true }
    const { container } = render(
      <div>
        <LineChart data={gapData} width={300} height={150}>
          <GapLine dataKey="v" dot={false} isAnimationActive={false} {...forced} />
        </LineChart>
      </div>,
    )

    const path = container.querySelector('path.recharts-line-curve')
    expect(subPaths(path?.getAttribute('d') ?? null)).toBe(2)
  })

  it('break an area at a null value', () => {
    const { container } = render(
      <div>
        <AreaChart data={gapData} width={300} height={150}>
          <GapArea dataKey="v" dot={false} isAnimationActive={false} />
        </AreaChart>
      </div>,
    )

    const curve = container.querySelector('path.recharts-area-curve')
    expect(subPaths(curve?.getAttribute('d') ?? null)).toBe(2)

    const connected = render(
      <div>
        <AreaChart data={gapData} width={300} height={150}>
          <Area dataKey="v" connectNulls dot={false} isAnimationActive={false} />
        </AreaChart>
      </div>,
    )
    const joined = connected.container.querySelector('path.recharts-area-curve')
    expect(subPaths(joined?.getAttribute('d') ?? null)).toBe(1)
  })
})

describe('ChartTooltipContent', () => {
  const payload = [
    { graphicalItemId: 'a', name: 'reads', dataKey: 'reads', value: 1200, color: 'var(--chart-1)' },
    { graphicalItemId: 'b', name: 'writes', dataKey: 'writes', value: 0, color: 'var(--chart-2)' },
  ]

  it('shows the label, the config label of each series and its value, zero included', async () => {
    // The tooltip reads the config of its container, so render it inside one.
    const { container } = render(
      <ChartContainer config={config}>
        <div>
          <ChartTooltipContent active payload={payload} label="12:00" />
        </div>
      </ChartContainer>,
    )

    const tooltip = container.querySelector('.grid.min-w-32')
    expect(tooltip).not.toBeNull()
    expect(tooltip).toHaveTextContent('Reads')
    expect(tooltip).toHaveTextContent('Writes')
    expect(tooltip).toHaveTextContent((1200).toLocaleString())
    // a value of 0 is a value, not a missing one
    expect(tooltip?.textContent).toMatch(/Writes\s*0/)
    expect(await axeViolations()).toEqual([])
  })

  it('renders nothing when inactive or empty', () => {
    const { container } = render(
      <ChartContainer config={config}>
        <div>
          <ChartTooltipContent active={false} payload={payload} />
          <ChartTooltipContent active payload={[]} />
        </div>
      </ChartContainer>,
    )

    expect(container.querySelector('.grid.min-w-32')).toBeNull()
  })

  it('formats through the formatter it is given, with the whole payload', () => {
    const formatter = vi.fn(() => <span>custom</span>)
    render(
      <ChartContainer config={config}>
        <div>
          <ChartTooltipContent active payload={payload} formatter={formatter} />
        </div>
      </ChartContainer>,
    )

    expect(screen.getAllByText('custom')).toHaveLength(2)
    expect(formatter).toHaveBeenCalledWith(1200, 'reads', payload[0], 0, payload)
  })
})

describe('ChartLegendContent', () => {
  it('labels each series from the config and falls back to the series name', () => {
    render(
      <ChartContainer config={config}>
        <div>
          <ChartLegendContent
            payload={[
              { value: 'reads', dataKey: 'reads', color: 'var(--chart-1)' },
              { value: 'unconfigured', dataKey: 'unconfigured', color: 'var(--chart-3)' },
            ]}
          />
        </div>
      </ChartContainer>,
    )

    expect(screen.getByText('Reads')).toBeInTheDocument()
    expect(screen.getByText('unconfigured')).toBeInTheDocument()
  })
})
