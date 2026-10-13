// Derived from supabase/supabase packages/ui-patterns/src/FilterBar/types.ts @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import type { ReactElement } from 'react'

export type CustomOptionProps = {
  onChange: (value: string) => void
  onCancel: () => void
  search?: string
}

export type FilterOptionObject = {
  label: string
  value: string
  count?: number
}

export type CustomOptionObject = {
  label?: string
  component: (props: CustomOptionProps) => ReactElement
}

export type FilterOption = string | FilterOptionObject | CustomOptionObject

/** One suggested value: a plain string or a label with the value it stands for. */
export type FilterSuggestion = string | FilterOptionObject

/**
 * Suggestions the caller loads (a request to the API, say). The bar calls it with what the person
 * typed; a rejected promise is shown as "Could not load suggestions", never as an empty list.
 */
export type AsyncOptionsFunction = (search?: string) => Promise<FilterSuggestion[]>
export type SyncOptionsFunction = (search?: string) => FilterSuggestion[]

export type FilterOperatorGroup = 'comparison' | 'pattern' | 'setNull' | 'uncategorized'

export const OPERATOR_GROUP_LABELS: Record<FilterOperatorGroup, string> = {
  comparison: 'Comparison',
  pattern: 'Pattern matching',
  setNull: 'Set and null checks',
  uncategorized: 'Other',
}

export const GROUP_ORDER: FilterOperatorGroup[] = [
  'comparison',
  'pattern',
  'setNull',
  'uncategorized',
]

export type OperatorDefinition = {
  value: string
  label: string
  group: FilterOperatorGroup
}

export type FilterOperatorObject = {
  value: string
  label: string
  group?: FilterOperatorGroup
}

export type FilterOperator = string | FilterOperatorObject

export type FilterProperty = {
  label: string
  name: string
  type: 'string' | 'number' | 'date' | 'boolean'
  options?: FilterOption[] | AsyncOptionsFunction | SyncOptionsFunction | CustomOptionObject
  operators?: FilterOperator[]
  /** Whether this property can be added or selected when changing a filter. Defaults to true. */
  isAvailable?: boolean
  /** Display a readable label while preserving the underlying value for editing. */
  formatValue?: (value: FilterCondition['value']) => string
}

export type FilterCondition = {
  propertyName: string
  value: string | number | boolean | Date | null
  operator: string
}

export type FilterGroup = {
  logicalOperator: 'AND' | 'OR'
  conditions: (FilterCondition | FilterGroup)[]
}

export function isGroup(condition: FilterCondition | FilterGroup): condition is FilterGroup {
  return 'logicalOperator' in condition
}

export type ConditionPath = number[]

export type MenuItem = {
  value: string
  label: string
  count?: number
  isCustom?: boolean
  customOption?: (props: CustomOptionProps) => ReactElement
  group?: FilterOperatorGroup
  operatorSymbol?: string
  isDefaultOperator?: boolean
  defaultValue?: string
  isFreeformSearch?: boolean
  freeformPropertyName?: string
  freeformValue?: string
  disabled?: boolean
}

export type GroupedMenuItem = {
  item: MenuItem
  index: number
}

export type MenuItemGroup = {
  group: FilterOperatorGroup
  items: GroupedMenuItem[]
}

/** What was loaded for a property's suggestions, and for which search text. */
export type OptionsCacheEntry = {
  options: FilterSuggestion[]
  searchValue: string
}

export type OptionsCache = Record<string, OptionsCacheEntry>

export type NavigationDirection = 'prev' | 'next'

export type HighlightNavigationResult = ConditionPath | 'clear' | null

export type ActiveInputState =
  | { type: 'value'; path: ConditionPath }
  | { type: 'operator'; path: ConditionPath }
  | { type: 'group'; path: ConditionPath }
  | { type: 'property'; path: ConditionPath }
  | null

export type KeyboardNavigationConfig = {
  activeInput: ActiveInputState
  setActiveInput: (input: ActiveInputState) => void
  activeFilters: FilterGroup
  commitFilters: (filters: FilterGroup) => void
  highlightedConditionPath: ConditionPath | null
  setHighlightedConditionPath: (path: ConditionPath | null) => void
}

export type ResolvedPropertyChange = {
  operator: string
  value: string
  focusTarget: 'operator' | 'value'
}
