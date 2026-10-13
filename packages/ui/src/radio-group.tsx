// Derived from supabase/supabase packages/ui/src/components/shadcn/ui/radio-group.tsx @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import { Circle } from '@exponetdb/icons'
import { RadioGroup as RadioGroupPrimitive } from 'radix-ui'
import * as React from 'react'

import { cn } from './lib/utils.ts'

const RadioGroup = React.forwardRef<
  React.ElementRef<typeof RadioGroupPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Root>
>(({ className, ...props }, ref) => {
  return (
    <RadioGroupPrimitive.Root
      className={cn('relative grid gap-2', className)}
      {...props}
      ref={ref}
    />
  )
})
RadioGroup.displayName = RadioGroupPrimitive.Root.displayName

const RadioGroupItem = React.forwardRef<
  React.ElementRef<typeof RadioGroupPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Item>
>(({ className, ...props }, ref) => {
  return (
    <RadioGroupPrimitive.Item
      ref={ref}
      className={cn(
        'relative aspect-square h-4 w-4 rounded-full border border-primary text-primary focus-ring disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    >
      <RadioGroupPrimitive.Indicator className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2">
        <Circle size={10} strokeWidth={0} className="fill-current text-current" />
      </RadioGroupPrimitive.Indicator>
    </RadioGroupPrimitive.Item>
  )
})
RadioGroupItem.displayName = RadioGroupPrimitive.Item.displayName

interface RadioGroupLargeItemProps {
  label: string
  showIndicator?: boolean
}

/** A card-sized radio with an indicator and a text label under optional children (an image, say). */
const RadioGroupLargeItem = React.forwardRef<
  React.ElementRef<typeof RadioGroupPrimitive.Item>,
  RadioGroupLargeItemProps & React.ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Item>
>(({ children, className, label, showIndicator = true, ...props }, ref) => {
  return (
    <RadioGroupPrimitive.Item
      ref={ref}
      {...props}
      className={cn(
        'flex flex-col gap-2',
        'w-48',
        'bg-surface-200',
        'rounded-md border border-strong',
        'p-2',
        'shadow-xs',
        'focus-ring',
        'hover:border-control-hover focus-visible:border-control-hover hover:bg-surface-300',
        'data-[state=checked]:bg-selection data-[state=checked]:border-control-hover',
        'disabled:cursor-not-allowed disabled:opacity-50',
        'transition-colors',
        'group',
        className,
      )}
    >
      {children}
      <span className="flex gap-2 w-full">
        {showIndicator && (
          <span aria-hidden className="relative w-3 h-3 min-w-3 mt-0.5">
            <RadioGroupPrimitive.Indicator
              className={cn(
                'absolute',
                'w-[10px] h-[10px]',
                'left-px top-px',
                'border border-background-surface-300',
                'rounded-full',
                'data-[state=checked]:border-background-surface-300',
                'data-[state=checked]:ring-foreground',
                'data-[state=checked]:bg-foreground',
              )}
            />
            <span
              className={cn(
                'absolute',
                'w-3 h-3',
                'border border-stronger',
                'rounded-full',
                'group-hover:border-control-hover',
                'group-focus-visible:border-control-hover',
                'group-data-[state=checked]:border-control-hover',
                'transition-colors',
              )}
            />
          </span>
        )}

        <span
          className={cn(
            'text-xs transition-colors text-left',
            'text-light',
            'group-hover:text-foreground group-data-[state=checked]:text-foreground',
            props.disabled ? 'cursor-not-allowed' : 'cursor-pointer',
          )}
        >
          {label}
        </span>
      </span>
    </RadioGroupPrimitive.Item>
  )
})

RadioGroupLargeItem.displayName = 'RadioGroupLargeItem'

export { RadioGroup, RadioGroupItem, RadioGroupLargeItem }
