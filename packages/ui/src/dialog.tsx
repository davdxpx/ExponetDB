// Derived from supabase/supabase packages/ui/src/components/shadcn/ui/dialog.tsx @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import { X } from '@exponetdb/icons'
import { cva, type VariantProps } from 'class-variance-authority'
import { Dialog as DialogPrimitive } from 'radix-ui'
import * as React from 'react'

import { getExplicitTabIndex } from './lib/get-explicit-tab-index.ts'
import { useGuardedOpen } from './lib/use-guarded-open.ts'
import { cn } from './lib/utils.ts'

export const DIALOG_PADDING_Y_SMALL = 'py-4'
export const DIALOG_PADDING_X_SMALL = 'px-4 md:px-5'

export const DIALOG_PADDING_Y = 'py-6'
export const DIALOG_PADDING_X = 'px-4 md:px-7'

const DialogPaddingVariants = cva('', {
  variants: {
    padding: {
      medium: `${DIALOG_PADDING_Y} ${DIALOG_PADDING_X}`,
      small: `${DIALOG_PADDING_Y_SMALL} ${DIALOG_PADDING_X_SMALL}`,
    },
  },
  defaultVariants: {
    padding: 'small',
  },
})

type DialogProps = Omit<DialogPrimitive.DialogProps, 'onOpenChange'> & {
  onOpenChange?: (open: boolean) => void
  /**
   * Called before a close that the user asked for: Escape, a click outside, the
   * close button or a `DialogClose`. Return `false` to keep the dialog open, for
   * example while a form has unsaved changes; show your own in-app confirmation
   * (never `window.confirm`) and close the dialog afterwards by setting `open`.
   * Closes you set through `open` are never intercepted, and neither is opening.
   */
  onRequestClose?: () => boolean | undefined
}

/**
 * A modal dialog. Give every `DialogContent` a `DialogTitle` (it is the accessible
 * name) and a `DialogDescription`, or `aria-describedby={undefined}` when there is
 * nothing to describe. Radix traps focus inside, restores it on close and locks
 * page scrolling.
 */
const Dialog = ({ open, defaultOpen, onOpenChange, onRequestClose, ...props }: DialogProps) => {
  const [isOpen, handleOpenChange] = useGuardedOpen({
    open,
    defaultOpen,
    onOpenChange,
    onRequestClose,
  })

  return <DialogPrimitive.Root open={isOpen} onOpenChange={handleOpenChange} {...props} />
}
Dialog.displayName = 'Dialog'

const DialogTrigger = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Trigger>
>(({ disabled, tabIndex, ...props }, ref) => {
  const computedTabIndex = getExplicitTabIndex(tabIndex, disabled)

  return (
    <DialogPrimitive.Trigger ref={ref} {...props} disabled={disabled} tabIndex={computedTabIndex} />
  )
})
DialogTrigger.displayName = DialogPrimitive.Trigger.displayName

const DialogPortal = (props: DialogPrimitive.DialogPortalProps) => (
  <DialogPrimitive.Portal {...props} />
)
DialogPortal.displayName = DialogPrimitive.Portal.displayName

const DialogOverlay = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay> & { centered?: boolean }
>(({ className, centered = true, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      'bg-black/40 backdrop-blur-xs',
      'z-50 fixed inset-0 grid place-items-center overflow-y-auto data-closed:animate-overlay-hide py-8',
      !centered && 'flex flex-col flex-start pb-8 sm:pt-12 md:pt-20 lg:pt-32 xl:pt-40 px-5',
      className,
    )}
    {...props}
  />
))
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName

