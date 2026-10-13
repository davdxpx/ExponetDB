// Derived from supabase/supabase packages/ui-patterns/src/Row/Row.utils.ts @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import { type RefObject, useLayoutEffect, useState } from 'react'

/** The width of an element in pixels, kept current while it resizes; `null` before the first measurement. */
export const useMeasuredWidth = <T extends HTMLElement>(ref: RefObject<T | null>) => {
  const [measuredWidth, setMeasuredWidth] = useState<number | null>(null)

  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return

    const initial = element.getBoundingClientRect().width
    setMeasuredWidth((prev) => (prev === initial ? prev : initial))

    if (typeof ResizeObserver !== 'undefined') {
      let frame = 0
      const resizeObserver = new ResizeObserver((entries) => {
        const width = entries[0]?.contentRect.width ?? 0
        if (frame) cancelAnimationFrame(frame)
        frame = requestAnimationFrame(() => {
          setMeasuredWidth((prev) => (prev === width ? prev : width))
        })
      })
      resizeObserver.observe(element)
      return () => {
        if (frame) cancelAnimationFrame(frame)
        resizeObserver.disconnect()
      }
    }

    const handleResize = () => {
      const width = element.getBoundingClientRect().width
      setMeasuredWidth((prev) => (prev === width ? prev : width))
    }
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [ref])

  return measuredWidth
}
