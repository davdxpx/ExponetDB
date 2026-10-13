// Derived from supabase/supabase packages/ui-patterns/src/CommandMenu/api/hooks/viewHooks.ts @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import { useCallback, useLayoutEffect, useRef } from 'react'

import { useCommandContext } from '../../internal/context.tsx'
import { useStoreValue } from '../../internal/state/store.ts'
import type { DialogSize } from '../../internal/state/view-state-types.ts'

const useCommandMenuInitiated = () => {
  const { viewState } = useCommandContext()
  return useStoreValue(viewState, (state) => state.initiated)
}

const useCommandMenuOpen = () => {
  const { viewState } = useCommandContext()
  return useStoreValue(viewState, (state) => state.open)
}

const useSetCommandMenuOpen = () => {
  const { viewState } = useCommandContext()
  return viewState.setOpen
}

/** Clears the search text and leaves every page. */
const useResetCommandMenu = () => {
  const { queryState, pagesState } = useCommandContext()
  return useCallback(() => {
    queryState.setQuery('')
    pagesState.resetPageStack()
  }, [queryState, pagesState])
}

const useToggleCommandMenu = () => {
  const { viewState } = useCommandContext()
  return viewState.toggleOpen
}

const useCommandMenuSize = () => {
  const { viewState } = useCommandContext()
  return useStoreValue(viewState, (state) => state.size)
}

/** Sizes the dialog for as long as the calling component (a page) is mounted. */
const useSetCommandMenuSize = (newSize: DialogSize) => {
  const { viewState } = useCommandContext()
  const originalSize = useRef(viewState.getState().size)

  useLayoutEffect(() => {
    const original = originalSize.current
    viewState.setSize(newSize)
    return () => viewState.setSize(original)
  }, [viewState, newSize])
}

export {
  useCommandMenuInitiated,
  useCommandMenuOpen,
  useCommandMenuSize,
  useResetCommandMenu,
  useSetCommandMenuOpen,
  useSetCommandMenuSize,
  useToggleCommandMenu,
}
