// Derived from supabase/supabase packages/ui/src/components/shadcn/ui/combobox-trigger.tsx @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import { ChevronDown } from '@exponetdb/icons'
import * as React from 'react'
import { getExplicitTabIndex } from './lib/get-explicit-tab-index.ts'
import { cn } from './lib/utils.ts'
import { type SelectTriggerVariantProps, selectTriggerVariants } from './select-trigger.tsx'

const ComboboxTrigger = React.forwardRef<
  HTMLButtonElement,
  Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'size'> & SelectTriggerVariantProps
>(({ className, children, disabled, size, tabIndex, ...props }, ref) => {
  const computedTabIndex = getExplicitTabIndex(tabIndex, disabled)

  return (
    <button
      ref={ref}
      type="button"
      role="combobox"
      // A combobox needs both; a popover trigger that wraps this component overrides them.
      aria-expanded={false}
      aria-haspopup="listbox"
      disabled={disabled}
      className={cn(selectTriggerVariants({ size }), className)}
      tabIndex={computedTabIndex}
      {...props}
    >
      <span className="min-w-0 flex-1 truncate text-left">{children}</span>
      <ChevronDown
        aria-hidden="true"
        className="h-4 w-4 shrink-0 text-foreground-lighter"
        strokeWidth={1.5}
      />
    </button>
  )
})
ComboboxTrigger.displayName = 'ComboboxTrigger'

export { ComboboxTrigger }
