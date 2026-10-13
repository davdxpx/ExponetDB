// Derived from supabase/supabase packages/ui-patterns/src/InnerSideMenu/index.tsx @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import { ChevronRight, ChevronsUpDown, Loader2, Search } from '@exponetdb/icons'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
  Input,
  Skeleton,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  TreeViewItemVariant,
} from '@exponetdb/ui'
import {
  type ComponentPropsWithoutRef,
  type ComponentRef,
  type ForwardRefExoticComponent,
  forwardRef,
  type ReactNode,
  type RefAttributes,
  useId,
} from 'react'

import { useLinkComponent } from '../seams/index.ts'
import { ShimmeringLoader } from '../shimmering-loader/index.tsx'

/**
 * The inner side menu of a section (the objects of a target, the pages of a settings area): a
 * named `nav` landmark. Its entries are links rendered through the link seam; the current one
 * carries `aria-current="page"`. It is navigation, not a menu widget (no `role="menu"`).
 */
const InnerSideMenu = forwardRef<
  HTMLElement,
  Omit<ComponentPropsWithoutRef<'nav'>, 'aria-label'> & {
    /** Names the landmark ("Schema objects"). Several navigations on a page need different names. */
    'aria-label': string
  }
>(({ className, ...props }, ref) => (
  <nav ref={ref} className={cn('flex w-full flex-col gap-0', className)} {...props} />
))
InnerSideMenu.displayName = 'InnerSideMenu'

const InnerSideBarTitle = forwardRef<HTMLSpanElement, ComponentPropsWithoutRef<'span'>>(
  ({ className, ...props }, ref) => {
    return (
      <span
        ref={ref}
        {...props}
        className={cn(
          'w-full flex gap-1 items-center group px-3 text-sm font-normal font-mono uppercase text-lighter tracking-wide group-hover:not-disabled:text-foreground',
          className,
        )}
      />
    )
  },
)
InnerSideBarTitle.displayName = 'InnerSideBarTitle'

type CollapsibleProps = ComponentPropsWithoutRef<typeof Collapsible>
const InnerSideMenuCollapsible: ForwardRefExoticComponent<
  CollapsibleProps & RefAttributes<ComponentRef<typeof Collapsible>>
> = forwardRef<ComponentRef<typeof Collapsible>, CollapsibleProps>(
  ({ className, ...props }, ref) => {
    return <Collapsible ref={ref} {...props} className={cn('w-full px-2 group', className)} />
  },
)
InnerSideMenuCollapsible.displayName = 'InnerSideMenuCollapsible'

type CollapsibleTriggerProps = Omit<
  ComponentPropsWithoutRef<typeof CollapsibleTrigger>,
  'title'
> & {
  /** The text of the trigger. Plain text: it names the group it opens. */
  title: string
}
const InnerSideMenuCollapsibleTrigger: ForwardRefExoticComponent<
  CollapsibleTriggerProps & RefAttributes<ComponentRef<typeof CollapsibleTrigger>>
> = forwardRef<ComponentRef<typeof CollapsibleTrigger>, CollapsibleTriggerProps>(
  ({ title, className, ...props }, ref) => {
    return (
      <CollapsibleTrigger
        ref={ref}
        {...props}
        className={cn(
          'w-full flex gap-1 items-center group px-3 text-sm font-normal font-mono uppercase text-lighter tracking-wide',
          className,
        )}
      >
        <ChevronRight
          aria-hidden="true"
          className="transition-all text-foreground-muted group-data-[state=open]:rotate-90 motion-reduce:transition-none"
          size={16}
          strokeWidth={1.5}
        />
        <span className="group-hover:not-disabled:text-foreground">{title}</span>
      </CollapsibleTrigger>
    )
  },
)
InnerSideMenuCollapsibleTrigger.displayName = 'InnerSideMenuCollapsibleTrigger'

type CollapsibleContentProps = ComponentPropsWithoutRef<typeof CollapsibleContent>
const InnerSideMenuCollapsibleContent: ForwardRefExoticComponent<
  CollapsibleContentProps & RefAttributes<ComponentRef<typeof CollapsibleContent>>
> = forwardRef<ComponentRef<typeof CollapsibleContent>, CollapsibleContentProps>(
  ({ className, ...props }, ref) => {
    return (
      <CollapsibleContent
        ref={ref}
        {...props}
        className={cn('w-full flex flex-col gap-0', className)}
      />
    )
  },
)
InnerSideMenuCollapsibleContent.displayName = 'InnerSideMenuCollapsibleContent'

