// Derived from supabase/supabase packages/ui/src/components/shadcn/ui/badge.tsx @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import { cva, type VariantProps } from 'class-variance-authority'
import * as React from 'react'

import { cn } from './lib/utils.ts'

const badgeVariants = cva(
  'inline-flex items-center gap-1 justify-center rounded-full font-normal whitespace-nowrap tracking-[0.07em] uppercase font-medium text-[9px] leading-none px-[5.5px] py-[3px]',
  {
    variants: {
      variant: {
        default: 'bg-surface-75 text-foreground-light border border-strong',
        warning: 'bg-warning/10 text-warning-600 border border-warning-500',
        success: 'bg-success/10 text-success-600 border border-success-500',
        destructive: 'bg-destructive/10 text-destructive border border-border-destructive',
        // Secondary is invisible
        secondary:
          'bg-secondary/50 hover:bg-secondary/80 border-transparent text-secondary-foreground',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

// Forward refs in order to allow tooltips to be applied to the badge
const Badge = React.forwardRef<HTMLDivElement, BadgeProps>(
  ({ className, variant = 'default', children, ...props }, ref) => {
    return (
      <div ref={ref} className={cn(badgeVariants({ variant }), className)} {...props}>
        {children}
      </div>
    )
  },
)
Badge.displayName = 'Badge'

export { Badge }
