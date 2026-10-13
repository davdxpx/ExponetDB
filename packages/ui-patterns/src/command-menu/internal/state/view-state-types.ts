// Derived from supabase/supabase packages/ui-patterns/src/CommandMenu/internal/state/viewState.types.ts @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import type { ReadableStore } from './store.ts'

export type DialogSize = 'small' | 'tiny' | 'medium' | 'large' | 'xlarge' | 'xxlarge' | 'xxxlarge'

export interface ViewSnapshot {
  initiated: boolean
  open: boolean
  size: DialogSize
}

export interface IViewState extends ReadableStore<ViewSnapshot> {
  setOpen: (open: boolean) => void
  toggleOpen: () => void
  setSize: (size: DialogSize) => void
}
