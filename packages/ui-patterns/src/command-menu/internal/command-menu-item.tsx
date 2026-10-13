// Derived from supabase/supabase packages/ui-patterns/src/CommandMenu/internal/CommandMenuItem.tsx @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import { CommandItem, cn } from '@exponetdb/ui'
import { type ComponentPropsWithoutRef, type ComponentRef, forwardRef } from 'react'

import { ShortcutKeys } from '../../shortcuts/shortcut-keys.tsx'
import { useRunCommand } from '../api/hooks/run-command-hook.ts'
import { type ICommand, isHrefCommand } from './types.ts'

const generateCommandClassNames = (isLink: boolean) =>
  cn(
    'cursor-default select-none items-center gap-2 rounded-md text-sm group py-2 md:py-3 text-foreground-light relative flex px-2',
    'data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50',
    isLink
      ? 'bg-transparent outline-hidden aria-selected:bg-selection/90 aria-selected:shadow-xs'
      : 'aria-selected:bg-selection/80',
  )

interface CommandItemProps extends ComponentPropsWithoutRef<typeof CommandItem> {
  command: ICommand
}

const CommandMenuItem = forwardRef<ComponentRef<typeof CommandItem>, CommandItemProps>(
  ({ children, className, command, ...props }, ref) => {
    const runCommand = useRunCommand()

    return (
      <CommandItem
        ref={ref}
        onSelect={() => runCommand(command, 'menu')}
        value={command.value ?? command.id}
        keywords={[command.name, ...(command.keywords ?? [])]}
        forceMount={command.forceMount}
        className={cn(
          generateCommandClassNames(isHrefCommand(command)),
          className,
          command.className,
        )}
        {...props}
      >
        <div className="flex w-full flex-row items-center justify-between gap-3">
          <div className="flex grow flex-row items-center gap-2">
            {command.icon?.()}
            {children}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {command.badge?.()}
            {command.shortcut !== undefined && <ShortcutKeys shortcut={command.shortcut} />}
          </div>
        </div>
      </CommandItem>
    )
  },
)
CommandMenuItem.displayName = 'CommandMenuItem'

export { CommandMenuItem, generateCommandClassNames }
