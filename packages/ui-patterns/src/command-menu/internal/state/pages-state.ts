// Derived from supabase/supabase packages/ui-patterns/src/CommandMenu/internal/state/pagesState.ts @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import type { ReactNode } from 'react'

import type { ICommandSection } from '../types.ts'
import { createStore, type ReadableStore } from './store.ts'

type PageComponent = () => ReactNode

const CommandPageType = { Commands: 'commands', Component: 'component' } as const
type CommandPageType = (typeof CommandPageType)[keyof typeof CommandPageType]

interface CommandsPage {
  type: typeof CommandPageType.Commands
  sections: readonly ICommandSection[]
}

interface ComponentPage {
  type: typeof CommandPageType.Component
  component: PageComponent
}

type CommandPageDefinition = CommandsPage | ComponentPage

const isCommandsPage = (page: CommandPageDefinition): page is CommandsPage =>
  page.type === CommandPageType.Commands
const isComponentPage = (page: CommandPageDefinition): page is ComponentPage =>
  page.type === CommandPageType.Component

interface PagesSnapshot {
  commandPages: Readonly<Record<string, CommandPageDefinition>>
  pageStack: readonly string[]
}

interface IPagesState extends ReadableStore<PagesSnapshot> {
  registerNewPage: (name: string, page: CommandPageDefinition) => () => void
  appendPageStack: (name: string) => void
  popPageStack: () => void
  resetPageStack: () => void
}

const initPagesState = (): IPagesState => {
  const store = createStore<PagesSnapshot>({ commandPages: {}, pageStack: [] })

  return {
    getState: store.getState,
    subscribe: store.subscribe,
    registerNewPage: (name, definition) => {
      store.setState((state) => ({
        ...state,
        commandPages: { ...state.commandPages, [name]: definition },
      }))
      return () => {
        store.setState((state) => {
          const { [name]: _removed, ...commandPages } = state.commandPages
          return {
            commandPages,
            pageStack: state.pageStack.filter((page) => page !== name),
          }
        })
      }
    },
    appendPageStack: (name) => {
      store.setState((state) =>
        name in state.commandPages && state.pageStack.at(-1) !== name
          ? { ...state, pageStack: [...state.pageStack, name] }
          : state,
      )
    },
    popPageStack: () => {
      store.setState((state) =>
        state.pageStack.length === 0
          ? state
          : { ...state, pageStack: state.pageStack.slice(0, -1) },
      )
    },
    resetPageStack: () => {
      store.setState((state) =>
        state.pageStack.length === 0 ? state : { ...state, pageStack: [] },
      )
    },
  }
}

export type { CommandPageDefinition, IPagesState, PagesSnapshot }
export { CommandPageType, initPagesState, isCommandsPage, isComponentPage }
