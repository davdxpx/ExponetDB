// Derived from supabase/supabase packages/ui/src/components/radio-group-stacked.tsx @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import { Circle } from '@exponetdb/icons'
import { RadioGroup as RadioGroupPrimitive } from 'radix-ui'
import * as React from 'react'

import { cn } from './lib/utils.ts'

const RadioGroupStacked = React.forwardRef<
  React.ElementRef<typeof RadioGroupPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Root>
>(({ className, ...props }, ref) => {
  return (
    <RadioGroupPrimitive.Root
      className={cn('relative flex flex-col -space-y-px w-full', className)}
      {...props}
      ref={ref}
    />
  )
})

RadioGroupStacked.displayName = 'RadioGroupStacked'

interface RadioGroupStackedItemProps {
  label: React.ReactNode
  showIndicator?: boolean
  description?: React.ReactNode
}

/** A full-width radio row for stacked lists. The accessible name is the label; the description is read after it. */
const RadioGroupStackedItem = React.forwardRef<
  React.ElementRef<typeof RadioGroupPrimitive.Item>,
  RadioGroupStackedItemProps & React.ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Item>
>(
  (
    { id: idProp, children, className, description, label, showIndicator = true, ...props },
    ref,
  ) => {
    const generatedId = React.useId()
    const id = idProp || generatedId
    return (
      <RadioGroupPrimitive.Item
        ref={ref}
        id={id}
        aria-labelledby={`${id}-label`}
        aria-describedby={description ? `${id}-description` : undefined}
        {...props}
        className={cn(
          // Base layout and sizing
          'flex flex-col gap-2 w-full',
          // Base styles
          'bg-overlay/50 border shadow-xs',
          'first-of-type:rounded-t-lg last-of-type:rounded-b-lg',
          // Disabled state
          'disabled:opacity-50 disabled:cursor-not-allowed',
          // Enabled/hover states
          'enabled:cursor-pointer enabled:hover:bg-surface-300 enabled:hover:border-control-hover',
          // Focus state
          'focus-ring enabled:focus-visible:border-control-hover',
          // Z-index for interactions
          'hover:z-1 focus-visible:z-1 data-[state=checked]:z-1',
          // Checked state
          'data-[state=checked]:bg-surface-300 data-[state=checked]:border-control-hover',
          // Colors only: avoid bare `transition` so the focus ring does not animate
          'transition-colors group',
          className,
        )}
      >
        <span className="flex gap-3 w-full px-[21px] py-3">
          {showIndicator && (
            <span
              aria-hidden
              className={cn(
                // Base styles
                'aspect-square h-4 w-4 min-w-4 min-h-4 rounded-full border relative',
                'flex items-center justify-center',
                // States
                'group-data-[state=checked]:border-control-hover',
                'group-focus-visible:border-control-hover',
                'group-hover:border-control-hover transition-colors',
              )}
            >
              <RadioGroupPrimitive.Indicator className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2">
                <Circle size={10} strokeWidth={0} className="fill-current text-current" />
              </RadioGroupPrimitive.Indicator>
            </span>
          )}
          <span className="flex flex-col gap-0.25 items-start">
            <span
              id={`${id}-label`}
              className={cn(
                // Base styles
                'block mt-[-0.15rem] text-sm text-left text-light',
                // Transitions
                'transition-colors',
                // States
                'enabled:group-hover:text-foreground group-data-[state=checked]:text-foreground',
              )}
            >
              {label}
            </span>
            {description ? (
              <span
                id={`${id}-description`}
                className="block text-left text-sm text-foreground-lighter text-balance"
              >
                {description}
              </span>
            ) : null}
            {children}
          </span>
        </span>
      </RadioGroupPrimitive.Item>
    )
  },
)

RadioGroupStackedItem.displayName = 'RadioGroupStackedItem'

export { RadioGroupStacked, RadioGroupStackedItem }
