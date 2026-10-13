// Derived from supabase/supabase packages/ui/src/components/shadcn/ui/sheet.tsx @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import { X } from '@exponetdb/icons'
import { cva, type VariantProps } from 'class-variance-authority'
import { Dialog as SheetPrimitive } from 'radix-ui'
import * as React from 'react'

import { getExplicitTabIndex } from './lib/get-explicit-tab-index.ts'
import { useGuardedOpen } from './lib/use-guarded-open.ts'
import { cn } from './lib/utils.ts'

type SheetProps = Omit<SheetPrimitive.DialogProps, 'onOpenChange'> & {
  onOpenChange?: (open: boolean) => void
  /**
   * Called before a close that the user asked for: Escape, a click on the overlay,
   * the close button or a `SheetClose`. Return `false` to keep the sheet open, for
   * example while a form has unsaved changes; show your own in-app confirmation
   * (never `window.confirm`) and close the sheet afterwards by setting `open`.
   * Closes you set through `open` are never intercepted, and neither is opening.
   */
  onRequestClose?: () => boolean | undefined
}

/**
 * A side panel on Radix Dialog (modal: focus is trapped and restored, page scrolling
 * is locked). Give every `SheetContent` a `SheetTitle` and a `SheetDescription`.
 */
const Sheet = ({ open, defaultOpen, onOpenChange, onRequestClose, ...props }: SheetProps) => {
  const [isOpen, handleOpenChange] = useGuardedOpen({
    open,
    defaultOpen,
    onOpenChange,
    onRequestClose,
  })

  return <SheetPrimitive.Root open={isOpen} onOpenChange={handleOpenChange} {...props} />
}
Sheet.displayName = 'Sheet'

const SheetTrigger = React.forwardRef<
  React.ComponentRef<typeof SheetPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Trigger>
>(({ disabled, tabIndex, ...props }, ref) => {
  const computedTabIndex = getExplicitTabIndex(tabIndex, disabled)

  return (
    <SheetPrimitive.Trigger ref={ref} {...props} disabled={disabled} tabIndex={computedTabIndex} />
  )
})
SheetTrigger.displayName = SheetPrimitive.Trigger.displayName

const SheetClose = SheetPrimitive.Close

const SheetPortal = (props: SheetPrimitive.DialogPortalProps) => (
  <SheetPrimitive.Portal {...props} />
)
SheetPortal.displayName = SheetPrimitive.Portal.displayName

const SheetOverlay = React.forwardRef<
  React.ComponentRef<typeof SheetPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <SheetPrimitive.Overlay
    className={cn(
      'fixed inset-0 z-50 bg-alternative/90 backdrop-blur-xs transition-all duration-100 data-[state=closed]:animate-out data-[state=closed]:fade-out data-[state=open]:fade-in',
      className,
    )}
    {...props}
    ref={ref}
  />
))
SheetOverlay.displayName = SheetPrimitive.Overlay.displayName

const classes = cn([
  'fixed z-50 scale-100 gap-4 bg-popover opacity-100 shadow-lg',
  'data-[state=open]:animate-in data-[state=open]:duration-300 data-[state=closed]:animate-out data-[state=closed]:duration-300',
])

