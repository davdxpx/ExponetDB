// Derived from supabase/supabase packages/ui-patterns/src/Row/index.tsx @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import { ChevronLeft, ChevronRight } from '@exponetdb/icons'
import { Button, cn, FloatingPlate } from '@exponetdb/ui'
import {
  Children,
  type CSSProperties,
  forwardRef,
  type HTMLAttributes,
  isValidElement,
  type KeyboardEventHandler,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
  type WheelEventHandler,
} from 'react'

import { useMeasuredWidth } from './row-utils.ts'

interface RowProps extends HTMLAttributes<HTMLDivElement> {
  // Maximum number of columns visible in the row at once
  maxColumns: number
  // Minimum width in pixels for each item before the row reduces the visible count
  minWidth: number
  children: ReactNode
  className?: string
  /** gap between items in pixels */
  gap?: number
  /** show left/right arrow buttons */
  showArrows?: boolean
  /** The accessible name of the scrollable region ("Recent plans"). */
  label?: string
}

export const resolveColumnsForWidth = ({
  width,
  maxColumns,
  minWidth,
  gap,
}: {
  width: number
  maxColumns: number
  minWidth: number
  gap: number
}) => {
  const denominator = minWidth + gap
  if (denominator <= 0) return Math.max(1, maxColumns)
  const fittedColumns = Math.floor((width + gap) / denominator)

  return Math.max(1, Math.min(maxColumns, fittedColumns))
}

/**
 * Whether the item at `index` shows (even partly) in the viewport at `scrollPosition`. Items
 * that do not are taken out of the tab order and the accessibility tree, so keyboard focus
 * never lands on something that is scrolled out of sight.
 */
export const isItemVisible = ({
  index,
  scrollPosition,
  viewportWidth,
  columnWidth,
  gap,
}: {
  index: number
  scrollPosition: number
  viewportWidth: number
  columnWidth: number
  gap: number
}) => {
  const start = index * (columnWidth + gap)
  const end = start + columnWidth
  return end > scrollPosition + 1 && start < scrollPosition + viewportWidth - 1
}

/**
 * A row of cards that shows as many columns as fit and scrolls sideways by column: arrow buttons
 * (only where there is something to scroll to), the left and right arrow keys on the focused
 * region, and a horizontal wheel or trackpad gesture. Items scrolled out of sight are `inert`.
 * Movement stops under `prefers-reduced-motion`.
 */
