// Derived from supabase/supabase packages/ui-patterns/src/FilterBar/FilterBarContext.tsx @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import {
  createContext,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
} from 'react'

import { useFilterBarState, useOptionsCache } from './hooks.ts'
import { usesSuggestionFunction } from './menu-items.ts'
import type {
  ActiveInputState,
  FilterGroup,
  FilterProperty,
  MenuItem,
  OptionsCache,
} from './types.ts'
import { useCommandHandling } from './use-command-handling.ts'
import { useKeyboardNavigation } from './use-keyboard-navigation.ts'
import {
  findConditionByPath,
  pathsEqual,
  removeFromGroup,
  resolvePropertyChange,
  updateNestedLogicalOperator,
  updateNestedOperator,
  updateNestedPropertyName,
  updateNestedValue,
} from './utils.ts'

export type FilterBarContextValue = {
  filters: FilterGroup
  filterProperties: FilterProperty[]
  activeInput: ActiveInputState
  freeformText: string
  isLoading: boolean
  error: string | null
  highlightedConditionPath: number[] | null
  setHighlightedConditionPath: (path: number[] | null) => void
  /** Whether Escape dismissed the list of this field (the cursor stays in it). */
  isPopupDismissed: (input: ActiveInputState) => boolean
  dismissPopup: (input: ActiveInputState) => void
  /** Shows the list of the active field again (typing or an arrow key does). */
  reopenPopup: () => void

  onFilterChange: (filters: FilterGroup) => void
  commitFilters: (filters: FilterGroup) => void
  onFreeformTextChange: (text: string) => void
  setActiveInput: (input: ActiveInputState) => void
  handleInputChange: (path: number[], value: string) => void
  handleOperatorChange: (path: number[], value: string) => void
  handleRemoveCondition: (path: number[]) => void
  handleKeyDown: (e: KeyboardEvent<HTMLInputElement>) => void
  handleSelectMenuItem: (item: MenuItem) => void
  handleInputFocus: (path: number[]) => void
  handleOperatorFocus: (path: number[]) => void
  handleGroupFreeformFocus: (path: number[]) => void
  handleInputBlur: () => void
  handleGroupFreeformChange: (path: number[], value: string) => void
  handleLabelClick: (path: number[]) => void
  handlePropertyChange: (path: number[], newPropertyName: string) => void
  handleLogicalOperatorChange: (path: number[]) => void

  propertyOptionsCache: OptionsCache
  loadingOptions: Record<string, boolean>
  /** Properties whose suggestions could not be loaded the last time they were asked for. */
  failedOptions: Record<string, boolean>
  loadPropertyOptions: (property: FilterProperty, search: string) => void

  supportsOperators: boolean
  variant: FilterBarVariant
  icon?: ReactNode
  freeformDefaultProperty?: string

  /** The id of the input of the root group (the search icon is its label's click target). */
  freeformInputId: string
  rootRef: RefObject<HTMLDivElement | null>
}

const FilterBarContext = createContext<FilterBarContextValue | null>(null)

export function useFilterBar() {
  const ctx = useContext(FilterBarContext)
  if (!ctx) {
    throw new Error('useFilterBar must be used within FilterBar.Root')
  }
  return ctx
}

export type FilterBarVariant = 'default' | 'pill'

export type FilterBarHandle = {
  focus: () => void
}

export type FilterBarRootProps = {
  children: ReactNode
  filterProperties: FilterProperty[]
  filters: FilterGroup
  onFilterChange: (filters: FilterGroup) => void
  onApply?: (filters: FilterGroup) => void
  freeformText: string
  onFreeformTextChange: (text: string) => void
  isLoading?: boolean
  supportsOperators?: boolean
  variant?: FilterBarVariant
  icon?: ReactNode
  freeformDefaultProperty?: string
  /** Accessible name of the bar. Default: "Filters". */
  label?: string
  ref?: Ref<FilterBarHandle>
}

