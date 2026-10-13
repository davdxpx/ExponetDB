import '@testing-library/jest-dom/vitest'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Sparkline, sparklineRuns } from '../../src/charts/sparkline.tsx'

afterEach(cleanup)

describe('sparklineRuns', () => {
  it('breaks the line at a missing value instead of connecting across it', () => {
    const runs = sparklineRuns([1, 2, null, 4, 5], 100, 20)
    expect(runs.map((run) => run.points.length)).toEqual([2, 2])
  })

  it('treats a value that is not a finite number as missing', () => {
    const runs = sparklineRuns([1, Number.NaN, 3, Number.POSITIVE_INFINITY, 5], 100, 20)
    expect(runs.map((run) => run.points.length)).toEqual([1, 1, 1])
  })

  it('keeps the place of a missing sample, so the spacing stays even', () => {
    const [first, second] = sparklineRuns([1, null, 3], 100, 20)
    expect(first?.points[0]?.x).toBe(2)
    expect(second?.points[0]?.x).toBe(98)
  })

  it('draws a larger value higher and a flat series in the middle', () => {
    const [rising] = sparklineRuns([0, 10], 100, 20)
    const low = rising?.points[0]
    const high = rising?.points[1]
    expect(low && high && high.y < low.y).toBe(true)
    const [flat] = sparklineRuns([5, 5, 5], 100, 20)
    expect(new Set(flat?.points.map((point) => point.y))).toEqual(new Set([10]))
  })

  it('uses the shared bounds when they are given', () => {
    const [run] = sparklineRuns([5, 5], 100, 20, 0, 10)
    expect(run?.points[0]?.y).toBe(10)
    const [top] = sparklineRuns([10, 10], 100, 20, 0, 10)
    expect(top?.points[0]?.y).toBe(2)
  })

  it('has no runs when nothing can be drawn', () => {
    expect(sparklineRuns([], 100, 20)).toEqual([])
    expect(sparklineRuns([null, null], 100, 20)).toEqual([])
  })
})

describe('Sparkline', () => {
  it('is a decorative polyline in a chart color slot', () => {
    const { container } = render(<Sparkline values={[1, 3, 2]} slot={3} />)
    const svg = container.querySelector('svg')
    expect(svg).toHaveAttribute('aria-hidden', 'true')
    expect(svg).toHaveAttribute('focusable', 'false')
    const line = container.querySelector('polyline')
    expect(line).toHaveAttribute('stroke', 'var(--chart-3)')
    expect(line?.getAttribute('points')?.split(' ')).toHaveLength(3)
  })

  it('draws one polyline per run and a dot for an isolated sample', () => {
    const { container } = render(<Sparkline values={[1, 2, null, 5, null, 7, 8]} />)
    expect(container.querySelectorAll('polyline')).toHaveLength(2)
    expect(container.querySelectorAll('circle')).toHaveLength(1)
  })

  it('falls back to the first slot for a slot that does not exist', () => {
    const forced = 99 as unknown as 1
    const { container } = render(<Sparkline values={[1, 2]} slot={forced} />)
    expect(container.querySelector('polyline')).toHaveAttribute('stroke', 'var(--chart-1)')
  })

  it('shows a dashed baseline, not a flat line of data, when there are no samples', () => {
    const { container } = render(<Sparkline values={[null, null, null]} />)
    expect(container.querySelector('polyline')).toBeNull()
    expect(container.querySelector('line')).toHaveAttribute('stroke-dasharray')
  })
})
