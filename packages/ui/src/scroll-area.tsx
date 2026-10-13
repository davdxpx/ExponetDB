// Derived from supabase/supabase packages/ui/src/components/shadcn/ui/scroll-area.tsx @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import { ScrollArea as ScrollAreaPrimitive } from 'radix-ui'
import * as React from 'react'

import { cn } from './lib/utils.ts'

/**
 * Radix hides the native scrollbar of the viewport with a `<style>` element it renders itself.
 * Under a strict `style-src` that element is blocked, so the rule is also set here through the
 * `style` prop (a CSSOM write, allowed). The `::-webkit-scrollbar` half cannot be written inline
 * and lives in the static stylesheet of the Web App; `scrollbar-width` covers current browsers.
 */
const hiddenNativeScrollbar: React.CSSProperties = {
  scrollbarWidth: 'none',
  msOverflowStyle: 'none',
}

const ScrollArea = React.forwardRef<
  React.ComponentRef<typeof ScrollAreaPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.Root> & {
    /** Which scrollbars the area offers. Defaults to the vertical one. */
    orientation?: 'vertical' | 'horizontal' | 'both'
  }
>(({ className, children, orientation = 'vertical', ...props }, ref) => (
  <ScrollAreaPrimitive.Root
    ref={ref}
    className={cn('relative overflow-hidden', className)}
    {...props}
  >
    <ScrollAreaPrimitive.Viewport
      className="h-full w-full rounded-[inherit]"
      style={hiddenNativeScrollbar}
    >
      {children}
    </ScrollAreaPrimitive.Viewport>
    {orientation !== 'horizontal' && <ScrollBar orientation="vertical" />}
    {orientation !== 'vertical' && <ScrollBar orientation="horizontal" />}
    <ScrollAreaPrimitive.Corner />
  </ScrollAreaPrimitive.Root>
))
ScrollArea.displayName = 'ScrollArea'

const ScrollViewport = React.forwardRef<
  React.ComponentRef<typeof ScrollAreaPrimitive.Viewport>,
  React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.Viewport>
>(({ className, children, style, ...props }, ref) => (
  <ScrollAreaPrimitive.Viewport
    ref={ref}
    className={cn('size-full rounded-[inherit]', className)}
    style={{ ...hiddenNativeScrollbar, ...style }}
    {...props}
  >
    {children}
  </ScrollAreaPrimitive.Viewport>
))

ScrollViewport.displayName = 'ScrollViewport'

const ScrollBar = React.forwardRef<
  React.ComponentRef<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>,
  React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>
>(({ className, orientation = 'vertical', ...props }, ref) => (
  <ScrollAreaPrimitive.ScrollAreaScrollbar
    ref={ref}
    orientation={orientation}
    className={cn(
      'flex touch-none select-none transition-colors',
      orientation === 'vertical' && 'h-full w-2.5 border-l border-l-transparent p-px',
      orientation === 'horizontal' && 'h-2.5 border-t border-t-transparent p-px',
      className,
    )}
    {...props}
  >
    <ScrollAreaPrimitive.ScrollAreaThumb className="relative flex-1 rounded-full bg-border" />
  </ScrollAreaPrimitive.ScrollAreaScrollbar>
))
ScrollBar.displayName = 'ScrollBar'

export { ScrollArea, ScrollBar, ScrollViewport }
