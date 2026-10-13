// Derived from supabase/supabase packages/ui/src/components/shadcn/ui/alert-dialog.tsx @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import { cva, type VariantProps } from 'class-variance-authority'
import { AlertDialog as AlertDialogPrimitive } from 'radix-ui'
import * as React from 'react'

import { Button, type ButtonVariantProps, buttonVariants } from './button.tsx'
import { getExplicitTabIndex } from './lib/get-explicit-tab-index.ts'
import { cn } from './lib/utils.ts'

type AlertDialogContextValue = {
  loading: boolean
  /**
   * Whether an action is pending right now, read from a ref: true from the press that
   * started it, before React renders the pending state, so an Escape, an outside focus or
   * a Cancel in the same moment cannot close the dialog under a running action.
   */
  isPending: () => boolean
  setActionLoading: (id: symbol, loading: boolean) => void
  setOpen: (open: boolean, options?: { force?: boolean }) => void
}

const AlertDialogContext = React.createContext<AlertDialogContextValue | null>(null)

const useAlertDialogContext = () => React.useContext(AlertDialogContext)

type AlertDialogProps = React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Root>

/**
 * A confirmation dialog that is aware of asynchronous actions.
 *
 * An `AlertDialogAction` whose `onClick` returns a promise keeps the dialog open
 * while the promise is pending: the action shows a spinner and cannot be pressed
 * again, and Escape and the cancel button do nothing (a click outside never
 * dismisses an alert dialog). When the promise resolves the dialog closes; when
 * it rejects the dialog stays open and `onActionError` receives the error, so the
 * caller can show it inside the dialog. A `loading` prop on the action blocks
 * dismissal the same way when the caller owns the pending state.
 */
const AlertDialog = ({
  children,
  defaultOpen = false,
  onOpenChange,
  open: openProp,
  ...props
}: AlertDialogProps) => {
  const onOpenChangeRef = React.useRef(onOpenChange)
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen)
  const [loadingActionIds, setLoadingActionIds] = React.useState<Set<symbol>>(() => new Set())
  const loading = loadingActionIds.size > 0
  const open = openProp ?? uncontrolledOpen

  React.useEffect(() => {
    onOpenChangeRef.current = onOpenChange
  }, [onOpenChange])

  // The pending actions, kept in a ref (read synchronously by every dismissal path) and
  // mirrored into state (rendered: the disabled Cancel, aria-busy).
  const pendingIds = React.useRef<Set<symbol>>(new Set())
  const setActionLoading = React.useCallback((id: symbol, actionLoading: boolean) => {
    if (actionLoading) pendingIds.current.add(id)
    else pendingIds.current.delete(id)
    setLoadingActionIds(new Set(pendingIds.current))
  }, [])
  const isPending = React.useCallback(() => pendingIds.current.size > 0, [])

  const setOpen = React.useCallback(
    (nextOpen: boolean, options?: { force?: boolean }) => {
      if (pendingIds.current.size > 0 && !nextOpen && !options?.force) return

      if (openProp === undefined) {
        setUncontrolledOpen(nextOpen)
      }

      onOpenChangeRef.current?.(nextOpen)
    },
    [openProp],
  )

  const contextValue = React.useMemo(
    () => ({ loading, isPending, setActionLoading, setOpen }),
    [loading, isPending, setActionLoading, setOpen],
  )

  return (
    <AlertDialogContext.Provider value={contextValue}>
      <AlertDialogPrimitive.Root open={open} onOpenChange={setOpen} {...props}>
        {children}
      </AlertDialogPrimitive.Root>
    </AlertDialogContext.Provider>
  )
}
AlertDialog.displayName = AlertDialogPrimitive.Root.displayName

const AlertDialogTrigger = React.forwardRef<
  React.ComponentRef<typeof AlertDialogPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Trigger>
>(({ disabled, tabIndex, ...props }, ref) => {
  const computedTabIndex = getExplicitTabIndex(tabIndex, disabled)

  return (
    <AlertDialogPrimitive.Trigger
      ref={ref}
      {...props}
      disabled={disabled}
      tabIndex={computedTabIndex}
    />
  )
})
AlertDialogTrigger.displayName = AlertDialogPrimitive.Trigger.displayName

const AlertDialogPortal = ({ children, ...props }: AlertDialogPrimitive.AlertDialogPortalProps) => (
  <AlertDialogPrimitive.Portal {...props}>
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      {children}
    </div>
  </AlertDialogPrimitive.Portal>
)
AlertDialogPortal.displayName = AlertDialogPrimitive.Portal.displayName

