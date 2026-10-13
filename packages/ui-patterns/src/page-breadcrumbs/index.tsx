// Derived from supabase/supabase packages/ui-patterns/src/PageBreadcrumbs/index.tsx @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
  cn,
} from '@exponetdb/ui'
import { type ComponentProps, Fragment, type ReactNode } from 'react'

import { PageContainer } from '../page-container/index.tsx'
import { useLinkComponent } from '../seams/index.ts'

const pageChromeClassName = 'px-4 xl:px-4'

// ============================================================================
// Actions
// ============================================================================

export type PageBreadcrumbsActionsProps = ComponentProps<'div'>

/**
 * Actions for the page breadcrumbs row.
 * Pass as the `actions` prop on `PageBreadcrumbs`.
 */
const PageBreadcrumbsActions = ({ className, ...props }: PageBreadcrumbsActionsProps) => {
  return (
    <div
      data-slot="page-breadcrumbs-actions"
      className={cn('ml-auto flex shrink-0 items-center gap-2', className)}
      {...props}
    />
  )
}
PageBreadcrumbsActions.displayName = 'PageBreadcrumbsActions'

// ============================================================================
// Breadcrumbs
// ============================================================================

export interface PageBreadcrumbItem {
  /** The text of the crumb. Names come from the registry: they render as text only. */
  readonly label: string
  /** An app path the caller built from typed values. The last item is the current page and takes none. */
  readonly href?: string
}

export type PageBreadcrumbsProps = Omit<ComponentProps<typeof Breadcrumb>, 'children'> & {
  /** From the top level to the current page; the last item is the current page. */
  items: readonly PageBreadcrumbItem[]
  actions?: ReactNode
  containerClassName?: string
  slotClassName?: string
}

/**
 * Full-width breadcrumb row for page chrome: a named `nav` landmark holding an
 * ordered list. The links render through the link seam; the last item is the
 * current page (`aria-current="page"`) and is not a link. Sits above
 * `PageHeader` and page content, not inside `PageHeader`.
 */
const PageBreadcrumbs = ({
  items,
  actions,
  className,
  containerClassName,
  slotClassName,
  ...props
}: PageBreadcrumbsProps) => {
  const Link = useLinkComponent()
  const lastIndex = items.length - 1

  return (
    <div data-slot="page-breadcrumbs" className={cn(slotClassName)}>
      <PageContainer
        size="full"
        className={cn(
          'flex min-h-12 items-center justify-between gap-4 border-b py-2',
          pageChromeClassName,
          containerClassName,
        )}
      >
        {items.length > 0 ? (
          <Breadcrumb
            data-slot="page-breadcrumbs-list"
            className={cn('min-w-0 [&_li]:text-sm', className)}
            {...props}
          >
            <BreadcrumbList>
              {items.map((item, index) => (
                <Fragment key={`${item.href ?? ''}|${item.label}`}>
                  <BreadcrumbItem className="min-w-0">
                    {index === lastIndex ? (
                      // UntrustedText: a crumb label can be a registry name
                      <BreadcrumbPage className="wrap-anywhere">{item.label}</BreadcrumbPage>
                    ) : item.href !== undefined ? (
                      <BreadcrumbLink asChild>
                        {/* UntrustedText: a crumb label can be a registry name */}
                        <Link href={item.href} className="wrap-anywhere">
                          {item.label}
                        </Link>
                      </BreadcrumbLink>
                    ) : (
                      <span className="wrap-anywhere">{item.label}</span>
                    )}
                  </BreadcrumbItem>
                  {index < lastIndex && <BreadcrumbSeparator />}
                </Fragment>
              ))}
            </BreadcrumbList>
          </Breadcrumb>
        ) : null}
        {actions}
      </PageContainer>
    </div>
  )
}
PageBreadcrumbs.displayName = 'PageBreadcrumbs'

export { PageBreadcrumbs, PageBreadcrumbsActions }
