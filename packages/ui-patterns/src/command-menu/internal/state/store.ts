import { useSyncExternalStore } from 'react'

/**
 * A small external store for the command menu state (it replaces a proxy-based
 * state library). State is immutable: every change replaces the state object, so
 * `useSyncExternalStore` sees a new snapshot only when something changed.
 */
export interface ReadableStore<T> {
  getState: () => T
  subscribe: (listener: () => void) => () => void
}

export interface Store<T> extends ReadableStore<T> {
  setState: (next: T | ((previous: T) => T)) => void
}

export function createStore<T>(initial: T): Store<T> {
  let state = initial
  const listeners = new Set<() => void>()

  return {
    getState: () => state,
    setState: (next) => {
      const resolved = typeof next === 'function' ? (next as (previous: T) => T)(state) : next
      if (Object.is(resolved, state)) return
      state = resolved
      for (const listener of [...listeners]) listener()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

/**
 * Reads a part of a store. The selector must return a value that stays the same
 * (by `Object.is`) while that part is unchanged: pick a field, never build a
 * new object or array.
 */
export function useStoreValue<T, S>(store: ReadableStore<T>, select: (state: T) => S): S {
  const getSnapshot = () => select(store.getState())
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot)
}
