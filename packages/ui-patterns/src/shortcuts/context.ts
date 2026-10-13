import {
  createContext,
  type RefObject,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
} from 'react'

import type { ShortcutId } from './definitions.ts'
import type { ShortcutManager } from './manager.ts'
import { isApplePlatform } from './registry.ts'

export interface ShortcutRuntime {
  readonly manager: ShortcutManager<ShortcutId>
  /** The modifier of a chord is Command (true) or Control (false). */
  readonly apple: boolean
}

export const ShortcutRuntimeContext = createContext<ShortcutRuntime | null>(null)

export interface ShortcutHelpControl {
  /** The element that had focus when the dialog opened; focus returns to it on close. */
  readonly returnFocus: RefObject<HTMLElement | null>
  readonly open: boolean
  readonly setOpen: (open: boolean) => void
  /** The letter and `?` shortcuts are on. */
  readonly characterShortcuts: boolean
  readonly setCharacterShortcuts: (enabled: boolean) => void
}

export const ShortcutHelpContext = createContext<ShortcutHelpControl | null>(null)

const EMPTY: readonly ShortcutId[] = []
const NO_UNSUBSCRIBE = () => {}
const subscribeNothing = () => NO_UNSUBSCRIBE
const getNothing = () => EMPTY

/** Runs `handler` when the shortcut `id` is pressed. Does nothing without a `ShortcutProvider` or while `enabled` is false. */
export function useShortcut(
  id: ShortcutId,
  handler: () => void,
  { enabled = true }: { enabled?: boolean } = {},
): void {
  const runtime = useContext(ShortcutRuntimeContext)
  const latest = useRef(handler)
  useLayoutEffect(() => {
    latest.current = handler
  })

  const manager = runtime?.manager
  useEffect(() => {
    if (manager === undefined || !enabled) return
    return manager.register(id, () => latest.current())
  }, [manager, id, enabled])
}

/**
 * Binds several shortcut ids to one runner (the commands that carry a shortcut).
 * The runner is called with the id that was pressed.
 */
export function useShortcutBindings(
  ids: readonly ShortcutId[],
  run: (id: ShortcutId) => void,
): void {
  const runtime = useContext(ShortcutRuntimeContext)
  const latest = useRef(run)
  useLayoutEffect(() => {
    latest.current = run
  })

  const manager = runtime?.manager
  const key = ids.join(',')
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` is the identity of `ids`
  useEffect(() => {
    if (manager === undefined) return
    const unregister = ids.map((id) => manager.register(id, () => latest.current(id)))
    return () => {
      for (const remove of unregister) remove()
    }
  }, [manager, key])
}

/** The shortcut ids that have a handler right now, in the order of the list. */
export function useActiveShortcuts(): readonly ShortcutId[] {
  const manager = useContext(ShortcutRuntimeContext)?.manager
  return useSyncExternalStore(
    manager?.subscribe ?? subscribeNothing,
    manager?.getActiveIds ?? getNothing,
    getNothing,
  )
}

/** True when the modifier of a chord is Command. Without a provider the platform is detected. */
export function useShortcutPlatform(): boolean {
  const runtime = useContext(ShortcutRuntimeContext)
  return runtime?.apple ?? isApplePlatform()
}

/** Opens the keyboard shortcut help dialog; `undefined` without a `ShortcutProvider`. */
export function useOpenShortcutHelp(): (() => void) | undefined {
  const help = useContext(ShortcutHelpContext)
  const setOpen = help?.setOpen
  return setOpen === undefined ? undefined : () => setOpen(true)
}