const AlertDialogOverlay = React.forwardRef<
  React.ComponentRef<typeof AlertDialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Overlay> & { centered?: boolean }
>(({ className, centered = true, ...props }, ref) => (
  <AlertDialogPrimitive.Overlay
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
AlertDialogOverlay.displayName = AlertDialogPrimitive.Overlay.displayName

const AlertDialogContentVariants = cva(
  cn(
    'relative z-50 w-full max-w-screen border shadow-md dark:shadow-xs',
    'data-open:animate-overlay-show data-closed:animate-overlay-hide',
    'sm:rounded-lg md:w-full',
    'bg-dash-sidebar',
  ),
  {
    variants: {
      size: {
        tiny: `sm:align-middle sm:w-full sm:max-w-xs`,
        small: `sm:align-middle sm:w-full sm:max-w-sm`,
        medium: `sm:align-middle sm:w-full sm:max-w-lg`,
        large: `sm:align-middle sm:w-full md:max-w-xl`,
        xlarge: `sm:align-middle sm:w-full md:max-w-3xl`,
        xxlarge: `sm:align-middle sm:w-full md:max-w-6xl`,
        xxxlarge: `sm:align-middle sm:w-full md:max-w-7xl`,
      },
    },
    defaultVariants: {
      size: 'small',
    },
  },
)

const AlertDialogContent = React.forwardRef<
  React.ComponentRef<typeof AlertDialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Content> &
    VariantProps<typeof AlertDialogContentVariants> & {
      dialogOverlayProps?: React.ComponentPropsWithoutRef<typeof AlertDialogOverlay>
      centered?: boolean
    }
>(
  (
    {
      className,
      children,
      size,
      dialogOverlayProps,
      centered = true,
      onEscapeKeyDown,
      onFocusOutside,
      ...props
    },
    ref,
  ) => {
    const alertDialogContext = useAlertDialogContext()

    return (
      <AlertDialogPortal>
        <AlertDialogOverlay centered={centered} {...dialogOverlayProps}>
          <AlertDialogPrimitive.Content
            ref={ref}
            className={cn(AlertDialogContentVariants({ size }), className)}
            onEscapeKeyDown={(event) => {
              onEscapeKeyDown?.(event)
              if (alertDialogContext?.isPending()) event.preventDefault()
            }}
            onFocusOutside={(event) => {
              onFocusOutside?.(event)
              if (alertDialogContext?.isPending()) event.preventDefault()
            }}
            {...props}
          >
            {children}
          </AlertDialogPrimitive.Content>
        </AlertDialogOverlay>
      </AlertDialogPortal>
    )
  },
)
AlertDialogContent.displayName = AlertDialogPrimitive.Content.displayName

const AlertDialogHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('flex flex-col text-left', className)} {...props} />
)
AlertDialogHeader.displayName = 'AlertDialogHeader'

const AlertDialogBody = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    data-slot="alert-dialog-body"
    className={cn(
      '[&>[data-slot=alert]]:mb-0 [&>[data-slot=alert]]:rounded-none [&>[data-slot=alert]]:border-x-0',
      className,
    )}
    {...props}
  />
)
AlertDialogBody.displayName = 'AlertDialogBody'

// Full-width alerts own the visual separator above the footer.
const AlertDialogFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    data-slot="alert-dialog-footer"
    className={cn(
      'flex flex-col-reverse gap-y-2 sm:flex-row sm:justify-end sm:space-x-2 border-t py-3 px-5 [[data-slot=alert-dialog-body]:has(>[data-slot=alert])+&]:border-t-0',
      className,
    )}
    {...props}
  />
)
AlertDialogFooter.displayName = 'AlertDialogFooter'

const AlertDialogTitle = React.forwardRef<
  React.ComponentRef<typeof AlertDialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <AlertDialogPrimitive.Title
    ref={ref}
    className={cn('text-base text-foreground border-b px-5 py-3', className)}
    {...props}
  />
))
AlertDialogTitle.displayName = AlertDialogPrimitive.Title.displayName

const AlertDialogDescription = React.forwardRef<
  React.ComponentRef<typeof AlertDialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <AlertDialogPrimitive.Description
    ref={ref}
    className={cn(
      'text-sm text-foreground-light px-5',
      // Optically align text vertically
      ' pt-3.5 pb-4',
      className,
    )}
    {...props}
  />
))
AlertDialogDescription.displayName = AlertDialogPrimitive.Description.displayName

const isPromiseLike = (value: unknown): value is PromiseLike<unknown> => {
  return (
    typeof value === 'object' &&
    value !== null &&
    'then' in value &&
    typeof value.then === 'function'
  )
}