const InnerSideMenuSeparator = forwardRef<HTMLHRElement, ComponentPropsWithoutRef<'hr'>>(
  ({ className, ...props }, ref) => {
    return <hr ref={ref} {...props} className={cn('h-px border-0 bg-border-muted', className)} />
  },
)
InnerSideMenuSeparator.displayName = 'InnerSideMenuSeparator'

type InnerSideMenuLinkProps = Omit<ComponentPropsWithoutRef<'a'>, 'href'> & {
  /** An app path the caller built from typed values, never one taken from data. */
  href: string
}

const InnerSideMenuItem = forwardRef<
  HTMLAnchorElement,
  InnerSideMenuLinkProps & {
    /** The current page: sets `aria-current="page"`. */
    isActive?: boolean
    forceHoverState?: boolean | null
  }
>(({ className, isActive = false, forceHoverState, ...props }, ref) => {
  const Link = useLinkComponent()
  return (
    <Link
      ref={ref}
      {...props}
      aria-current={isActive ? 'page' : undefined}
      className={cn(
        'text-sm',
        'h-7 pl-3 pr-2',
        'flex items-center justify-between rounded-md group relative focus-ring',
        isActive ? 'bg-selection' : 'hover:bg-surface-200',
        forceHoverState && 'bg-surface-200',
        isActive ? 'text-foreground' : 'text-foreground-light hover:text-foreground',
        className,
      )}
    />
  )
})
InnerSideMenuItem.displayName = 'InnerSideMenuItem'

const InnerSideMenuDataItem = forwardRef<
  HTMLAnchorElement,
  InnerSideMenuLinkProps & {
    /** The current page: sets `aria-current="page"`. */
    isActive?: boolean
    isPreview?: boolean
    isOpened?: boolean
  }
>(({ isActive = false, isPreview, isOpened = true, ...props }, ref) => {
  const Link = useLinkComponent()
  const { className, children, ...linkProps } = props
  return (
    <Link
      ref={ref}
      {...linkProps}
      aria-current={isActive ? 'page' : undefined}
      className={cn(
        TreeViewItemVariant({
          isSelected: isActive && !isPreview,
          isOpened: isOpened && !isPreview,
          isPreview,
        }),
        'px-4 focus-ring',
        className,
      )}
    >
      {!isPreview && isActive && (
        <div aria-hidden="true" className="absolute left-0 h-full w-0.5 bg-foreground" />
      )}
      {children}
    </Link>
  )
})
InnerSideMenuDataItem.displayName = 'InnerSideMenuDataItem'

