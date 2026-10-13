// Derived from supabase/supabase packages/ui-patterns/src/CommandMenu/api/CommandMenuList.tsx @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import { CommandList, cn } from '@exponetdb/ui'
import { type ComponentPropsWithoutRef, type ComponentRef, forwardRef } from 'react'

import { CommandMenuEmpty } from '../internal/command-menu-empty.tsx'
import { CommandMenuGroup } from '../internal/command-menu-group.tsx'
import { CommandMenuItem } from '../internal/command-menu-item.tsx'
import { useCommands } from './hooks/commands-hooks.ts'
import { useCommandMenuQuery } from './hooks/query-hooks.ts'
import { TextHighlighter } from './text-highlighter.tsx'

const CommandMenuList = forwardRef<
  ComponentRef<typeof CommandList>,
  ComponentPropsWithoutRef<typeof CommandList>
>(({ className, ...props }, ref) => {
  const commandSections = useCommands()
  const query = useCommandMenuQuery()

  const shown = commandSections
    .map((section) => ({
      section,
      commands: section.commands.filter((command) => !command.defaultHidden || query),
    }))
    .filter(({ commands }) => commands.length > 0)

  const forcedCount = shown.reduce(
    (total, { section, commands }) =>
      total + commands.filter((command) => command.forceMount ?? section.forceMount).length,
    0,
  )

  return (
    <>
      <CommandList
        ref={ref}
        label="Commands"
        className={cn(
          'max-h-[initial] overflow-y-auto overflow-x-hidden bg-transparent',
          className,
        )}
        {...props}
      >
        {shown.map(({ section, commands }) => (
          <CommandMenuGroup key={section.id} heading={section.name} forceMount={section.forceMount}>
            {commands.map((command) => (
              <CommandMenuItem key={command.id} command={command}>
                <TextHighlighter>{command.name}</TextHighlighter>
              </CommandMenuItem>
            ))}
          </CommandMenuGroup>
        ))}
      </CommandList>
      {/* Outside the listbox, which may hold options and groups only. */}
      <CommandMenuEmpty forcedCount={forcedCount} />
    </>
  )
})
CommandMenuList.displayName = 'CommandMenuList'

export { CommandMenuList }
