import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useIsMobile } from '../src/hooks/use-mobile.tsx'

type Listener = () => void

function stubViewport(width: number) {
  const listeners = new Set<Listener>()
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width })
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        matches: width < 768,
        media: query,
        addEventListener: (_type: string, listener: Listener) => listeners.add(listener),
        removeEventListener: (_type: string, listener: Listener) => listeners.delete(listener),
      }) as unknown as MediaQueryList,
  )
  return {
    resize(next: number) {
      Object.defineProperty(window, 'innerWidth', {
        configurable: true,
        writable: true,
        value: next,
      })
      for (const listener of listeners) listener()
    },
    listeners,
  }
}

describe('useIsMobile', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('is true below the 768px breakpoint', () => {
    stubViewport(500)

    const { result } = renderHook(() => useIsMobile())
    expect(result.current).toBe(true)
  })

  it('is false at and above the breakpoint', () => {
    stubViewport(768)

    const { result } = renderHook(() => useIsMobile())
    expect(result.current).toBe(false)
  })

  it('follows the viewport and stops listening on unmount', () => {
    const viewport = stubViewport(1200)

    const { result, unmount } = renderHook(() => useIsMobile())
    expect(result.current).toBe(false)

    act(() => viewport.resize(400))
    expect(result.current).toBe(true)

    expect(viewport.listeners.size).toBe(1)
    unmount()
    expect(viewport.listeners.size).toBe(0)
  })
})