type AlertDialogActionProps = Omit<
  React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Action>,
  'onClick'
> & {
  variant?: NonNullable<ButtonVariantProps['variant']>
  /** Shows the spinner and blocks dismissal while the caller owns the pending state. */
  loading?: boolean
  /**
   * Runs when the action is pressed. Return a promise to keep the dialog open until it
   * settles: it closes when the promise resolves and stays open when it rejects.
   * Any other result closes the dialog at once.
   */
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => unknown
  /**
   * Receives the reason when the promise returned by `onClick` rejects. The dialog
   * stays open; show the error inside it (an `Alert` in `AlertDialogBody`).
   */
  onActionError?: (error: unknown) => void
}

const AlertDialogAction = React.forwardRef<
  React.ComponentRef<typeof AlertDialogPrimitive.Action>,
  AlertDialogActionProps
>(
  (
    {
      asChild,
      children,
      className,
      disabled,
      loading: loadingProp = false,
      onClick,
      onActionError,
      variant = 'primary',
      type = 'button',
      ...props
    },
    ref,
  ) => {
    const alertDialogContext = useAlertDialogContext()
    const dialogLoading = alertDialogContext?.loading ?? false
    const setActionLoading = alertDialogContext?.setActionLoading
    const setOpen = alertDialogContext?.setOpen
    const actionId = React.useRef(Symbol('AlertDialogAction'))
    const [internalLoading, setInternalLoading] = React.useState(false)
    // Set synchronously on the first press, so a second press before React renders the
    // pending state cannot start the action again.
    const inFlight = React.useRef(false)
    const loading = loadingProp || internalLoading
    // While pending the action stays keyboard-focusable (aria-disabled instead of
    // disabled) so that focus is not thrown out of the dialog when it is pressed.
    const pending = loading || dialogLoading
    const isDisabled = disabled || pending

    React.useEffect(() => {
      setActionLoading?.(actionId.current, loading)

      return () => {
        setActionLoading?.(actionId.current, false)
      }
    }, [loading, setActionLoading])

    const handleClick = (event: React.MouseEvent<HTMLButtonElement>) => {
      if (isDisabled || inFlight.current) {
        event.preventDefault()
        return
      }

      const result = onClick?.(event)

      if (!isPromiseLike(result)) return

      event.preventDefault()
      inFlight.current = true
      // Pending from this press on, not from the next render (see `isPending`).
      setActionLoading?.(actionId.current, true)
      setInternalLoading(true)

      void (async () => {
        try {
          await result
          setOpen?.(false, { force: true })
        } catch (error) {
          // Keep the dialog open so the caller can show the error in context.
          onActionError?.(error)
        } finally {
          inFlight.current = false
          setInternalLoading(false)
          setActionLoading?.(actionId.current, false)
        }
      })()
    }

    if (asChild) {
      return (
        <AlertDialogPrimitive.Action
          ref={ref}
          asChild
          className={cn(buttonVariants({ variant, size: 'tiny' }), className)}
          disabled={isDisabled}
          aria-busy={pending || undefined}
          onClick={handleClick}
          type={type}
          {...props}
        >
          {children}
        </AlertDialogPrimitive.Action>
      )
    }

    return (
      <AlertDialogPrimitive.Action asChild onClick={handleClick} {...props}>
        <Button
          ref={ref}
          className={className}
          disabled={isDisabled}
          focusableWhenDisabled={pending}
          type={type}
          loading={loading}
          variant={variant}
        >
          {children}
        </Button>
      </AlertDialogPrimitive.Action>
    )
  },
)
AlertDialogAction.displayName = AlertDialogPrimitive.Action.displayName

const AlertDialogCancel = React.forwardRef<
  React.ComponentRef<typeof AlertDialogPrimitive.Cancel>,
  React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Cancel>
>(({ className, disabled, onClick, ...props }, ref) => {
  const alertDialogContext = useAlertDialogContext()

  return (
    <AlertDialogPrimitive.Cancel
      ref={ref}
      className={cn(
        buttonVariants({ variant: 'default', size: 'tiny' }),
        'disabled:pointer-events-none disabled:opacity-50',
        className,
      )}
      disabled={disabled || alertDialogContext?.loading}
      onClick={(event) => {
        onClick?.(event)
        // A Cancel pressed in the same moment as the action, before it rendered as disabled.
        if (alertDialogContext?.isPending()) event.preventDefault()
      }}
      {...props}
    />
  )
})
AlertDialogCancel.displayName = AlertDialogPrimitive.Cancel.displayName

export {
  AlertDialog,
  AlertDialogAction,
  AlertDialogBody,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
}
