import { afterEach, beforeEach, vi } from 'vitest'

/**
 * jsdom has no layout, so a responsive chart measures 0 by 0 and draws nothing.
 * Call once at the top of a test file: every element then reports a 640 by 240
 * box, which is what the chart is drawn into.
 */
export function mockChartLayout(width = 640, height = 240): void {
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width,
      height,
      top: 0,
      left: 0,
      right: width,
      bottom: height,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    })
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })
}
