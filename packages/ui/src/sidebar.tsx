// Derived from supabase/supabase packages/ui/src/components/shadcn/ui/sidebar.tsx @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import { PanelLeft } from '@exponetdb/icons'
import { cva, type VariantProps } from 'class-variance-authority'
import { type Separator as SeparatorPrimitive, Slot as SlotPrimitive } from 'radix-ui'
import * as React from 'react'

import { Button } from './button.tsx'
import { useIsMobile } from './hooks/use-mobile.tsx'
import { Input } from './input.tsx'
import { getExplicitTabIndex } from './lib/get-explicit-tab-index.ts'
import { cn } from './lib/utils.ts'
import { Separator } from './separator.tsx'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from './sheet.tsx'
import { Skeleton } from './skeleton.tsx'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './tooltip.tsx'

const SIDEBAR_WIDTH = '13rem'
const SIDEBAR_WIDTH_MOBILE = '18rem'
const SIDEBAR_WIDTH_ICON = '3rem'

/**
 * A keyboard shortcut by physical key (`KeyboardEvent.code`, so it does not depend on the keyboard
 * layout or on what Option types on a Mac).
 */
export interface SidebarShortcut {
  code: string
  ctrl?: boolean
  meta?: boolean
  alt?: boolean
  shift?: boolean
}

// Symbol keys that browsers leave alone. Ctrl or Cmd with a letter or digit belongs to the
// browser and to text fields (new tab, find, bold, the bookmarks sidebar), Alt with a letter,
// digit or arrow to menus and tab switching, so none of those can be a sidebar shortcut.
const CTRL_META_CODES: ReadonlySet<string> = new Set(['Backslash', 'Slash'])
const ALT_CODES: ReadonlySet<string> = new Set([
  'Backslash',
  'Slash',
  'BracketLeft',
  'BracketRight',
  'Backquote',
  'Semicolon',
  'Quote',
  'Comma',
  'Period',
  'Minus',
  'Equal',
])

/** Whether `shortcut` avoids the combinations that browsers and text fields use. */
export function isSidebarShortcutAllowed(shortcut: SidebarShortcut): boolean {
  const { code, ctrl = false, meta = false, alt = false } = shortcut
  if (alt) {
    return ALT_CODES.has(code)
  }
  return (ctrl || meta) && CTRL_META_CODES.has(code)
}

type SidebarContextValue = {
  /** `expanded` while the sidebar is open or expanded by hover or focus, else `collapsed`. */
  state: 'expanded' | 'collapsed'
  /** The persistent state (what `open` and `onOpenChange` carry); hover does not change it. */
  open: boolean
  setOpen: (open: boolean) => void
  openMobile: boolean
  setOpenMobile: (open: boolean) => void
  isMobile: boolean
  toggleSidebar: () => void
  /** Whether hover or focus expands the (otherwise collapsed) sidebar right now. */
  expandedByHover: boolean
  setExpandedByHover: (expanded: boolean) => void
}

const SidebarContext = React.createContext<SidebarContextValue | null>(null)

function useSidebar() {
  const context = React.useContext(SidebarContext)
  if (!context) {
    throw new Error('useSidebar must be used within a SidebarProvider.')
  }

  return context
}

/**
 * Holds the state of the sidebar. The sidebar does not remember anything: the app keeps the
 * choice (always open, collapsed, expand on hover) wherever it keeps preferences and passes it back
 * in as `open` (or `defaultOpen`); `onOpenChange` reports every deliberate toggle (button, rail,
 * shortcut). Expansion by hover never reaches `onOpenChange`.
 */
const SidebarProvider = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<'div'> & {
    defaultOpen?: boolean
    open?: boolean
    onOpenChange?: (open: boolean) => void
    /**
     * Toggles the sidebar from anywhere on the page. None by default, so no key is taken from
     * the page unless the app asks for one; combinations that browsers use are ignored (see
     * `isSidebarShortcutAllowed`).
     */
    shortcut?: SidebarShortcut | null
  }
