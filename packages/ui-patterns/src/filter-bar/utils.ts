// Derived from supabase/supabase packages/ui-patterns/src/FilterBar/utils.ts @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import {
  type AsyncOptionsFunction,
  type CustomOptionObject,
  type FilterCondition,
  type FilterGroup,
  type FilterOperatorGroup,
  type FilterOperatorObject,
  type FilterOptionObject,
  type FilterProperty,
  type FilterSuggestion,
  GROUP_ORDER,
  type GroupedMenuItem,
  isGroup,
  type MenuItem,
  type MenuItemGroup,
  type ResolvedPropertyChange,
  type SyncOptionsFunction,
} from './types.ts'

export function pathsEqual(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

export function findGroupByPath(group: FilterGroup, path: number[]): FilterGroup | null {
  const [current, ...rest] = path
  if (current === undefined) return group

  const condition = group.conditions[current]
  if (!condition) return null

  if (rest.length === 0) {
    return isGroup(condition) ? condition : null
  }

  if (isGroup(condition)) {
    return findGroupByPath(condition, rest)
  }

  return null
}

export function findConditionByPath(group: FilterGroup, path: number[]): FilterCondition | null {
  const [current, ...rest] = path
  if (current === undefined) return null

  const condition = group.conditions[current]
  if (!condition) return null

  if (rest.length === 0) {
    return isGroup(condition) ? null : condition
  }

  if (isGroup(condition)) {
    return findConditionByPath(condition, rest)
  }

  return null
}

export function collectConditions(
  group: FilterGroup,
  path: number[] = [],
): { condition: FilterCondition; path: number[] }[] {
  return group.conditions.flatMap((condition, index) => {
    const currentPath = [...path, index]
    return isGroup(condition)
      ? collectConditions(condition, currentPath)
      : [{ condition, path: currentPath }]
  })
}

export function isCustomOptionObject(option: unknown): option is CustomOptionObject {
  return typeof option === 'object' && option !== null && 'component' in option
}

export function isFilterOptionObject(option: unknown): option is FilterOptionObject {
  return typeof option === 'object' && option !== null && 'value' in option && 'label' in option
}

export function isFilterOperatorObject(operator: unknown): operator is FilterOperatorObject {
  return (
    typeof operator === 'object' && operator !== null && 'value' in operator && 'label' in operator
  )
}

/**
 * Whether the property's suggestions come from a function the caller supplied. Whether that
 * function is `async` is not told apart by its source text (a function returning a promise is not
 * marked `async`, and bundlers rewrite `async`); the bar calls it and awaits whatever it returns.
 */
export function isOptionsFunction(
  options: FilterProperty['options'],
): options is AsyncOptionsFunction | SyncOptionsFunction {
  return typeof options === 'function'
}

/** The label/value form of a suggestion. */
export function normalizeSuggestion(suggestion: FilterSuggestion): FilterOptionObject {
  return typeof suggestion === 'string' ? { label: suggestion, value: suggestion } : suggestion
}

export function updateNestedFilter(
  group: FilterGroup,
  path: number[],
  updateFn: (condition: FilterCondition) => FilterCondition,
): FilterGroup {
  const [current, ...rest] = path
  if (current === undefined) return group

  return {
    ...group,
    conditions: group.conditions.map((condition, index) => {
      if (index !== current) return condition
      if (rest.length === 0) return isGroup(condition) ? condition : updateFn(condition)
      return isGroup(condition) ? updateNestedFilter(condition, rest, updateFn) : condition
    }),
  }
}

export function removeFromGroup(group: FilterGroup, path: number[]): FilterGroup {
  const [current, ...rest] = path
  if (current === undefined) return group

  if (rest.length === 0) {
    return {
      ...group,
      conditions: group.conditions.filter((_, i) => i !== current),
    }
  }

  return {
    ...group,
    conditions: group.conditions.map((condition, i) =>
      i === current && isGroup(condition) ? removeFromGroup(condition, rest) : condition,
    ),
  }
}

export function addFilterToGroup(
  group: FilterGroup,
  path: number[],
  property: FilterProperty,
): FilterGroup {
  const [current, ...rest] = path
  if (current === undefined) {
    return {
      ...group,
      conditions: [...group.conditions, { propertyName: property.name, value: '', operator: '' }],
    }
  }

  return {
    ...group,
    conditions: group.conditions.map((condition, i) =>
      i === current && isGroup(condition) ? addFilterToGroup(condition, rest, property) : condition,
    ),
  }
}

export function addGroupToGroup(group: FilterGroup, path: number[]): FilterGroup {
  const [current, ...rest] = path
  if (current === undefined) {
    return {
      ...group,
      conditions: [...group.conditions, { logicalOperator: 'AND', conditions: [] }],
    }
  }

  return {
    ...group,
    conditions: group.conditions.map((condition, i) =>
      i === current && isGroup(condition) ? addGroupToGroup(condition, rest) : condition,
    ),
  }
}

export function updateNestedValue(
  group: FilterGroup,
  path: number[],
  newValue: string,
): FilterGroup {
  return updateNestedFilter(group, path, (condition) => ({ ...condition, value: newValue }))
}

export function updateNestedOperator(
  group: FilterGroup,
  path: number[],
  newOperator: string,
): FilterGroup {
  return updateNestedFilter(group, path, (condition) => ({ ...condition, operator: newOperator }))
}

export function updateNestedPropertyName(
  group: FilterGroup,
  path: number[],
  newPropertyName: string,
  newOperator?: string,
  newValue?: string,
): FilterGroup {
  return updateNestedFilter(group, path, (condition) => ({
    ...condition,
    propertyName: newPropertyName,
    ...(newOperator !== undefined ? { operator: newOperator } : {}),
    ...(newValue !== undefined ? { value: newValue } : {}),
  }))
}

export function resolvePropertyChange(
  currentOperator: string,
  currentValue: string,
  newProperty: FilterProperty,
): ResolvedPropertyChange {
  if (!currentOperator || !newProperty.operators) {
    return { operator: '', value: '', focusTarget: 'operator' }
  }

  const operatorValues = newProperty.operators.map((op) =>
    isFilterOperatorObject(op) ? op.value : op,
  )

  if (!operatorValues.includes(currentOperator)) {
    return { operator: '', value: '', focusTarget: 'operator' }
  }

  if (!currentValue) {
    return { operator: currentOperator, value: '', focusTarget: 'value' }
  }

  if (newProperty.options && Array.isArray(newProperty.options)) {
    // New property has fixed options: only preserve the value if it is in the list
    const optionValues = newProperty.options.map((opt) =>
      typeof opt === 'string' ? opt : 'value' in opt ? opt.value : '',
    )
    const preservedValue = optionValues.includes(currentValue) ? currentValue : ''
    return { operator: currentOperator, value: preservedValue, focusTarget: 'value' }
  }

  return { operator: currentOperator, value: currentValue, focusTarget: 'value' }
}

export function updateNestedLogicalOperator(group: FilterGroup, path: number[]): FilterGroup {
  const [current, ...rest] = path
  if (current === undefined) {
    return {
      ...group,
      logicalOperator: group.logicalOperator === 'AND' ? 'OR' : 'AND',
    }
  }

  return {
    ...group,
    conditions: group.conditions.map((condition, i) =>
      i === current && isGroup(condition)
        ? updateNestedLogicalOperator(condition, rest)
        : condition,
    ),
  }
}

export function updateGroupAtPath(
  group: FilterGroup,
  path: number[],
  newGroup: FilterGroup,
): FilterGroup {
  const [current, ...rest] = path
  if (current === undefined) {
    return newGroup
  }

  return {
    ...group,
    conditions: group.conditions.map((condition, index) =>
      index === current && isGroup(condition)
        ? updateGroupAtPath(condition, rest, newGroup)
        : condition,
    ),
  }
}

export function groupMenuItemsByOperator(items: MenuItem[]): MenuItemGroup[] {
  const grouped = new Map<FilterOperatorGroup, GroupedMenuItem[]>()
  items.forEach((item, index) => {
    const group: FilterOperatorGroup = item.group ?? 'uncategorized'
    const existing = grouped.get(group)
    if (existing) {
      existing.push({ item, index })
    } else {
      grouped.set(group, [{ item, index }])
    }
  })

  return GROUP_ORDER.filter((groupKey) => grouped.has(groupKey)).map((groupKey) => ({
    group: groupKey,
    items: grouped.get(groupKey) ?? [],
  }))
}

export function buildFilterPlaceholder(
  filterProperties: FilterProperty[],
  options: { maxProperties?: number } = {},
): string {
  const { maxProperties = 3 } = options

  if (filterProperties.length === 0) {
    return 'Add filters...'
  }

  const propertyNames = filterProperties
    .slice(0, maxProperties)
    .map((prop) => prop.label)
    .join(', ')

  const suffix = filterProperties.length > maxProperties ? '...' : ''

  return `Filter by ${propertyNames}${suffix}`
}
