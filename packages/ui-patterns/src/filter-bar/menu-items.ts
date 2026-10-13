// Derived from supabase/supabase packages/ui-patterns/src/FilterBar/menuItems.ts @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import type {
  ActiveInputState,
  FilterGroup,
  FilterProperty,
  FilterSuggestion,
  MenuItem,
  OptionsCache,
} from './types.ts'
import {
  collectConditions,
  findConditionByPath,
  isCustomOptionObject,
  isFilterOperatorObject,
  isFilterOptionObject,
  isOptionsFunction,
  pathsEqual,
} from './utils.ts'

/**
 * Pattern-matching operators (e.g. iLike) search for a substring, not an exact value, so a list of
 * exact-value suggestions would be misleading: the person types freely instead.
 */
function isPatternOperator(property: FilterProperty, operator: string | undefined): boolean {
  const definition = property.operators?.find((op) =>
    isFilterOperatorObject(op) ? op.value === operator : op === operator,
  )
  return isFilterOperatorObject(definition) && definition.group === 'pattern'
}

/**
 * Whether the value field of a condition can offer anything: IS has its own values, a pattern
 * operator is typed freely, and otherwise the property's options (a list, a function or the
 * caller's picker). A field that offers nothing is a plain text field.
 */
export function valueHasSuggestions(property: FilterProperty, operator: string): boolean {
  if (operator === 'is') return true
  return property.options !== undefined && !isPatternOperator(property, operator)
}

/** Whether the values of a condition are suggested by the function the caller supplied. */
export function usesSuggestionFunction(property: FilterProperty, operator: string): boolean {
  return (
    isOptionsFunction(property.options) &&
    operator !== 'is' &&
    !isPatternOperator(property, operator)
  )
}

export function buildOperatorItems(
  activeInput: Extract<ActiveInputState, { type: 'operator' }> | null,
  activeFilters: FilterGroup,
  filterProperties: FilterProperty[],
  hasTypedSinceFocus: boolean = true,
  inputValue?: string,
): MenuItem[] {
  if (!activeInput) return []
  const condition = findConditionByPath(activeFilters, activeInput.path)
  const property = filterProperties.find((p) => p.name === condition?.propertyName)
  const operatorValue = (inputValue ?? condition?.operator ?? '').toUpperCase()
  const availableOperators = property?.operators || ['=']

  // Only filter if user has typed since focusing
  const shouldFilter = hasTypedSinceFocus && operatorValue.length > 0

  const items: MenuItem[] = availableOperators
    .filter((op) => {
      if (!shouldFilter) return true
      if (isFilterOperatorObject(op)) {
        return (
          op.value.toUpperCase().includes(operatorValue) ||
          op.label.toUpperCase().includes(operatorValue)
        )
      }
      return op.toUpperCase().includes(operatorValue)
    })
    .map((op) => {
      if (isFilterOperatorObject(op)) {
        return {
          value: op.value,
          label: op.label,
          group: op.group,
          operatorSymbol: op.value,
        }
      }
      return { value: op, label: op, operatorSymbol: op }
    })

  if (shouldFilter && items.length === 0) {
    const equalsOperator = availableOperators.find((op) =>
      isFilterOperatorObject(op) ? op.value === '=' : op === '=',
    )

    if (equalsOperator) {
      const equalsLabel = isFilterOperatorObject(equalsOperator) ? equalsOperator.label : 'Equals'
      items.push({
        value: '=',
        label: `${equalsLabel}: "${inputValue ?? condition?.operator ?? ''}"`,
        operatorSymbol: '=',
        isDefaultOperator: true,
        defaultValue: inputValue ?? condition?.operator ?? '',
      })
    }
  }

  return items
}

export function buildPropertyItems(params: {
  filterProperties: FilterProperty[]
  inputValue: string
  supportsOperators?: boolean
  freeformDefaultProperty?: FilterProperty
}): MenuItem[] {
  const { filterProperties, inputValue, supportsOperators, freeformDefaultProperty } = params
  const availableProperties = filterProperties.filter((property) => property.isAvailable !== false)
  const items: MenuItem[] = []

  const trimmedInput = inputValue.trim()
  if (
    freeformDefaultProperty &&
    freeformDefaultProperty.isAvailable !== false &&
    trimmedInput.length > 0
  ) {
    items.push({
      value: '__freeform_search__',
      label: `Search ${freeformDefaultProperty.label.toLowerCase()}: "${trimmedInput}"`,
      isFreeformSearch: true,
      freeformPropertyName: freeformDefaultProperty.name,
      freeformValue: trimmedInput,
    })
  }

  items.push(
    ...availableProperties
      .filter((prop) => prop.label.toLowerCase().includes(inputValue.toLowerCase()))
      .map((prop) => ({ value: prop.name, label: prop.label })),
  )

  if (supportsOperators) {
    items.push({ value: '__new_group__', label: 'New group' })
  }

  return items
}

