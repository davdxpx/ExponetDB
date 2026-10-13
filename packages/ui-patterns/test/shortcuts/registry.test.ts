import { describe, expect, it } from 'vitest'

import {
  SEQUENCE_LEADERS,
  SHORTCUT_DEFINITIONS,
  SHORTCUT_GROUPS,
  type ShortcutDefinition,
} from '../../src/shortcuts/definitions.ts'
import {
  defineShortcuts,
  ShortcutConflictError,
  ShortcutDefinitionError,
  shortcutRegistry,
  spokenBinding,
} from '../../src/shortcuts/registry.ts'

const sequence = (first: string, second: string, label = 'Go somewhere'): ShortcutDefinition => ({
  binding: { type: 'sequence', keys: [first, second] },
  label,
  group: 'Go to',
})

describe('the built-in shortcut list', () => {
  const entries = Object.entries(SHORTCUT_DEFINITIONS) as [string, ShortcutDefinition][]

  it('passes its own validation (importing the registry would throw otherwise)', () => {
    expect(shortcutRegistry.ids).toEqual(entries.map(([id]) => id))
  })

  it('binds the shortcuts the design system names', () => {
    expect(shortcutRegistry.sequenceFor('g', 'p')).toBe('nav.plans')
    expect(shortcutRegistry.sequenceFor('e', 'p')).toBe('env.production')
    expect(shortcutRegistry.chordFor('k')).toBe('palette.open')
    expect(shortcutRegistry.keyFor('?')).toBe('help.open')
    expect(shortcutRegistry.chordFor('enter')).toBe('sql.run')
    expect(shortcutRegistry.chordFor('s')).toBe('sql.save')
  })

  it('starts every sequence with G or E and uses one binding once', () => {
    const seen = new Set<string>()
    for (const [id, definition] of entries) {
      const { binding } = definition
      if (binding.type === 'sequence') {
        expect(SEQUENCE_LEADERS as readonly string[], id).toContain(binding.keys[0])
      }
      const key = JSON.stringify(binding)
      expect(seen.has(key), `${id} repeats a binding`).toBe(false)
      seen.add(key)
    }
  })

  it('groups navigation under G and environment switches under E', () => {
    for (const [id, definition] of entries) {
      if (id.startsWith('nav.')) {
        expect(definition.binding).toMatchObject({ type: 'sequence' })
        expect(definition.group).toBe('Go to')
        if (definition.binding.type === 'sequence') expect(definition.binding.keys[0]).toBe('g')
      }
      if (id.startsWith('env.')) {
        expect(definition.group).toBe('Switch environment')
        if (definition.binding.type === 'sequence') expect(definition.binding.keys[0]).toBe('e')
      }
    }
  })

  it('words every label as a command in sentence case without a period or an exclamation mark', () => {
    for (const [id, { label, group }] of entries) {
      expect(label, id).toMatch(/^[A-Z][a-z]/)
      expect(label, id).not.toMatch(/[.!]$/)
      expect(SHORTCUT_GROUPS as readonly string[], id).toContain(group)
    }
  })

  it('has only one single-key shortcut, the question mark', () => {
    const singles = entries.filter(([, { binding }]) => binding.type === 'key')
    expect(singles.map(([id]) => id)).toEqual(['help.open'])
    expect(SHORTCUT_DEFINITIONS['help.open'].binding.key).toBe('?')
  })
})

describe('defineShortcuts', () => {
  it('throws when two shortcuts use the same sequence', () => {
    expect(() =>
      defineShortcuts({ 'nav.a': sequence('g', 'p'), 'nav.b': sequence('g', 'p') }),
    ).toThrow(ShortcutConflictError)
  })

  it('throws when two shortcuts use the same chord', () => {
    const chord = (key: string): ShortcutDefinition => ({
      binding: { type: 'chord', key },
      label: 'Open something',
      group: 'General',
    })
    expect(() => defineShortcuts({ one: chord('k'), two: chord('k') })).toThrow(
      ShortcutConflictError,
    )
  })

  it('names both shortcuts in the conflict message', () => {
    expect(() =>
      defineShortcuts({ first: sequence('g', 'p'), second: sequence('g', 'p') }),
    ).toThrow(/first and second/)
  })

  it('accepts a sequence and a chord on the same letter: they are different keys', () => {
    expect(() =>
      defineShortcuts({
        one: sequence('g', 'k'),
        two: { binding: { type: 'chord', key: 'k' }, label: 'Open something', group: 'General' },
      }),
    ).not.toThrow()
  })

  it('refuses a sequence that does not start with G or E', () => {
    expect(() => defineShortcuts({ bad: sequence('x', 'p') })).toThrow(ShortcutDefinitionError)
    expect(() => defineShortcuts({ bad: sequence('x', 'p') })).toThrow(/G or E|g or e/i)
  })

  it('refuses a single key other than the question mark', () => {
    expect(() =>
      defineShortcuts({
        bad: { binding: { type: 'key', key: 'g' }, label: 'Do something', group: 'General' },
      }),
    ).toThrow(ShortcutDefinitionError)
  })

  it('refuses keys that are not lower case letters', () => {
    expect(() => defineShortcuts({ bad: sequence('g', '1') })).toThrow(ShortcutDefinitionError)
    expect(() => defineShortcuts({ bad: sequence('g', 'P') })).toThrow(ShortcutDefinitionError)
    expect(() =>
      defineShortcuts({
        bad: { binding: { type: 'chord', key: 'Enter' }, label: 'Do something', group: 'General' },
      }),
    ).toThrow(ShortcutDefinitionError)
  })

  it('refuses an unknown group', () => {
    expect(() =>
      defineShortcuts({
        bad: {
          binding: { type: 'sequence', keys: ['g', 'p'] },
          label: 'Do something',
          group: 'Elsewhere' as ShortcutDefinition['group'],
        },
      }),
    ).toThrow(ShortcutDefinitionError)
  })

  it('looks bindings up by their keys', () => {
    const registry = defineShortcuts({ 'nav.plans': sequence('g', 'p') })
    expect(registry.sequenceFor('g', 'p')).toBe('nav.plans')
    expect(registry.sequenceFor('g', 'x')).toBeUndefined()
    expect(registry.isLeader('g')).toBe(true)
    expect(registry.isLeader('p')).toBe(false)
    expect(registry.definition('nav.plans').label).toBe('Go somewhere')
  })
})

describe('spokenBinding', () => {
  it('says what a screen reader should read', () => {
    expect(spokenBinding({ type: 'sequence', keys: ['g', 'p'] }, false)).toBe('G then P')
    expect(spokenBinding({ type: 'chord', key: 'k' }, true)).toBe('Command K')
    expect(spokenBinding({ type: 'chord', key: 'k' }, false)).toBe('Control K')
    expect(spokenBinding({ type: 'key', key: '?' }, false)).toBe('Question mark')
    expect(spokenBinding({ type: 'chord', key: 'enter' }, true)).toBe('Command Enter')
  })
})
