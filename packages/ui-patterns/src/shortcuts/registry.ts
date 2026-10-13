import {
  SEQUENCE_LEADERS,
  SHORTCUT_DEFINITIONS,
  SHORTCUT_GROUPS,
  type ShortcutBinding,
  type ShortcutDefinition,
  type ShortcutId,
} from './definitions.ts'

/** A definition list that breaks a rule (see `definitions.ts`). It is a defect of the list, never data. */
export class ShortcutDefinitionError extends Error {
  override readonly name = 'ShortcutDefinitionError'
}

/** Two active handlers for one shortcut id, or two ids on one binding. */
export class ShortcutConflictError extends Error {
  override readonly name = 'ShortcutConflictError'
}

export interface ShortcutRegistry<Id extends string = string> {
  readonly ids: readonly Id[]
  definition: (id: Id) => ShortcutDefinition
  /** The id of the `Mod+<letter>` chord. */
  chordFor: (letter: string) => Id | undefined
  /** The id of a single key (`?`). */
  keyFor: (key: string) => Id | undefined
  /** The id of the sequence `first` then `second`. */
  sequenceFor: (first: string, second: string) => Id | undefined
  /** True when a sequence may start with this letter. */
  isLeader: (letter: string) => boolean
}

const LETTER = /^[a-z]$/

function bindingKey(binding: ShortcutBinding): string {
  switch (binding.type) {
    case 'chord':
      return `chord:${binding.key}`
    case 'sequence':
      return `sequence:${binding.keys[0]}${binding.keys[1]}`
    case 'key':
      return `key:${binding.key}`
  }
}

function checkBinding(id: string, binding: ShortcutBinding): void {
  switch (binding.type) {
    case 'chord':
      if (!LETTER.test(binding.key)) {
        throw new ShortcutDefinitionError(
          `Shortcut ${id}: a chord is the modifier plus one lower case letter a to z.`,
        )
      }
      return
    case 'key':
      if (binding.key !== '?') {
        throw new ShortcutDefinitionError(
          `Shortcut ${id}: the only single-key shortcut is ?, so shortcuts never collide with the quick keys of screen readers.`,
        )
      }
      return
    case 'sequence': {
      const [first, second] = binding.keys
      if (!LETTER.test(first) || !LETTER.test(second)) {
        throw new ShortcutDefinitionError(
          `Shortcut ${id}: a sequence is two lower case letters a to z.`,
        )
      }
      if (!(SEQUENCE_LEADERS as readonly string[]).includes(first)) {
        throw new ShortcutDefinitionError(
          `Shortcut ${id}: a sequence starts with ${SEQUENCE_LEADERS.join(' or ')} only.`,
        )
      }
    }
  }
}

/**
 * Validates a list of shortcut definitions and builds the lookups the matcher
 * needs. Throws `ShortcutDefinitionError` for a binding that breaks a rule and
 * `ShortcutConflictError` for two ids on the same binding, so a conflict shows up
 * when the list is registered (at import time for the built-in list), never as a
 * shortcut that silently does the wrong thing.
 */
export function defineShortcuts<Id extends string>(
  definitions: Readonly<Record<Id, ShortcutDefinition>>,
): ShortcutRegistry<Id> {
  const ids = Object.keys(definitions) as Id[]
  const byBinding = new Map<string, Id>()
  const chords = new Map<string, Id>()
  const keys = new Map<string, Id>()
  const sequences = new Map<string, Id>()
  const leaders = new Set<string>()

  for (const id of ids) {
    const definition = definitions[id]
    checkBinding(id, definition.binding)
    if (!(SHORTCUT_GROUPS as readonly string[]).includes(definition.group)) {
      throw new ShortcutDefinitionError(`Shortcut ${id}: unknown group ${definition.group}.`)
    }
    const key = bindingKey(definition.binding)
    const other = byBinding.get(key)
    if (other !== undefined) {
      throw new ShortcutConflictError(`Shortcuts ${other} and ${id} use the same keys.`)
    }
    byBinding.set(key, id)

    const { binding } = definition
    if (binding.type === 'chord') chords.set(binding.key, id)
    else if (binding.type === 'key') keys.set(binding.key, id)
    else {
      sequences.set(`${binding.keys[0]}${binding.keys[1]}`, id)
      leaders.add(binding.keys[0])
    }
  }

  return {
    ids,
    definition: (id) => definitions[id],
    chordFor: (letter) => chords.get(letter),
    keyFor: (key) => keys.get(key),
    sequenceFor: (first, second) => sequences.get(`${first}${second}`),
    isLeader: (letter) => leaders.has(letter),
  }
}

/** The registry of the built-in list. Importing this module validates the list. */
export const shortcutRegistry: ShortcutRegistry<ShortcutId> = defineShortcuts(SHORTCUT_DEFINITIONS)

/** The words a screen reader should say for a binding: "G then P", "Command K". */
export function spokenBinding(binding: ShortcutBinding, apple: boolean): string {
  switch (binding.type) {
    case 'chord':
      return `${apple ? 'Command' : 'Control'} ${binding.key.toUpperCase()}`
    case 'sequence':
      return `${binding.keys[0].toUpperCase()} then ${binding.keys[1].toUpperCase()}`
    case 'key':
      return 'Question mark'
  }
}

/** True on Apple platforms, where the modifier of a chord is Command. */
export function isApplePlatform(): boolean {
  if (typeof navigator === 'undefined') return false
  if (navigator.userAgent.includes('Mac')) return true
  const platform = navigator.platform as string | undefined
  return platform !== undefined && (platform.startsWith('Mac') || platform === 'iPhone')
}
