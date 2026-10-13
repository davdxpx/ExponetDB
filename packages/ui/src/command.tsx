// Derived from supabase/supabase packages/ui/src/components/shadcn/ui/command.tsx @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import { X as RemoveIcon, Search } from '@exponetdb/icons'
import { Command as CommandPrimitive } from 'cmdk'
import * as React from 'react'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  type DialogProps,
  DialogTitle,
} from './dialog.tsx'
import { cn } from './lib/utils.ts'

/**
 * A filterable list with keyboard navigation (cmdk). `label` is the accessible name of the
 * search field and is not shown; name what is searched ("Search targets").
 */
const Command = React.forwardRef<
  React.ComponentRef<typeof CommandPrimitive>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive>
>(({ className, label = 'Search commands', ...props }, ref) => (
  <CommandPrimitive
    ref={ref}
    label={label}
    className={cn(
      'flex h-full w-full flex-col overflow-hidden rounded-md bg-overlay text-foreground-light',
      className,
    )}
    {...props}
  />
))
Command.displayName = CommandPrimitive.displayName

type CommandDialogProps = DialogProps & {
  /** Accessible name of the dialog; not shown. */
  title?: string
  /** Accessible description of the dialog; not shown. */
  description?: string
}

const CommandDialog = ({
  children,
  title = 'Command menu',
  description = 'Type to search, use the arrow keys to choose and press Enter to run.',
  ...props
}: CommandDialogProps) => {
  return (
    <Dialog {...props}>
      <DialogContent className="overflow-hidden p-0 shadow-lg">
        <DialogTitle className="sr-only">{title}</DialogTitle>
        <DialogDescription className="sr-only">{description}</DialogDescription>
        <Command
          label={title}
          className="**:[[cmdk-group-heading]]:px-2 **:[[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-foreground-muted [&_[cmdk-group]:not([hidden])_~[cmdk-group]]:pt-0 **:[[cmdk-group]]:px-2 [&_[cmdk-input-wrapper]_svg]:h-5 [&_[cmdk-input-wrapper]_svg]:w-5 **:[[cmdk-input]]:h-12 **:[[cmdk-item]]:px-2 **:[[cmdk-item]]:py-3 [&_[cmdk-item]_svg]:h-5 [&_[cmdk-item]_svg]:w-5"
        >
          {children}
        </Command>
      </DialogContent>
    </Dialog>
  )
}

const CommandInput = React.forwardRef<
  React.ComponentRef<typeof CommandPrimitive.Input>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Input> & {
    wrapperClassName?: string
    showResetIcon?: boolean
    showSearchIcon?: boolean
    handleReset?: () => void
  }
>(
  (
    {
      className,
      wrapperClassName,
      showResetIcon = false,
      showSearchIcon = true,
      handleReset,
      ...props
    },
    ref,
  ) => (
    <div className={cn('flex items-center border-b px-3', wrapperClassName)} cmdk-input-wrapper="">
      {showSearchIcon && <Search className="h-4 w-4 shrink-0 opacity-50" aria-hidden />}
      <CommandPrimitive.Input
        ref={ref}
        className={cn(
          'flex h-9 w-full rounded-md bg-transparent py-3 pl-2 text-sm focus-inset placeholder:text-muted disabled:cursor-not-allowed disabled:opacity-50 border-none focus:ring-0',
          className,
        )}
        {...props}
      />
      {showResetIcon && (
        <button
          type="button"
          tabIndex={props.disabled || !props.value?.length ? -1 : 0}
          disabled={props.disabled || !props.value?.length}
          onClick={handleReset}
          aria-label="Clear search"
          className={cn(
            'rounded-xs text-foreground-lighter hover:text-foreground-light hover:cursor-pointer transition-all opacity-0 duration-100 focus-ring',
            !!props.value?.length && 'opacity-100',
          )}
        >
          <RemoveIcon size={14} aria-hidden />
        </button>
      )}
    </div>
  ),
)

CommandInput.displayName = CommandPrimitive.Input.displayName

const CommandList = React.forwardRef<
  React.ComponentRef<typeof CommandPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.List>
>(({ className, onWheel, onTouchMove, ...props }, ref) => (
  <CommandPrimitive.List
    ref={ref}
    className={cn('max-h-full overflow-y-auto overflow-x-hidden', className)}
    // A dialog or sheet locks scrolling by cancelling wheel and touch events that land outside
    // it, and a dropdown portals to the body. Keeping both off the document is what lets the
    // list scroll with a trackpad and with a finger while an overlay is open.
    onWheel={(event) => {
      event.stopPropagation()
      onWheel?.(event)
    }}
    onTouchMove={(event) => {
      event.stopPropagation()
      onTouchMove?.(event)
    }}
    {...props}
  />
))

CommandList.displayName = CommandPrimitive.List.displayName

const CommandEmpty = React.forwardRef<
  React.ComponentRef<typeof CommandPrimitive.Empty>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Empty>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Empty
    ref={ref}
    className={cn('py-6 text-center text-xs', className)}
    {...props}
  />
))

CommandEmpty.displayName = CommandPrimitive.Empty.displayName

const CommandGroup = React.forwardRef<
  React.ComponentRef<typeof CommandPrimitive.Group>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Group>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Group
    ref={ref}
    className={cn(
      'overflow-hidden p-1 text-foreground-light **:[[cmdk-group-heading]]:px-2 **:[[cmdk-group-heading]]:py-1.5 **:[[cmdk-group-heading]]:text-xs **:[[cmdk-group-heading]]:font-normal [&_[cmdk-group-heading]]:text-foreground-muted',
      '**:[[cmdk-group-heading]]:font-mono',
      '**:[[cmdk-group-heading]]:uppercase',
      '**:[[cmdk-group-heading]]:tracking-wider',
      className,
    )}
    {...props}
  />
))

CommandGroup.displayName = CommandPrimitive.Group.displayName

const CommandSeparator = React.forwardRef<
  React.ComponentRef<typeof CommandPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Separator
    ref={ref}
    // A purely visual divider: a listbox may only own options and groups, so a
    // `role="separator"` inside it is an accessibility violation unless it is hidden.
    aria-hidden="true"
    className={cn('-mx-1 h-px bg-border-overlay', className)}
    {...props}
  />
))
CommandSeparator.displayName = CommandPrimitive.Separator.displayName

const CommandItem = React.forwardRef<
  React.ComponentRef<typeof CommandPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Item>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Item
    ref={ref}
    className={cn(
      'relative flex cursor-default select-none items-center rounded-item px-2 py-1.5 text-xs outline-hidden data-[selected=true]:bg-overlay-hover data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50',
      className,
    )}
    {...props}
  />
))

CommandItem.displayName = CommandPrimitive.Item.displayName

const CommandShortcut = ({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) => {
  return (
    <span
      className={cn('ml-auto text-xs tracking-widest text-foreground-muted', className)}
      {...props}
    />
  )
}
CommandShortcut.displayName = 'CommandShortcut'

export {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
}