const sheetVariants = cva(classes, {
  variants: {
    side: {
      top: 'data-[state=open]:slide-in-from-top data-[state=closed]:slide-out-to-top w-full border-b inset-x-0 top-0',
      bottom:
        'data-[state=open]:slide-in-from-bottom data-[state=closed]:slide-out-to-bottom w-full border-t inset-x-0 bottom-0',
      left: 'data-[state=open]:slide-in-from-left data-[state=closed]:slide-out-to-left h-full border-r inset-y-0 left-0',
      right:
        'data-[state=open]:slide-in-from-right data-[state=closed]:slide-out-to-right h-full border-l inset-y-0 right-0',
    },
    size: {
      content: '',
      default: '',
      sm: '',
      lg: '',
      xl: '',
      xxl: '',
      /** 656 px wide (left and right sheets); the full viewport width below the `sm` breakpoint. */
      w656: '',
      /** 800 px wide (left and right sheets); the full viewport width below the `sm` breakpoint. */
      w800: '',
      full: '',
    },
  },
  compoundVariants: [
    {
      side: ['top', 'bottom'],
      size: 'content',
      class: 'max-h-screen',
    },
    {
      side: ['top', 'bottom'],
      size: 'default',
      class: 'h-1/3',
    },
    {
      side: ['top', 'bottom'],
      size: 'sm',
      class: 'h-1/4',
    },
    {
      side: ['top', 'bottom'],
      size: 'lg',
      class: 'h-1/2',
    },
    {
      side: ['top', 'bottom'],
      size: 'xl',
      class: 'h-5/6',
    },
    {
      side: ['top', 'bottom'],
      size: 'full',
      class: 'h-screen',
    },
    {
      side: ['right', 'left'],
      size: 'content',
      class: 'max-w-screen',
    },
    {
      side: ['right', 'left'],
      size: 'default',
      class: 'lg:w-1/3',
    },
    {
      side: ['right', 'left'],
      size: 'sm',
      class: 'lg:w-1/4',
    },
    {
      side: ['right', 'left'],
      size: 'lg',
      class: 'lg:w-1/2',
    },
    {
      side: ['right', 'left'],
      size: 'xl',
      class: 'lg:w-4/6',
    },
    {
      side: ['right', 'left'],
      size: 'xxl',
      class: 'w-5/6',
    },
    {
      side: ['right', 'left'],
      size: 'w656',
      class: 'w-full max-w-full sm:w-[656px]',
    },
    {
      side: ['right', 'left'],
      size: 'w800',
      class: 'w-full max-w-full sm:w-[800px]',
    },
    {
      side: ['right', 'left'],
      size: 'full',
      class: 'w-screen',
    },
  ],
  defaultVariants: {
    side: 'right',
    size: 'default',
  },
})

export interface SheetContentProps
  extends React.ComponentPropsWithoutRef<typeof SheetPrimitive.Content>,
    VariantProps<typeof sheetVariants> {
  showClose?: boolean
  hasOverlay?: boolean
}

const SheetContent = React.forwardRef<
  React.ComponentRef<typeof SheetPrimitive.Content>,
  SheetContentProps
>(({ side, size, className, children, showClose = true, hasOverlay = true, ...props }, ref) => (
  <SheetPortal>
    {hasOverlay && <SheetOverlay />}
    <SheetPrimitive.Content
      ref={ref}
      className={cn(sheetVariants({ side, size }), className)}
      tabIndex={undefined}
      {...props}
    >
      {children}
      {showClose ? (
        <SheetPrimitive.Close
          className={cn(
            'absolute right-4 top-4 rounded-xs opacity-70 transition-opacity hover:opacity-100 focus-ring disabled:pointer-events-none data-[state=open]:bg-secondary',
            'hit-area-6',
          )}
        >
          <X className="h-4 w-4" />
          <span className="sr-only">Close</span>
        </SheetPrimitive.Close>
      ) : null}
    </SheetPrimitive.Content>
  </SheetPortal>
))
SheetContent.displayName = SheetPrimitive.Content.displayName

const SheetHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn('px-5 py-4 text-center sm:text-left border-b bg-popover', className)}
    {...props}
  />
)
SheetHeader.displayName = 'SheetHeader'

const SheetSection = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('px-5 py-4', className)} {...props} />
)
SheetSection.displayName = 'SheetSection'

const SheetFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      'px-5 py-3 border-t w-full',
      'flex flex-col-reverse sm:flex-row sm:justify-end gap-2',
      className,
    )}
    {...props}
  />
)
SheetFooter.displayName = 'SheetFooter'

const SheetTitle = React.forwardRef<
  React.ComponentRef<typeof SheetPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Title>
>(({ className, ...props }, ref) => (
  <SheetPrimitive.Title ref={ref} className={cn('text-lg text-foreground', className)} {...props} />
))
SheetTitle.displayName = SheetPrimitive.Title.displayName

const SheetDescription = React.forwardRef<
  React.ComponentRef<typeof SheetPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Description>
>(({ className, ...props }, ref) => (
  <SheetPrimitive.Description
    ref={ref}
    className={cn('text-sm text-foreground-light', className)}
    {...props}
  />
))
SheetDescription.displayName = SheetPrimitive.Description.displayName

export {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  type SheetProps,
  SheetSection,
  SheetTitle,
  SheetTrigger,
}
