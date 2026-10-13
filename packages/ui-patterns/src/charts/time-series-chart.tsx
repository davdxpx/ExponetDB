import {
  Alert,
  AlertDescription,
  CHART_SLOTS,
  type ChartConfig,
  ChartContainer,
  type ChartSlot,
  ChartTooltip,
  chartColor,
  cn,
  GapArea,
  GapLine,
} from '@exponetdb/ui'
import { type ReactNode, useId, useMemo } from 'react'
import {
  AreaChart,
  CartesianGrid,
  LineChart,
  ReferenceArea,
  ReferenceDot,
  XAxis,
  YAxis,
} from 'recharts'

import type { Readable } from '../readable.ts'
import { type ChartDataColumn, ChartDataTableToggle } from './chart-data-table.tsx'
import { ReadableChart, type ReadableChartProps } from './chart-states.tsx'
import { ClippedText, visibleText } from './clipped-text.tsx'
import {
  formatCompact,
  formatDateTime,
  formatNumber,
  formatTick,
  isDrawable,
  parseTime,
} from './format.ts'

/** One line or area of a time series. */
export interface TimeSeriesSeries {
  /** Identifies the series in each point's `values`. */
  readonly key: string
  /** Shown in the legend, the tooltip and the data table. Untrusted text: rendered as text only. */
  readonly label: string
  /** Chart color slot (1 to 8); by position when omitted. */
  readonly slot?: ChartSlot
}

/** The values of every series at one time. */
export interface TimeSeriesPoint {
  /** ISO 8601 time with an offset (`2026-10-13T09:05:00Z`). A point with any other time is left out and counted. */
  readonly time: string
  /**
   * The value of each series at this time. `null` is a gap: nothing was sampled,
   * and the chart never draws a line across it, never fills it and never reads
   * it as zero.
   */
  readonly values: Readonly<Record<string, number | null>>
  /**
   * Why a value is missing, by series key: "no samples: agent offline". Shown on
   * hover, in the gap list and in the data table. Only a reported cause is shown;
   * without one the chart says the cause is not reported.
   */
  readonly gaps?: Readonly<Record<string, string>>
}

export interface TimeSeriesChartProps
  extends Pick<
    ReadableChartProps<readonly TimeSeriesPoint[]>,
    'name' | 'now' | 'timeZone' | 'onRefresh' | 'onRetry' | 'emptyTitle' | 'emptyDescription'
  > {
  data: Readable<readonly TimeSeriesPoint[]>
  series: readonly TimeSeriesSeries[]
  /** `line` (default) draws one line per series; `area` also fills below it. */
  variant?: 'line' | 'area'
  /** Height of the plot in pixels (default 200). */
  height?: number
  /** Formats a value for the axis, tooltip and table (default: grouped number). */
  formatValue?: (value: number) => string
  className?: string
}

/** Line styles by position, so two series differ by more than their color. */
const DASHES: readonly (string | undefined)[] = [undefined, '6 3', '2 2', '8 3 2 3']
/** Gaps listed under the chart; the data table has the rest. */
const GAP_LIST_LIMIT = 6
const MINUTE_MS = 60_000

interface ResolvedSeries {
  readonly id: string
  readonly label: string
  readonly slot: ChartSlot
  readonly dash: string | undefined
}

export interface PreparedPoint {
  readonly t: number
  readonly values: readonly (number | null)[]
  readonly causes: readonly (string | undefined)[]
}

export interface GapRun {
  readonly seriesIndex: number
  readonly fromMs: number
  readonly toMs: number
  readonly count: number
  /** The distinct causes reported inside the run, in order. Empty when none was reported. */
  readonly causes: readonly string[]
}

function resolveSeries(series: readonly TimeSeriesSeries[]): ResolvedSeries[] {
  return series.map((entry, index) => ({
    id: `s${index}`,
    label: entry.label,
    slot:
      entry.slot !== undefined && CHART_SLOTS.includes(entry.slot)
        ? entry.slot
        : (CHART_SLOTS[index % CHART_SLOTS.length] ?? 1),
    dash: DASHES[index % DASHES.length],
  }))
}

/**
 * The points of a read as chart input: sorted by time, with a value that is not
 * a finite number turned into a gap and a point with an unreadable time left out
 * (and counted in `dropped`).
 */
