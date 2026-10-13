// Derived from supabase/supabase packages/ui-patterns/src/PageHeader/index.tsx @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import { cn } from '@exponetdb/ui'
import { cva, type VariantProps } from 'class-variance-authority'
import { type ComponentProps, createContext, type ReactNode, useContext } from 'react'

import { PageContainer } from '../page-container/index.tsx'

// ============================================================================
// Variants
// ============================================================================

const pageHeaderVariants = cva(['flex flex-col gap-4 w-full'], {
  variants: {
    size: {
      default: 'pt-12',
      small: 'pt-12',
      large: 'pt-12',
      full: 'pt-6',
    },
  },
  defaultVariants: {
    size: 'default',
  },
})

// ============================================================================
// Context
// ============================================================================

type PageHeaderSize = 'default' | 'small' | 'large' | 'full'

const PageHeaderContext = createContext<{ size: PageHeaderSize }>({ size: 'default' })

const usePageHeaderContext = () => useContext(PageHeaderContext)

// ============================================================================
// Root
// ============================================================================

export type PageHeaderRootProps = ComponentProps<'div'> & VariantProps<typeof pageHeaderVariants>

/**
 * Root of the page header: the title of the page, its description, the
 * actions and, on a page that belongs to a production target, the production
 * cue. Compose it from `PageHeaderMeta`, `PageHeaderSummary`,
 * `PageHeaderTitle`, `PageHeaderDescription`, `PageHeaderAside` and
 * `PageHeaderNavigationTabs`; the breadcrumb row lives above it
 * (`PageBreadcrumbs`). A page has one `PageHeaderTitle`, the single `h1`.
 */
const PageHeaderRoot = ({ className, size, children, ...props }: PageHeaderRootProps) => {
  const contextSize: PageHeaderSize = size ?? 'default'
  return (
    <PageHeaderContext.Provider value={{ size: contextSize }}>
      <div
        data-slot="page-header"
        data-size={contextSize}
        className={cn(pageHeaderVariants({ size: contextSize }), className)}
        {...props}
      >
        {children}
      </div>
    </PageHeaderContext.Provider>
  )
}

// ============================================================================
// Icon
// ============================================================================

export type PageHeaderIconProps = ComponentProps<'div'>

/**
 * Icon component for page header.
 * Positioned to the left of title and description. Decorative: the title
 * names the page.
 */
const PageHeaderIcon = ({ className, ...props }: PageHeaderIconProps) => {
  return (
    <div
      data-slot="page-header-icon"
      aria-hidden="true"
      className={cn('text-foreground-light', className)}
      {...props}
    />
  )
}
PageHeaderIcon.displayName = 'PageHeaderIcon'

// ============================================================================
// Summary
// ============================================================================

export type PageHeaderSummaryProps = ComponentProps<'div'>

/**
 * Summary component to contain title and description.
 * Provides layout structure for text content.
 * Should be placed inside PageHeaderMeta.
 */
const PageHeaderSummary = ({ className, children, ...props }: PageHeaderSummaryProps) => {
  return (
    <div
      data-slot="page-header-summary"
      className={cn('flex flex-col gap-1', className)}
      {...props}
    >
      {children}
    </div>
  )
}
PageHeaderSummary.displayName = 'PageHeaderSummary'

// ============================================================================
// Title
// ============================================================================

export type PageHeaderTitleProps = ComponentProps<'h1'> & {
  /**
   * The production cue of the page: the app's production chip when the page
   * belongs to a production target. It sits next to the title, outside the
   * heading, so the heading text stays the page name. A pattern never decides
   * what is production; the app fills this slot.
   */
  productionCue?: ReactNode
}

/**
 * Title component for page header: the `h1` of the page, with the optional
 * production cue beside it.
 */
