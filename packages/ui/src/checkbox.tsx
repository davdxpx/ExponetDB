// Derived from supabase/supabase packages/ui/src/components/shadcn/ui/checkbox.tsx @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import { Check } from '@exponetdb/icons'
import { Checkbox as CheckboxPrimitive } from 'radix-ui'
import * as React from 'react'

import { getExplicitTabIndex } from './lib/get-explicit-tab-index.ts'
import { cn } from './lib/utils.ts'

const Checkbox = React.forwardRef<
  React.ElementRef<typeof CheckboxPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>
>(({ className, disabled, tabIndex, ...props }, ref) => {
  const computedTabIndex = getExplicitTabIndex(tabIndex, disabled)

  return (
    <CheckboxPrimitive.Root
      ref={ref}
      className={cn(
        'peer flex cursor-pointer items-center justify-center h-4 w-4 shrink-0 rounded-sm border border-control bg-control/25 ring-offset-background',
        'transition-colors duration-150 ease-in-out',
        'hover:border-strong',
        'focus-ring',
        'disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-foreground data-[state=checked]:text-background data-[state=indeterminate]:bg-foreground data-[state=indeterminate]:text-background',
        className,
      )}
      {...props}
      disabled={disabled}
      tabIndex={computedTabIndex}
    >
      <CheckboxPrimitive.Indicator
        className={cn('group/indicator flex items-center justify-center text-current')}
      >
        <Check
          aria-hidden
          className="h-3 w-3 text-background group-data-[state=indeterminate]/indicator:hidden"
          strokeWidth={4}
        />
        {/* Partially selected (checked="indeterminate"): a dash instead of the check mark. */}
        <span
          aria-hidden
          className="hidden h-0.5 w-2 rounded-full bg-background group-data-[state=indeterminate]/indicator:block"
        />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  )
})
Checkbox.displayName = CheckboxPrimitive.Root.displayName

export { Checkbox }
