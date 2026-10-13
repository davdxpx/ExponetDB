import { CHART_SLOTS, type ChartSlot, chartColor } from '@exponetdb/ui'
import type { ReactNode } from 'react'

import { isDrawable } from './format.ts'

export interface SparklineProps {
  /**
   * One value per sample, evenly spaced. `null` (or a value that is not a finite
   * number) is a gap: the line breaks there and is never drawn across it.
   */
  values: readonly (number | null)[]
  width?: number
  height?: number
  slot?: ChartSlot
  /**
   * The lowest and highest value of the shared scale. Rows of a table pass the
   * same bounds so their lines are comparable; by default the series' own.
   */
  min?: number
  max?: number
  className?: string
}

const PADDING = 2

interface Run {
  readonly points: readonly { readonly x: number; readonly y: number }[]
}

/** The runs of consecutive drawable values, positioned in a `width` by `height` box. */
export function sparklineRuns(
  values: readonly (number | null)[],
  width: number,
  height: number,
  min?: number,
  max?: number,
): readonly Run[] {
  const drawable = values.filter(isDrawable)
  if (drawable.length === 0) return []
  const low = min ?? Math.min(...drawable)
  const high = max ?? Math.max(...drawable)
  const span = high - low
  const innerWidth = width - PADDING * 2
  const innerHeight = height - PADDING * 2
  const stepX = values.length > 1 ? innerWidth / (values.length - 1) : 0
  const runs: { x: number; y: number }[][] = []
  let current: { x: number; y: number }[] | null = null
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]
    if (!isDrawable(value)) {
      current = null
      continue
    }
    // A flat series sits in the middle of the box instead of on an edge.
    const ratio = span > 0 ? (value - low) / span : 0.5
    const point = {
      x: values.length > 1 ? PADDING + stepX * index : width / 2,
      y: PADDING + innerHeight * (1 - Math.min(1, Math.max(0, ratio))),
    }
    if (current === null) {
      current = [point]
      runs.push(current)
    } else {
      current.push(point)
    }
  }
  return runs.map((points) => ({ points }))
}

/**
 * A small trend line (SVG `polyline`), decorative: it is hidden from assistive
 * technology and the numbers it stands for belong in text next to it. A missing
 * sample breaks the line; an isolated sample is drawn as a dot, so a value
 * between two gaps is not lost.
 */
export function Sparkline({
  values,
  width = 96,
  height = 24,
  slot = 1,
  min,
  max,
  className,
}: SparklineProps): ReactNode {
  const safeSlot: ChartSlot = CHART_SLOTS.includes(slot) ? slot : 1
  const color = chartColor(safeSlot)
  const runs = sparklineRuns(values, width, height, min, max)
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      data-slot="sparkline"
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      className={className}
    >
      {runs.length === 0 ? (
        <line
          x1={PADDING}
          x2={width - PADDING}
          y1={height / 2}
          y2={height / 2}
          stroke="var(--border-default)"
          strokeWidth={1}
          strokeDasharray="2 3"
        />
      ) : (
        runs.map((run, index) => {
          const first = run.points[0]
          if (first === undefined) return null
          const key = `${index}-${first.x}`
          return run.points.length === 1 ? (
            <circle key={key} cx={first.x} cy={first.y} r={1.75} fill={color} />
          ) : (
            <polyline
              key={key}
              fill="none"
              stroke={color}
              strokeWidth={1.5}
              strokeLinejoin="round"
              strokeLinecap="round"
              points={run.points.map((point) => `${point.x},${point.y}`).join(' ')}
            />
          )
        })
      )}
    </svg>
  )
}