const DialogContentVariants = cva(
  cn(
    'relative z-50 w-full max-w-screen border shadow-md dark:shadow-xs',
    'data-[state=open]:animate-in data-[state=closed]:animate-out',
    'data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
    'data-[state=closed]:slide-out-to-left-[0%] data-[state=closed]:slide-out-to-top-[0%]',
    'data-[state=open]:slide-in-from-left-[0%] data-[state=open]:slide-in-from-top-[0%]',
    'sm:rounded-lg md:w-full',
    'bg-background',
  ),
  {
    variants: {
      size: {
        tiny: 'sm:align-middle sm:w-full sm:max-w-xs',
        small: 'sm:align-middle sm:w-full sm:max-w-sm',
        medium: 'sm:align-middle sm:w-full sm:max-w-lg',
        large: 'sm:align-middle sm:w-full md:max-w-xl',
        xlarge: 'sm:align-middle sm:w-full md:max-w-3xl',
        xxlarge: 'sm:align-middle sm:w-full md:max-w-6xl',
        xxxlarge: 'sm:align-middle sm:w-full md:max-w-7xl',
      },
    },
    defaultVariants: {
      size: 'medium',
    },
  },
)

const DialogContent = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> &
    VariantProps<typeof DialogContentVariants> & {
      hideClose?: boolean
      dialogOverlayProps?: React.ComponentPropsWithoutRef<typeof DialogOverlay>
      centered?: boolean
    }
>(
  (
    { className, children, size, hideClose, dialogOverlayProps, centered = true, ...props },
    ref,
  ) => (
    <DialogPortal>
      <DialogOverlay centered={centered} {...dialogOverlayProps}>
        <DialogPrimitive.Content
          ref={ref}
          className={cn(DialogContentVariants({ size }), className)}
          {...props}
        >
          {children}
          {!hideClose && (
            <DialogPrimitive.Close
              className={cn(
                'absolute p-0.5 right-3.5 top-3.5 rounded-xs opacity-20 transition-opacity hover:opacity-100 focus-ring disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-foreground-muted',
                'hit-area-6',
              )}
            >
              <X size={16} />
              <span className="sr-only">Close</span>
            </DialogPrimitive.Close>
          )}
        </DialogPrimitive.Content>
      </DialogOverlay>
    </DialogPortal>
  ),
)
DialogContent.displayName = DialogPrimitive.Content.displayName

const DialogHeader = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & VariantProps<typeof DialogPaddingVariants>
>(({ className, padding, ...props }, ref) => (
  <div
    ref={ref}
    {...props}
    className={cn(
      'flex flex-col gap-1.5 text-center sm:text-left',
      DialogPaddingVariants({ padding }),
      className,
    )}
  />
))

DialogHeader.displayName = 'DialogHeader'

const DialogFooter = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & VariantProps<typeof DialogPaddingVariants>
>(({ className, children, padding, ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      'flex flex-col-reverse gap-y-2 sm:flex-row sm:justify-end sm:space-x-2',
      'border-t',
      DialogPaddingVariants({ padding }),
      className,
    )}
    {...props}
  >
    {children}
  </div>
))
DialogFooter.displayName = 'DialogFooter'

const DialogTitle = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    // max-w leaves room for the close button
    className={cn('text-base leading-none font-normal max-w-[calc(100%-1rem)]', className)}
    {...props}
  />
))
DialogTitle.displayName = DialogPrimitive.Title.displayName

const DialogDescription = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn('text-sm text-foreground-lighter', className)}
    {...props}
  />
))
DialogDescription.displayName = DialogPrimitive.Description.displayName

const DialogClose = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Close>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Close>
>(({ className, children, asChild, ...props }, ref) => (
  <DialogPrimitive.Close
    ref={ref}
    asChild={asChild}
    className={cn(
      !asChild &&
        'opacity-70 transition-opacity hover:opacity-100 focus-ring disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-foreground-muted',
      className,
    )}
    {...props}
  >
    {children}
  </DialogPrimitive.Close>
))
DialogClose.displayName = DialogPrimitive.Close.displayName

const DialogSection = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & VariantProps<typeof DialogPaddingVariants>
>(({ className, children, padding, ...props }, ref) => (
  <div
    ref={ref}
    {...props}
    className={cn(DialogPaddingVariants({ padding }), 'overflow-hidden', className)}
  >
    {children}
  </div>
))
DialogSection.displayName = 'DialogSection'

const DialogSectionSeparator = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div ref={ref} {...props} className={cn('w-full h-px bg-border', className)} />
))
DialogSectionSeparator.displayName = 'DialogSectionSeparator'

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  type DialogProps,
  DialogSection,
  DialogSectionSeparator,
  DialogTitle,
  DialogTrigger,
}
