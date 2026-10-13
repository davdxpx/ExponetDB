// Derived from supabase/supabase packages/ui-patterns/src/FilterBar/FilterCondition.tsx @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import { X } from '@exponetdb/icons'
import { Button, cn, Input } from '@exponetdb/ui'
import {
  type ChangeEvent,
  type KeyboardEvent,
  type MouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

import { useFilterBar } from './filter-bar-context.tsx'
import { useDeferredBlur, useHighlightNavigation } from './hooks.ts'
import {
  buildOperatorItems,
  buildPropertyChangeItems,
  buildValueItems,
  usesSuggestionFunction,
  valueHasSuggestions,
} from './menu-items.ts'
import { BARE_INPUT_CLASS_NAME, NO_AUTOFILL } from './styles.ts'
import { SuggestionPopover, type SuggestionStatus } from './suggestion-popover.tsx'
import type { FilterCondition as FilterConditionType } from './types.ts'
import { isCustomOptionObject } from './utils.ts'

export type FilterConditionProps = {
  condition: FilterConditionType
  path: number[]
  isActive: boolean
  isOperatorActive: boolean
  isPropertyActive: boolean
  isHighlighted: boolean
}

export function FilterCondition({
  condition,
  path,
  isActive,
  isOperatorActive,
  isPropertyActive,
  isHighlighted,
}: FilterConditionProps) {
  const {
    filters: rootFilters,
    filterProperties,
    propertyOptionsCache,
    loadingOptions,
    failedOptions,
    freeformInputId,
    isPopupDismissed,
    dismissPopup,
    reopenPopup,
    handleInputChange,
    handleOperatorFocus,
    handleInputFocus,
    handleInputBlur,
    handleLabelClick,
    handlePropertyChange,
    handleKeyDown,
    handleRemoveCondition,
    handleSelectMenuItem,
    setActiveInput,
    setHighlightedConditionPath,
    variant,
  } = useFilterBar()

  const operatorRef = useRef<HTMLInputElement>(null)
  const valueRef = useRef<HTMLInputElement>(null)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const property = filterProperties.find((p) => p.name === condition.propertyName)
  const [showValueCustom, setShowValueCustom] = useState(false)
  const [hasTypedOperator, setHasTypedOperator] = useState(false)
  const [hasTypedValue, setHasTypedValue] = useState(false)
  const [localOperator, setLocalOperator] = useState(condition.operator)
  const [localValue, setLocalValue] = useState((condition.value ?? '').toString())
  const [propertySearchText, setPropertySearchText] = useState('')

  const conditionOperator = condition.operator ?? ''
  const conditionValue = (condition.value ?? '').toString()
  const hasFormattedCustomValue = !!property?.formatValue && isCustomOptionObject(property.options)
  const displayedValue =
    (!isActive || hasFormattedCustomValue) && property?.formatValue
      ? property.formatValue(condition.value)
      : localValue

  // Reset "has typed" state when focus changes
  useEffect(() => {
    if (!isOperatorActive) setHasTypedOperator(false)
  }, [isOperatorActive])

  useEffect(() => {
    if (!isOperatorActive && localOperator !== conditionOperator) {
      setLocalOperator(conditionOperator)
    }
  }, [conditionOperator, isOperatorActive, localOperator])

  useEffect(() => {
    if (!isActive) setHasTypedValue(false)
  }, [isActive])

  // Sync local value with condition.value when it changes externally (e.g., dropdown selection)
  useEffect(() => {
    setLocalValue(conditionValue)
  }, [conditionValue])

  useEffect(() => {
    if (isOperatorActive && operatorRef.current) {
      operatorRef.current.focus()
    } else if (isActive && valueRef.current) {
      valueRef.current.focus()
    }
  }, [isActive, isOperatorActive])

  const handleOperatorBlur = useDeferredBlur(wrapperRef, () => {
    setLocalOperator(conditionOperator)
    handleInputBlur()
  })
  const handleValueBlur = useDeferredBlur(wrapperRef, handleInputBlur)

  useEffect(() => {
    if (!isPropertyActive) setPropertySearchText('')
  }, [isPropertyActive])

  const propertyItems = useMemo(
    () =>
      buildPropertyChangeItems({
        filterProperties,
        currentPropertyName: condition.propertyName,
        inputValue: propertySearchText,
      }),
    [filterProperties, condition.propertyName, propertySearchText],
  )

  const {
    highlightedIndex: propHighlightedIndex,
    setHighlightedIndex: setPropHighlightedIndex,
    handleKeyDown: handlePropertyKeyDown,
    reset: resetPropHighlight,
  } = useHighlightNavigation(
    propertyItems.length,
    (index) => {
      const item = propertyItems[index]
      if (item) handlePropertyChange(path, item.value)
    },
    handleKeyDown,
  )

  useEffect(() => {
    if (!isPropertyActive) resetPropHighlight()
  }, [isPropertyActive, resetPropHighlight])

  const handlePropertyBlur = useDeferredBlur(wrapperRef, handleInputBlur)

  const operatorItems = useMemo(
    () =>
      buildOperatorItems(
        { type: 'operator', path },
        rootFilters,
        filterProperties,
        hasTypedOperator,
        localOperator,
      ),
    [path, rootFilters, filterProperties, hasTypedOperator, localOperator],
  )

  const valueItems = useMemo(
    () =>
      buildValueItems(
        { type: 'value', path },
        rootFilters,
        filterProperties,
        propertyOptionsCache,
        conditionValue,
        hasTypedValue,
      ),
    [path, rootFilters, filterProperties, propertyOptionsCache, conditionValue, hasTypedValue],
  )

  const customValueItem = useMemo(
    () => valueItems.find((i) => i.isCustom && i.customOption),
    [valueItems],
  )

  // Suggestions the caller loads: say so while they load and when they could not be loaded, so a
  // failed load is never taken for "there are no suggestions".
  const valueStatus: SuggestionStatus | null =
    property && usesSuggestionFunction(property, conditionOperator)
      ? failedOptions[property.name]
        ? 'failed'
        : loadingOptions[property.name]
          ? 'loading'
          : null
      : null

  // If the value options are only a custom component, open it immediately
  useEffect(() => {
    if (!isActive) return
    const hasOnlyCustom = valueItems.length > 0 && valueItems.every((i) => i.isCustom)
    if (hasOnlyCustom && !showValueCustom) {
      setShowValueCustom(true)
    }
  }, [isActive, valueItems, showValueCustom])

  const operatorDismissed = isOperatorActive && isPopupDismissed({ type: 'operator', path })
  const operatorIsOpen = isOperatorActive && operatorItems.length > 0 && !operatorDismissed
  const valueDismissed = isActive && isPopupDismissed({ type: 'value', path })
  const valueIsOpen =
    isActive &&
    (showValueCustom || valueItems.length > 0 || valueStatus !== null) &&
    !valueDismissed

  const handleOperatorBackspace = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Backspace' && localOperator === '') {
        e.preventDefault()
        handleRemoveCondition(path)
        setActiveInput({ type: 'group', path: path.slice(0, -1) })
        return
      }
      // Escape leaves the field and Enter moves on to the value, as in the other fields.
      if (e.key === 'Escape' || e.key === 'Enter') handleKeyDown(e)
    },
    [localOperator, setActiveInput, path, handleRemoveCondition, handleKeyDown],
  )

  const {
    highlightedIndex: opHighlightedIndex,
    setHighlightedIndex: setOpHighlightedIndex,
    handleKeyDown: handleOperatorKeyDown,
    reset: resetOpHighlight,
  } = useHighlightNavigation(
    operatorItems.length,
    (index) => {
      const item = operatorItems[index]
      if (item) handleSelectMenuItem(item)
    },
    handleOperatorBackspace,
    {
      isOpen: operatorIsOpen,
      isDismissed: operatorDismissed,
      onDismiss: () => dismissPopup({ type: 'operator', path }),
      onReopen: reopenPopup,
    },
  )

  const {
    highlightedIndex: valHighlightedIndex,
    setHighlightedIndex: setValHighlightedIndex,
    handleKeyDown: handleValueKeyDown,
    reset: resetValHighlight,
  } = useHighlightNavigation(
    valueItems.length,
    (index) => {
      const item = valueItems[index]
      if (!item || item.disabled) return
      if (item.isCustom) {
        setShowValueCustom(true)
      } else {
        handleSelectMenuItem(item)
      }
    },
    handleKeyDown,
    {
      isOpen: valueIsOpen,
      isDismissed: valueDismissed,
      onDismiss: () => dismissPopup({ type: 'value', path }),
      onReopen: reopenPopup,
    },
  )

  useEffect(() => {
    if (!isOperatorActive) resetOpHighlight()
  }, [isOperatorActive, resetOpHighlight])

  useEffect(() => {
    if (!isActive) resetValHighlight()
  }, [isActive, resetValHighlight])

  const onOperatorChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      reopenPopup()
      setHasTypedOperator(true)
      setLocalOperator(e.target.value)
    },
    [reopenPopup],
  )

  const onValueChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      setHasTypedValue(true)
      setLocalValue(e.target.value)
      handleInputChange(path, e.target.value)
    },
    [handleInputChange, path],
  )

  const onRemove = useCallback(
    (event?: MouseEvent<HTMLButtonElement>) => {
      handleRemoveCondition(path)
      if (event?.detail === 0) {
        // Removed with the keyboard: keep the cursor in the bar.
        window.setTimeout(() => {
          document.getElementById(freeformInputId)?.focus()
        }, 0)
      }
    },
    [handleRemoveCondition, path, freeformInputId],
  )

  // A condition whose property the bar does not know (a stale link, say) still applies: show it as
  // text, so it can be seen and removed, instead of dropping it from view.
  if (!property) {
    return (
      // biome-ignore lint/a11y/useSemanticElements: see the group below
      <div
        role="group"
        aria-label={`${condition.propertyName} filter, unknown property`}
        className={cn(
          'group relative flex shrink-0 items-stretch bg-muted px-0',
          variant === 'pill' ? 'h-7 rounded-sm border' : 'self-stretch border-r',
        )}
        data-testid={`filter-condition-${condition.propertyName}`}
        data-highlighted={isHighlighted}
      >
        {/* UntrustedText: the property, operator and value come from the filter value. */}
        <span className="flex items-center whitespace-pre px-2 text-xs text-foreground-light">
          {`${condition.propertyName} ${condition.operator} ${(condition.value ?? '').toString()}`}
        </span>
        <Button
          variant="text"
          size="tiny"
          icon={<X size={12} strokeWidth={1} />}
          onClick={onRemove}
          className="m-0.5 shrink-0 self-center rounded-sm px-0"
          aria-label={`Remove ${condition.propertyName} filter`}
        />
      </div>
    )
  }

  const customOption = showValueCustom ? customValueItem?.customOption : undefined
  const CustomOption = customOption
  return (
    // biome-ignore lint/a11y/useSemanticElements: one condition is a group of three fields and a button; <fieldset> is not a reliable flex container
    <div
      ref={wrapperRef}
      role="group"
      aria-label={`${property.label} filter`}
      className={cn(
        'group relative flex shrink-0 items-stretch bg-muted px-0',
        variant === 'pill' ? 'h-7 rounded-sm border' : 'self-stretch border-r',
        isHighlighted &&
          (variant === 'pill' ? 'ring-2 ring-ring' : 'rounded-sm ring-2 ring-inset ring-ring'),
      )}
      onFocusCapture={() => setHighlightedConditionPath(null)}
      data-testid={`filter-condition-${property.name}`}
      data-highlighted={isHighlighted}
    >
      <SuggestionPopover
        open={isPropertyActive && propertyItems.length > 0}
        items={propertyItems}
        highlightedIndex={propHighlightedIndex}
        onHighlight={setPropHighlightedIndex}
        onSelect={(item) => handlePropertyChange(path, item.value)}
        listLabel="Properties"
        wrapperRef={wrapperRef}
        onClickOutside={handleInputBlur}
      >
        {(aria) => (
          <div className="relative inline-flex shrink-0 items-center">
            {isPropertyActive ? (
              <>
                <Input
                  {...aria}
                  {...NO_AUTOFILL}
                  type="text"
                  value={propertySearchText}
                  onChange={(e) => {
                    reopenPopup()
                    setPropertySearchText(e.target.value)
                  }}
                  onBlur={handlePropertyBlur}
                  onKeyDown={handlePropertyKeyDown}
                  className={cn(
                    BARE_INPUT_CLASS_NAME,
                    'absolute top-0 left-0 h-full w-full py-0 pr-1 pl-2 leading-4 text-foreground-light',
                  )}
                  placeholder={property.label}
                  autoFocus
                  aria-label={`Change property from ${property.label}`}
                  data-testid={`filter-property-search-${property.name}`}
                  tabIndex={-1}
                />
                <span
                  aria-hidden
                  className="invisible flex h-full shrink-0 items-center whitespace-nowrap pr-1 pl-2 text-xs leading-4"
                >
                  {property.label}
                </span>
              </>
            ) : (
              <button
                type="button"
                className="flex h-full shrink-0 cursor-pointer items-center whitespace-nowrap pr-1 pl-2 text-xs leading-4 text-foreground-light transition-colors hover:text-foreground focus-inset"
                aria-label={`Change property from ${property.label}`}
                onFocus={() => handleLabelClick(path)}
                onClick={() => handleLabelClick(path)}
              >
                {/* UntrustedText: property labels are set by the caller. */}
                {property.label}
              </button>
            )}
          </div>
        )}
      </SuggestionPopover>
      <SuggestionPopover
        open={operatorIsOpen}
        items={operatorItems}
        highlightedIndex={opHighlightedIndex}
        onHighlight={setOpHighlightedIndex}
        onSelect={handleSelectMenuItem}
        listLabel="Operators"
        grouped
        wrapperRef={wrapperRef}
        onClickOutside={handleInputBlur}
      >
        {(aria) => (
          <div className="relative inline-block">
            <Input
              {...aria}
              {...NO_AUTOFILL}
              ref={operatorRef}
              type="text"
              value={isOperatorActive ? localOperator : conditionOperator}
              onChange={onOperatorChange}
              onFocus={() => {
                setLocalOperator(conditionOperator)
                handleOperatorFocus(path)
              }}
              onBlur={handleOperatorBlur}
              onKeyDown={handleOperatorKeyDown}
              className={cn(
                BARE_INPUT_CLASS_NAME,
                'absolute top-0 left-0 h-full w-full px-1 py-0 text-center text-foreground',
              )}
              aria-label={`Operator for ${property.label}`}
              data-testid={`filter-operator-${property.name}`}
            />
            <span aria-hidden className="invisible block shrink-0 whitespace-pre px-1 text-xs">
              {(isOperatorActive ? localOperator : conditionOperator) || ' '}
            </span>
          </div>
        )}
      </SuggestionPopover>
      <SuggestionPopover
        open={valueIsOpen}
        hasPopup={valueHasSuggestions(property, conditionOperator)}
        items={valueItems}
        highlightedIndex={valHighlightedIndex}
        onHighlight={setValHighlightedIndex}
        onSelect={(item) => {
          if (item.disabled) return
          if (item.isCustom) {
            setShowValueCustom(true)
          } else {
            handleSelectMenuItem(item)
          }
        }}
        listLabel="Values"
        showSelection
        status={valueStatus}
        custom={
          CustomOption ? (
            <CustomOption
              onChange={(value) => {
                handleInputChange(path, value)
                setShowValueCustom(false)
                setTimeout(() => {
                  setActiveInput({ type: 'group', path: path.slice(0, -1) })
                }, 0)
              }}
              onCancel={() => {
                setShowValueCustom(false)
                onRemove()
              }}
              search={conditionValue}
            />
          ) : undefined
        }
        wrapperRef={wrapperRef}
        onClickOutside={handleInputBlur}
        contentClassName="w-fit"
      >
        {(aria) => (
          <div className="relative inline-block max-w-[180px]">
            <Input
              {...aria}
              {...NO_AUTOFILL}
              ref={valueRef}
              type="text"
              value={displayedValue}
              readOnly={hasFormattedCustomValue}
              onChange={onValueChange}
              onFocus={() => handleInputFocus(path)}
              onBlur={handleValueBlur}
              onKeyDown={handleValueKeyDown}
              className={cn(
                BARE_INPUT_CLASS_NAME,
                'absolute top-0 left-0 h-full w-full px-1 py-0',
                hasFormattedCustomValue &&
                  'focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
              )}
              aria-label={`Value for ${property.label}`}
              data-testid={`filter-value-${property.name}`}
            />
            <span aria-hidden className="invisible block whitespace-pre px-1 text-xs">
              {displayedValue || ' '}
            </span>
          </div>
        )}
      </SuggestionPopover>
      <Button
        variant="text"
        size="tiny"
        icon={<X size={12} strokeWidth={1} />}
        onClick={onRemove}
        className="m-0.5 shrink-0 self-center rounded-sm px-0"
        aria-label={`Remove ${property.label} filter`}
        data-testid={`filter-remove-${property.name}`}
      />
    </div>
  )
}
