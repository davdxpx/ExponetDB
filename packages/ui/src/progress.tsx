// Derived from supabase/supabase packages/ui/src/components/shadcn/ui/progress.tsx @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import { Progress as ProgressPrimitive } from 'radix-ui'
import * as React from 'react'

import { cn } from './lib/utils.ts'

/**
 * A progress bar. Name it with `aria-label` or `aria-labelledby` ("Backup upload"). With a
 * `value` it is determinate (`aria-valuenow` is set and the fill is proportional to
 * `value / max`); without one it is indeterminate and pulses, except for people who ask
 * for reduced motion. Show the number or the step as text beside the bar when it matters:
 * the bar alone is an approximation.
 */
const Progress = React.forwardRef<
  React.ComponentRef<typeof ProgressPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof ProgressPrimitive.Root>
>(({ className, value, max = 100, ...props }, ref) => {
  const determinate = typeof value === 'number' && max > 0
  // An indeterminate bar shows a pulsing partial fill: busy, not done.
  const percent = determinate ? Math.min(100, Math.max(0, (value / max) * 100)) : 35

  return (
    <ProgressPrimitive.Root
      ref={ref}
      value={value}
      max={max}
      className={cn('relative h-1 w-full overflow-hidden rounded-full bg-surface-300', className)}
      {...props}
    >
      <ProgressPrimitive.Indicator
        className="h-full w-full flex-1 bg-foreground transition-all data-[state=indeterminate]:motion-safe:animate-pulse"
        // A style prop is a CSSOM write, allowed under style-src 'self'.
        style={{ transform: `translateX(-${100 - percent}%)` }}
      />
    </ProgressPrimitive.Root>
  )
})
Progress.displayName = ProgressPrimitive.Root.displayName

export { Progress }
