// Derived from supabase/supabase packages/ui/src/components/shadcn/ui/alert.tsx @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import { cva, type VariantProps } from 'class-variance-authority'
import * as React from 'react'

import { cn } from './lib/utils.ts'
import { StatusIcon } from './status-icon.tsx'

export const alertVariants = cva(
  cn(
    // Container
    'relative w-full text-sm rounded-lg border p-4',
    // Icon SVG: a direct child svg sits in the corner and pushes the text right
    '[&>svg~*]:pl-10 [&>svg]:absolute [&>svg]:left-4 [&>svg]:top-4',
  ),
  {
    variants: {
      variant: {
        default: 'bg-surface-200/25 border-default text-foreground',
        info: 'bg-info/10 border-info/40 text-foreground',
        success: 'bg-success-200 border-success-400 text-foreground',
        warning: 'bg-warning-200 border-warning-400 text-foreground',
        destructive: 'bg-destructive-200 border-destructive-400 text-foreground',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
)

type AlertVariant = NonNullable<VariantProps<typeof alertVariants>['variant']>

export type AlertProps = React.HTMLAttributes<HTMLDivElement> &
  VariantProps<typeof alertVariants> & {
    /**
     * The icon in the corner. By default the status icon of the variant, whose shape and
     * accessible name (Warning, Error, …) carry the meaning next to the color. Pass your
     * own node to replace it or `false` to leave it out.
     */
    icon?: React.ReactNode | false
  }

/**
 * `destructive` alerts are announced at once (`role="alert"`); the other variants are polite
 * status messages. Pass `role` to override.
 */
const Alert = React.forwardRef<HTMLDivElement, AlertProps>(
  ({ className, variant, icon, children, ...props }, ref) => {
    const resolvedVariant: AlertVariant = variant ?? 'default'

    return (
      <div
        ref={ref}
        data-slot="alert"
        role={resolvedVariant === 'destructive' ? 'alert' : 'status'}
        className={cn(alertVariants({ variant }), className)}
        {...props}
      >
        {icon === undefined ? (
          <StatusIcon variant={resolvedVariant} className="size-[23px] p-1" />
        ) : (
          icon || null
        )}
        {children}
      </div>
    )
  },
)
Alert.displayName = 'Alert'

const AlertTitle = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => (
  <p
    ref={ref}
    data-slot="alert-title"
    className={cn('mt-0! mb-0.5 font-medium', className)}
    {...props}
  />
))
AlertTitle.displayName = 'AlertTitle'

const AlertDescription = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, children, ...props }, ref) => {
    // Automatically wrap primitive text nodes (string/number) in <p> tags for semantic HTML
    const content =
      typeof children === 'string' || typeof children === 'number' ? <p>{children}</p> : children

    return (
      <div
        ref={ref}
        data-slot="alert-description"
        className={cn(
          'text-sm text-foreground-light font-normal',
          // Optically align text in container
          'mb-0.5',
          // Handle paragraphs (dense spacing)
          '[&_p]:mb-0.5 [&_p:last-child]:mb-0',
          className,
        )}
        {...props}
      >
        {content}
      </div>
    )
  },
)
AlertDescription.displayName = 'AlertDescription'

export { Alert, AlertDescription, AlertTitle }
