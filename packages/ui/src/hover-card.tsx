// Derived from supabase/supabase packages/ui/src/components/shadcn/ui/hover-card.tsx @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import { HoverCard as HoverCardPrimitive } from 'radix-ui'
import * as React from 'react'

import { cn } from './lib/utils.ts'

/**
 * Supplementary detail that appears on pointer hover or keyboard focus of its trigger and
 * can be dismissed with Escape. Radix ignores touch, so nothing essential may live only
 * in a hover card: the same information must be reachable some other way.
 */
const HoverCard = HoverCardPrimitive.Root

const HoverCardTrigger = HoverCardPrimitive.Trigger

const HoverCardContent = React.forwardRef<
  React.ComponentRef<typeof HoverCardPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof HoverCardPrimitive.Content> & {
    animate?: 'zoom-in' | 'slide-in'
  }
>(({ className, align = 'center', animate = 'zoom-in', sideOffset = 4, ...props }, ref) => (
  <HoverCardPrimitive.Portal>
    <HoverCardPrimitive.Content
      ref={ref}
      align={align}
      sideOffset={sideOffset}
      className={cn(
        'z-50 w-64 rounded-md border bg-overlay p-4 text-popover-foreground shadow-md outline-hidden',
        animate === 'zoom-in'
          ? 'animate-in zoom-in-[99%]'
          : 'animate-in fade-in-50 data-[side=bottom]:slide-in-from-top-1 data-[side=left]:slide-in-from-right-1 data-[side=right]:slide-in-from-left-1 data-[side=top]:slide-in-from-bottom-1',
        className,
      )}
      {...props}
    />
  </HoverCardPrimitive.Portal>
))
HoverCardContent.displayName = HoverCardPrimitive.Content.displayName

export { HoverCard, HoverCardContent, HoverCardTrigger }
