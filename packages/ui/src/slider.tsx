// Derived from supabase/supabase packages/ui/src/components/shadcn/ui/slider.tsx @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import { Slider as SliderPrimitive } from 'radix-ui'
import * as React from 'react'

import { cn } from './lib/utils.ts'

/**
 * A slider with one thumb per value. Every thumb needs an accessible name:
 * `aria-label` or `aria-labelledby` name a single thumb, `thumbLabels` names each
 * thumb of a range (Radix falls back to "Minimum" and "Maximum" for two).
 */
function Slider({
  className,
  defaultValue,
  value,
  min = 0,
  max = 100,
  thumbLabels,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledby,
  ...props
}: React.ComponentProps<typeof SliderPrimitive.Root> & {
  thumbLabels?: readonly string[]
}) {
  const _values = React.useMemo(
    () => (Array.isArray(value) ? value : Array.isArray(defaultValue) ? defaultValue : [min]),
    [value, defaultValue, min],
  )

  return (
    <SliderPrimitive.Root
      data-slot="slider"
      defaultValue={defaultValue}
      value={value}
      min={min}
      max={max}
      className={cn('relative flex w-full touch-none select-none items-center', className)}
      {...props}
    >
      <SliderPrimitive.Track
        data-slot="slider-track"
        className="relative h-1 w-full grow overflow-hidden rounded-full bg-border-stronger"
      >
        <SliderPrimitive.Range
          data-slot="slider-range"
          className="absolute h-full bg-foreground-muted"
        />
      </SliderPrimitive.Track>
      {Array.from({ length: _values.length }, (_, index) => (
        <SliderPrimitive.Thumb
          data-slot="slider-thumb"
          // The thumbs have no identity beyond their position.
          // biome-ignore lint/suspicious/noArrayIndexKey: one thumb per value, in order
          key={index}
          aria-label={thumbLabels?.[index] ?? (_values.length === 1 ? ariaLabel : undefined)}
          aria-labelledby={_values.length === 1 ? ariaLabelledby : undefined}
          className="block h-5 w-5 rounded-full border-2 border-background-surface-100 bg-foreground transition-colors focus-ring disabled:pointer-events-none disabled:opacity-50"
        />
      ))}
    </SliderPrimitive.Root>
  )
}

export { Slider }
