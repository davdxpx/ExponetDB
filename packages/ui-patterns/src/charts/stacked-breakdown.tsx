import {
  CHART_SLOTS,
  type ChartConfig,
  ChartContainer,
  type ChartSlot,
  ChartTooltip,
  chartColor,
  cn,
} from '@exponetdb/ui'
import { type ReactNode, useId, useMemo } from 'react'
import { Bar, CartesianGrid, ComposedChart, LabelList, Line, XAxis, YAxis } from 'recharts'

import type { Readable } from '../readable.ts'
import { type ChartDataColumn, ChartDataTableToggle } from './chart-data-table.tsx'
import { ReadableChart, type ReadableChartProps } from './chart-states.tsx'
import { ClippedText, clipVisible, visibleText } from './clipped-text.tsx'
import { formatCompact, formatNumber, isDrawable } from './format.ts'

/** One part of every bar (a state, a schema, an outcome). */
export interface BreakdownSegment {
  /** Identifies the segment in each bar's `values`. */
  readonly key: string
  /** Shown in the legend, the tooltip and the data table. Untrusted text: rendered as text only. */
  readonly label: string
  /** Chart color slot (1 to 8); by position when omitted. */
  readonly slot?: ChartSlot
}

/** One bar: a category (a database, a time bucket) split into segments. */
export interface BreakdownBar {
  readonly id: string
  /** The category name on the axis. Untrusted text: rendered as text only. */
  readonly label: string
  /**
   * The size of each segment. `null` means the value was not read: the segment
   * is not drawn, the total is shown as "at least", and the reason is listed.
   * A negative or non-finite number is treated the same way.
   */
  readonly values: Readonly<Record<string, number | null>>
  /** Why a segment was not read, by segment key. */
  readonly notRead?: Readonly<Record<string, string>>
}

export interface StackedBreakdownProps
  extends Pick<
    ReadableChartProps<readonly BreakdownBar[]>,
    'name' | 'now' | 'timeZone' | 'onRefresh' | 'onRetry' | 'emptyTitle' | 'emptyDescription'
  > {
  data: Readable<readonly BreakdownBar[]>
  segments: readonly BreakdownSegment[]
  /** Height of the plot in pixels (default 220). */
  height?: number
  /** Formats a value for the axis, tooltip and table (default: grouped number). */
  formatValue?: (value: number) => string
  className?: string
}

/** Characters of a category name kept on the axis; the tooltip and the table show it whole. */
const TICK_LIMIT = 14
/** Unread values listed under the chart; the data table has the rest. */
const UNREAD_LIST_LIMIT = 6

interface ResolvedSegment {
  readonly id: string
  readonly label: string
  readonly slot: ChartSlot
}

export interface PreparedBar {
  readonly label: string
  readonly values: readonly (number | null)[]
  readonly causes: readonly (string | undefined)[]
  /** Sum of the values that were read. */
  readonly total: number
  /** How many segments were not read; the total is then a lower bound. */
  readonly unread: number
}

function resolveSegments(segments: readonly BreakdownSegment[]): ResolvedSegment[] {
  return segments.map((segment, index) => ({
    id: `s${index}`,
    label: segment.label,
    slot:
      segment.slot !== undefined && CHART_SLOTS.includes(segment.slot)
        ? segment.slot
        : (CHART_SLOTS[index % CHART_SLOTS.length] ?? 1),
  }))
}

/** The bars with their totals; a segment that is not a finite, non-negative number counts as not read. */
export function prepareBreakdown(
  bars: readonly BreakdownBar[],
  segments: readonly BreakdownSegment[],
): PreparedBar[] {
  return bars.map((bar) => {
    const values = segments.map((segment) => {
      const value = bar.values[segment.key]
      return isDrawable(value) && value >= 0 ? value : null
    })
    return {
      label: bar.label,
      values,
      causes: segments.map((segment) => bar.notRead?.[segment.key]),
      total: values.reduce<number>((sum, value) => sum + (value ?? 0), 0),
      unread: values.filter((value) => value === null).length,
    }
  })
}

/** The total of a bar in words: "120", or "at least 120" when some values were not read. */
export function describeTotal(bar: PreparedBar, formatValue: (value: number) => string): string {
  if (bar.unread === 0) return formatValue(bar.total)
  const unread = bar.unread === 1 ? '1 value' : `${bar.unread} values`
  return `at least ${formatValue(bar.total)} (${unread} not read)`
}

function totalLabel(bar: PreparedBar, formatValue: (value: number) => string): string {
  return bar.unread === 0 ? formatValue(bar.total) : `≥ ${formatValue(bar.total)}`
}

function Swatch({ slot }: { slot: ChartSlot }): ReactNode {
  return (
    <span
      aria-hidden="true"
      className="size-2.5 shrink-0 rounded-[2px]"
      style={{ backgroundColor: chartColor(slot) }}
    />
  )
}