>(
  (
    {
      defaultOpen = true,
      open: openProp,
      onOpenChange,
      shortcut = null,
      className,
      style,
      children,
      ...props
    },
    ref,
  ) => {
    const isMobile = useIsMobile()
    const [openMobile, setOpenMobile] = React.useState(false)
    const [expandedByHover, setExpandedByHover] = React.useState(false)

    // The sidebar is controlled when `open` is passed; otherwise it keeps its own state. Either way
    // `onOpenChange` is told, so the app can save the choice.
    const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen)
    const isControlled = openProp !== undefined
    const open = openProp ?? uncontrolledOpen
    const setOpen = React.useCallback(
      (value: boolean) => {
        if (!isControlled) {
          setUncontrolledOpen(value)
        }
        onOpenChange?.(value)
      },
      [isControlled, onOpenChange],
    )

    // Helper to toggle the sidebar.
    const toggleSidebar = React.useCallback(() => {
      return isMobile ? setOpenMobile((current) => !current) : setOpen(!open)
    }, [isMobile, open, setOpen])

    const shortcutCode = shortcut?.code
    const shortcutCtrl = shortcut?.ctrl ?? false
    const shortcutMeta = shortcut?.meta ?? false
    const shortcutAlt = shortcut?.alt ?? false
    const shortcutShift = shortcut?.shift ?? false
    React.useEffect(() => {
      if (shortcutCode === undefined) {
        return
      }
      const configured: SidebarShortcut = {
        code: shortcutCode,
        ctrl: shortcutCtrl,
        meta: shortcutMeta,
        alt: shortcutAlt,
        shift: shortcutShift,
      }
      if (!isSidebarShortcutAllowed(configured)) {
        return
      }

      const handleKeyDown = (event: KeyboardEvent) => {
        if (event.defaultPrevented || event.repeat || event.isComposing) {
          return
        }
        if (
          event.code === shortcutCode &&
          event.ctrlKey === shortcutCtrl &&
          event.metaKey === shortcutMeta &&
          event.altKey === shortcutAlt &&
          event.shiftKey === shortcutShift
        ) {
          event.preventDefault()
          toggleSidebar()
        }
      }

      window.addEventListener('keydown', handleKeyDown)
      return () => window.removeEventListener('keydown', handleKeyDown)
    }, [shortcutCode, shortcutCtrl, shortcutMeta, shortcutAlt, shortcutShift, toggleSidebar])

    // We add a state so that we can do data-state="expanded" or "collapsed".
    // This makes it easier to style the sidebar with Tailwind classes.
    const state = open || expandedByHover ? 'expanded' : 'collapsed'

    const contextValue = React.useMemo<SidebarContextValue>(
      () => ({
        state,
        open,
        setOpen,
        isMobile,
        openMobile,
        setOpenMobile,
        toggleSidebar,
        expandedByHover,
        setExpandedByHover,
      }),
      [state, open, setOpen, isMobile, openMobile, toggleSidebar, expandedByHover],
    )

    return (
      <SidebarContext.Provider value={contextValue}>
        <TooltipProvider delayDuration={0}>
          <div
            style={
              {
                '--sidebar-width': SIDEBAR_WIDTH,
                '--sidebar-width-icon': SIDEBAR_WIDTH_ICON,
                ...style,
              } as React.CSSProperties
            }
            className={cn(
              'group/sidebar-wrapper flex min-h-svh w-full has-[[data-variant=inset]]:bg-sidebar',
              className,
            )}
            ref={ref}
            {...props}
          >
            {children}
          </div>
        </TooltipProvider>
      </SidebarContext.Provider>
    )
  },
)
SidebarProvider.displayName = 'SidebarProvider'

const Sidebar = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<'div'> & {
    side?: 'left' | 'right'
    variant?: 'sidebar' | 'floating' | 'inset'
    collapsible?: 'offcanvas' | 'icon' | 'none'
    /**
     * With `collapsible="icon"`: the collapsed sidebar keeps its icon width in the layout and
     * opens over the page while the pointer is on it or keyboard focus is inside it (focus a
     * click leaves behind does not keep it open). The page does not move. (Always open and collapsed need no prop: they are the `open` state of the provider.)
     */
    expandOnHover?: boolean
    /** Names the sidebar where it is a sheet (small screens). */
    label?: string
  }
