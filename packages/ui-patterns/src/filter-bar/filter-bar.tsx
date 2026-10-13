// Derived from supabase/supabase packages/ui-patterns/src/FilterBar/FilterBar.tsx @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import { Search } from '@exponetdb/icons'
import { cn } from '@exponetdb/ui'
import type { ReactNode, Ref } from 'react'

import {
  type FilterBarHandle,
  FilterBarRoot,
  type FilterBarVariant,
  useFilterBar,
} from './filter-bar-context.tsx'
import { FilterGroup } from './filter-group.tsx'
import type { FilterGroup as FilterGroupType, FilterProperty } from './types.ts'

export type FilterBarProps = {
  filterProperties: FilterProperty[]
  freeformText: string
  filters: FilterGroupType
  isLoading?: boolean
  className?: string
  supportsOperators?: boolean
  variant?: FilterBarVariant
  /** Shown in place of the search icon (a spinner, say) while `isLoading` is set. */
  icon?: ReactNode
  /** Accessible name of the bar. Default: "Filters". */
  label?: string
  /**
   * Name of the property to use when the user commits free text from the root input. Must match
   * a `name` in `filterProperties`. When set, the dropdown shows a "Search <propertyLabel>: \"...\""
   * item as the first option while the user is typing. Selecting it (Enter) creates a filter
   * `{ propertyName, operator: '=', value: typedText }`. If the property has no `=` operator,
   * the first operator in its list is used instead.
   */
  freeformDefaultProperty?: string
  /**
   * Called with the new filters on every change, including every keystroke in a value. It keeps
   * the controlled `filters` prop in sync. The bar builds a structured value only: it never
   * builds SQL and never sends anything.
   */
  onFilterChange: (filters: FilterGroupType) => void
  /**
   * Fires only on commit boundaries: menu item selected, operator/property/logical-operator
   * change, condition removed, Enter pressed in value input, or focus leaves the FilterBar. Use
   * this when downstream state (URL params, table filters, queries) should only update once the
   * person has finalized a value.
   */
  onApply?: (filters: FilterGroupType) => void
  onFreeformTextChange: (freeformText: string) => void
  ref?: Ref<FilterBarHandle>
}

export function FilterBarContent({ className }: { className?: string }) {
  const { filters, error, isLoading, variant, icon: loadingIcon, freeformInputId } = useFilterBar()

  return (
    <div className="relative w-full space-y-2">
      <div
        aria-busy={isLoading}
        className={cn(
          'relative flex h-full w-full cursor-text items-stretch gap-0 overflow-auto rounded-md border bg-foreground/[.026] p-0',
          'focus-within:ring-2 focus-within:ring-inset focus-within:ring-ring',
          className,
        )}
      >
        {/* Pressing the icon puts the cursor in the search field. */}
        <label
          htmlFor={freeformInputId}
          className={cn(
            'relative flex shrink-0 cursor-pointer items-center justify-center bg-surface-200 px-2',
            variant === 'pill' ? 'border-r-0 bg-transparent' : 'border-r',
          )}
        >
          <span
            aria-hidden
            className={cn(
              'transition-opacity duration-300 ease-in-out motion-reduce:transition-none',
              loadingIcon ? 'opacity-0' : 'opacity-100',
            )}
          >
            <Search className="sticky h-4 w-4 text-foreground-muted" />
          </span>
          {loadingIcon ? (
            <span aria-hidden className="absolute inset-0 flex items-center justify-center">
              {loadingIcon}
            </span>
          ) : null}
        </label>
        <div
          className={cn(
            'flex flex-1 flex-wrap items-stretch gap-0',
            isLoading && 'motion-safe:animate-pulse',
          )}
        >
          <FilterGroup group={filters} path={[]} />
        </div>
      </div>
      {error ? (
        <div role="alert" className="mt-1 text-xs text-destructive">
          {error}
        </div>
      ) : null}
    </div>
  )
}

/**
 * FilterBar: builds structured filters (`property operator value`) from the properties the caller
 * lists, with full keyboard operation. Every value is text; suggestions come from the caller.
 *
 * Simple usage:
 * ```tsx
 * <FilterBar
 *   filterProperties={filterProperties}
 *   filters={filters}
 *   onFilterChange={setFilters}
 *   freeformText={freeformText}
 *   onFreeformTextChange={setFreeformText}
 * />
 * ```
 *
 * Composable usage:
 * ```tsx
 * <FilterBar.Root
 *   filterProperties={filterProperties}
 *   filters={filters}
 *   onFilterChange={setFilters}
 *   freeformText={freeformText}
 *   onFreeformTextChange={setFreeformText}
 * >
 *   <FilterBar.Content />
 * </FilterBar.Root>
 * ```
 */
function FilterBarComponent({
  filterProperties,
  filters,
  onFilterChange,
  onApply,
  freeformText,
  onFreeformTextChange,
  isLoading,
  className,
  supportsOperators = false,
  variant = 'default',
  icon,
  label,
  freeformDefaultProperty,
  ref,
}: FilterBarProps) {
  return (
    <FilterBarRoot
      ref={ref}
      filterProperties={filterProperties}
      filters={filters}
      onFilterChange={onFilterChange}
      onApply={onApply}
      freeformText={freeformText}
      onFreeformTextChange={onFreeformTextChange}
      isLoading={isLoading}
      supportsOperators={supportsOperators}
      variant={variant}
      icon={icon}
      label={label}
      freeformDefaultProperty={freeformDefaultProperty}
    >
      <FilterBarContent className={className} />
    </FilterBarRoot>
  )
}

export const FilterBar = Object.assign(FilterBarComponent, {
  Root: FilterBarRoot,
  Content: FilterBarContent,
  Group: FilterGroup,
})
