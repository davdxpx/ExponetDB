// Derived from supabase/supabase packages/ui-patterns/src/FilterBar/hooks.ts @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import { type KeyboardEvent, type RefObject, useCallback, useEffect, useRef, useState } from 'react'

import type {
  ActiveInputState,
  ConditionPath,
  FilterProperty,
  OptionsCache,
  OptionsCacheEntry,
} from './types.ts'
import { isOptionsFunction } from './utils.ts'

export type HighlightNavigationOptions = {
  skipEnterWhenFilterHighlighted?: boolean
  /** The list is showing: Escape dismisses it and keeps the cursor in the field. */
  isOpen?: boolean
  /** The list was dismissed with Escape: the arrow keys show it again and Enter picks nothing. */
  isDismissed?: boolean
  onDismiss?: () => void
  onReopen?: () => void
}

/** How long typing pauses before the bar asks the caller for new suggestions. */
export const SUGGESTION_DEBOUNCE_MS = 300

export function useFilterBarState() {
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isCommandMenuVisible, setIsCommandMenuVisible] = useState(false)
  const hideTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [activeInput, setActiveInput] = useState<ActiveInputState>(null)
  const newPathRef = useRef<ConditionPath>([])
  const [highlightedConditionPath, setHighlightedConditionPath] = useState<ConditionPath | null>(
    null,
  )

  return {
    isLoading,
    setIsLoading,
    error,
    setError,
    isCommandMenuVisible,
    setIsCommandMenuVisible,
    hideTimeoutRef,
    activeInput,
    setActiveInput,
    newPathRef,
    highlightedConditionPath,
    setHighlightedConditionPath,
  }
}

/**
 * Loads the suggestions a property gets from a caller-supplied function. A request is sent after
 * typing pauses; an answer that arrives after a newer request was sent is dropped. A rejected
 * request is recorded in `failedOptions` (the list says "Could not load suggestions"); it never
 * leaves an empty cache entry that would read as "no suggestions exist".
 */
export function useOptionsCache() {
  const [loadingOptions, setLoadingOptions] = useState<Record<string, boolean>>({})
  const [failedOptions, setFailedOptions] = useState<Record<string, boolean>>({})
  const [propertyOptionsCache, setPropertyOptionsCache] = useState<OptionsCache>({})

  const cacheRef = useRef<OptionsCache>({})
  const timersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const latestRequestRef = useRef(new Map<string, number>())

  const loadPropertyOptions = useCallback((property: FilterProperty, search: string = '') => {
    const source = property.options
    if (!isOptionsFunction(source)) return

    const name = property.name
    const cached = cacheRef.current[name]
    if (cached && cached.searchValue === search) return

    const pending = timersRef.current.get(name)
    if (pending !== undefined) clearTimeout(pending)

    const run = async () => {
      timersRef.current.delete(name)
      const requestId = (latestRequestRef.current.get(name) ?? 0) + 1
      latestRequestRef.current.set(name, requestId)
      const isLatest = () => latestRequestRef.current.get(name) === requestId

      setLoadingOptions((prev) => ({ ...prev, [name]: true }))
      try {
        const suggestions = await source(search)
        if (!isLatest()) return
        const entry: OptionsCacheEntry = { options: suggestions, searchValue: search }
        cacheRef.current = { ...cacheRef.current, [name]: entry }
        setPropertyOptionsCache(cacheRef.current)
        setFailedOptions((prev) => ({ ...prev, [name]: false }))
      } catch {
        if (!isLatest()) return
        setFailedOptions((prev) => ({ ...prev, [name]: true }))
      } finally {
        if (isLatest()) setLoadingOptions((prev) => ({ ...prev, [name]: false }))
      }
    }

    timersRef.current.set(
      name,
      setTimeout(() => {
        void run()
      }, SUGGESTION_DEBOUNCE_MS),
    )
  }, [])

  useEffect(() => {
    const timers = timersRef.current
    const latest = latestRequestRef.current
    return () => {
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
      // Answers still in flight are no longer the latest request.
      for (const name of latest.keys()) latest.set(name, (latest.get(name) ?? 0) + 1)
    }
  }, [])

  return {
    loadingOptions,
    failedOptions,
    propertyOptionsCache,
    loadPropertyOptions,
  }
}

/**
 * Runs `onBlur` once focus has really left the wrapper: a click inside a popover of the bar
 * (which lives in a portal) is not leaving it.
 */
export function useDeferredBlur(wrapperRef: RefObject<HTMLElement | null>, onBlur: () => void) {
  return useCallback(() => {
    setTimeout(() => {
      const active = document.activeElement
      if (active instanceof Element) {
        if (wrapperRef.current?.contains(active)) return
        // Check if the active element is within a popover
        if (active.closest('[data-radix-popper-content-wrapper]')) return
      }
      onBlur()
    }, 0)
  }, [wrapperRef, onBlur])
}

export function useHighlightNavigation(
  itemsLength: number,
  onEnter: (index: number) => void,
  fallbackKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void,
  options?: HighlightNavigationOptions,
) {
  const [highlightedIndex, setHighlightedIndex] = useState(0)

  useEffect(() => {
    if (highlightedIndex > itemsLength - 1) {
      setHighlightedIndex(itemsLength > 0 ? itemsLength - 1 : 0)
    }
  }, [itemsLength, highlightedIndex])

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Escape' && options?.isOpen && options.onDismiss) {
        e.preventDefault()
        options.onDismiss()
        return
      }
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && options?.isDismissed) {
        e.preventDefault()
        options.onReopen?.()
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setHighlightedIndex((prev) => (prev < itemsLength - 1 ? prev + 1 : prev))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setHighlightedIndex((prev) => (prev > 0 ? prev - 1 : 0))
        return
      }
      if (e.key === 'Enter') {
        // Edge case: when a filter is highlighted, skip dropdown selection and let fallback handle it
        if (options?.skipEnterWhenFilterHighlighted) {
          fallbackKeyDown?.(e)
          return
        }
        if (itemsLength > 0 && !options?.isDismissed) {
          e.preventDefault()
          onEnter(highlightedIndex)
          return
        }
        fallbackKeyDown?.(e)
        return
      }
      fallbackKeyDown?.(e)
    },
    [itemsLength, highlightedIndex, onEnter, fallbackKeyDown, options],
  )

  const reset = useCallback(() => setHighlightedIndex(0), [])

  return { highlightedIndex, setHighlightedIndex, handleKeyDown, reset }
}