/** The hover tooltip: the category, each segment's value or reason, and the total. */
export function StackedBreakdownTooltip({
  active,
  bar,
  segments,
  formatValue,
}: {
  active: boolean | undefined
  bar: PreparedBar | undefined
  segments: readonly ResolvedSegment[]
  formatValue: (value: number) => string
}): ReactNode {
  if (!active || bar === undefined) return null
  return (
    <div
      data-slot="tooltip"
      className="grid min-w-40 max-w-72 gap-1.5 rounded-lg border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-xl"
    >
      <div className="font-medium">{visibleText(bar.label)}</div>
      {segments.map((segment, index) => {
        const value = bar.values[index]
        const cause = bar.causes[index]
        return (
          <div key={segment.id} className="flex items-start gap-2">
            <Swatch slot={segment.slot} />
            <div className="min-w-0 flex-1">
              <span className="text-foreground-light">{visibleText(segment.label)}</span>
              {isDrawable(value) ? (
                <span className="ml-2 font-mono font-medium tabular-nums">
                  {formatValue(value)}
                </span>
              ) : (
                // UntrustedText: a reason is text reported by a collector.
                <span className="block text-foreground">
                  Not read{cause !== undefined && cause !== '' ? `: ${visibleText(cause)}` : ''}
                </span>
              )}
            </div>
          </div>
        )
      })}
      <div className="border-t pt-1.5 font-medium">Total: {describeTotal(bar, formatValue)}</div>
    </div>
  )
}

const TICK = { fill: 'var(--foreground-lighter)', fontSize: 10 } as const
const AXIS_STROKE = 'var(--border-default)'