export function FilterBarRoot({
  children,
  filterProperties,
  filters,
  onFilterChange,
  onApply,
  freeformText,
  onFreeformTextChange,
  isLoading: externalLoading,
  supportsOperators = false,
  variant = 'default',
  icon,
  freeformDefaultProperty,
  label = 'Filters',
  ref,
}: FilterBarRootProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const freeformInputId = useId()

  // Keep latest onApply in a ref so commitFilters/handleInputBlur don't need to be re-created
  // (and downstream callbacks don't churn) when only the consumer's onApply identity changes.
  const onApplyRef = useRef(onApply)
  useEffect(() => {
    onApplyRef.current = onApply
  }, [onApply])

  const filtersRef = useRef(filters)
  useEffect(() => {
    filtersRef.current = filters
  }, [filters])

  const commitFilters = useCallback(
    (next: FilterGroup) => {
      onFilterChange(next)
      onApplyRef.current?.(next)
    },
    [onFilterChange],
  )

  const {
    isLoading,
    error,
    hideTimeoutRef,
    activeInput,
    setActiveInput,
    newPathRef,
    setIsCommandMenuVisible,
    highlightedConditionPath,
    setHighlightedConditionPath,
  } = useFilterBarState()

  const { loadingOptions, failedOptions, propertyOptionsCache, loadPropertyOptions } =
    useOptionsCache()

  const [dismissedInput, setDismissedInput] = useState<ActiveInputState>(null)
  const dismissPopup = useCallback((input: ActiveInputState) => setDismissedInput(input), [])
  const reopenPopup = useCallback(() => setDismissedInput(null), [])
  const isPopupDismissed = useCallback(
    (input: ActiveInputState) =>
      input !== null &&
      dismissedInput !== null &&
      input.type === dismissedInput.type &&
      pathsEqual(input.path, dismissedInput.path),
    [dismissedInput],
  )

  const handleInputChange = useCallback(
    (path: number[], value: string) => {
      reopenPopup()
      const updatedFilters = updateNestedValue(filters, path, value)
      onFilterChange(updatedFilters)

      const condition = findConditionByPath(updatedFilters, path)
      const property = filterProperties.find((p) => p.name === condition?.propertyName)
      if (property && condition && usesSuggestionFunction(property, condition.operator)) {
        loadPropertyOptions(property, value)
      }
    },
    [filters, onFilterChange, filterProperties, loadPropertyOptions, reopenPopup],
  )

  const handleOperatorChange = useCallback(
    (path: number[], value: string) => {
      const updatedFilters = updateNestedOperator(filters, path, value)
      commitFilters(updatedFilters)
    },
    [filters, commitFilters],
  )

  const { handleItemSelect } = useCommandHandling({
    activeInput,
    setActiveInput,
    activeFilters: filters,
    onFilterChange,
    commitFilters,
    filterProperties,
    onFreeformTextChange,
    handleOperatorChange,
    newPathRef,
  })

  const { handleKeyDown } = useKeyboardNavigation({
    activeInput,
    setActiveInput,
    activeFilters: filters,
    commitFilters,
    highlightedConditionPath,
    setHighlightedConditionPath,
  })

  const handleInputFocus = useCallback(
    (path: number[]) => {
      setActiveInput({ type: 'value', path })
      setDismissedInput(null)
      setIsCommandMenuVisible(true)
      if (hideTimeoutRef.current) {
        clearTimeout(hideTimeoutRef.current)
      }

      const condition = findConditionByPath(filters, path)
      const property = filterProperties.find((p) => p.name === condition?.propertyName)
      if (property && condition && usesSuggestionFunction(property, condition.operator)) {
        loadPropertyOptions(property, condition.value?.toString() || '')
      }
    },
    [
      filters,
      filterProperties,
      loadPropertyOptions,
      setActiveInput,
      setIsCommandMenuVisible,
      hideTimeoutRef,
    ],
  )

  const handleOperatorFocus = useCallback(
    (path: number[]) => {
      setActiveInput({ type: 'operator', path })
      setDismissedInput(null)
      setIsCommandMenuVisible(true)
      if (hideTimeoutRef.current) {
        clearTimeout(hideTimeoutRef.current)
      }
    },
    [setActiveInput, setIsCommandMenuVisible, hideTimeoutRef],
  )

  const handleGroupFreeformFocus = useCallback(
    (path: number[]) => {
      setActiveInput({ type: 'group', path })
      setDismissedInput(null)
      setIsCommandMenuVisible(true)
      if (hideTimeoutRef.current) {
        clearTimeout(hideTimeoutRef.current)
      }
    },
    [setActiveInput, setIsCommandMenuVisible, hideTimeoutRef],
  )

  const handleInputBlur = useCallback(() => {
    if (hideTimeoutRef.current) {
      clearTimeout(hideTimeoutRef.current)
    }
    hideTimeoutRef.current = setTimeout(() => {
      const activeEl = document.activeElement
      if (activeEl && rootRef.current?.contains(activeEl)) {
        return
      }
      setIsCommandMenuVisible(false)
      setActiveInput(null)
      setHighlightedConditionPath(null)
      // Focus has actually left the FilterBar: fire onApply with the latest filters so any
      // value typed but never confirmed via Enter still gets pushed downstream.
      onApplyRef.current?.(filtersRef.current)
    }, 0)
  }, [setIsCommandMenuVisible, setActiveInput, hideTimeoutRef, setHighlightedConditionPath])

  const handleGroupFreeformChange = useCallback(
    (_path: number[], value: string) => {
      if (highlightedConditionPath) {
        setHighlightedConditionPath(null)
      }
      reopenPopup()
      onFreeformTextChange(value)
    },
    [onFreeformTextChange, highlightedConditionPath, setHighlightedConditionPath, reopenPopup],
  )

  const handleLabelClick = useCallback(
    (path: number[]) => {
      setActiveInput({ type: 'property', path })
      setDismissedInput(null)
      setIsCommandMenuVisible(true)
      if (hideTimeoutRef.current) {
        clearTimeout(hideTimeoutRef.current)
      }
    },
    [setActiveInput, setIsCommandMenuVisible, hideTimeoutRef],
  )

  const handlePropertyChange = useCallback(
    (path: number[], newPropertyName: string) => {
      const condition = findConditionByPath(filters, path)
      if (!condition) return

      const newProperty = filterProperties.find((p) => p.name === newPropertyName)
      if (!newProperty) return

      const { operator, value, focusTarget } = resolvePropertyChange(
        condition.operator,
        (condition.value ?? '').toString(),
        newProperty,
      )

      const updatedFilters = updateNestedPropertyName(
        filters,
        path,
        newPropertyName,
        operator,
        value,
      )
      commitFilters(updatedFilters)
      setActiveInput({ type: focusTarget, path })
    },
    [filters, filterProperties, commitFilters, setActiveInput],
  )

  const handleLogicalOperatorChange = useCallback(
    (path: number[]) => {
      const updatedFilters = updateNestedLogicalOperator(filters, path)
      commitFilters(updatedFilters)
    },
    [filters, commitFilters],
  )

  const handleRemoveCondition = useCallback(
    (path: number[]) => {
      const updatedFilters = removeFromGroup(filters, path)
      commitFilters(updatedFilters)
      setActiveInput(null)
    },
    [filters, commitFilters, setActiveInput],
  )

  // Cleanup hideTimeoutRef on unmount to prevent memory leaks
  useEffect(() => {
    return () => {
      if (hideTimeoutRef.current) {
        clearTimeout(hideTimeoutRef.current)
      }
    }
  }, [hideTimeoutRef])

  const loading = externalLoading ?? isLoading

  const contextValue: FilterBarContextValue = {
    filters,
    filterProperties,
    activeInput,
    freeformText,
    isLoading: loading,
    error,
    highlightedConditionPath,
    setHighlightedConditionPath,
    isPopupDismissed,
    dismissPopup,
    reopenPopup,

    onFilterChange,
    commitFilters,
    onFreeformTextChange,
    setActiveInput,
    handleInputChange,
    handleOperatorChange,
    handleRemoveCondition,
    handleKeyDown,
    handleSelectMenuItem: handleItemSelect,
    handleInputFocus,
    handleOperatorFocus,
    handleGroupFreeformFocus,
    handleInputBlur,
    handleGroupFreeformChange,
    handleLabelClick,
    handlePropertyChange,
    handleLogicalOperatorChange,

    propertyOptionsCache,
    loadingOptions,
    failedOptions,
    loadPropertyOptions,

    supportsOperators,
    variant,
    icon,
    freeformDefaultProperty,

    freeformInputId,
    rootRef,
  }

  useImperativeHandle(ref, () => ({
    focus: () => handleGroupFreeformFocus([]),
  }))

  return (
    <FilterBarContext.Provider value={contextValue}>
      {/* biome-ignore lint/a11y/useSemanticElements: the bar is a group of fields and buttons; <fieldset> is not a reliable flex container */}
      <div
        ref={rootRef}
        role="group"
        aria-label={label}
        data-filterbar-root
        className="flex h-full min-h-[32px] items-stretch"
      >
        {children}
      </div>
    </FilterBarContext.Provider>
  )
}
