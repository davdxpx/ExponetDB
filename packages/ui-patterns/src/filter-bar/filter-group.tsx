// Derived from supabase/supabase packages/ui-patterns/src/FilterBar/FilterGroup.tsx @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import { cn, Input } from '@exponetdb/ui'
import { type ChangeEvent, Fragment, useEffect, useMemo, useRef, useState } from 'react'

import { useFilterBar } from './filter-bar-context.tsx'
import { FilterCondition } from './filter-condition.tsx'
import { useDeferredBlur, useHighlightNavigation } from './hooks.ts'
import { buildPropertyItems } from './menu-items.ts'
import { BARE_INPUT_CLASS_NAME, NO_AUTOFILL } from './styles.ts'
import { SuggestionPopover } from './suggestion-popover.tsx'
import { type FilterGroup as FilterGroupType, isGroup } from './types.ts'
import { buildFilterPlaceholder, pathsEqual } from './utils.ts'

/** A nested group is announced as a named group; the root group is the bar itself. */
const NESTED_GROUP_PROPS = { role: 'group', 'aria-label': 'Filter group' } as const

export type FilterGroupProps = {
  group: FilterGroupType
  path: number[]
}

export function FilterGroup({ group, path }: FilterGroupProps) {
  const {
    filterProperties,
    activeInput,
    freeformText,
    supportsOperators,
    variant,
    highlightedConditionPath,
    freeformDefaultProperty,
    freeformInputId,
    isPopupDismissed,
    dismissPopup,
    reopenPopup,
    handleInputBlur,
    handleGroupFreeformFocus,
    handleGroupFreeformChange,
    handleLogicalOperatorChange,
    handleKeyDown,
    handleSelectMenuItem,
  } = useFilterBar()

  const [localFreeformValue, setLocalFreeformValue] = useState('')
  const freeformInputRef = useRef<HTMLInputElement>(null)
  const wrapperRef = useRef<HTMLDivElement>(null)

  const isActive = activeInput?.type === 'group' && pathsEqual(path, activeInput.path)
  // Free-text search only applies to the root group's input; nested groups don't synthesize
  // a "Search <property>" item. Only the root group expands to fill the available space.
  const isRootGroup = path.length === 0

  useEffect(() => {
    if (freeformText === '') {
      setLocalFreeformValue('')
    }
  }, [freeformText])

  useEffect(() => {
    if (isActive && freeformInputRef.current) {
      freeformInputRef.current.focus()
    }
  }, [isActive])

  const handleFreeformBlur = useDeferredBlur(wrapperRef, handleInputBlur)

  const handleFreeformChange = (e: ChangeEvent<HTMLInputElement>) => {
    setLocalFreeformValue(e.target.value)
    handleGroupFreeformChange(path, e.target.value)
  }

  const isConditionActive = (conditionPath: number[]) =>
    activeInput?.type === 'value' && pathsEqual(conditionPath, activeInput.path)

  const isOperatorActive = (conditionPath: number[]) =>
    activeInput?.type === 'operator' && pathsEqual(conditionPath, activeInput.path)

  const isPropertyActiveForCondition = (conditionPath: number[]) =>
    activeInput?.type === 'property' && pathsEqual(conditionPath, activeInput.path)

  const isConditionHighlighted = (conditionPath: number[]) =>
    highlightedConditionPath !== null && pathsEqual(conditionPath, highlightedConditionPath)

  const resolvedFreeformDefaultProperty = useMemo(
    () =>
      isRootGroup && freeformDefaultProperty
        ? filterProperties.find((p) => p.name === freeformDefaultProperty)
        : undefined,
    [isRootGroup, freeformDefaultProperty, filterProperties],
  )

  const typedText = (isActive ? freeformText : localFreeformValue) || ''

  const items = useMemo(
    () =>
      buildPropertyItems({
        filterProperties,
        inputValue: typedText,
        supportsOperators,
        freeformDefaultProperty: resolvedFreeformDefaultProperty,
      }),
    [filterProperties, typedText, supportsOperators, resolvedFreeformDefaultProperty],
  )

  const emptyPlaceholder = useMemo(
    () => buildFilterPlaceholder(filterProperties),
    [filterProperties],
  )

  const dismissed = isActive && isPopupDismissed({ type: 'group', path })
  const isOpen = isActive && items.length > 0 && highlightedConditionPath === null && !dismissed

  const {
    highlightedIndex,
    setHighlightedIndex,
    handleKeyDown: handleFreeformKeyDown,
    reset: resetFreeformHighlight,
  } = useHighlightNavigation(
    items.length,
    (index) => {
      const item = items[index]
      if (item) handleSelectMenuItem(item)
    },
    handleKeyDown,
    {
      skipEnterWhenFilterHighlighted: highlightedConditionPath !== null,
      isOpen,
      isDismissed: dismissed,
      onDismiss: () => dismissPopup({ type: 'group', path }),
      onReopen: reopenPopup,
    },
  )

  useEffect(() => {
    if (!isActive) resetFreeformHighlight()
  }, [isActive, resetFreeformHighlight])

  return (
    <div
      ref={wrapperRef}
      {...(isRootGroup ? {} : NESTED_GROUP_PROPS)}
      className={cn(
        'flex shrink-0 items-stretch gap-0',
        !isRootGroup &&
          "before:text-foreground-muted before:content-['('] after:text-foreground-muted after:content-[')']",
        isRootGroup && 'min-w-0 flex-1',
      )}
    >
      <div
        className={cn(
          'flex flex-wrap items-center',
          isRootGroup && 'min-w-0 flex-1',
          variant === 'pill' ? 'gap-1' : 'gap-0',
        )}
      >
        {group.conditions.map((condition, index) => {
          const currentPath = [...path, index]

          return (
            // The position is the identity of a condition: there are no ids in the filter value.
            // biome-ignore lint/suspicious/noArrayIndexKey: see above
            <Fragment key={index}>
              {index > 0 && supportsOperators ? (
                <button
                  type="button"
                  onClick={() => handleLogicalOperatorChange(path)}
                  aria-label={`${group.logicalOperator}, change to ${group.logicalOperator === 'AND' ? 'OR' : 'AND'}`}
                  className="cursor-pointer text-xs font-medium text-foreground-muted hover:bg-surface-400 hover:text-foreground focus-inset"
                >
                  {group.logicalOperator}
                </button>
              ) : null}
              {isGroup(condition) ? (
                <FilterGroup group={condition} path={currentPath} />
              ) : (
                <FilterCondition
                  condition={condition}
                  path={currentPath}
                  isActive={isConditionActive(currentPath)}
                  isOperatorActive={isOperatorActive(currentPath)}
                  isPropertyActive={isPropertyActiveForCondition(currentPath)}
                  isHighlighted={isConditionHighlighted(currentPath)}
                />
              )}
            </Fragment>
          )
        })}
        <SuggestionPopover
          open={isOpen}
          items={items}
          highlightedIndex={highlightedIndex}
          onHighlight={setHighlightedIndex}
          onSelect={handleSelectMenuItem}
          listLabel="Properties"
          wrapperRef={wrapperRef}
          onClickOutside={handleInputBlur}
          contentClassName="max-w-[360px]"
        >
          {(aria) =>
            isRootGroup ? (
              <Input
                {...aria}
                {...NO_AUTOFILL}
                id={freeformInputId}
                ref={freeformInputRef}
                type="text"
                value={typedText}
                onChange={handleFreeformChange}
                onFocus={() => handleGroupFreeformFocus(path)}
                onBlur={handleFreeformBlur}
                onKeyDown={handleFreeformKeyDown}
                className={cn(
                  BARE_INPUT_CLASS_NAME,
                  'relative m-[3px] h-auto w-auto min-w-0 flex-1 px-2 py-1',
                )}
                placeholder={
                  group.conditions.length === 0 ? emptyPlaceholder : 'Add more filters...'
                }
                aria-label="Add filter"
                data-testid="filter-bar-freeform-input"
              />
            ) : (
              <div className="relative inline-block py-1">
                <Input
                  {...aria}
                  {...NO_AUTOFILL}
                  ref={freeformInputRef}
                  type="text"
                  value={typedText}
                  onChange={handleFreeformChange}
                  onFocus={() => handleGroupFreeformFocus(path)}
                  onBlur={handleFreeformBlur}
                  onKeyDown={handleFreeformKeyDown}
                  className={cn(
                    BARE_INPUT_CLASS_NAME,
                    'absolute top-0 left-0 h-full w-full px-2 py-0',
                  )}
                  placeholder="+ Add filter"
                  aria-label="Add filter to group"
                />
                {/* Sizes the field to its text. */}
                <span aria-hidden className="invisible block whitespace-pre text-xs">
                  {typedText || '+'}
                </span>
              </div>
            )
          }
        </SuggestionPopover>
      </div>
    </div>
  )
}