export const Row = forwardRef<HTMLDivElement, RowProps>(function Row(
  { maxColumns, minWidth, children, className, gap = 16, showArrows = true, label, ...rest },
  ref,
) {
  const containerRef = useRef<HTMLElement>(null)

  const items = useMemo(() => Children.toArray(children), [children])

  const [scrollPosition, setScrollPosition] = useState(0)
  const measuredWidth = useMeasuredWidth(containerRef)

  const numberOfColumns = useMemo(
    () =>
      resolveColumnsForWidth({
        width: measuredWidth ?? 0,
        maxColumns,
        minWidth,
        gap,
      }),
    [gap, maxColumns, measuredWidth, minWidth],
  )

  const columnWidth =
    measuredWidth === null ? 0 : (measuredWidth - (numberOfColumns - 1) * gap) / numberOfColumns

  const maxScroll = useMemo(() => {
    if (measuredWidth == null) return -1
    const totalWidth = items.length * columnWidth + (items.length - 1) * gap
    return Math.max(0, totalWidth - measuredWidth)
  }, [measuredWidth, columnWidth, items.length, gap])

  const scrollByStep = (direction: -1 | 1) => {
    const scrollAmount = columnWidth + gap
    setScrollPosition((prev) => {
      const next = Math.max(0, Math.min(maxScroll, prev + direction * scrollAmount))
      return next === prev ? prev : next
    })
  }

  const scrollLeft = () => scrollByStep(-1)
  const scrollRight = () => scrollByStep(1)

  const canScrollLeft = scrollPosition > 0
  const canScrollRight = scrollPosition < maxScroll

  const hasContentToScroll = items.length > numberOfColumns

  const rafIdRef = useRef(0)
  const pendingDeltaRef = useRef(0)

  useEffect(
    () => () => {
      if (rafIdRef.current) cancelAnimationFrame(rafIdRef.current)
    },
    [],
  )

  const handleWheel: WheelEventHandler<HTMLDivElement> = (e) => {
    // Only scroll sideways when horizontal intent wins. Trackpads report a small
    // deltaX on vertical scrolls, so a deltaX === 0 check would hijack them.
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return

    const delta = Math.abs(e.deltaX) * 2 * (e.deltaX > 0 ? 1 : -1)
    pendingDeltaRef.current += delta

    if (!rafIdRef.current) {
      rafIdRef.current = requestAnimationFrame(() => {
        rafIdRef.current = 0
        const accumulated = pendingDeltaRef.current
        pendingDeltaRef.current = 0
        setScrollPosition((prev) => {
          const target = prev + accumulated
          const next = Math.max(0, Math.min(maxScroll, target))
          return next === prev ? prev : next
        })
      })
    }
  }

  // Keep the position inside the range when the width or the number of items changes. Before the
  // first measurement `maxScroll` is -1: the position stays at 0 then, never below it.
  useEffect(() => {
    setScrollPosition((prev) => {
      const next = Math.max(0, Math.min(prev, maxScroll))
      return next === prev ? prev : next
    })
  }, [maxScroll])

  const handleKeyDown: KeyboardEventHandler<HTMLDivElement> = (e) => {
    if (e.key === 'ArrowLeft' && canScrollLeft) {
      e.preventDefault()
      scrollLeft()
    } else if (e.key === 'ArrowRight' && canScrollRight) {
      e.preventDefault()
      scrollRight()
    }
  }

  return (
    <div ref={ref} className={cn('relative w-full', className)} {...rest}>
      {showArrows && canScrollLeft && (
        <FloatingPlate rounded="full" className="absolute left-0 top-1/2 z-10 -translate-y-1/2">
          <Button
            onClick={scrollLeft}
            className="w-8 h-8 rounded-full p-2"
            aria-label="Scroll left"
          >
            <ChevronLeft aria-hidden="true" className="w-4 h-4" />
          </Button>
        </FloatingPlate>
      )}

      {showArrows && canScrollRight && hasContentToScroll && (
        <FloatingPlate rounded="full" className="absolute right-0 top-1/2 z-10 -translate-y-1/2">
          <Button
            onClick={scrollRight}
            className="w-8 h-8 rounded-full p-2"
            aria-label="Scroll right"
          >
            <ChevronRight aria-hidden="true" className="w-4 h-4" />
          </Button>
        </FloatingPlate>
      )}

      <section
        ref={containerRef}
        className="w-full overflow-x-clip focus-ring rounded-md"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: the region takes the arrow keys to scroll
        tabIndex={0}
        aria-roledescription="carousel"
        aria-label={label ?? 'Horizontally scrollable content'}
        style={{ overscrollBehaviorX: 'contain' }}
        onWheel={handleWheel}
        onKeyDown={handleKeyDown}
      >
        <div
          className="flex items-stretch min-w-full transition-transform duration-300 ease-out motion-reduce:transition-none"
          style={
            {
              gap: `${gap}px`,
              '--column-width': `calc((100% - ${(numberOfColumns - 1) * gap}px) / ${numberOfColumns})`,
              transform: `translateX(-${scrollPosition}px)`,
              willChange: 'transform',
            } as CSSProperties
          }
        >
          {items.map((child, index) => {
            const visible =
              measuredWidth === null ||
              measuredWidth <= 0 ||
              isItemVisible({
                index,
                scrollPosition,
                viewportWidth: measuredWidth,
                columnWidth,
                gap,
              })
            return (
              <div
                key={isValidElement(child) && child.key !== null ? child.key : String(child)}
                className="shrink-0"
                style={{ width: 'var(--column-width)' }}
                inert={!visible}
              >
                {child}
              </div>
            )
          })}
        </div>
      </section>
    </div>
  )
})

Row.displayName = 'Row'
