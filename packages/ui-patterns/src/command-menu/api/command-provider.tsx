// Derived from supabase/supabase packages/ui-patterns/src/CommandMenu/api/CommandProvider.tsx @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import { type PropsWithChildren, useEffect, useMemo, useRef, useState } from 'react'

import { useTelemetry } from '../../seams/index.ts'
import { useShortcut, useShortcutBindings } from '../../shortcuts/context.ts'
import type { ShortcutId } from '../../shortcuts/definitions.ts'
import { CommandContext, createCommandContextValue } from '../internal/context.tsx'
import type { ICommand } from '../internal/types.ts'
import { useRegisteredCommands } from './hooks/commands-hooks.ts'
import { useRunCommand } from './hooks/run-command-hook.ts'
import {
  useCommandMenuOpen,
  useResetCommandMenu,
  useSetCommandMenuOpen,
  useToggleCommandMenu,
} from './hooks/view-hooks.ts'

/**
 * Wiring that needs the menu state: `Mod+K` toggles the menu, a command with a
 * `shortcut` runs when its keys are pressed, the menu starts fresh each time it
 * opens, and the browser's back button closes it. A component, not a hook, so it
 * can read the context its parent provides.
 */
function CommandMenuEffects() {
  const open = useCommandMenuOpen()
  const setOpen = useSetCommandMenuOpen()
  const toggleOpen = useToggleCommandMenu()
  const reset = useResetCommandMenu()
  const telemetry = useTelemetry()
  const runCommand = useRunCommand()
  const sections = useRegisteredCommands()

  useShortcut('palette.open', () => {
    if (!open) telemetry({ name: 'command_menu.opened', properties: { trigger: 'shortcut' } })
    toggleOpen()
  })

  // The first command registered for a shortcut owns it.
  const byShortcut = useMemo(() => {
    const map = new Map<ShortcutId, ICommand>()
    for (const section of sections) {
      for (const command of section.commands) {
        if (command.shortcut !== undefined && !map.has(command.shortcut)) {
          map.set(command.shortcut, command)
        }
      }
    }
    return map
  }, [sections])
  useShortcutBindings([...byShortcut.keys()], (id) => {
    const command = byShortcut.get(id)
    if (command) runCommand(command, 'shortcut')
  })

  const wasOpen = useRef(false)
  useEffect(() => {
    if (wasOpen.current && !open) {
      telemetry({ name: 'command_menu.closed' })
      reset()
    }
    wasOpen.current = open
  }, [open, reset, telemetry])

  useEffect(() => {
    const close = () => setOpen(false)
    window.addEventListener('popstate', close)
    return () => window.removeEventListener('popstate', close)
  }, [setOpen])

  return null
}

/**
 * Holds the state of the command menu (commands, pages, search text, open state)
 * for everything below it. Mount it once, inside `ShortcutProvider` and the
 * providers of the navigate and telemetry seams.
 */
const CommandProvider = ({ children }: PropsWithChildren) => {
  const [value] = useState(createCommandContextValue)

  return (
    <CommandContext.Provider value={value}>
      <CommandMenuEffects />
      {children}
    </CommandContext.Provider>
  )
}

export { CommandProvider }