>(
  (
    {
      side = 'left',
      variant = 'sidebar',
      collapsible = 'offcanvas',
      expandOnHover = false,
      label = 'Navigation',
      className,
      children,
      onPointerEnter,
      onPointerLeave,
      onPointerDown,
      onFocus,
      onBlur,
      ...props
    },
    ref,
  ) => {
    const { isMobile, state, openMobile, setOpenMobile, setExpandedByHover } = useSidebar()
    const overflowing = expandOnHover && collapsible === 'icon'

    // Hover and focus are tracked apart: leaving with the pointer must not collapse a sidebar
    // that holds focus, and the other way around. Only focus that does not come from the pointer
    // counts: a link clicked in the rail keeps focus after the click, and the rail must not stay
    // open over the page once the pointer has left (the page would be covered with nothing to
    // close it). Keyboard focus keeps it open until focus leaves.
    const [pointerInside, setPointerInside] = React.useState(false)
    const [focusInside, setFocusInside] = React.useState(false)
    const pointerFocus = React.useRef(false)
    React.useEffect(() => {
      if (!overflowing) return
      // Focus follows pointerdown and precedes pointerup: once the pointer is up, focus that
      // arrives is the keyboard's again (also when the pointer was released outside the rail).
      const reset = () => {
        pointerFocus.current = false
      }
      window.addEventListener('pointerup', reset, true)
      window.addEventListener('pointercancel', reset, true)
      return () => {
        window.removeEventListener('pointerup', reset, true)
        window.removeEventListener('pointercancel', reset, true)
      }
    }, [overflowing])
    const expandedByHover = overflowing && (pointerInside || focusInside)
    React.useEffect(() => {
      setExpandedByHover(expandedByHover)
      return () => setExpandedByHover(false)
    }, [expandedByHover, setExpandedByHover])

    if (collapsible === 'none') {
      return (
        <div
          className={cn(
            'flex h-full w-(--sidebar-width) flex-col bg-sidebar text-sidebar-foreground',
            className,
          )}
          ref={ref}
          {...props}
        >
          {children}
        </div>
      )
    }

    if (isMobile) {
      return (
        <Sheet open={openMobile} onOpenChange={setOpenMobile}>
          <SheetContent
            data-sidebar="sidebar"
            data-mobile="true"
            className="w-(--sidebar-width) bg-sidebar p-0 text-sidebar-foreground [&>button]:hidden"
            style={
              {
                '--sidebar-width': SIDEBAR_WIDTH_MOBILE,
              } as React.CSSProperties
            }
            side={side}
          >
            <SheetTitle className="sr-only">{label}</SheetTitle>
            <SheetDescription className="sr-only">Navigation of the Web App</SheetDescription>
            <div className="flex h-full w-full flex-col">{children}</div>
          </SheetContent>
        </Sheet>
      )
    }

    return (
      <div
        ref={ref}
        className={cn(
          overflowing ? 'w-12' : '',
          'relative group peer hidden md:block text-sidebar-foreground',
          'shrink-0',
        )}
        data-state={state}
        data-collapsible={state === 'collapsed' ? collapsible : ''}
        data-variant={variant}
        data-side={side}
      >
        {/* This is what handles the sidebar gap on desktop */}
        <div
          className={cn(
            overflowing ? 'absolute top-0' : 'relative',
            'duration-100 h-full w-(--sidebar-width) bg-transparent transition-[width] ease-linear motion-reduce:transition-none',
            'group-data-[collapsible=offcanvas]:w-0',
            'group-data-[side=right]:rotate-180',
            variant === 'floating' || variant === 'inset'
              ? 'group-data-[collapsible=icon]:w-[calc(var(--sidebar-width-icon)+(--spacing(4)))]'
              : 'group-data-[collapsible=icon]:w-(--sidebar-width-icon)',
          )}
        />
        {/* biome-ignore lint/a11y/noStaticElementInteractions: hover and focus tracking only; the controls inside are the interactive elements */}
        <div
          className={cn(
            'absolute top-0 h-full', // sidebar custom changes - We have also removed 'fixed', and 'h-svh'
            //
            'duration-100 inset-y-0 z-10 hidden w-(--sidebar-width) transition-[left,right,width] ease-linear motion-reduce:transition-none md:flex',
            side === 'left'
              ? 'left-0 group-data-[collapsible=offcanvas]:-left-(--sidebar-width)'
              : 'right-0 group-data-[collapsible=offcanvas]:-right-(--sidebar-width)',
            // Adjust the padding for floating and inset variants.
            variant === 'floating' || variant === 'inset'
              ? 'p-2 group-data-[collapsible=icon]:w-[calc(var(--sidebar-width-icon)+(--spacing(4))+2px)]'
              : 'group-data-[collapsible=icon]:w-(--sidebar-width-icon) group-data-[side=left]:border-r group-data-[side=right]:border-l',
            className,
          )}
          onPointerEnter={(event) => {
            onPointerEnter?.(event)
            // A touch is not a hover: a finger on the sidebar would leave it open.
            if (event.pointerType !== 'touch') {
              setPointerInside(true)
            }
          }}
          onPointerLeave={(event) => {
            onPointerLeave?.(event)
            setPointerInside(false)
          }}
          onPointerDown={(event) => {
            onPointerDown?.(event)
            pointerFocus.current = true
          }}
          onFocus={(event) => {
            onFocus?.(event)
            setFocusInside(!pointerFocus.current)
          }}
          onBlur={(event) => {
            onBlur?.(event)
            if (!event.currentTarget.contains(event.relatedTarget)) {
              setFocusInside(false)
            }
          }}
          {...props}
        >
          <div
            data-sidebar="sidebar"
            className="flex h-full w-full flex-col bg-sidebar group-data-[variant=floating]:rounded-lg group-data-[variant=floating]:border group-data-[variant=floating]:border-sidebar-border group-data-[variant=floating]:shadow-sm"
          >
            {children}
          </div>
        </div>
      </div>
    )
  },
)
Sidebar.displayName = 'Sidebar'

