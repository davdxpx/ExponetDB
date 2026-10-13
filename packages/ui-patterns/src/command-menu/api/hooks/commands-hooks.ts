// Derived from supabase/supabase packages/ui-patterns/src/CommandMenu/api/hooks/commandsHooks.ts @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import { useLayoutEffect, useMemo, useRef } from 'react'

import { useCommandContext } from '../../internal/context.tsx'
import { isCommandsPage } from '../../internal/state/pages-state.ts'
import { useStoreValue } from '../../internal/state/store.ts'
import type { ICommand, ICommandSection } from '../../internal/types.ts'
import type { CommandOptions } from '../types.ts'
import { useCurrentCommandPage } from './pages-hooks.ts'
import { useDepsVersion } from './use-deps-version.ts'

/**
 * The commands a person may use: a command the caller disabled (`enabled: false`)
 * is left out, and so is a section that has none left.
 */
const visibleSections = (sections: readonly ICommandSection[]): readonly ICommandSection[] =>
  sections.flatMap((section) => {
    const commands = section.commands.filter((command) => command.enabled !== false)
    return commands.length === 0 ? [] : [{ ...section, commands }]
  })

/** Every registered section that has a visible command, whichever page of the menu is open. */
const useRegisteredCommands = (): readonly ICommandSection[] => {
  const { commandsState } = useCommandContext()
  const sections = useStoreValue(commandsState, (state) => state)
  return useMemo(() => visibleSections(sections), [sections])
}

/** The sections of the page that is open (the top level, or a commands page). */
const useCommands = (): readonly ICommandSection[] => {
  const registered = useRegisteredCommands()
  const page = useCurrentCommandPage()
  const pageSections = page && isCommandsPage(page) ? page.sections : undefined
  return useMemo(
    () => (pageSections === undefined ? registered : visibleSections(pageSections)),
    [registered, pageSections],
  )
}

/**
 * Registers `commands` under the section `sectionName` for as long as the
 * component is mounted. The commands are read again only when `options.deps`
 * changes (without `deps` they are registered once), and `options.enabled:
 * false` removes them.
 */
const useRegisterCommands = (
  sectionName: string,
  commands: readonly ICommand[],
  options: CommandOptions = {},
) => {
  const { commandsState } = useCommandContext()
  const { enabled = true } = options

  const latest = useRef({ commands, options })
  useLayoutEffect(() => {
    latest.current = { commands, options }
  })
  const depsVersion = useDepsVersion(options.deps)

  // Registered before paint, so a menu opened right after a route change already has them.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `depsVersion` stands for `options.deps`
  useLayoutEffect(() => {
    if (!enabled) return
    return commandsState.registerSection(
      sectionName,
      latest.current.commands,
      latest.current.options,
    )
  }, [commandsState, sectionName, enabled, depsVersion])
}

export { useCommands, useRegisterCommands, useRegisteredCommands, visibleSections }
