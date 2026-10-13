import {
  type ChartSlot,
  cn,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@exponetdb/ui'
import type { ReactNode } from 'react'

import type { Readable } from '../readable.ts'
import { ReadableChart, type ReadableChartProps } from './chart-states.tsx'
import { ClippedText, visibleText } from './clipped-text.tsx'
import { formatNumber, isDrawable } from './format.ts'
import { Sparkline } from './sparkline.tsx'

/** One row of a top-N table. */
export interface TopNRow {
  readonly id: string
  /**
   * What the row is (a statement, a role, a table). Untrusted text: rendered as
   * text only, truncated with a control to show the whole value.
   */
  readonly label: string
  /** The ranked value, in text. `null` means it was not read. */
  readonly value: number | null
  /** The samples behind the trend line, oldest first. `null` is a missing sample: a gap in the line. */
  readonly trend: readonly (number | null)[]
  /** A short remark under the label, such as why a value was not read. Untrusted text. */
  readonly note?: string
}

export interface TopNTableProps
  extends Pick<
    ReadableChartProps<readonly TopNRow[]>,
    'name' | 'now' | 'timeZone' | 'onRefresh' | 'onRetry' | 'emptyTitle' | 'emptyDescription'
  > {
  /** Rows in rank order: the first row is rank 1. */
  data: Readable<readonly TopNRow[]>
  /** Header of the label column: "Statement". */
  labelHeader: string
  /** Header of the value column: "Total time". */
  valueHeader: string
  /** Header of the trend column (default "Trend"). */
  trendHeader?: string
  /** The period of the trend, for the text alternative: "over the last hour". */
  trendSpan?: string
  /** At most this many rows are shown (default 10); the table says how many it left out. */
  limit?: number
  /** Formats the value column (default: grouped number). */
  formatValue?: (value: number) => string
  /** Draws every trend on one scale instead of each on its own. */
  sharedScale?: boolean
  /** Chart color slot of the trend lines (default 1). */
  slot?: ChartSlot
  /** Replaces the label cell, for example with a link the caller builds from typed values. */
  renderLabel?: (row: TopNRow) => ReactNode
  /** Height of the loading skeleton in pixels (default 220). */
  height?: number
  className?: string
}

/** The trend in words, for assistive technology: where it starts and ends, its range and its gaps. */
export function describeTrend(
  values: readonly (number | null)[],
  span: string,
  formatValue: (value: number) => string,
): string {
  const drawable = values.filter(isDrawable)
  const first = drawable[0]
  const last = drawable[drawable.length - 1]
  if (first === undefined || last === undefined) return `No samples ${span}`
  const missing = values.length - drawable.length
  return `Trend ${span}: from ${formatValue(first)} to ${formatValue(last)}, lowest ${formatValue(
    Math.min(...drawable),
  )}, highest ${formatValue(Math.max(...drawable))}${
    missing > 0 ? `, ${missing} of ${values.length} samples missing` : ''
  }`
}

function TopNView({
  name,
  rows,
  labelHeader,
  valueHeader,
  trendHeader,
  trendSpan,
  limit,
  formatValue,
  sharedScale,
  slot,
  renderLabel,
  className,
}: {
  name: string
  rows: readonly TopNRow[]
  labelHeader: string
  valueHeader: string
  trendHeader: string
  trendSpan: string
  limit: number
  formatValue: (value: number) => string
  sharedScale: boolean
  slot: ChartSlot
  renderLabel: ((row: TopNRow) => ReactNode) | undefined
  className: string | undefined
}): ReactNode {
  const shownName = visibleText(name)
  const shown = rows.slice(0, Math.max(1, limit))
  const scale = (() => {
    if (!sharedScale) return {}
    const all = shown.flatMap((row) => row.trend.filter(isDrawable))
    return all.length === 0 ? {} : { min: Math.min(...all), max: Math.max(...all) }
  })()
  return (
    <div className={cn('flex flex-col gap-1', className)} data-chart="top-n">
      <Table containerProps={{ 'aria-label': `${shownName}, table` }}>
        <caption className="sr-only">
          {shownName}: the top {shown.length} by {valueHeader.toLowerCase()}
        </caption>
        <TableHeader>
          <TableRow>
            <TableHead scope="col" className="w-10 px-3">
              Rank
            </TableHead>
            <TableHead scope="col" className="px-3">
              {labelHeader}
            </TableHead>
            <TableHead scope="col" className="px-3 text-right">
              {valueHeader}
            </TableHead>
            <TableHead scope="col" className="px-3">
              {trendHeader}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {shown.map((row, index) => {
            const drawable = row.trend.filter(isDrawable)
            const peak = drawable.length === 0 ? undefined : Math.max(...drawable)
            return (
              <TableRow key={row.id}>
                <TableCell className="px-3 py-2 text-xs tabular-nums text-foreground-lighter">
                  {index + 1}
                </TableCell>
                <th scope="row" className="px-3 py-2 text-left align-middle font-normal">
                  {/* UntrustedText: a label is a statement, a role or a name from a target. */}
                  {renderLabel ? renderLabel(row) : <ClippedText text={row.label} limit={80} />}
                  {row.note ? (
                    <span className="block text-xs text-foreground-lighter">
                      <ClippedText text={row.note} limit={120} />
                    </span>
                  ) : null}
                </th>
                <TableCell className="px-3 py-2 text-right font-mono tabular-nums">
                  {isDrawable(row.value) ? formatValue(row.value) : 'Not read'}
                </TableCell>
                <TableCell className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    <Sparkline values={row.trend} slot={slot} {...scale} />
                    {peak === undefined ? null : (
                      <span
                        aria-hidden="true"
                        className="text-xs tabular-nums text-foreground-lighter"
                      >
                        peak {formatValue(peak)}
                      </span>
                    )}
                    <span className="sr-only">
                      {describeTrend(row.trend, trendSpan, formatValue)}
                    </span>
                  </div>
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
      {rows.length > shown.length ? (
        <p className="text-xs text-foreground-lighter">
          Showing the top {shown.length} of {rows.length} rows in {shownName}.
        </p>
      ) : null}
    </div>
  )
}

/**
 * A ranked table of the biggest consumers (statements, roles, tables) with an
 * inline trend line per row. The numbers are in text cells; the line is a
 * decorative SVG `polyline` hidden from assistive technology, with the trend
 * described in words next to it. A missing sample breaks the line.
 */
export function TopNTable({
  name,
  data,
  labelHeader,
  valueHeader,
  trendHeader = 'Trend',
  trendSpan = 'over the period',
  limit = 10,
  formatValue = formatNumber,
  sharedScale = false,
  slot = 1,
  renderLabel,
  height = 220,
  timeZone,
  now,
  onRefresh,
  onRetry,
  emptyTitle,
  emptyDescription,
  className,
}: TopNTableProps): ReactNode {
  return (
    <ReadableChart
      name={name}
      readable={data}
      isEmpty={(rows) => rows.length === 0}
      height={height}
      {...(timeZone === undefined ? {} : { timeZone })}
      {...(now === undefined ? {} : { now })}
      {...(onRefresh ? { onRefresh } : {})}
      {...(onRetry ? { onRetry } : {})}
      {...(emptyTitle === undefined ? {} : { emptyTitle })}
      {...(emptyDescription === undefined ? {} : { emptyDescription })}
    >
      {(rows) => (
        <TopNView
          name={name}
          rows={rows}
          labelHeader={labelHeader}
          valueHeader={valueHeader}
          trendHeader={trendHeader}
          trendSpan={trendSpan}
          limit={limit}
          formatValue={formatValue}
          sharedScale={sharedScale}
          slot={slot}
          renderLabel={renderLabel}
          className={className}
        />
      )}
    </ReadableChart>
  )
}
