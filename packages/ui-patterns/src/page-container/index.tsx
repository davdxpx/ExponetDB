// Derived from supabase/supabase packages/ui-patterns/src/PageContainer/index.tsx @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.

import { cn } from '@exponetdb/ui'
import { cva, type VariantProps } from 'class-variance-authority'
import { forwardRef, type HTMLAttributes } from 'react'

// ============================================================================
// Variants
// ============================================================================

const pageContainerVariants = cva(['mx-auto w-full @container px-6 xl:px-10'], {
  variants: {
    size: {
      small: 'max-w-[768px]',
      default: 'max-w-[1200px]',
      large: 'max-w-[1600px]',
      full: 'max-w-none',
    },
  },
  defaultVariants: {
    size: 'default',
  },
})

// ============================================================================
// Component
// ============================================================================

export type PageContainerProps = HTMLAttributes<HTMLDivElement> &
  VariantProps<typeof pageContainerVariants>

/**
 * Container component for page content.
 * Provides consistent max-width and padding based on size prop.
 *
 * @example
 * ```tsx
 * <PageContainer size="large">
 *   <PageHeader>
 *     <PageHeaderTitle>My Page</PageHeaderTitle>
 *   </PageHeader>
 *   {children}
 * </PageContainer>
 * ```
 */
export const PageContainer = forwardRef<HTMLDivElement, PageContainerProps>(
  ({ className, size, ...props }, ref) => {
    return <div ref={ref} {...props} className={cn(pageContainerVariants({ size }), className)} />
  },
)

PageContainer.displayName = 'PageContainer'
