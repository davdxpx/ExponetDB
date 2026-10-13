// Derived from supabase/supabase packages/ui-patterns/src/CommandMenu/internal/state/commandsState.ts @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import { section$new } from '../command-section.tsx'
import type { CommandOptions, ICommandSection, ICommandsState } from '../types.ts'
import { createStore } from './store.ts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function mergeMeta(previous: unknown, next: unknown): unknown {
  return isRecord(previous) && isRecord(next) ? { ...previous, ...next } : next
}

const initCommandsState = (): ICommandsState => {
  const store = createStore<readonly ICommandSection[]>([])

  return {
    getState: store.getState,
    subscribe: store.subscribe,
    registerSection: (sectionName, commands, options) => {
      store.setState((sections) => {
        const found = sections.findIndex((section) => section.name === sectionName)
        const existing = sections[found] ?? section$new(sectionName)

        const updated: ICommandSection = {
          ...existing,
          commands: options?.orderCommands
            ? options.orderCommands(existing.commands, commands)
            : [...existing.commands, ...commands],
        }
        if (options?.sectionMeta) updated.meta = mergeMeta(existing.meta, options.sectionMeta)
        if (options?.forceMountSection) updated.forceMount = true

        const index = found === -1 ? sections.length : found
        const next = sections.toSpliced(index, found === -1 ? 0 : 1, updated)
        return options?.orderSection?.(next, index) ?? next
      })

      return () => {
        store.setState((sections) => {
          const index = sections.findIndex((section) => section.name === sectionName)
          const section = sections[index]
          if (section === undefined) return sections
          const registered = new Set(commands.map((command) => command.id))
          const remaining = section.commands.filter((command) => !registered.has(command.id))
          return remaining.length === 0
            ? sections.toSpliced(index, 1)
            : sections.toSpliced(index, 1, { ...section, commands: remaining })
        })
      }
    },
  }
}

const orderSectionFirst = (sections: readonly ICommandSection[], idx: number) => {
  const first = sections[idx]
  return first === undefined
    ? [...sections]
    : [first, ...sections.slice(0, idx), ...sections.slice(idx + 1)]
}

export type { CommandOptions }
export { initCommandsState, orderSectionFirst }
