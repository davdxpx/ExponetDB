// Derived from supabase/supabase packages/ui-patterns/src/CommandMenu/api/hooks/pagesHooks.ts @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import { useCallback, useLayoutEffect, useMemo, useRef } from 'react'

import { useCommandContext } from '../../internal/context.tsx'
import { type CommandPageDefinition, isComponentPage } from '../../internal/state/pages-state.ts'
import { useStoreValue } from '../../internal/state/store.ts'
import { useSetCommandMenuQuery } from './query-hooks.ts'
import { useDepsVersion } from './use-deps-version.ts'

const useCurrentCommandPage = () => {
  const { pagesState } = useCommandContext()
  const commandPages = useStoreValue(pagesState, (state) => state.commandPages)
  const topOfStack = useStoreValue(pagesState, (state) => state.pageStack.at(-1))

  return useMemo(() => {
    const definition = topOfStack === undefined ? undefined : commandPages[topOfStack]
    return topOfStack !== undefined && definition !== undefined
      ? { ...definition, name: topOfStack }
      : undefined
  }, [commandPages, topOfStack])
}

const useCommandPageComponent = () => {
  const currentPage: (CommandPageDefinition & { name: string }) | undefined =
    useCurrentCommandPage()
  if (!currentPage || !isComponentPage(currentPage)) return undefined

  return currentPage.component
}

const useSetCommandPage = () => {
  const { pagesState } = useCommandContext()
  const setQuery = useSetCommandMenuQuery()

  return useCallback(
    (name: string, preserveQuery = false) => {
      pagesState.appendPageStack(name)
      if (!preserveQuery) setQuery('')
    },
    [pagesState, setQuery],
  )
}

const usePopCommandPage = () => {
  const { pagesState } = useCommandContext()
  return pagesState.popPageStack
}

const useRegisterCommandPage = (
  name: string,
  definition: CommandPageDefinition,
  { deps, enabled = true }: { deps?: readonly unknown[]; enabled?: boolean } = {},
) => {
  const { pagesState } = useCommandContext()

  const definitionRef = useRef(definition)
  useLayoutEffect(() => {
    definitionRef.current = definition
  })
  const depsVersion = useDepsVersion(deps)

  // useLayoutEffect runs synchronously after DOM mutations but before paint.
  // This ensures the page is registered before any subsequent code (e.g. in
  // child components) tries to access it, avoiding a timing gap that would
  // exist with useEffect.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `depsVersion` stands for `deps`
  useLayoutEffect(() => {
    if (!enabled) return

    return pagesState.registerNewPage(name, definitionRef.current)
  }, [pagesState, name, enabled, depsVersion])
}

export {
  useCommandPageComponent,
  useCurrentCommandPage,
  usePopCommandPage,
  useRegisterCommandPage,
  useSetCommandPage,
}