const PageHeaderTitle = ({
  className,
  children,
  productionCue,
  ...props
}: PageHeaderTitleProps) => {
  const hasCue = productionCue !== undefined && productionCue !== null && productionCue !== false
  const heading = (
    <h1
      data-slot="page-header-title"
      className={cn('scroll-m-20 text-2xl tracking-tight', className)}
      {...props}
    >
      {children}
    </h1>
  )
  if (!hasCue) return heading
  return (
    <div data-slot="page-header-heading" className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {heading}
      <div data-slot="page-header-production-cue" className="shrink-0">
        {productionCue}
      </div>
    </div>
  )
}

// ============================================================================
// Description
// ============================================================================

export type PageHeaderDescriptionProps = ComponentProps<'div'>

/**
 * Description component for page header.
 * Supporting text rendered below the title.
 */
const PageHeaderDescription = ({ className, children, ...props }: PageHeaderDescriptionProps) => {
  return (
    <div
      data-slot="page-header-description"
      className={cn('scroll-m-20 text-base text-foreground-light', className)}
      {...props}
    >
      {children}
    </div>
  )
}

// ============================================================================
// Meta
// ============================================================================

export type PageHeaderMetaProps = ComponentProps<'div'>

/**
 * Meta wrapper for page header.
 * Contains icon, summary, and aside components with proper layout.
 * Should be placed before PageHeaderNavigationTabs.
 * Uses CSS to style children based on their data-slot attributes.
 */
const PageHeaderMeta = ({ className, children, ...props }: PageHeaderMetaProps) => {
  const { size } = usePageHeaderContext()
  return (
    <PageContainer size={size}>
      <div
        data-slot="page-header-meta"
        className={cn(
          'flex flex-col @xl:flex-row @xl:justify-between @xl:items-center gap-4',
          '*:data-[slot="page-header-icon"]:shrink-0',
          '*:data-[slot="page-header-summary"]:flex-1',
          className,
        )}
        {...props}
      >
        {children}
      </div>
    </PageContainer>
  )
}
PageHeaderMeta.displayName = 'PageHeaderMeta'

// ============================================================================
// Actions
// ============================================================================

export type PageHeaderAsideProps = ComponentProps<'div'>

/**
 * Actions component for page header.
 * Container for buttons and other action elements.
 * Should be placed inside PageHeaderMeta.
 */
const PageHeaderAside = ({ className, ...props }: PageHeaderAsideProps) => {
  return (
    <div
      data-slot="page-header-actions"
      className={cn('flex items-center gap-2 shrink-0', className)}
      {...props}
    />
  )
}
PageHeaderAside.displayName = 'PageHeaderAside'

// ============================================================================
// Navigation
// ============================================================================

export type PageHeaderNavigationTabsProps = ComponentProps<'div'>

/**
 * Navigation component for page header.
 * Container for tab navigation (`NavMenu`, a named navigation landmark).
 * Should be placed as the last child of PageHeader.
 */
const PageHeaderNavigationTabs = ({ className, ...props }: PageHeaderNavigationTabsProps) => {
  const { size } = usePageHeaderContext()
  return (
    <PageContainer size={size} className={cn(size === 'full' && 'border-b')}>
      <div
        data-slot="page-header-footer"
        className={cn('w-full [&>nav]:border-b-0', size !== 'full' && 'border-b', className)}
        {...props}
      />
    </PageContainer>
  )
}
PageHeaderNavigationTabs.displayName = 'PageHeaderNavigationTabs'

// ============================================================================
// Exports
// ============================================================================

export type PageHeaderProps = PageHeaderRootProps

/**
 * Page header root component.
 * Use PageHeader, PageHeaderMeta, PageHeaderIcon, PageHeaderSummary, etc.
 */
export {
  PageHeaderAside,
  PageHeaderDescription,
  PageHeaderIcon,
  PageHeaderMeta,
  PageHeaderNavigationTabs,
  PageHeaderRoot as PageHeader,
  PageHeaderSummary,
  PageHeaderTitle,
}