export function buildPropertyChangeItems(params: {
  filterProperties: FilterProperty[]
  currentPropertyName: string
  inputValue: string
}): MenuItem[] {
  const { filterProperties, currentPropertyName, inputValue } = params

  return filterProperties
    .filter((property) => property.isAvailable !== false)
    .filter((prop) => prop.name !== currentPropertyName)
    .filter((prop) => prop.label.toLowerCase().includes(inputValue.toLowerCase()))
    .map((prop) => ({ value: prop.name, label: prop.label }))
}

/**
 * The suggestions for the value of the condition at the active path. Loading and failure are not
 * items: the list shows them as a status line next to the items (a failed load is never an empty
 * list).
 */
export function buildValueItems(
  activeInput: Extract<ActiveInputState, { type: 'value' }> | null,
  activeFilters: FilterGroup,
  filterProperties: FilterProperty[],
  propertyOptionsCache: OptionsCache,
  inputValue: string,
  hasTypedSinceFocus: boolean = true,
): MenuItem[] {
  if (!activeInput) return []
  const activeCondition = findConditionByPath(activeFilters, activeInput.path)
  const property = filterProperties.find((p) => p.name === activeCondition?.propertyName)
  const items: MenuItem[] = []

  if (!property) return items

  // Values already used by other conditions on this same property shouldn't be re-selectable.
  const usedValues = new Set(
    collectConditions(activeFilters)
      .filter(({ path }) => !pathsEqual(path, activeInput.path))
      .filter(({ condition }) => condition.propertyName === activeCondition?.propertyName)
      .map(({ condition }) => String(condition.value)),
  )

  if (activeCondition?.operator === 'is') {
    return getIsOperatorValueItems(property, inputValue, hasTypedSinceFocus, usedValues)
  }

  if (isPatternOperator(property, activeCondition?.operator)) {
    return items
  }

  const options = property.options
  if (isCustomOptionObject(options)) {
    items.push({
      value: 'custom',
      label: options.label || 'Custom...',
      isCustom: true,
      customOption: options.component,
    })
  } else if (Array.isArray(options)) {
    items.push(
      ...getArrayOptionItems({
        options,
        inputValue,
        hasTypedSinceFocus,
        showCount: activeCondition?.operator === '=',
        usedValues,
      }),
    )
  } else if (typeof options === 'function') {
    const cached = propertyOptionsCache[property.name]
    if (cached) items.push(...getCachedOptionItems(cached.options, usedValues))
  }

  return items
}

function getArrayOptionItems({
  options,
  inputValue,
  hasTypedSinceFocus,
  showCount,
  usedValues,
}: {
  options: readonly unknown[]
  inputValue: string
  hasTypedSinceFocus: boolean
  showCount?: boolean
  usedValues?: Set<string>
}): MenuItem[] {
  const items: MenuItem[] = []
  const normalizedInput = inputValue.toLowerCase()

  // Only filter if user has typed since focusing
  const shouldFilter = hasTypedSinceFocus && inputValue.length > 0

  for (const option of options) {
    if (typeof option === 'string') {
      if (!shouldFilter || option.toLowerCase().includes(normalizedInput)) {
        items.push({ value: option, label: option, disabled: usedValues?.has(option) || undefined })
      }
    } else if (isFilterOptionObject(option)) {
      if (!shouldFilter || option.label.toLowerCase().includes(normalizedInput)) {
        items.push({
          value: option.value,
          label: option.label,
          count: showCount ? option.count : undefined,
          disabled: usedValues?.has(option.value) || undefined,
        })
      }
    } else if (isCustomOptionObject(option)) {
      if (!shouldFilter || (option.label?.toLowerCase().includes(normalizedInput) ?? true)) {
        items.push({
          value: 'custom',
          label: option.label || 'Custom...',
          isCustom: true,
          customOption: option.component,
        })
      }
    }
  }
  return items
}

function getCachedOptionItems(
  options: readonly FilterSuggestion[],
  usedValues?: Set<string>,
): MenuItem[] {
  return options.map((option) => {
    if (typeof option === 'string') {
      return { value: option, label: option, disabled: usedValues?.has(option) || undefined }
    }
    return {
      value: option.value,
      label: option.label,
      disabled: usedValues?.has(option.value) || undefined,
    }
  })
}

function getIsOperatorValueItems(
  property: FilterProperty,
  inputValue: string,
  hasTypedSinceFocus: boolean,
  usedValues?: Set<string>,
): MenuItem[] {
  const options: { value: string; label: string }[] = [
    { value: 'null', label: 'NULL' },
    { value: 'not null', label: 'NOT NULL' },
  ]

  if (property.type === 'boolean') {
    options.push({ value: 'true', label: 'TRUE' }, { value: 'false', label: 'FALSE' })
  }

  const shouldFilter = hasTypedSinceFocus && inputValue.length > 0
  const filtered = shouldFilter
    ? options.filter((opt) => {
        const normalizedInput = inputValue.toLowerCase()
        return (
          opt.label.toLowerCase().includes(normalizedInput) || opt.value.includes(normalizedInput)
        )
      })
    : options

  return filtered.map((opt) => ({ ...opt, disabled: usedValues?.has(opt.value) || undefined }))
}