const SidebarTrigger = React.forwardRef<
  React.ComponentRef<typeof Button>,
  React.ComponentProps<typeof Button>
>(({ className, onClick, ...props }, ref) => {
  const { toggleSidebar, isMobile, openMobile, open } = useSidebar()

  return (
    <Button
      ref={ref}
      data-sidebar="trigger"
      variant="text"
      aria-label="Toggle sidebar"
      aria-expanded={isMobile ? openMobile : open}
      icon={<PanelLeft className="size-4" />}
      className={cn('h-7 w-7', className)}
      onClick={(event) => {
        onClick?.(event)
        toggleSidebar()
      }}
      {...props}
    />
  )
})
SidebarTrigger.displayName = 'SidebarTrigger'

const SidebarRail = React.forwardRef<HTMLButtonElement, React.ComponentProps<'button'>>(
  ({ className, ...props }, ref) => {
    const { toggleSidebar } = useSidebar()

    return (
      <button
        ref={ref}
        type="button"
        data-sidebar="rail"
        // A pointer shortcut for what SidebarTrigger already offers, so it is left out of the
        // accessibility tree and the tab order rather than announced twice.
        aria-hidden="true"
        tabIndex={-1}
        onClick={toggleSidebar}
        className={cn(
          'absolute inset-y-0 z-20 hidden w-4 -translate-x-1/2 transition-all ease-linear motion-reduce:transition-none after:absolute after:inset-y-0 after:left-1/2 after:w-[2px] hover:after:bg-sidebar-border group-data-[side=left]:-right-4 group-data-[side=right]:left-0 sm:flex',
          'in-data-[side=left]:cursor-w-resize in-data-[side=right]:cursor-e-resize',
          '[[data-side=left][data-state=collapsed]_&]:cursor-e-resize [[data-side=right][data-state=collapsed]_&]:cursor-w-resize',
          'group-data-[collapsible=offcanvas]:translate-x-0 group-data-[collapsible=offcanvas]:after:left-full group-data-[collapsible=offcanvas]:hover:bg-sidebar',
          '[[data-side=left][data-collapsible=offcanvas]_&]:-right-2',
          '[[data-side=right][data-collapsible=offcanvas]_&]:-left-2',
          className,
        )}
        {...props}
      />
    )
  },
)
SidebarRail.displayName = 'SidebarRail'

