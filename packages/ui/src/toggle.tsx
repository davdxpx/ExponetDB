// Derived from supabase/supabase packages/ui/src/components/shadcn/ui/toggle.tsx @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import { cva, type VariantProps } from 'class-variance-authority'
import { Toggle as TogglePrimitive } from 'radix-ui'
import * as React from 'react'

import { cn } from './lib/utils.ts'

const toggleVariants = cva(
  'inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors text-foreground-light data-[state=on]:bg-accent data-[state=on]:text-foreground aria-checked:bg-accent aria-checked:text-foreground focus-ring disabled:pointer-events-none disabled:opacity-50 bg-surface-200 hover:bg-muted px-3 py-1 h-auto',
  {
    variants: {
      variant: {
        default: 'bg-transparent',
        outline:
          'bg-transparent border border-control hover:bg-accent hover:text-accent-foreground',
        segmented:
          'relative z-10 cursor-pointer rounded-sm bg-transparent hover:bg-transparent text-foreground-light hover:text-foreground data-[state=on]:bg-transparent data-[state=on]:text-foreground aria-checked:bg-transparent aria-checked:text-foreground',
      },
      size: {
        tiny: 'h-[26px] px-2.5 text-xs',
        default: 'h-10 px-3',
        sm: 'h-[34px] px-2.5',
        lg: 'h-11 px-5',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
)

const Toggle = React.forwardRef<
  React.ElementRef<typeof TogglePrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof TogglePrimitive.Root> & VariantProps<typeof toggleVariants>
>(({ className, variant, size, ...props }, ref) => (
  <TogglePrimitive.Root
    ref={ref}
    className={cn(toggleVariants({ variant, size, className }))}
    tabIndex={0}
    {...props}
  />
))

Toggle.displayName = TogglePrimitive.Root.displayName

export { Toggle, toggleVariants }
