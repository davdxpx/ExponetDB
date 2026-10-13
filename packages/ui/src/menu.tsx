// Derived from supabase/supabase packages/ui/src/components/Menu/Menu.tsx @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import { cva } from 'class-variance-authority'
import { type CSSProperties, type ElementType, type MouseEvent, type ReactNode, useId } from 'react'

import { cn } from './lib/utils.ts'
import { MenuContextProvider, type MenuType, useMenuContext } from './menu-context.tsx'

interface MenuProps {
  children: ReactNode
  className?: string
  ulClassName?: string
  style?: CSSProperties
  type?: MenuType
  /** Names the navigation landmark. Several navigations on one page need different names. */
  'aria-label': string
}

/**
 * A vertical list of navigation links (a settings sidebar, an object list): a `nav` landmark
 * holding lists. It is navigation, not a menu widget: no `role="menu"`, Tab moves between the
 * entries and the current one carries `aria-current="page"`.
 */
function Menu({
  children,
  className,
  ulClassName,
  style,
  type = 'text',
  'aria-label': ariaLabel,
}: MenuProps) {
  return (
    <nav aria-label={ariaLabel} className={className} style={style}>
      <MenuContextProvider type={type}>
        <ul className={ulClassName}>{children}</ul>
      </MenuContextProvider>
    </nav>
  )
}

interface MenuItemProps {
  children: ReactNode
  icon?: ReactNode
  /** The current page: sets `aria-current="page"` and the active styling. */
  active?: boolean
  /** Renders a link to this address. Without it the entry is a button that calls `onClick`. */
  href?: string
  /**
   * The component that renders the link, in place of `<a>`: the seam to a router's link. It
   * receives `href`, `className`, `aria-current`, `style` and `onClick`. Only used with `href`.
   */
  linkComponent?: ElementType
  onClick?: (event: MouseEvent<HTMLElement>) => void
  style?: CSSProperties
  className?: string
}

export const menuItemVariants = cva(
  cn(
    'cursor-pointer flex space-x-3 items-center focus-visible:z-10 group w-full text-left',
    'focus-ring',
  ),
  {
    variants: {
      type: {
        text: 'py-1',
        border: 'px-4 py-1',
        pills: 'my-px px-3 py-[3px] rounded-md transition-colors active:bg-sidebar-accent/50',
      },
      active: {
        true: 'font-semibold z-10',
        false: 'font-normal border-default group-hover:border-foreground-muted',
      },
    },
    compoundVariants: [
      {
        type: 'text',
        active: true,
        className: 'text-foreground-muted',
      },
      {
        type: 'border',
        active: true,
        className:
          'text-foreground-muted border-l border-primary-bright group-hover:border-primary-bright',
      },
      {
        type: 'border',
        active: false,
        className: 'border-l',
      },
      {
        type: 'pills',
        active: true,
        className: 'bg-sidebar-accent text-foreground-lighter',
      },
      {
        type: 'pills',
        active: false,
        className: 'hover:bg-sidebar-accent/50',
      },
    ],
    defaultVariants: {
      active: false,
    },
  },
)

function MenuItem({
  children,
  icon,
  active,
  href,
  linkComponent,
  onClick,
  style,
  className,
}: MenuItemProps) {
  const { type } = useMenuContext()
  const LinkComponent: ElementType = linkComponent ?? 'a'
  const itemClassName = cn(menuItemVariants({ type, active }), className)

  const content = (
    <>
      {icon && (
        <span
          className={cn('transition truncate text-sm min-w-fit', {
            'text-foreground-lighter group-hover:text-foreground-light': !active,
            'text-foreground': active,
          })}
        >
          {icon}
        </span>
      )}
      <span
        className={cn('transition truncate text-sm w-full', {
          'text-foreground-light group-hover:text-foreground': !active,
          'text-foreground font-semibold': active,
        })}
      >
        {children}
      </span>
    </>
  )

  return (
    <li>
      {href !== undefined ? (
        <LinkComponent
          href={href}
          className={itemClassName}
          style={style}
          onClick={onClick}
          aria-current={active ? 'page' : undefined}
        >
          {content}
        </LinkComponent>
      ) : (
        <button
          type="button"
          className={itemClassName}
          style={style}
          onClick={onClick}
          aria-current={active ? 'page' : undefined}
        >
          {content}
        </button>
      )}
    </li>
  )
}

interface MenuGroupProps {
  /** The entries of the group (`MenuItem`s). */
  children?: ReactNode
  icon?: ReactNode
  title: ReactNode
  /** A control at the end of the title row, such as an add button. */
  action?: ReactNode
}

/** A titled group of entries: a list item holding the title and a list named by it. */
function MenuGroup({ children, icon, title, action }: MenuGroupProps) {
  const { type } = useMenuContext()
  const titleId = useId()

  return (
    <li>
      <div
        className={cn('flex space-x-3 mb-2 font-normal', {
          'px-3': type === 'pills',
        })}
      >
        {icon && <span className="text-foreground-lighter">{icon}</span>}
        <span id={titleId} className="text-sm text-foreground-lighter w-full">
          {title}
        </span>
        {action}
      </div>
      {children && <ul aria-labelledby={titleId}>{children}</ul>}
    </li>
  )
}

export { Menu, MenuGroup, MenuItem }
