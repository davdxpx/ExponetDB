// Derived from supabase/supabase packages/ui/src/components/shadcn/ui/tooltip.tsx @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import { Tooltip as TooltipPrimitive } from 'radix-ui'
import * as React from 'react'

import { cn } from './lib/utils.ts'

/**
 * Wrap the app (or a region) once. Tooltips open on pointer hover and on keyboard
 * focus, close on Escape, stay open while the pointer is over the tooltip itself,
 * and are linked to their trigger with `aria-describedby`.
 *
 * A tooltip describes; it is not the only place for essential information. To
 * explain why a control is unavailable, keep the control focusable instead of
 * `disabled` (`<Button focusableWhenDisabled disabled>`): a natively disabled
 * button gets no pointer events and no focus, so its tooltip could never open.
 */
const TooltipProvider = TooltipPrimitive.Provider

const TooltipPortal = TooltipPrimitive.Portal

const Tooltip = TooltipPrimitive.Root

const TooltipTrigger = TooltipPrimitive.Trigger

const TooltipContent = React.forwardRef<
  React.ComponentRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 4, ...props }, ref) => (
  // Portaled to the body so that no ancestor can clip it or paint over it.
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      {...props}
      className={cn(
        'z-50 overflow-hidden rounded-md border bg-alternative px-3 py-1.5 text-xs text-foreground shadow-md animate-in fade-in-50 data-[side=bottom]:slide-in-from-top-1 data-[side=left]:slide-in-from-right-1 data-[side=right]:slide-in-from-left-1 data-[side=top]:slide-in-from-bottom-1',
        className,
      )}
    />
  </TooltipPrimitive.Portal>
))
TooltipContent.displayName = TooltipPrimitive.Content.displayName

export type TooltipContentProps = React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>

export { Tooltip, TooltipContent, TooltipPortal, TooltipProvider, TooltipTrigger }