const SidebarInset = React.forwardRef<HTMLDivElement, React.ComponentProps<'main'>>(
  ({ className, ...props }, ref) => {
    return (
      <main
        ref={ref}
        className={cn(
          'relative flex min-h-svh flex-1 flex-col bg-background',
          'peer-data-[variant=inset]:min-h-[calc(100svh-(--spacing(4)))] md:peer-data-[variant=inset]:m-2 md:peer-data-[state=collapsed]:peer-data-[variant=inset]:ml-2 md:peer-data-[variant=inset]:ml-0 md:peer-data-[variant=inset]:rounded-xl md:peer-data-[variant=inset]:shadow-sm',
          className,
        )}
        {...props}
      />
    )
  },
)
SidebarInset.displayName = 'SidebarInset'

const SidebarInput = React.forwardRef<
  React.ComponentRef<typeof Input>,
  React.ComponentProps<typeof Input>
>(({ className, ...props }, ref) => {
  return (
    <Input
      ref={ref}
      data-sidebar="input"
      className={cn('h-8 w-full bg-background shadow-none', className)}
      {...props}
    />
  )
})
SidebarInput.displayName = 'SidebarInput'

const SidebarHeader = React.forwardRef<HTMLDivElement, React.ComponentProps<'div'>>(
  ({ className, ...props }, ref) => {
    return (
      <div
        ref={ref}
        data-sidebar="header"
        className={cn('flex flex-col gap-2 p-2', className)}
        {...props}
      />
    )
  },
)
SidebarHeader.displayName = 'SidebarHeader'

const SidebarFooter = React.forwardRef<HTMLDivElement, React.ComponentProps<'div'>>(
  ({ className, ...props }, ref) => {
    return (
      <div
        ref={ref}
        data-sidebar="footer"
        className={cn('flex flex-col gap-2 p-2', className)}
        {...props}
      />
    )
  },
)
SidebarFooter.displayName = 'SidebarFooter'

const SidebarSeparator = React.forwardRef<
  React.ComponentRef<typeof SeparatorPrimitive.Root>,
  React.ComponentProps<typeof Separator>
>(({ className, ...props }, ref) => {
  return (
    <Separator
      ref={ref}
      data-sidebar="separator"
      className={cn('mx-2 w-auto bg-sidebar-border', className)}
      {...props}
    />
  )
})
SidebarSeparator.displayName = 'SidebarSeparator'

const SidebarContent = React.forwardRef<HTMLDivElement, React.ComponentProps<'div'>>(
  ({ className, ...props }, ref) => {
    return (
      <div
        ref={ref}
        data-sidebar="content"
        className={cn(
          'flex min-h-0 flex-1 flex-col gap-2 overflow-auto group-data-[collapsible=icon]:overflow-hidden',
          className,
        )}
        {...props}
      />
    )
  },
)
SidebarContent.displayName = 'SidebarContent'

const SidebarGroup = React.forwardRef<HTMLDivElement, React.ComponentProps<'div'>>(
  ({ className, ...props }, ref) => {
    return (
      <div
        ref={ref}
        data-sidebar="group"
        className={cn('relative flex w-full min-w-0 flex-col p-2', className)}
        {...props}
      />
    )
  },
)
SidebarGroup.displayName = 'SidebarGroup'

const SidebarGroupLabel = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<'div'> & { asChild?: boolean }
>(({ className, asChild = false, ...props }, ref) => {
  const Comp = asChild ? SlotPrimitive.Slot : 'div'

  return (
    <Comp
      ref={ref}
      data-sidebar="group-label"
      className={cn(
        'duration-100 flex h-8 shrink-0 items-center rounded-md px-2 text-xs font-medium text-sidebar-foreground/70 focus-ring transition-[margin,opacity] ease-linear motion-reduce:transition-none [&>svg]:size-5 [&>svg]:shrink-0',
        'group-data-[collapsible=icon]:-mt-8 group-data-[collapsible=icon]:opacity-0',
        className,
      )}
      {...props}
    />
  )
})
SidebarGroupLabel.displayName = 'SidebarGroupLabel'

const SidebarGroupAction = React.forwardRef<
  HTMLButtonElement,
  React.ComponentProps<'button'> & { asChild?: boolean }
