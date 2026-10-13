// Derived from supabase/supabase packages/ui-patterns/src/CommandMenu/api/CommandMenu.tsx @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import { ChevronLeft, Search } from '@exponetdb/icons'
import { Command, cn, Dialog, DialogContent, DialogDescription, DialogTitle } from '@exponetdb/ui'
import {
  Children,
  type ComponentPropsWithoutRef,
  type ComponentRef,
  cloneElement,
  forwardRef,
  type HTMLAttributes,
  isValidElement,
  type MouseEvent,
  type PropsWithChildren,
  type ReactElement,
  type ReactNode,
} from 'react'

import { useTelemetry } from '../../seams/index.ts'
import { useActiveShortcuts, useShortcutPlatform } from '../../shortcuts/context.ts'
import { ShortcutKeys } from '../../shortcuts/shortcut-keys.tsx'
import { CommandMenuErrorBoundary } from '../internal/command-menu-error-boundary.tsx'
import { CommandHeader } from './command-header.tsx'
import { CommandMenuInput } from './command-menu-input.tsx'
import { CommandMenuList } from './command-menu-list.tsx'
import {
  useCommandPageComponent,
  useCurrentCommandPage,
  usePopCommandPage,
} from './hooks/pages-hooks.ts'
import { useCommandMenuQuery, useSetCommandMenuQuery } from './hooks/query-hooks.ts'
import {
  useCommandMenuOpen,
  useCommandMenuSize,
  useSetCommandMenuOpen,
} from './hooks/view-hooks.ts'

const NARROW_VIEWPORT = '(max-width: 639px)'

/** The way back from a command page. Renders nothing at the top level. */
function CommandMenuBackButton({ className }: { className?: string }) {
  const currPage = useCurrentCommandPage()
  const popPage = usePopCommandPage()

  if (!currPage) return null

  return (
    <button
      type="button"
      aria-label={`Back from ${currPage.name}`}
      className={cn(
        'flex items-center gap-2 bg-overlay p-2 text-xs text-foreground-lighter focus-ring',
        className,
      )}
      onClick={popPage}
    >
      <ChevronLeft aria-hidden width={12} height={12} />
      {currPage.name}
    </button>
  )
}

const CommandWrapper = forwardRef<
  ComponentRef<typeof Command>,
  ComponentPropsWithoutRef<typeof Command>
>(({ children, className, ...props }, ref) => {
  return (
    <Command
      ref={ref}
      // Control+K is the shortcut that closes the menu; the list's own vim-style
      // Control+J and Control+K would take it first.
      vimBindings={false}
      className={cn(
        'flex h-full w-full flex-col overflow-hidden',
        '**:[[cmdk-group]]:bg-transparent! **:[[cmdk-group]]:px-2 **:[[cmdk-group-heading]]:bg-transparent! **:[[cmdk-group-heading]]:px-2 **:[[cmdk-group-heading]]:font-medium',
        '[&_[cmdk-item]_svg]:h-5 [&_[cmdk-item]_svg]:w-5 [&_[cmdk-input-wrapper]_svg]:h-5 [&_[cmdk-input-wrapper]_svg]:w-5',
        '[&_[cmdk-group]:not([hidden])_~[cmdk-group]]:pt-0',
        className,
      )}
      {...props}
    >
      {children}
    </Command>
  )
})
CommandWrapper.displayName = 'CommandWrapper'

function PageSwitch({ children }: PropsWithChildren) {
  const PageComponent = useCommandPageComponent()

  return PageComponent ? <PageComponent /> : <CommandWrapper>{children}</CommandWrapper>
}

/**
 * Wraps the element that opens the menu (a button): it toggles the menu and tells
 * assistive technology that the button opens a dialog.
 */
