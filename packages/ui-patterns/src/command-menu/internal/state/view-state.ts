// Derived from supabase/supabase packages/ui-patterns/src/CommandMenu/internal/state/viewState.ts @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import { createStore } from './store.ts'
import type { DialogSize, IViewState } from './view-state-types.ts'

const initViewState = (): IViewState => {
  const store = createStore({ initiated: false, open: false, size: 'large' as DialogSize })

  return {
    getState: store.getState,
    subscribe: store.subscribe,
    setOpen: (open) => store.setState((state) => ({ ...state, initiated: true, open })),
    toggleOpen: () => store.setState((state) => ({ ...state, initiated: true, open: !state.open })),
    setSize: (size) => store.setState((state) => ({ ...state, size })),
  }
}

export type { DialogSize }
export { initViewState }