export function prepareTimeSeries(
  points: readonly TimeSeriesPoint[],
  series: readonly TimeSeriesSeries[],
): { readonly prepared: readonly PreparedPoint[]; readonly dropped: number } {
  const prepared: PreparedPoint[] = []
  let dropped = 0
  for (const point of points) {
    const t = parseTime(point.time)
    if (!Number.isFinite(t)) {
      dropped += 1
      continue
    }
    prepared.push({
      t,
      values: series.map((entry) => {
        const value = point.values[entry.key]
        return isDrawable(value) ? value : null
      }),
      causes: series.map((entry) => point.gaps?.[entry.key]),
    })
  }
  prepared.sort((a, b) => a.t - b.t)
  return { prepared, dropped }
}

/** The runs of consecutive missing values of each series. */
export function findGapRuns(prepared: readonly PreparedPoint[], seriesCount: number): GapRun[] {
  const runs: GapRun[] = []
  for (let seriesIndex = 0; seriesIndex < seriesCount; seriesIndex += 1) {
    let start = -1
    const close = (endExclusive: number) => {
      if (start < 0) return
      const first = prepared[start]
      const last = prepared[endExclusive - 1]
      if (first === undefined || last === undefined) return
      const causes: string[] = []
      for (let i = start; i < endExclusive; i += 1) {
        const cause = prepared[i]?.causes[seriesIndex]
        if (cause !== undefined && cause !== '' && !causes.includes(cause)) causes.push(cause)
      }
      runs.push({
        seriesIndex,
        fromMs: first.t,
        toMs: last.t,
        count: endExclusive - start,
        causes,
      })
      start = -1
    }
    prepared.forEach((point, index) => {
      if (point.values[seriesIndex] === null) {
        if (start < 0) start = index
      } else {
        close(index)
      }
    })
    close(prepared.length)
  }
  return runs
}

/** The time spans in which every series is missing: the whole chart has nothing to draw there. */
function findBlankSpans(prepared: readonly PreparedPoint[]): { from: number; to: number }[] {
  const spans: { from: number; to: number }[] = []
  let start = -1
  const close = (endExclusive: number) => {
    if (start < 0) return
    const from = prepared[start - 1] ?? prepared[start]
    const to = prepared[endExclusive] ?? prepared[endExclusive - 1]
    if (from !== undefined && to !== undefined && to.t > from.t)
      spans.push({ from: from.t, to: to.t })
    start = -1
  }
  prepared.forEach((point, index) => {
    if (point.values.every((value) => value === null)) {
      if (start < 0) start = index
    } else {
      close(index)
    }
  })
  close(prepared.length)
  return spans
}

/** Points that have a value while both neighbors are missing: a line cannot show them, a dot does. */
function findIsolated(
  prepared: readonly PreparedPoint[],
  seriesCount: number,
): { seriesIndex: number; t: number; value: number }[] {
  const isolated: { seriesIndex: number; t: number; value: number }[] = []
  for (let seriesIndex = 0; seriesIndex < seriesCount; seriesIndex += 1) {
    prepared.forEach((point, index) => {
      const value = point.values[seriesIndex]
      if (!isDrawable(value)) return
      const before = index > 0 ? prepared[index - 1]?.values[seriesIndex] : null
      const after = prepared[index + 1]?.values[seriesIndex] ?? null
      if ((before ?? null) === null && after === null) {
        isolated.push({ seriesIndex, t: point.t, value })
      }
    })
  }
  return isolated
}

function pointsLabel(count: number): string {
  return count === 1 ? '1 point' : `${count} points`
}

/** What a gap run says in words: the series, the cause, the span. */
export function describeGapRun(run: GapRun, label: string, timeZone: string): string {
  const cause = run.causes.length > 0 ? run.causes.join('; ') : 'no data, cause not reported'
  const span =
    run.count === 1
      ? `at ${formatDateTime(run.fromMs, timeZone)}`
      : `${formatDateTime(run.fromMs, timeZone)} to ${formatDateTime(run.toMs, timeZone)}`
  return `${label}: ${cause} (${span}, ${pointsLabel(run.count)})`
}

