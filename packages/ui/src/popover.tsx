// Derived from supabase/supabase packages/ui/src/components/shadcn/ui/popover.tsx @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import { Popover as PopoverPrimitive } from 'radix-ui'
import * as React from 'react'
import { getExplicitTabIndex } from './lib/get-explicit-tab-index.ts'
import { cn } from './lib/utils.ts'

const Popover = PopoverPrimitive.Root

const PopoverTrigger = React.forwardRef<
  React.ComponentRef<typeof PopoverPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Trigger>
>(({ disabled, tabIndex, ...props }, ref) => {
  const computedTabIndex = getExplicitTabIndex(tabIndex, disabled)

  return (
    <PopoverPrimitive.Trigger
      ref={ref}
      {...props}
      disabled={disabled}
      tabIndex={computedTabIndex}
    />
  )
})
PopoverTrigger.displayName = PopoverPrimitive.Trigger.displayName

const PopoverAnchor = PopoverPrimitive.Anchor

const PopoverClose = PopoverPrimitive.Close

export type PopoverContentProps = {
  align?: 'center' | 'start' | 'end'
  sideOffset?: number
  sameWidthAsTrigger?: boolean
} & React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>

const PopoverContent = React.forwardRef<
  React.ComponentRef<typeof PopoverPrimitive.Content>,
  PopoverContentProps
>(({ className, align = 'center', sideOffset = 4, sameWidthAsTrigger = false, ...props }, ref) => {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        ref={ref}
        align={align}
        sideOffset={sideOffset}
        className={cn(
          'z-50 w-72 rounded-md border border-overlay bg-overlay p-4 text-popover-foreground shadow-md outline-hidden origin-(--radix-popover-content-transform-origin) ease-enter data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2',
          // After `w-72`, so that tailwind-merge lets the trigger width win.
          sameWidthAsTrigger && 'w-(--radix-popover-trigger-width)',
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  )
})
PopoverContent.displayName = 'PopoverContent'

const PopoverSeparator = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} {...props} className={cn('w-full h-px bg-border-overlay', className)} />
  ),
)
PopoverSeparator.displayName = 'PopoverSeparator'

export { Popover, PopoverAnchor, PopoverClose, PopoverContent, PopoverSeparator, PopoverTrigger }
