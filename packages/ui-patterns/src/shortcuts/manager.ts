import { ShortcutConflictError, type ShortcutRegistry } from './registry.ts'

/** The parts of a `KeyboardEvent` the matcher reads (a plain object works in tests). */
export interface ShortcutKeyEvent {
  readonly key: string
  readonly code: string
  readonly ctrlKey: boolean
  readonly metaKey: boolean
  readonly altKey: boolean
  readonly shiftKey: boolean
  readonly repeat: boolean
  readonly isComposing: boolean
}

/**
 * What the page around the event allows. The DOM layer decides this, the matcher
 * only obeys it. The answers are functions so the document is inspected only for
 * key presses that could be a shortcut.
 */
export interface ShortcutContext {
  /** Letter and `?` shortcuts: false in a text field and while a dialog is open. */
  readonly allowCharacterShortcuts: () => boolean
  /** Modifier shortcuts: false while a dialog other than the command menu is open. */
  readonly allowChordShortcuts: () => boolean
}

export type ShortcutHandler = () => void

export interface ShortcutManagerOptions {
  /** The platform modifier of a chord is Command (true) or Control (false). */
  readonly apple: boolean
  /** How long the second key of a sequence may take. Default 1000 ms. */
  readonly sequenceTimeoutMs?: number
  /** A clock in milliseconds; the default is `performance.now`. Tests pass their own. */
  readonly now?: () => number
  /**
   * Registering a second handler for an id that already has one throws
   * `ShortcutConflictError` (development). Without it the newest handler wins
   * until it unregisters.
   */
  readonly strict?: boolean
}

export interface ShortcutManager<Id extends string = string> {
  /** Sets the handler of an id. Returns the function that removes it again. */
  register: (id: Id, handler: ShortcutHandler) => () => void
  /** The ids that have a handler right now, in registry order. The array changes only when the set does. */
  getActiveIds: () => readonly Id[]
  /** Called when the set of active ids changes. */
  subscribe: (listener: () => void) => () => void
  /** Turns the letter and `?` shortcuts on or off (WCAG 2.1.4); modifier shortcuts stay on. */
  setCharacterShortcuts: (enabled: boolean) => void
  /** Feeds a key press. Returns the id that ran, so the caller can prevent the browser default. */
  handleKeyDown: (event: ShortcutKeyEvent, context: ShortcutContext) => Id | undefined
  /** Forgets a half-typed sequence. */
  reset: () => void
}

const MODIFIER_KEYS: ReadonlySet<string> = new Set([
  'Shift',
  'Control',
  'Alt',
  'AltGraph',
  'Meta',
  'OS',
  'CapsLock',
  'NumLock',
  'ScrollLock',
  'Fn',
  'FnLock',
  'Hyper',
  'Super',
  'Symbol',
  'SymbolLock',
])

const LATIN_LETTER = /^[a-z]$/
const PHYSICAL_LETTER = /^Key([A-Z])$/

/**
 * The letter a key press stands for, lower case, or undefined. A letter of the
 * layout wins (`event.key`), so Dvorak and AZERTY users press the letter they
 * see. On a layout without Latin letters (Cyrillic, Greek) the physical key
 * (`event.code`) stands in, so the shortcuts stay reachable.
 */
export function eventLetter(event: Pick<ShortcutKeyEvent, 'key' | 'code'>): string | undefined {
  const lower = event.key.toLowerCase()
  if (LATIN_LETTER.test(lower)) return lower
  if ([...event.key].length !== 1) return undefined
  const physical = PHYSICAL_LETTER.exec(event.code)?.[1]
  return physical?.toLowerCase()
}

interface Pending {
  readonly letter: string
  readonly at: number
}

interface Entry {
  readonly handler: ShortcutHandler
}

export function createShortcutManager<Id extends string>(
  registry: ShortcutRegistry<Id>,
  options: ShortcutManagerOptions,
): ShortcutManager<Id> {
  const timeoutMs = options.sequenceTimeoutMs ?? 1000
  const now = options.now ?? (() => performance.now())
  const strict = options.strict ?? false

  const stacks = new Map<Id, Entry[]>()
  const listeners = new Set<() => void>()
  let active: readonly Id[] = []
  let characterShortcuts = true
  let pending: Pending | undefined

  function publish(): void {
    const next = registry.ids.filter((id) => (stacks.get(id)?.length ?? 0) > 0)
    const same = next.length === active.length && next.every((id, i) => id === active[i])
    if (same) return
    active = next
    for (const listener of [...listeners]) listener()
  }

  function topHandler(id: Id): ShortcutHandler | undefined {
    return stacks.get(id)?.at(-1)?.handler
  }

  function run(id: Id): Id | undefined {
    const handler = topHandler(id)
    if (handler === undefined) return undefined
    handler()
    return id
  }

  return {
    register: (id, handler) => {
      const stack = stacks.get(id) ?? []
      if (strict && stack.length > 0) {
        throw new ShortcutConflictError(`Shortcut ${id} already has a handler.`)
      }
      const entry: Entry = { handler }
      stacks.set(id, [...stack, entry])
      publish()
      return () => {
        const current = stacks.get(id) ?? []
        const rest = current.filter((candidate) => candidate !== entry)
        if (rest.length === 0) stacks.delete(id)
        else stacks.set(id, rest)
        publish()
      }
    },
    getActiveIds: () => active,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    setCharacterShortcuts: (enabled) => {
      characterShortcuts = enabled
      if (!enabled) pending = undefined
    },
    reset: () => {
      pending = undefined
    },
    handleKeyDown: (event, context) => {
      if (event.repeat || event.isComposing || MODIFIER_KEYS.has(event.key)) return undefined

      const letter = eventLetter(event)
      const modifier = options.apple
        ? event.metaKey && !event.ctrlKey
        : event.ctrlKey && !event.metaKey

      // A modifier chord: Mod + letter, no Alt, no Shift.
      if (modifier && !event.altKey && !event.shiftKey) {
        pending = undefined
        if (letter === undefined || !context.allowChordShortcuts()) return undefined
        const id = registry.chordFor(letter)
        return id === undefined ? undefined : run(id)
      }

      // Any other use of Control, Command or Alt belongs to the browser or the page.
      if (event.ctrlKey || event.metaKey || event.altKey) {
        pending = undefined
        return undefined
      }

      // Only a key that can start or finish a sequence, or `?`, makes the page worth inspecting.
      const relevant =
        event.key === '?' ||
        (letter !== undefined &&
          !event.shiftKey &&
          (pending !== undefined || registry.isLeader(letter)))
      if (!characterShortcuts || !relevant || !context.allowCharacterShortcuts()) {
        pending = undefined
        return undefined
      }

      // `?` is typed with Shift on most layouts, so it is checked before Shift is refused.
      if (event.key === '?') {
        pending = undefined
        const id = registry.keyFor('?')
        return id === undefined ? undefined : run(id)
      }

      if (event.shiftKey || letter === undefined) {
        pending = undefined
        return undefined
      }

      const started = pending
      pending = undefined
      if (started !== undefined && now() - started.at <= timeoutMs) {
        const id = registry.sequenceFor(started.letter, letter)
        if (id !== undefined) return run(id)
        // Not a sequence: this key may start a new one.
      }

      if (registry.isLeader(letter)) pending = { letter, at: now() }
      return undefined
    },
  }
}
