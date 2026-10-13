// Derived from supabase/supabase packages/ui-patterns/src/PageNav/index.tsx @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import { cn, NavMenu, NavMenuItem } from '@exponetdb/ui'
import type { ComponentProps } from 'react'

import { PageContainer } from '../page-container/index.tsx'
import { useLinkComponent } from '../seams/index.ts'

const pageChromeClassName = 'px-4 xl:px-4'

export interface PageNavItem {
  /** The text of the link. */
  readonly label: string
  /** An app path the caller built from typed values, never one taken from data. */
  readonly href: string
  /** True for the page the person is on: the link gets `aria-current="page"`. */
  readonly active: boolean
}

export type PageNavProps = Omit<ComponentProps<'div'>, 'children'> & {
  /** Names the navigation landmark ("Target sections"). Several navigations on a page need different names. */
  readonly label: string
  readonly items: readonly PageNavItem[]
}

/**
 * Full-width sub-navigation row for page chrome. It is navigation, not a menu
 * widget: a named `nav` landmark holding a list of links (through the link
 * seam), Tab moves between the links and the current one carries
 * `aria-current="page"`. Sits below `PageBreadcrumbs` and outside `PageHeader`.
 */
const PageNav = ({ label, items, className, ...props }: PageNavProps) => {
  const linkComponent = useLinkComponent()
  return (
    <PageContainer
      data-slot="page-nav"
      size="full"
      className={cn('flex min-h-12 items-center border-b', pageChromeClassName)}
    >
      <div
        data-slot="page-nav-menu"
        className={cn(
          'flex min-h-12 w-full items-center',
          '[&>nav]:flex [&>nav]:h-12 [&>nav]:items-center [&>nav]:border-b-0',
          '[&>nav>ul]:h-full [&>nav>ul]:items-center',
          '[&>nav>ul>li]:h-full',
          className,
        )}
        {...props}
      >
        <NavMenu aria-label={label}>
          {items.map((item) => (
            <NavMenuItem
              key={item.href}
              active={item.active}
              href={item.href}
              linkComponent={linkComponent}
            >
              {item.label}
            </NavMenuItem>
          ))}
        </NavMenu>
      </div>
    </PageContainer>
  )
}
PageNav.displayName = 'PageNav'

export { PageNav }
