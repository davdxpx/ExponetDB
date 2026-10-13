import { act, renderHook } from '@testing-library/react'
import { createRef } from 'react'
import { describe, expect, it } from 'vitest'

import { useHorizontalScroll } from '../src/hooks/use-horizontal-scroll.ts'

function scroller({
  scrollWidth,
  clientWidth,
  scrollLeft,
}: {
  scrollWidth: number
  clientWidth: number
  scrollLeft: number
}) {
  const element = document.createElement('div')
  Object.defineProperty(element, 'scrollWidth', { configurable: true, value: scrollWidth })
  Object.defineProperty(element, 'clientWidth', { configurable: true, value: clientWidth })
  element.scrollLeft = scrollLeft
  const ref = createRef<HTMLDivElement>()
  ;(ref as { current: HTMLDivElement | null }).current = element
  return { element, ref }
}

describe('useHorizontalScroll', () => {
  it('reports no scroll when the content fits', () => {
    const { ref } = scroller({ scrollWidth: 300, clientWidth: 300, scrollLeft: 0 })

    const { result } = renderHook(() => useHorizontalScroll(ref))

    expect(result.current).toEqual({
      hasHorizontalScroll: false,
      canScrollLeft: false,
      canScrollRight: false,
    })
  })

  it('reports room to the right at the start of an overflowing element', () => {
    const { ref } = scroller({ scrollWidth: 900, clientWidth: 300, scrollLeft: 0 })

    const { result } = renderHook(() => useHorizontalScroll(ref))

    expect(result.current).toEqual({
      hasHorizontalScroll: true,
      canScrollLeft: false,
      canScrollRight: true,
    })
  })

  it('follows the scroll position', () => {
    const { element, ref } = scroller({ scrollWidth: 900, clientWidth: 300, scrollLeft: 0 })
    const { result } = renderHook(() => useHorizontalScroll(ref))

    act(() => {
      element.scrollLeft = 200
      element.dispatchEvent(new Event('scroll'))
    })
    expect(result.current.canScrollLeft).toBe(true)
    expect(result.current.canScrollRight).toBe(true)

    act(() => {
      element.scrollLeft = 600
      element.dispatchEvent(new Event('scroll'))
    })
    expect(result.current.canScrollLeft).toBe(true)
    expect(result.current.canScrollRight).toBe(false)
  })

  it('measures again when the window is resized', () => {
    const { element, ref } = scroller({ scrollWidth: 900, clientWidth: 300, scrollLeft: 0 })
    const { result } = renderHook(() => useHorizontalScroll(ref))
    expect(result.current.hasHorizontalScroll).toBe(true)

    act(() => {
      Object.defineProperty(element, 'clientWidth', { configurable: true, value: 900 })
      window.dispatchEvent(new Event('resize'))
    })
    expect(result.current.hasHorizontalScroll).toBe(false)
    expect(result.current.canScrollRight).toBe(false)
  })

  it('does nothing without an element', () => {
    const ref = createRef<HTMLDivElement>()

    const { result } = renderHook(() => useHorizontalScroll(ref))

    expect(result.current.hasHorizontalScroll).toBe(false)
  })
})
