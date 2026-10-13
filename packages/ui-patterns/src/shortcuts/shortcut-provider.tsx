import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  ShortcutHelpContext,
  type ShortcutHelpControl,
  type ShortcutRuntime,
  ShortcutRuntimeContext,
} from './context.ts'
import { COMMAND_MENU_ATTRIBUTE, hasOpenDialog, isTextEntryTarget } from './dom.ts'
import { ShortcutHelpDialog } from './help-dialog.tsx'
import { createShortcutManager } from './manager.ts'
import { isApplePlatform, shortcutRegistry } from './registry.ts'

export interface ShortcutProviderProps {
  children: ReactNode
  /**
   * A second handler for a shortcut id that already has one throws. The Web App
   * turns this on in development; read once, when the provider mounts.
   */
  strict?: boolean
  /** How long the second key of a sequence may take. Default 1000 ms; read once. */
  sequenceTimeoutMs?: number
  /**
   * Whether the letter shortcuts (G then P, `?`) are on. Pass it with
   * `onCharacterShortcutsChange` to keep the choice (the Web App stores it in the
   * person's preferences); without it the choice lasts until the page is reloaded.
   */
  characterShortcuts?: boolean
  onCharacterShortcutsChange?: (enabled: boolean) => void
  /** Overrides the detected platform (Command or Control as the modifier). Read once. */
  apple?: boolean
}

/**
 * Listens for the shortcuts of `definitions.ts` and runs the handlers components
 * register with `useShortcut`. Mount it once, above the command menu.
 */
export function ShortcutProvider({
  children,
  strict = false,
  sequenceTimeoutMs,
  characterShortcuts,
  onCharacterShortcutsChange,
  apple,
}: ShortcutProviderProps): ReactNode {
  const [runtime] = useState<ShortcutRuntime>(() => {
    const isApple = apple ?? isApplePlatform()
    return {
      apple: isApple,
      manager: createShortcutManager(shortcutRegistry, {
        apple: isApple,
        strict,
        sequenceTimeoutMs,
      }),
    }
  })
  const { manager } = runtime

  const [uncontrolled, setUncontrolled] = useState(true)
  const lettersOn = characterShortcuts ?? uncontrolled
  const controlled = characterShortcuts !== undefined
  const setLettersOn = useCallback(
    (next: boolean) => {
      if (!controlled) setUncontrolled(next)
      onCharacterShortcutsChange?.(next)
    },
    [controlled, onCharacterShortcutsChange],
  )
  useEffect(() => {
    manager.setCharacterShortcuts(lettersOn)
  }, [manager, lettersOn])

  const [helpOpen, setHelpOpenState] = useState(false)
  const returnFocus = useRef<HTMLElement | null>(null)
  const setHelpOpen = useCallback((next: boolean) => {
    if (next) {
      returnFocus.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null
    }
    setHelpOpenState(next)
  }, [])
  useEffect(() => manager.register('help.open', () => setHelpOpen(true)), [manager, setHelpOpen])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return
      const id = manager.handleKeyDown(event, {
        allowCharacterShortcuts: () => !isTextEntryTarget(event.target) && !hasOpenDialog(document),
        allowChordShortcuts: () => !hasOpenDialog(document, `[${COMMAND_MENU_ATTRIBUTE}]`),
      })
      if (id !== undefined) event.preventDefault()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [manager])

  const help = useMemo<ShortcutHelpControl>(
    () => ({
      returnFocus,
      open: helpOpen,
      setOpen: setHelpOpen,
      characterShortcuts: lettersOn,
      setCharacterShortcuts: setLettersOn,
    }),
    [helpOpen, setHelpOpen, lettersOn, setLettersOn],
  )

  return (
    <ShortcutRuntimeContext.Provider value={runtime}>
      <ShortcutHelpContext.Provider value={help}>
        {children}
        <ShortcutHelpDialog />
      </ShortcutHelpContext.Provider>
    </ShortcutRuntimeContext.Provider>
  )
}
