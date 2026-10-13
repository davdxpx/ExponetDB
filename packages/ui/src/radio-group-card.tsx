// Derived from supabase/supabase packages/ui/src/components/radio-group-card.tsx @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import { Circle } from '@exponetdb/icons'
import { RadioGroup as RadioGroupPrimitive } from 'radix-ui'
import * as React from 'react'

import { cn } from './lib/utils.ts'

const RadioGroupCard = React.forwardRef<
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
RadioGroupCard.displayName = RadioGroupPrimitive.Root.displayName

interface RadioGroupCardItemProps {
  label: React.ReactNode
  showIndicator?: boolean
}

/** A card-shaped radio. The accessible name is the label; children (an image, say) sit above it. */
const RadioGroupCardItem = React.forwardRef<
  React.ElementRef<typeof RadioGroupPrimitive.Item>,
  RadioGroupCardItemProps & React.ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Item>
>(({ id: idProp, children, className, label, showIndicator = true, ...props }, ref) => {
  const generatedId = React.useId()
  const id = idProp || generatedId
  return (
    <RadioGroupPrimitive.Item
      ref={ref}
      id={id}
      aria-labelledby={`${id}-label`}
      {...props}
      className={cn(
        'flex flex-col gap-2',
        'w-48',
        'bg-overlay',
        'rounded-md',
        'border',
        'p-2',
        'hover:border-control-hover',
        'hover:z-1 focus-visible:z-1 focus-visible:border-control-hover',
        'focus-ring',
        'disabled:cursor-not-allowed disabled:opacity-50',
        'transition-colors',
        'group',
        'data-[state=checked]:border-control-hover',
        className,
      )}
    >
      {children}
      <span className="flex gap-2 w-full" id={`${id}-label`}>
        {showIndicator && (
          <span
            aria-hidden
            className="
                aspect-square h-4 w-4
                rounded-full border group-data-[state=checked]:border-control-hover
                group-focus:border-control-hover
                group-hover:border-control-hover
                flex items-center justify-center
                transition-colors
          "
          >
            <RadioGroupPrimitive.Indicator className="flex items-center justify-center">
              <Circle className="h-2.5 w-2.5 fill-current text-current" />
            </RadioGroupPrimitive.Indicator>
          </span>
        )}

        <span
          className={cn(
            'w-full',
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

RadioGroupCardItem.displayName = 'RadioGroupCardItem'

export { RadioGroupCard, RadioGroupCardItem }