function StackedBreakdownView({
  name,
  bars,
  segments,
  height,
  formatValue,
  className,
}: {
  name: string
  bars: readonly BreakdownBar[]
  segments: readonly BreakdownSegment[]
  height: number
  formatValue: ((value: number) => string) | undefined
  className: string | undefined
}): ReactNode {
  const captionId = useId()
  const resolved = useMemo(() => resolveSegments(segments), [segments])
  const prepared = useMemo(() => prepareBreakdown(bars, segments), [bars, segments])
  const tooltipValue = formatValue ?? formatNumber
  const tickValue = formatValue ?? formatCompact
  const config = useMemo<ChartConfig>(() => {
    const entries: ChartConfig = {}
    for (const segment of resolved) {
      entries[segment.id] = { label: visibleText(segment.label), color: chartColor(segment.slot) }
    }
    return entries
  }, [resolved])
  const rows = useMemo(
    () =>
      prepared.map((bar, index) => {
        const row: Record<string, number | string | null> = {
          x: index,
          total: bar.total,
          totalText: totalLabel(bar, tooltipValue),
        }
        resolved.forEach((segment, position) => {
          row[segment.id] = bar.values[position] ?? null
        })
        return row
      }),
    [prepared, resolved, tooltipValue],
  )

  const unreadItems = prepared.flatMap((bar) =>
    resolved.flatMap((segment, index) =>
      bar.values[index] === null
        ? [
            {
              key: `${bar.label}-${segment.id}`,
              text: `${bar.label}: ${segment.label} not read${
                bar.causes[index] ? ` (${bar.causes[index]})` : ' (cause not reported)'
              }`,
            },
          ]
        : [],
    ),
  )

  const largest = prepared.reduce<PreparedBar | undefined>(
    (best, bar) => (best === undefined || bar.total > best.total ? bar : best),
    undefined,
  )
  const shownName = visibleText(name)
  const summary = `${shownName}, stacked bar chart, ${prepared.length === 1 ? '1 bar' : `${prepared.length} bars`} with ${resolved.length === 1 ? '1 segment' : `${resolved.length} segments`}.${
    largest === undefined
      ? ''
      : ` Largest total: ${visibleText(largest.label)}, ${describeTotal(largest, tooltipValue)}.`
  } ${unreadItems.length === 0 ? 'Every value was read.' : `${unreadItems.length === 1 ? '1 value was' : `${unreadItems.length} values were`} not read; those totals are lower bounds.`}`

  const columns: ChartDataColumn[] = [
    { id: 'category', header: 'Category' },
    ...resolved.map((segment) => ({
      id: segment.id,
      header: visibleText(segment.label),
      align: 'right' as const,
    })),
    { id: 'total', header: 'Total', align: 'right' as const },
  ]
  const tableRows = prepared.map((bar, rowIndex) => ({
    id: `${rowIndex}-${bar.label}`,
    cells: [
      <ClippedText key="label" text={bar.label} limit={60} />,
      ...resolved.map((segment, index) => {
        const value = bar.values[index]
        if (isDrawable(value)) return tooltipValue(value)
        const cause = bar.causes[index]
        return (
          <span key={segment.id} className="text-foreground-light">
            Not read{cause !== undefined && cause !== '' ? `: ${visibleText(cause)}` : ''}
          </span>
        )
      }),
      describeTotal(bar, tooltipValue),
    ],
  }))
  const unreadShown = unreadItems.slice(0, UNREAD_LIST_LIMIT)

  return (
    <figure
      aria-label={shownName}
      aria-describedby={captionId}
      data-chart="stacked-breakdown"
      className={cn('m-0', className)}
    >
      <figcaption id={captionId} className="sr-only">
        {summary}
      </figcaption>
      {/* The picture repeats the data table below; assistive technology reads the caption and the table. */}
      <div aria-hidden="true" data-slot="plot">
        <ChartContainer
          config={config}
          className="aspect-auto w-full"
          style={{ height }}
          initialDimension={{ width: 640, height }}
        >
          <ComposedChart
            data={rows}
            margin={{ top: 22, right: 12, bottom: 0, left: 0 }}
            accessibilityLayer={false}
          >
            <CartesianGrid vertical={false} stroke={AXIS_STROKE} strokeOpacity={0.7} />
            <XAxis
              dataKey="x"
              tick={TICK}
              tickMargin={6}
              tickLine={false}
              axisLine={{ stroke: AXIS_STROKE }}
              tickFormatter={(value: unknown) => {
                const bar = typeof value === 'number' ? prepared[value] : undefined
                return bar === undefined ? '' : clipVisible(bar.label, TICK_LIMIT)
              }}
            />
            <YAxis
              width={56}
              tick={TICK}
              tickLine={false}
              axisLine={false}
              tickFormatter={(value: unknown) =>
                typeof value === 'number' ? tickValue(value) : ''
              }
            />
            <ChartTooltip
              filterNull={false}
              isAnimationActive={false}
              cursor={{ fill: 'var(--chart-muted-fill)' }}
              content={(tooltip) => (
                <StackedBreakdownTooltip
                  active={tooltip.active}
                  bar={
                    tooltip.activeIndex === undefined
                      ? undefined
                      : prepared[Number(tooltip.activeIndex)]
                  }
                  segments={resolved}
                  formatValue={tooltipValue}
                />
              )}
            />
            {resolved.map((segment) => (
              <Bar
                key={segment.id}
                dataKey={segment.id}
                stackId="breakdown"
                fill={`var(--color-${segment.id})`}
                stroke="var(--background)"
                strokeWidth={1}
                maxBarSize={48}
                isAnimationActive={false}
              />
            ))}
            {/* An invisible line through the totals carries their labels above the bars. */}
            <Line
              dataKey="total"
              stroke="none"
              dot={false}
              activeDot={false}
              legendType="none"
              tooltipType="none"
              isAnimationActive={false}
            >
              <LabelList
                dataKey="totalText"
                position="top"
                fill="var(--foreground-light)"
                fontSize={10}
              />
            </Line>
          </ComposedChart>
        </ChartContainer>
      </div>
      <ul aria-label="Legend" className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {resolved.map((segment) => (
          <li key={segment.id} className="flex min-w-0 items-center gap-1.5">
            <Swatch slot={segment.slot} />
            <span className="text-foreground-light">
              <ClippedText text={segment.label} limit={48} />
            </span>
          </li>
        ))}
      </ul>
      {unreadItems.length > 0 ? (
        <div className="mt-2 text-xs" data-slot="not-read">
          <p className="font-medium text-foreground-light">
            Not read: these totals are lower bounds, marked with ≥
          </p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-foreground-light">
            {unreadShown.map((item) => (
              <li key={item.key}>
                {/* UntrustedText: the category, segment and reason are text from the registry and collectors. */}
                <ClippedText text={item.text} limit={200} />
              </li>
            ))}
          </ul>
          {unreadItems.length > unreadShown.length ? (
            <p className="mt-1 text-foreground-lighter">
              And {unreadItems.length - unreadShown.length} more in the data table.
            </p>
          ) : null}
        </div>
      ) : null}
      <ChartDataTableToggle className="mt-2" name={shownName} columns={columns} rows={tableRows} />
    </figure>
  )
}

/**
 * Stacked bars with a total above each bar: a category (a database, a time
 * bucket) split into segments (states, outcomes). A value that was not read is
 * not drawn as zero: the bar's total is marked "at least" (≥) and the reason is
 * listed. The caption and the data table are the text alternative.
 */
export function StackedBreakdown({
  name,
  data,
  segments,
  height = 220,
  formatValue,
  timeZone,
  now,
  onRefresh,
  onRetry,
  emptyTitle,
  emptyDescription,
  className,
}: StackedBreakdownProps): ReactNode {
  return (
    <ReadableChart
      name={name}
      readable={data}
      isEmpty={(bars) => bars.length === 0}
      height={height}
      {...(timeZone === undefined ? {} : { timeZone })}
      {...(now === undefined ? {} : { now })}
      {...(onRefresh ? { onRefresh } : {})}
      {...(onRetry ? { onRetry } : {})}
      {...(emptyTitle === undefined ? {} : { emptyTitle })}
      {...(emptyDescription === undefined ? {} : { emptyDescription })}
    >
      {(bars) => (
        <StackedBreakdownView
          name={name}
          bars={bars}
          segments={segments}
          height={height}
          formatValue={formatValue}
          className={className}
        />
      )}
    </ReadableChart>
  )
}
