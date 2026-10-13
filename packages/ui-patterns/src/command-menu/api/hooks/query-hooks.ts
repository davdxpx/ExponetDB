// Derived from supabase/supabase packages/ui-patterns/src/CommandMenu/api/hooks/queryHooks.ts @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import { useCommandContext } from '../../internal/context.tsx'
import { useStoreValue } from '../../internal/state/store.ts'

const useCommandMenuQuery = () => {
  const { queryState } = useCommandContext()
  return useStoreValue(queryState, (query) => query)
}

const useSetCommandMenuQuery = () => {
  const { queryState } = useCommandContext()
  return queryState.setQuery
}

export { useCommandMenuQuery, useSetCommandMenuQuery }