>(({ className, asChild = false, disabled, tabIndex, ...props }, ref) => {
  const Comp = asChild ? SlotPrimitive.Slot : 'button'
  const computedTabIndex = getExplicitTabIndex(tabIndex, disabled)

  return (
    <Comp
      ref={ref}
      data-sidebar="group-action"
      className={cn(
        'absolute right-3 top-3.5 flex aspect-square w-5 items-center justify-center rounded-md p-0 text-sidebar-foreground focus-ring transition-transform motion-reduce:transition-none hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground [&>svg]:size-5 [&>svg]:shrink-0',
        // Increases the hit area of the button on mobile.
        'after:absolute after:-inset-2 after:md:hidden',
        'group-data-[collapsible=icon]:hidden',
        className,
      )}
      {...props}
      disabled={disabled}
      tabIndex={computedTabIndex}
    />
  )
})
SidebarGroupAction.displayName = 'SidebarGroupAction'

const SidebarGroupContent = React.forwardRef<HTMLDivElement, React.ComponentProps<'div'>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      data-sidebar="group-content"
      className={cn('w-full text-sm', className)}
      {...props}
    />
  ),
)
SidebarGroupContent.displayName = 'SidebarGroupContent'

const SidebarMenu = React.forwardRef<HTMLUListElement, React.ComponentProps<'ul'>>(
  ({ className, ...props }, ref) => (
    <ul
      ref={ref}
      data-sidebar="menu"
      className={cn('flex w-full min-w-0 flex-col gap-1', className)}
      {...props}
    />
  ),
)
SidebarMenu.displayName = 'SidebarMenu'

const SidebarMenuItem = React.forwardRef<HTMLLIElement, React.ComponentProps<'li'>>(
  ({ className, ...props }, ref) => (
    <li
      ref={ref}
      data-sidebar="menu-item"
      className={cn('group/menu-item relative', className)}
      {...props}
    />
  ),
)
SidebarMenuItem.displayName = 'SidebarMenuItem'

