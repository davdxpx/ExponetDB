// Derived from supabase/supabase packages/ui-patterns/src/CommandMenu/internal/state/queryState.ts @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import { createStore, type ReadableStore } from './store.ts'

type IQueryState = ReadableStore<string> & {
  setQuery: (newQuery: string) => void
}

const initQueryState = (): IQueryState => {
  const store = createStore('')
  return {
    getState: store.getState,
    subscribe: store.subscribe,
    setQuery: (newQuery) => store.setState(newQuery),
  }
}

export type { IQueryState }
export { initQueryState }
