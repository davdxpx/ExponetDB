// Derived from supabase/supabase packages/ui/src/components/NavMenu/index.tsx @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import { Slot } from 'radix-ui'
import { type ComponentPropsWithoutRef, type ElementType, forwardRef, type ReactNode } from 'react'

import { cn } from './lib/utils.ts'

interface NavMenuProps extends Omit<ComponentPropsWithoutRef<'nav'>, 'aria-label'> {
  /** Names the navigation landmark. Several navigations on one page need different names. */
  'aria-label': string
}

/**
 * Horizontal sub-navigation: a `nav` landmark holding a list of links. It is navigation, not a
 * menu widget, so there is no `role="menu"` and the arrow keys are not captured; Tab moves between
 * the links and the current one carries `aria-current="page"`.
 */
export const NavMenu = forwardRef<HTMLElement, NavMenuProps>(
  ({ children, className, ...props }, forwardedRef) => {
    return (
      <nav ref={forwardedRef} dir="ltr" {...props} className={cn('border-b', className)}>
        <ul className="flex gap-5">{children}</ul>
      </nav>
    )
  },
)
NavMenu.displayName = 'NavMenu'

interface NavMenuItemProps extends Omit<ComponentPropsWithoutRef<'li'>, 'children'> {
  /** The current page: sets `aria-current="page"` on the link and the active styling. */
  active: boolean
  children: ReactNode
  /** Renders the children as the label of a link to this address. */
  href?: string
  /**
   * The component that renders the link, in place of `<a>`: the seam to a router's link. It
   * receives `href`, `className`, `aria-current` and the link props. Only used with `href`.
   */
  linkComponent?: ElementType
  /** Extra props for the link, such as `target` or `onClick`. Only used with `href`. */
  linkProps?: Omit<ComponentPropsWithoutRef<'a'>, 'href' | 'children' | 'aria-current'>
  /**
   * Treat the single child as the link and merge `aria-current` and the styling into it (for a
   * link element made elsewhere). Without `href` and `asChild` the children are rendered as they are.
   */
  asChild?: boolean
}

const linkClassName = 'focus-ring rounded-sm'

export const NavMenuItem = forwardRef<HTMLLIElement, NavMenuItemProps>(
  (
    { children, className, active, href, linkComponent, linkProps, asChild = false, ...props },
    ref,
  ) => {
    const current = active ? 'page' : undefined
    const LinkComponent: ElementType = linkComponent ?? 'a'

    return (
      <li
        ref={ref}
        data-state={active ? 'active' : 'inactive'}
        className={cn(
          'inline-flex items-center justify-center whitespace-nowrap text-sm transition-colors data-[state=active]:text-foreground text-foreground-lighter hover:text-foreground data-[state=active]:border-foreground border-b-2 border-transparent *:py-1.5',
          className,
        )}
        {...props}
      >
        {href !== undefined ? (
          <LinkComponent
            {...linkProps}
            href={href}
            aria-current={current}
            className={cn(linkClassName, linkProps?.className)}
          >
            {children}
          </LinkComponent>
        ) : asChild ? (
          <Slot.Slot aria-current={current} className={linkClassName}>
            {children}
          </Slot.Slot>
        ) : (
          children
        )}
      </li>
    )
  },
)
NavMenuItem.displayName = 'NavMenuItem'