const sidebarMenuButtonVariants = cva(
  cn(
    'peer/menu-button flex w-full items-center gap-2 overflow-hidden rounded-md py-2 px-1.5 text-left text-sm focus-ring transition-[width,height,padding] motion-reduce:transition-none hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground active:bg-sidebar-accent/50 active:text-sidebar-accent-foreground disabled:pointer-events-none disabled:opacity-50 group-has-data-[sidebar=menu-action]/menu-item:pr-8 aria-disabled:opacity-50 aria-disabled:cursor-not-allowed data-[active=true]:bg-sidebar-accent data-[active=true]:font-medium data-[active=true]:text-sidebar-accent-foreground data-[state=open]:hover:bg-sidebar-accent/50 data-[state=open]:hover:text-sidebar-accent-foreground [&>span:last-child]:truncate [&>svg]:size-5 [&>svg]:shrink-0 text-foreground-lighter data-[active=true]:text-foreground',
  ),
  {
    variants: {
      variant: {
        default: 'hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground',
        outline:
          'bg-background shadow-[0_0_0_1px_var(--sidebar-border)] hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground hover:shadow-[0_0_0_1px_var(--sidebar-accent)]',
      },
      size: {
        default: 'h-8 text-sm',
        sm: 'h-7 text-xs',
        lg: 'h-12 text-sm group-data-[collapsible=icon]:p-0!',
      },
      hasIcon: {
        true: 'group-data-[collapsible=icon]:size-8! group-data-[collapsible=icon]:pl-1.5! group-data-[collapsible=icon]:pr-2!',
        false: '',
      },
      isLoading: {
        // When data necessary to check whether an item should be disabled is not yet available, override the styles to avoid
        // showing the disabled state just for a moment
        true: 'disabled:opacity-100 aria-disabled:opacity-100',
        // If the item is not loading, fallback to the default styles so that disabled state is handled properly
        false: '',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
      hasIcon: true,
    },
  },
)

const SidebarMenuButton = React.forwardRef<
  HTMLButtonElement,
  React.ComponentProps<'button'> & {
    asChild?: boolean
    isActive?: boolean
    tooltip?: string | React.ComponentProps<typeof TooltipContent>
    hasIcon?: boolean
    isLoading?: boolean
    /**
     * Keeps a disabled entry focusable (`aria-disabled` instead of `disabled`, with the click
     * suppressed), so a tooltip can say why it is unavailable: for such an entry `tooltip` is shown
     * in every state of the sidebar, not only while it is collapsed. A link (`asChild`) cannot be
     * natively disabled and is always handled this way; render a button for a destination that is
     * unavailable if a router would navigate before the click is stopped.
     */
    focusableWhenDisabled?: boolean
  } & VariantProps<typeof sidebarMenuButtonVariants>
>(
  (
    {
      asChild = false,
      isActive = false,
      variant = 'default',
      size = 'default',
      hasIcon = true,
      isLoading = false,
      focusableWhenDisabled = false,
      tooltip,
      className,
      ...props
    },
    ref,
  ) => {
    const Comp = asChild ? SlotPrimitive.Slot : 'button'
    const { isMobile, state } = useSidebar()
    const [tooltipOpen, setTooltipOpen] = React.useState(false)
    const { disabled, tabIndex, onClick, ...rest } = props

    const isDisabled = disabled === true
    const ariaOnly = isDisabled && (asChild || focusableWhenDisabled)
    const nativeDisabled = isDisabled && !ariaOnly
    const computedTabIndex = getExplicitTabIndex(tabIndex, nativeDisabled)

    const button = (
      <Comp
        ref={ref}
        data-sidebar="menu-button"
        data-size={size}
        data-active={isActive}
        data-has-icon={hasIcon}
        aria-current={isActive ? 'page' : undefined}
        className={cn(sidebarMenuButtonVariants({ variant, size, hasIcon, isLoading }), className)}
        {...rest}
        aria-disabled={ariaOnly || undefined}
        disabled={asChild ? undefined : nativeDisabled}
        tabIndex={computedTabIndex}
        onClick={(event: React.MouseEvent<HTMLButtonElement>) => {
          if (isDisabled) {
            event.preventDefault()
            event.stopPropagation()
            return
          }
          onClick?.(event)
        }}
      />
    )

    if (!tooltip) {
      return button
    }

    const tooltipProps = typeof tooltip === 'string' ? { children: tooltip } : tooltip
    // The tooltip repeats the label that the collapsed sidebar hides. While the label is visible
    // it stays closed (and unmounted), so it cannot take the Escape key from the sheet or the
    // page behind it; the tree keeps its shape so focus is not lost when the state switches. An
    // entry that is disabled with a reason shows its tooltip, the reason, in every state.
    const tooltipEnabled = (state === 'collapsed' && !isMobile) || ariaOnly

    return (
      <Tooltip open={tooltipEnabled && tooltipOpen} onOpenChange={setTooltipOpen}>
        <TooltipTrigger asChild>{button}</TooltipTrigger>
        <TooltipContent side="right" align="center" {...tooltipProps} />
      </Tooltip>
    )
  },
)
SidebarMenuButton.displayName = 'SidebarMenuButton'

const SidebarMenuAction = React.forwardRef<
  HTMLButtonElement,
  React.ComponentProps<'button'> & {
    asChild?: boolean
    showOnHover?: boolean
  }
>(({ className, asChild = false, showOnHover = false, disabled, tabIndex, ...props }, ref) => {
  const Comp = asChild ? SlotPrimitive.Slot : 'button'
  const computedTabIndex = getExplicitTabIndex(tabIndex, disabled)

  return (
    <Comp
      ref={ref}
      data-sidebar="menu-action"
      className={cn(
        'absolute right-1 top-1.5 flex aspect-square w-5 items-center justify-center rounded-md p-0 text-sidebar-foreground focus-ring transition-transform motion-reduce:transition-none hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground peer-hover/menu-button:text-sidebar-accent-foreground [&>svg]:size-5 [&>svg]:shrink-0',
        // Increases the hit area of the button on mobile.
        'after:absolute after:-inset-2 after:md:hidden',
        'peer-data-[size=sm]/menu-button:top-1',
        'peer-data-[size=default]/menu-button:top-1.5',
        'peer-data-[size=lg]/menu-button:top-2.5',
        'group-data-[collapsible=icon]:hidden',
        showOnHover &&
          'group-focus-within/menu-item:opacity-100 group-hover/menu-item:opacity-100 data-[state=open]:opacity-100 peer-data-[active=true]/menu-button:text-sidebar-accent-foreground md:opacity-0',
        className,
      )}
      {...props}
      disabled={disabled}
      tabIndex={computedTabIndex}
    />
  )
})
SidebarMenuAction.displayName = 'SidebarMenuAction'

const SidebarMenuBadge = React.forwardRef<HTMLDivElement, React.ComponentProps<'div'>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      data-sidebar="menu-badge"
      className={cn(
        'absolute right-1 flex h-5 min-w-5 items-center justify-center rounded-md px-1 text-xs font-medium tabular-nums text-sidebar-foreground select-none pointer-events-none',
        'peer-hover/menu-button:text-sidebar-accent-foreground peer-data-[active=true]/menu-button:text-sidebar-accent-foreground',
        'peer-data-[size=sm]/menu-button:top-1',
        'peer-data-[size=default]/menu-button:top-1.5',
        'peer-data-[size=lg]/menu-button:top-2.5',
        'group-data-[collapsible=icon]:hidden',
        className,
      )}
      {...props}
    />
  ),
)
SidebarMenuBadge.displayName = 'SidebarMenuBadge'