function InnerSideMenuItemLoading({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof Skeleton>) {
  return (
    <div className="py-0.5 h-7">
      <Skeleton {...props} className={cn('h-full w-full bg-surface-200', className)} />
    </div>
  )
}

const InnerSideBarFilters = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<'div'>>(
  ({ className, ...props }, ref) => {
    return <div ref={ref} {...props} className={cn('flex px-2 gap-2 items-center', className)} />
  },
)
InnerSideBarFilters.displayName = 'InnerSideBarFilters'

const InnerSideBarFilterSearchInput = forwardRef<
  HTMLInputElement,
  Omit<ComponentPropsWithoutRef<typeof Input>, 'aria-label' | 'aria-labelledby'> & {
    /** The accessible name of the field ("Filter objects"). Read by assistive technology, not shown. */
    label: string
    isLoading?: boolean
    /** Controls placed over the end of the field (a sort menu). */
    children?: ReactNode
  }
>(({ children, label, isLoading = false, className, id, ...props }, ref) => {
  const generatedId = useId()
  const inputId = id ?? generatedId
  return (
    <div className="relative w-full">
      <label htmlFor={inputId} className="sr-only">
        {label}
      </label>
      <Input
        ref={ref}
        id={inputId}
        type="text"
        aria-busy={isLoading || undefined}
        className={cn(
          'h-[32px] md:h-[28px] w-full',
          'text-base md:text-xs',
          'pl-7',
          'pr-7',
          'w-full',
          'rounded-sm',
          className,
        )}
        {...props}
      />
      {children}
      {isLoading ? (
        <Loader2
          aria-hidden="true"
          className="animate-spin motion-reduce:animate-none absolute left-2 top-0 bottom-0 my-auto text-foreground-muted"
          size={14}
          strokeWidth={1.5}
        />
      ) : (
        <Search
          aria-hidden="true"
          className="absolute left-2 top-0 bottom-0 my-auto text-foreground-muted"
          size={14}
          strokeWidth={1.5}
        />
      )}
    </div>
  )
})
InnerSideBarFilterSearchInput.displayName = 'InnerSideBarFilterSearchInput'

/**
 * A sort menu over the end of the filter field. The options are `InnerSideBarFilterSortDropdownItem`s
 * in a radio group, so the chosen one is announced as checked. The trigger has an accessible
 * name and a tooltip. Needs the app's `TooltipProvider`.
 */
function InnerSideBarFilterSortDropdown({
  value,
  onValueChange,
  label = 'Sort by',
  contentClassName,
  triggerClassName,
  children,
}: {
  value: string
  onValueChange: (value: string) => void
  /** The accessible name of the trigger and the text of its tooltip. */
  label?: string
  contentClassName?: string
  triggerClassName?: string
  children?: ReactNode
}) {
  return (
    <DropdownMenu modal={false}>
      <Tooltip delayDuration={0}>
        <DropdownMenuTrigger asChild>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={label}
              className={cn(
                'absolute right-1 top-[.4rem] md:top-[.3rem] rounded-sm focus-ring',
                'text-foreground transition-colors motion-reduce:transition-none',
                triggerClassName,
              )}
            >
              <ChevronsUpDown aria-hidden="true" size={18} strokeWidth={1} />
            </button>
          </TooltipTrigger>
        </DropdownMenuTrigger>
        <TooltipContent side="bottom">{label}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent side="bottom" align="end" className={cn('w-48', contentClassName)}>
        <DropdownMenuRadioGroup value={value} onValueChange={onValueChange}>
          {children}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

type SortDropdownItemProps = ComponentPropsWithoutRef<typeof DropdownMenuRadioItem>
const InnerSideBarFilterSortDropdownItem: ForwardRefExoticComponent<
  SortDropdownItemProps & RefAttributes<ComponentRef<typeof DropdownMenuRadioItem>>
> = forwardRef<ComponentRef<typeof DropdownMenuRadioItem>, SortDropdownItemProps>((props, ref) => {
  return <DropdownMenuRadioItem ref={ref} {...props} />
})
InnerSideBarFilterSortDropdownItem.displayName = 'InnerSideBarFilterSortDropdownItem'

/** Placeholder rows while the list loads; announces `label` as a status. */
const InnerSideBarShimmeringLoaders = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<'div'> & { label?: string }
>(({ label = 'Loading', className, ...props }, ref) => {
  return (
    <div
      ref={ref}
      role="status"
      {...props}
      className={cn('flex flex-col px-2 gap-1 pb-4', className)}
    >
      <span className="sr-only">{label}</span>
      <ShimmeringLoader className="w-full h-7 rounded-md" delayIndex={0} />
      <ShimmeringLoader className="w-full h-7 rounded-md" delayIndex={1} />
      <ShimmeringLoader className="w-full h-7 rounded-md" delayIndex={2} />
    </div>
  )
})
InnerSideBarShimmeringLoaders.displayName = 'InnerSideBarShimmeringLoaders'

/**
 * The panel for a list that was read successfully and has no entries. A list whose read failed
 * must show the failed-read state instead (C-28); never this panel.
 */
const InnerSideBarEmptyPanel = forwardRef<
  HTMLDivElement,
  Omit<ComponentPropsWithoutRef<'div'>, 'title'> & {
    title: string
    description?: ReactNode
    illustration?: ReactNode
    actions?: ReactNode
  }
>(({ illustration, title, description, actions, className, children, ...props }, ref) => {
  return (
    <div
      ref={ref}
      {...props}
      className={cn(
        'border border-muted bg-surface-100 flex flex-col gap-y-3 items-center justify-center rounded-md px-5 py-4',
        className,
      )}
    >
      <div className="w-full flex flex-col gap-y-1 items-center">
        {illustration}
        <p className="text-xs text-foreground-light">{title}</p>
        {description && (
          <p className="text-xs text-foreground-lighter text-center">{description}</p>
        )}
        {actions && <div className="mt-2">{actions}</div>}
        {children}
      </div>
    </div>
  )
})
InnerSideBarEmptyPanel.displayName = 'InnerSideBarEmptyPanel'

export {
  InnerSideBarEmptyPanel,
  InnerSideBarFilterSearchInput,
  InnerSideBarFilterSortDropdown,
  InnerSideBarFilterSortDropdownItem,
  InnerSideBarFilters,
  InnerSideBarShimmeringLoaders,
  InnerSideBarTitle,
  InnerSideMenu,
  InnerSideMenuCollapsible,
  InnerSideMenuCollapsibleContent,
  InnerSideMenuCollapsibleTrigger,
  InnerSideMenuDataItem,
  InnerSideMenuItem,
  InnerSideMenuItemLoading,
  InnerSideMenuSeparator,
}
