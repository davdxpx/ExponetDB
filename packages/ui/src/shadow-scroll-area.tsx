// Derived from supabase/supabase packages/ui/src/components/ShadowScrollArea/index.tsx @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import * as React from 'react'
import { useHorizontalScroll } from './hooks/use-horizontal-scroll.ts'
import { cn } from './lib/utils.ts'

interface ShadowScrollAreaProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode
  containerClassName?: string
  stickyLastColumn?: boolean
  outerContainerRef?: React.Ref<HTMLDivElement>
}

/**
 * A horizontally scrollable region with edge shadows that show where more content is. Note for
 * later: the sticky column logic belongs in `Table` (declared through a prop); this component
 * should only draw the shadows.
 *
 * While the content overflows, the region itself is a tab stop (so a keyboard user can scroll it)
 * and takes an inset focus ring; give it an `aria-label` and it is also exposed as a region.
 */
const ShadowScrollArea = React.forwardRef<HTMLDivElement, ShadowScrollAreaProps>(
  (
    {
      className,
      containerClassName,
      children,
      stickyLastColumn,
      outerContainerRef,
      tabIndex,
      ...props
    },
    ref,
  ) => {
    const containerRef = React.useRef<HTMLDivElement | null>(null)
    const { hasHorizontalScroll, canScrollLeft, canScrollRight } = useHorizontalScroll(containerRef)
    const setContainerRef = React.useCallback(
      (node: HTMLDivElement | null) => {
        containerRef.current = node
        if (typeof ref === 'function') {
          ref(node)
        } else if (ref) {
          ref.current = node
        }
      },
      [ref],
    )
    const isNamed = props['aria-label'] !== undefined || props['aria-labelledby'] !== undefined

    const stickyColumnShadow = cn(
      '[&_td:last-child]:before:absolute [&_td:last-child]:before:top-0 [&_td:last-child]:before:-left-6',
      '[&_td:last-child]:before:bottom-0 [&_td:last-child]:before:w-6 [&_td:last-child]:before:bg-linear-to-l',
      '[&_td:last-child]:before:from-black/5 dark:[&_td:last-child]:before:from-black/20 [&_td:last-child]:before:to-transparent',
      '[&_td:last-child]:before:opacity-0 [&_td:last-child]:before:transition-all [&_td:last-child]:before:duration-400',
      '[&_td:last-child]:before:easing-[0.24, 0.25, 0.05, 1] [&_td:last-child]:before:z-39',
      '[&_th:last-child]:before:absolute [&_th:last-child]:before:top-0 [&_th:last-child]:before:-left-6',
      '[&_th:last-child]:before:bottom-0 [&_th:last-child]:before:w-6 [&_th:last-child]:before:bg-linear-to-l',
      '[&_th:last-child]:before:from-black/5 dark:[&_th:last-child]:before:from-black/20 [&_th:last-child]:before:to-transparent',
      '[&_th:last-child]:before:opacity-0 [&_th:last-child]:before:transition-all [&_th:last-child]:before:duration-400',
      '[&_th:last-child]:before:easing-[0.24, 0.25, 0.05, 1] [&_th:last-child]:before:z-39',
    )

    // `min-w-0 max-w-full` on the outer box: inside a flex or grid parent the region shrinks to the
    // page and scrolls inside itself instead of widening the page to the width of its table.
    return (
      <div
        ref={outerContainerRef}
        className={cn(containerClassName, 'relative min-w-0 max-w-full')}
      >
        <div
          className={cn(
            'absolute inset-0 pointer-events-none z-38',
            'before:absolute before:top-0 before:right-0 before:bottom-0 before:w-6 before:bg-linear-to-l before:from-black/5 dark:before:from-black/20 before:to-transparent before:opacity-0 before:transition-all before:duration-400 before:easing-[0.24, 0.25, 0.05, 1]',
            'after:absolute after:top-0 after:left-0 after:bottom-0 after:w-6 after:bg-linear-to-r after:from-black/5 dark:after:from-black/20 after:to-transparent after:opacity-0 after:transition-all after:duration-400 after:easing-[0.24, 0.25, 0.05, 1]',
            hasHorizontalScroll && 'hover:before:opacity-100 hover:after:opacity-100',
            canScrollRight && 'before:opacity-100',
            canScrollLeft && 'after:opacity-100',
          )}
        />
        <div
          ref={setContainerRef}
          className={cn(
            'w-full overflow-auto',
            stickyLastColumn && [
              '[&_tr>*:last-child]:sticky [&_tr>*:last-child]:z-38 [&_tr>*:last-child]:right-0',
              // Sticky cells need an opaque base. `bg-surface-200` / `--muted` is alpha-based,
              // so using it alone lets scrolled row content show through on hover. Keep the
              // opaque surface-100 base and composite muted via background-image so hover
              // matches TableRow without becoming transparent.
              '[&_td:last-child]:bg-surface-100',
              '[&_tr:hover>td:last-child]:!bg-surface-100',
              '[&_tr:hover>td:last-child]:![background-image:linear-gradient(var(--background-surface-200),var(--background-surface-200))]',
              '[&_th:last-child]:bg-200',
              stickyColumnShadow,
            ],
            canScrollRight &&
              '[&_td]:before:opacity-100 [&_tr>*:last-child]:before:opacity-100 [&_th:last-child]:before:opacity-100',
            hasHorizontalScroll && 'focus-inset',
            className,
          )}
          tabIndex={tabIndex ?? (hasHorizontalScroll ? 0 : undefined)}
          role={hasHorizontalScroll && isNamed ? 'region' : undefined}
          {...props}
        >
          {children}
        </div>
      </div>
    )
  },
)

ShadowScrollArea.displayName = 'ShadowScrollArea'

export { ShadowScrollArea }
