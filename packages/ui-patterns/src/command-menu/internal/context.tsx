// Derived from supabase/supabase packages/ui-patterns/src/CommandMenu/internal/Context.tsx @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import { createContext, useContext } from 'react'

import { initCommandsState } from './state/commands-state.ts'
import { type IPagesState, initPagesState } from './state/pages-state.ts'
import { type IQueryState, initQueryState } from './state/query-state.ts'
import { initViewState } from './state/view-state.ts'
import type { IViewState } from './state/view-state-types.ts'
import type { ICommandsState } from './types.ts'

interface CommandContextValue {
  commandsState: ICommandsState
  pagesState: IPagesState
  queryState: IQueryState
  viewState: IViewState
}

const createCommandContextValue = (): CommandContextValue => ({
  commandsState: initCommandsState(),
  pagesState: initPagesState(),
  queryState: initQueryState(),
  viewState: initViewState(),
})

const CommandContext = createContext<CommandContextValue | undefined>(undefined)

const useCommandContext = () => {
  const ctx = useContext(CommandContext)
  if (!ctx) throw Error('`useCommandContext` must be used within a `CommandProvider`')
  return ctx
}

export type { CommandContextValue }
export { CommandContext, createCommandContextValue, useCommandContext }