const SidebarMenuSkeleton = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<'div'> & {
    showIcon?: boolean
  }
>(({ className, showIcon = false, ...props }, ref) => {
  // A width between 50 and 89%, derived from the instance id: it varies between rows but is the
  // same on every render and in every test run.
  const id = React.useId()
  const width = `${50 + (Array.from(id).reduce((sum, char) => sum + char.charCodeAt(0), 0) % 40)}%`

  return (
    <div
      ref={ref}
      data-sidebar="menu-skeleton"
      className={cn('rounded-md h-8 flex gap-2 px-2 items-center', className)}
      {...props}
    >
      {showIcon && <Skeleton className="size-4 rounded-md" data-sidebar="menu-skeleton-icon" />}
      <Skeleton
        className="h-4 flex-1 max-w-(--skeleton-width)"
        data-sidebar="menu-skeleton-text"
        style={
          {
            '--skeleton-width': width,
          } as React.CSSProperties
        }
      />
    </div>
  )
})
SidebarMenuSkeleton.displayName = 'SidebarMenuSkeleton'

const SidebarMenuSub = React.forwardRef<HTMLUListElement, React.ComponentProps<'ul'>>(
  ({ className, ...props }, ref) => (
    <ul
      ref={ref}
      data-sidebar="menu-sub"
      className={cn(
        'mx-3.5 flex min-w-0 translate-x-px flex-col gap-1 border-l border-sidebar-border px-2.5 py-0.5',
        'group-data-[collapsible=icon]:hidden',
        className,
      )}
      {...props}
    />
  ),
)
SidebarMenuSub.displayName = 'SidebarMenuSub'

const SidebarMenuSubItem = React.forwardRef<HTMLLIElement, React.ComponentProps<'li'>>(
  ({ ...props }, ref) => <li ref={ref} {...props} />,
)
SidebarMenuSubItem.displayName = 'SidebarMenuSubItem'

const SidebarMenuSubButton = React.forwardRef<
  HTMLAnchorElement,
  React.ComponentProps<'a'> & {
    asChild?: boolean
    size?: 'sm' | 'md'
    isActive?: boolean
  }
>(({ asChild = false, size = 'md', isActive, className, ...props }, ref) => {
  const Comp = asChild ? SlotPrimitive.Slot : 'a'

  return (
    <Comp
      ref={ref}
      data-sidebar="menu-sub-button"
      data-size={size}
      data-active={isActive}
      className={cn(
        'flex h-6 min-w-0 -translate-x-px items-center gap-2 overflow-hidden rounded-md px-2 text-sidebar-foreground focus-ring hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground active:bg-sidebar-accent/50 active:text-sidebar-accent-foreground disabled:pointer-events-none disabled:opacity-50 aria-disabled:opacity-50 aria-disabled:cursor-not-allowed [&>span:last-child]:truncate [&>svg]:size-5 [&>svg]:shrink-0 [&>svg]:text-sidebar-accent-foreground',
        'data-[active=true]:bg-sidebar-accent data-[active=true]:text-sidebar-accent-foreground',
        size === 'sm' && 'text-xs',
        size === 'md' && 'text-sm',
        'group-data-[collapsible=icon]:hidden',
        className,
      )}
      {...props}
    />
  )
})
SidebarMenuSubButton.displayName = 'SidebarMenuSubButton'

export {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInput,
  SidebarInset,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
  SidebarRail,
  SidebarSeparator,
  SidebarTrigger,
  sidebarMenuButtonVariants,
  useSidebar,
}