function CommandMenuTrigger({ children }: PropsWithChildren) {
  const open = useCommandMenuOpen()
  const setOpen = useSetCommandMenuOpen()
  const telemetry = useTelemetry()
  const apple = useShortcutPlatform()
  const shortcutActive = useActiveShortcuts().includes('palette.open')

  const child = Children.only(children) as ReactElement<
    { onClick?: (event: MouseEvent) => void } & HTMLAttributes<HTMLElement>
  >
  if (!isValidElement(child)) return null

  const handleOpen = (event: MouseEvent) => {
    child.props.onClick?.(event)
    setOpen(!open)
    if (!open) telemetry({ name: 'command_menu.opened', properties: { trigger: 'button' } })
  }

  return cloneElement(child, {
    onClick: handleOpen,
    'aria-haspopup': 'dialog',
    'aria-expanded': open,
    'aria-controls': 'command-menu-dialog-content',
    'aria-keyshortcuts': shortcutActive ? (apple ? 'Meta+K' : 'Control+K') : undefined,
    className: cn(
      'h-10 px-4 py-2',
      'inline-flex items-center justify-center whitespace-nowrap',
      'rounded-md border border-input bg-background text-sm',
      'hover:bg-accent hover:text-accent-foreground',
      'focus-ring disabled:pointer-events-none disabled:opacity-50 transition-colors',
      child.props.className,
    ),
  })
}

/** A search-field-looking button that opens the menu, with the shortcut shown. */
function CommandMenuTriggerInput({
  className,
  placeholder = 'Search commands',
  showShortcut = true,
}: {
  className?: string
  placeholder?: string
  showShortcut?: boolean
}) {
  const shortcutActive = useActiveShortcuts().includes('palette.open')
  return (
    <CommandMenuTrigger>
      <button
        type="button"
        className={cn(
          'group cursor-pointer',
          'h-[30px] grow rounded-md pl-1.5 pr-1 md:min-w-44 md:pl-2 xl:min-w-56',
          'flex items-center justify-between',
          'border border-strong bg-transparent text-foreground-lighter',
          'hover:border-control-hover hover:bg-popover',
          'focus-ring transition-colors',
          className,
        )}
      >
        <span className="flex items-center space-x-1.5 text-foreground-lighter">
          <Search
            aria-hidden
            size={16}
            strokeWidth={1.5}
            className="transition-colors group-hover:text-foreground-light"
          />
          <span className="pr-2 text-xs text-foreground-muted">{placeholder}</span>
        </span>
        {showShortcut && shortcutActive && (
          // The button carries aria-keyshortcuts, so the hint is for people who see it.
          <span aria-hidden="true" className="hidden md:inline-flex">
            <ShortcutKeys shortcut="palette.open" />
          </span>
        )}
      </button>
    </CommandMenuTrigger>
  )
}

interface CommandMenuProps extends PropsWithChildren {
  trigger?: ReactNode
  /** Called when a page or command component fails to render; the menu shows a fallback. */
  onError?: (error: Error) => void
}

/**
 * The command menu: a dialog with a search field and the commands registered under
 * `CommandProvider`. Without children it shows the search field and the list.
 * Escape clears the search, then leaves a page, then closes the menu.
 */
function CommandMenu({ children, trigger, onError }: CommandMenuProps) {
  const open = useCommandMenuOpen()
  const setOpen = useSetCommandMenuOpen()
  const size = useCommandMenuSize()
  const page = useCurrentCommandPage()
  const popPage = usePopCommandPage()
  const query = useCommandMenuQuery()
  const setQuery = useSetCommandMenuQuery()

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {trigger}
      <DialogContent
        id="command-menu-dialog-content"
        data-command-menu=""
        centered={false}
        size={size}
        onOpenAutoFocus={(event) => {
          if (window.matchMedia(NARROW_VIEWPORT).matches) event.preventDefault()
        }}
        onEscapeKeyDown={(event) => {
          event.preventDefault()
          if (query) setQuery('')
          else if (page) popPage()
          else setOpen(false)
        }}
        className="mx-auto flex max-h-[min(32rem,80dvh)] flex-col overflow-hidden p-0"
      >
        <DialogTitle className="sr-only">Command menu</DialogTitle>
        <DialogDescription className="sr-only">
          Type to search the commands, use the arrow keys to choose one and press Enter to run it.
        </DialogDescription>
        <CommandMenuErrorBoundary onError={onError}>
          <PageSwitch>
            {children ?? (
              <>
                <CommandHeader>
                  <CommandMenuBackButton />
                  <CommandMenuInput />
                </CommandHeader>
                <CommandMenuList />
              </>
            )}
          </PageSwitch>
        </CommandMenuErrorBoundary>
      </DialogContent>
    </Dialog>
  )
}

export {
  CommandMenu,
  CommandMenuBackButton,
  CommandMenuTrigger,
  CommandMenuTriggerInput,
  CommandWrapper,
}
