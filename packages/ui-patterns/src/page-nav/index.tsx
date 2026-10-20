// Derived from supabase/supabase packages/ui-patterns/src/PageNav/index.tsx @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import { cn, NavMenu, NavMenuItem } from '@exponetdb/ui'
import { type ComponentProps, type ReactNode, useEffect, useRef } from 'react'

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
  /**
   * A small count or mark after the label ("3"). Part of the link, so its text is part of the
   * link's accessible name: the caller adds visually hidden words that say what it counts. Omit
   * it (or pass `undefined`) when there is nothing to say; a count that could not be read is
   * never passed as 0.
   */
  readonly badge?: ReactNode
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
  const scroller = useRef<HTMLDivElement>(null)
  // On a narrow screen the row scrolls inside itself; the current link is brought into view
  // (only this row moves, never the page).
  useEffect(() => {
    const row = scroller.current
    const current = row?.querySelector('[aria-current="page"]')
    if (row === null || row === undefined || current === null || current === undefined) return
    const rowBox = row.getBoundingClientRect()
    const box = current.getBoundingClientRect()
    if (box.left < rowBox.left) row.scrollLeft += box.left - rowBox.left
    else if (box.right > rowBox.right) row.scrollLeft += box.right - rowBox.right
  })
  return (
    <PageContainer
      data-slot="page-nav"
      size="full"
      className={cn('flex min-h-12 items-center border-b', pageChromeClassName)}
    >
      <div
        ref={scroller}
        data-slot="page-nav-menu"
        className={cn(
          'flex min-h-12 w-full items-center overflow-x-auto overscroll-x-contain',
          '[&>nav]:flex [&>nav]:h-12 [&>nav]:items-center [&>nav]:border-b-0',
          '[&>nav]:min-w-max',
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
              {item.badge === undefined || item.badge === null || item.badge === false ? null : (
                <>
                  {/* A space of its own, so the label and the badge's words never run together in the link's name. */}{' '}
                  <span data-slot="page-nav-badge" className="ml-0.5 inline-flex items-center">
                    {item.badge}
                  </span>
                </>
              )}
            </NavMenuItem>
          ))}
        </NavMenu>
      </div>
    </PageContainer>
  )
}
PageNav.displayName = 'PageNav'

export { PageNav }
