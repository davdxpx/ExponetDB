// Derived from supabase/supabase packages/ui-patterns/src/FilterBar/hooks.test.ts @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import { act, cleanup, renderHook } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  SUGGESTION_DEBOUNCE_MS,
  useFilterBarState,
  useOptionsCache,
} from '../../src/filter-bar/hooks.ts'
import type { FilterProperty } from '../../src/filter-bar/types.ts'

function propertyWith(options: FilterProperty['options']): FilterProperty {
  return { label: 'Test', name: 'test', type: 'string', options }
}

/** Lets the debounce timer and the promise it starts settle. */
async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(SUGGESTION_DEBOUNCE_MS)
  })
}

describe('FilterBar Hooks', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    cleanup()
  })

  describe('useFilterBarState', () => {
    it('initializes with default values', () => {
      const { result } = renderHook(() => useFilterBarState())

      expect(result.current.isLoading).toBe(false)
      expect(result.current.error).toBeNull()
      expect(result.current.isCommandMenuVisible).toBe(false)
      expect(result.current.activeInput).toBeNull()
      expect(result.current.hideTimeoutRef.current).toBeNull()
      expect(result.current.newPathRef.current).toEqual([])
    })

    it('updates state correctly', () => {
      const { result } = renderHook(() => useFilterBarState())

      act(() => {
        result.current.setIsLoading(true)
        result.current.setError('Test error')
        result.current.setIsCommandMenuVisible(true)
        result.current.setActiveInput({ type: 'value', path: [0] })
      })

      expect(result.current.isLoading).toBe(true)
      expect(result.current.error).toBe('Test error')
      expect(result.current.isCommandMenuVisible).toBe(true)
      expect(result.current.activeInput).toEqual({ type: 'value', path: [0] })
    })
  })

  describe('useOptionsCache', () => {
    it('initializes with empty cache', () => {
      const { result } = renderHook(() => useOptionsCache())

      expect(result.current.loadingOptions).toEqual({})
      expect(result.current.failedOptions).toEqual({})
      expect(result.current.propertyOptionsCache).toEqual({})
    })

    it('loads suggestions after typing pauses and caches them', async () => {
      const options = vi.fn(async (search?: string) => [
        `${search}-one`,
        { label: 'Two', value: '2' },
      ])
      const { result } = renderHook(() => useOptionsCache())

      act(() => {
        result.current.loadPropertyOptions(propertyWith(options), 'a')
        result.current.loadPropertyOptions(propertyWith(options), 'ab')
      })
      // Nothing is asked for while the person is still typing.
      expect(options).not.toHaveBeenCalled()

      await settle()

      expect(options).toHaveBeenCalledTimes(1)
      expect(options).toHaveBeenCalledWith('ab')
      expect(result.current.propertyOptionsCache).toEqual({
        test: { options: ['ab-one', { label: 'Two', value: '2' }], searchValue: 'ab' },
      })
      expect(result.current.loadingOptions).toEqual({ test: false })
      expect(result.current.failedOptions).toEqual({ test: false })

      // The same search is answered from the cache.
      act(() => {
        result.current.loadPropertyOptions(propertyWith(options), 'ab')
      })
      await settle()
      expect(options).toHaveBeenCalledTimes(1)
    })

    it('awaits a function that is not marked async', async () => {
      const options = vi.fn(() => Promise.resolve(['x']))
      const { result } = renderHook(() => useOptionsCache())

      act(() => {
        result.current.loadPropertyOptions(propertyWith(options), '')
      })
      await settle()

      expect(result.current.propertyOptionsCache['test']?.options).toEqual(['x'])
    })

    it('takes a plain list from a function that answers at once', async () => {
      const { result } = renderHook(() => useOptionsCache())

      act(() => {
        result.current.loadPropertyOptions(
          propertyWith(() => ['y']),
          '',
        )
      })
      await settle()

      expect(result.current.propertyOptionsCache['test']?.options).toEqual(['y'])
    })

    it('records a failed load as failed, never as an empty list', async () => {
      const options = vi.fn<() => Promise<string[]>>(async () => {
        throw new Error('request failed')
      })
      const { result } = renderHook(() => useOptionsCache())

      act(() => {
        result.current.loadPropertyOptions(propertyWith(options), 'q')
      })
      await settle()

      expect(result.current.failedOptions).toEqual({ test: true })
      expect(result.current.loadingOptions).toEqual({ test: false })
      expect(result.current.propertyOptionsCache).toEqual({})

      // Asking again retries, and an answer clears the failure.
      options.mockImplementation(async () => {
        return []
      })
      act(() => {
        result.current.loadPropertyOptions(propertyWith(options), 'q')
      })
      await settle()
      expect(options).toHaveBeenCalledTimes(2)
      expect(result.current.failedOptions).toEqual({ test: false })
      expect(result.current.propertyOptionsCache['test']?.options).toEqual([])
    })

    it('drops an answer that arrives after a newer request was sent', async () => {
      const resolvers: Array<(value: string[]) => void> = []
      const options = vi.fn(
        () =>
          new Promise<string[]>((resolve) => {
            resolvers.push(resolve)
          }),
      )
      const { result } = renderHook(() => useOptionsCache())

      act(() => {
        result.current.loadPropertyOptions(propertyWith(options), 'a')
      })
      await settle()
      act(() => {
        result.current.loadPropertyOptions(propertyWith(options), 'ab')
      })
      await settle()
      expect(resolvers).toHaveLength(2)

      await act(async () => {
        resolvers[1]?.(['newer'])
        resolvers[0]?.(['older'])
        await Promise.resolve()
      })

      expect(result.current.propertyOptionsCache['test']).toEqual({
        options: ['newer'],
        searchValue: 'ab',
      })
    })

    it('does not load options for lists and custom pickers', () => {
      const { result } = renderHook(() => useOptionsCache())

      act(() => {
        result.current.loadPropertyOptions(propertyWith(['option1', 'option2']), 'search')
        result.current.loadPropertyOptions(
          propertyWith({ component: () => createElement('div') }),
          'search',
        )
        result.current.loadPropertyOptions(propertyWith(undefined), 'search')
      })

      // Should not update loading state for array options
      expect(result.current.loadingOptions).toEqual({})
    })

    it('does not send a request after the bar is gone', async () => {
      const options = vi.fn(async () => ['x'])
      const { result, unmount } = renderHook(() => useOptionsCache())

      act(() => {
        result.current.loadPropertyOptions(propertyWith(options), '')
      })
      unmount()
      await vi.advanceTimersByTimeAsync(SUGGESTION_DEBOUNCE_MS)

      expect(options).not.toHaveBeenCalled()
    })
  })
})
