// Derived from supabase/supabase packages/ui-patterns/src/CommandMenu/internal/CommandMenuGroup.tsx @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import { CommandGroup, cn } from '@exponetdb/ui'
import { type ComponentPropsWithoutRef, type ComponentRef, forwardRef } from 'react'

const CommandMenuGroup = forwardRef<
  ComponentRef<typeof CommandGroup>,
  ComponentPropsWithoutRef<typeof CommandGroup>
>(({ className, ...props }, ref) => {
  return (
    <CommandGroup
      ref={ref}
      className={cn(
        'overflow-hidden px-2 py-3 text-foreground-lighter **:[[cmdk-group-heading]]:px-2 **:[[cmdk-group-heading]]:pb-1.5 **:[[cmdk-group-heading]]:text-sm **:[[cmdk-group-heading]]:font-normal [&_[cmdk-group-heading]]:text-foreground-lighter',
        className,
      )}
      {...props}
    />
  )
})
CommandMenuGroup.displayName = 'CommandMenuGroup'

export { CommandMenuGroup }