function Swatch({ slot, dash }: { slot: ChartSlot; dash: string | undefined }): ReactNode {
  return (
    <svg aria-hidden="true" focusable="false" width="20" height="8" className="shrink-0">
      <line
        x1="1"
        x2="19"
        y1="4"
        y2="4"
        stroke={chartColor(slot)}
        strokeWidth="2"
        strokeLinecap="round"
        {...(dash === undefined ? {} : { strokeDasharray: dash })}
      />
    </svg>
  )
}

/** The content of the hover tooltip: the time and, per series, the value or the reason it is missing. */
export function TimeSeriesTooltip({
  active,
  point,
  series,
  formatValue,
  timeZone,
}: {
  active: boolean | undefined
  point: PreparedPoint | undefined
  series: readonly ResolvedSeries[]
  formatValue: (value: number) => string
  timeZone: string
}): ReactNode {
  if (!active || point === undefined) return null
  return (
    <div
      data-slot="tooltip"
      className="grid min-w-40 max-w-72 gap-1.5 rounded-lg border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-xl"
    >
      <div className="font-medium">{formatDateTime(point.t, timeZone)}</div>
      {series.map((entry, index) => {
        const value = point.values[index]
        const cause = point.causes[index]
        return (
          <div key={entry.id} className="flex items-start gap-2">
            <Swatch slot={entry.slot} dash={entry.dash} />
            <div className="min-w-0 flex-1">
              <span className="text-foreground-light">{visibleText(entry.label)}</span>
              {isDrawable(value) ? (
                <span className="ml-2 font-mono font-medium tabular-nums">
                  {formatValue(value)}
                </span>
              ) : (
                // UntrustedText: a cause is text reported by a node or a collector.
                <span className="block text-foreground">
                  {cause !== undefined && cause !== ''
                    ? visibleText(cause)
                    : 'No data, cause not reported'}
                </span>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function latestValues(
  prepared: readonly PreparedPoint[],
  series: readonly ResolvedSeries[],
  formatValue: (value: number) => string,
): string[] {
  const parts: string[] = []
  series.forEach((entry, index) => {
    for (let i = prepared.length - 1; i >= 0; i -= 1) {
      const value = prepared[i]?.values[index]
      if (isDrawable(value)) {
        parts.push(`${visibleText(entry.label)} ${formatValue(value)}`)
        return
      }
    }
    parts.push(`${visibleText(entry.label)} has no values`)
  })
  return parts
}

const TICK = { fill: 'var(--foreground-lighter)', fontSize: 10 } as const
const AXIS_STROKE = 'var(--border-default)'

function TimeSeriesView({
  name,
  points,
  series,
  variant,
  height,
  formatValue,
  timeZone,
  className,
}: {
  name: string
  points: readonly TimeSeriesPoint[]
  series: readonly TimeSeriesSeries[]
  variant: 'line' | 'area'
  height: number
  formatValue: ((value: number) => string) | undefined
  timeZone: string
  className: string | undefined
}): ReactNode {
  const captionId = useId()
  const resolved = useMemo(() => resolveSeries(series), [series])
  const { prepared, dropped } = useMemo(() => prepareTimeSeries(points, series), [points, series])
  const gapRuns = useMemo(() => findGapRuns(prepared, resolved.length), [prepared, resolved])
  const blankSpans = useMemo(() => findBlankSpans(prepared), [prepared])
  const isolated = useMemo(() => findIsolated(prepared, resolved.length), [prepared, resolved])
  const config = useMemo<ChartConfig>(() => {
    const entries: ChartConfig = {}
    for (const entry of resolved) {
      entries[entry.id] = { label: visibleText(entry.label), color: chartColor(entry.slot) }
    }
    return entries
  }, [resolved])
  const rows = useMemo(
    () =>
      prepared.map((point) => {
        const row: Record<string, number | null> = { t: point.t }
        resolved.forEach((entry, index) => {
          row[entry.id] = point.values[index] ?? null
        })
        return row
      }),
    [prepared, resolved],
  )

  const tooltipValue = formatValue ?? formatNumber
  const tickValue = formatValue ?? formatCompact

  const first = prepared[0]
  const last = prepared[prepared.length - 1]

  if (first === undefined || last === undefined) {
    return (
      <Alert variant="warning" data-state="unreadable">
        <AlertDescription>
          None of the {pointsLabel(points.length)} had a readable time, so nothing can be drawn.
        </AlertDescription>
      </Alert>
    )
  }

  const spanMs = last.t - first.t
  const domain: [number, number] =
    spanMs > 0 ? [first.t, last.t] : [first.t - MINUTE_MS, first.t + MINUTE_MS]
  const kind = variant === 'area' ? 'area chart' : 'line chart'
  const shownName = visibleText(name)
  const summary = `${shownName}, ${kind}, ${resolved.length === 1 ? '1 series' : `${resolved.length} series`}, ${pointsLabel(prepared.length)} from ${formatDateTime(first.t, timeZone)} to ${formatDateTime(last.t, timeZone)}. Latest: ${latestValues(prepared, resolved, tooltipValue).join('; ')}. ${gapRuns.length === 0 ? 'No gaps.' : `${gapRuns.length === 1 ? '1 gap' : `${gapRuns.length} gaps`} where nothing was sampled.`}`

  const columns: ChartDataColumn[] = [
    { id: 'time', header: `Time (${timeZone})` },
    ...resolved.map((entry) => ({
      id: entry.id,
      header: visibleText(entry.label),
      align: 'right' as const,
    })),
  ]
  const tableRows = prepared.map((point) => ({
    id: String(point.t),
    cells: [
      <time key="t" dateTime={new Date(point.t).toISOString()}>
        {formatDateTime(point.t, timeZone)}
      </time>,
      ...resolved.map((entry, index) => {
        const value = point.values[index]
        if (isDrawable(value)) return tooltipValue(value)
        const cause = point.causes[index]
        return (
          <span key={entry.id} className="text-foreground-light">
            No data
            {cause !== undefined && cause !== ''
              ? `: ${visibleText(cause)}`
              : ', cause not reported'}
          </span>
        )
      }),
    ],
  }))

  const axes = [
    <CartesianGrid key="grid" vertical={false} stroke={AXIS_STROKE} strokeOpacity={0.7} />,
    <XAxis
      key="x"
      dataKey="t"
      type="number"
      scale="time"
      domain={domain}
      tick={TICK}
      tickMargin={6}
      tickLine={false}
      axisLine={{ stroke: AXIS_STROKE }}
      tickFormatter={(value: unknown) =>
        typeof value === 'number' ? formatTick(value, spanMs, timeZone) : ''
      }
    />,
    <YAxis
      key="y"
      width={56}
      tick={TICK}
      tickLine={false}
      axisLine={false}
      tickFormatter={(value: unknown) => (typeof value === 'number' ? tickValue(value) : '')}
    />,
    ...blankSpans.map((span) => (
      <ReferenceArea
        key={`blank-${span.from}`}
        x1={span.from}
        x2={span.to}
        fill="var(--chart-muted-fill)"
        fillOpacity={1}
        stroke="var(--chart-muted)"
        strokeDasharray="3 3"
        ifOverflow="visible"
      />
    )),
    <ChartTooltip
      key="tooltip"
      filterNull={false}
      isAnimationActive={false}
      cursor={{ stroke: 'var(--border-strong)' }}
      content={(tooltip) => (
        <TimeSeriesTooltip
          active={tooltip.active}
          point={
            tooltip.activeIndex === undefined ? undefined : prepared[Number(tooltip.activeIndex)]
          }
          series={resolved}
          formatValue={tooltipValue}
          timeZone={timeZone}
        />
      )}
    />,
  ]
  const dots = isolated.map((dot) => {
    const entry = resolved[dot.seriesIndex]
    return entry === undefined ? null : (
      <ReferenceDot
        key={`dot-${entry.id}-${dot.t}`}
        x={dot.t}
        y={dot.value}
        r={2.5}
        fill={`var(--color-${entry.id})`}
        stroke="none"
        ifOverflow="visible"
      />
    )
  })

  const margin = { top: 8, right: 12, bottom: 0, left: 0 }
  const gapsShown = gapRuns.slice(0, GAP_LIST_LIMIT)

  return (
    <figure
      aria-label={shownName}
      aria-describedby={captionId}
      data-chart="time-series"
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
          {variant === 'area' ? (
            <AreaChart data={rows} margin={margin} accessibilityLayer={false}>
              {axes}
              {resolved.map((entry) => (
                <GapArea
                  key={entry.id}
                  dataKey={entry.id}
                  type="linear"
                  stroke={`var(--color-${entry.id})`}
                  strokeWidth={1.75}
                  {...(entry.dash === undefined ? {} : { strokeDasharray: entry.dash })}
                  fill={`var(--chart-${entry.slot}-fill)`}
                  fillOpacity={1}
                  dot={false}
                  activeDot={{ r: 3 }}
                  isAnimationActive={false}
                />
              ))}
              {dots}
            </AreaChart>
          ) : (
            <LineChart data={rows} margin={margin} accessibilityLayer={false}>
              {axes}
              {resolved.map((entry) => (
                <GapLine
                  key={entry.id}
                  dataKey={entry.id}
                  type="linear"
                  stroke={`var(--color-${entry.id})`}
                  strokeWidth={1.75}
                  {...(entry.dash === undefined ? {} : { strokeDasharray: entry.dash })}
                  dot={false}
                  activeDot={{ r: 3 }}
                  isAnimationActive={false}
                />
              ))}
              {dots}
            </LineChart>
          )}
        </ChartContainer>
      </div>
      <ul aria-label="Legend" className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {resolved.map((entry) => (
          <li key={entry.id} className="flex min-w-0 items-center gap-1.5">
            <Swatch slot={entry.slot} dash={entry.dash} />
            <span className="text-foreground-light">
              <ClippedText text={entry.label} limit={48} />
            </span>
          </li>
        ))}
      </ul>
      {gapRuns.length > 0 ? (
        <div className="mt-2 text-xs" data-slot="gaps">
          <p className="font-medium text-foreground-light">
            Gaps: nothing was sampled, so no line is drawn across them
          </p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-foreground-light">
            {gapsShown.map((run) => {
              const label = resolved[run.seriesIndex]?.label ?? ''
              return (
                <li key={`${run.seriesIndex}-${run.fromMs}`}>
                  {/* UntrustedText: the label and the causes are text from the registry and collectors. */}
                  <ClippedText text={describeGapRun(run, label, timeZone)} limit={200} />
                </li>
              )
            })}
          </ul>
          {gapRuns.length > gapsShown.length ? (
            <p className="mt-1 text-foreground-lighter">
              And {gapRuns.length - gapsShown.length} more in the data table.
            </p>
          ) : null}
        </div>
      ) : null}
      {dropped > 0 ? (
        <p className="mt-2 text-xs text-foreground-lighter">
          {dropped === 1
            ? '1 point with an unreadable time was left out.'
            : `${dropped} points with an unreadable time were left out.`}
        </p>
      ) : null}
      <ChartDataTableToggle className="mt-2" name={shownName} columns={columns} rows={tableRows} />
    </figure>
  )
}

/**
 * A line or area chart of values over time in which a missing value is a gap
 * (C-28): the line breaks, nothing is interpolated or read as zero, and the
 * cause is shown on hover, in a list under the chart and in the data table.
 * The chart is a picture of its data table; the caption and the table are the
 * text alternative.
 */
export function TimeSeriesChart({
  name,
  data,
  series,
  variant = 'line',
  height = 200,
  formatValue,
  timeZone = 'UTC',
  now,
  onRefresh,
  onRetry,
  emptyTitle,
  emptyDescription,
  className,
}: TimeSeriesChartProps): ReactNode {
  return (
    <ReadableChart
      name={name}
      readable={data}
      isEmpty={(points) => points.length === 0}
      height={height}
      timeZone={timeZone}
      {...(now === undefined ? {} : { now })}
      {...(onRefresh ? { onRefresh } : {})}
      {...(onRetry ? { onRetry } : {})}
      {...(emptyTitle === undefined ? {} : { emptyTitle })}
      {...(emptyDescription === undefined ? {} : { emptyDescription })}
    >
      {(points) => (
        <TimeSeriesView
          name={name}
          points={points}
          series={series}
          variant={variant}
          height={height}
          formatValue={formatValue}
          timeZone={timeZone}
          className={className}
        />
      )}
    </ReadableChart>
  )
}
