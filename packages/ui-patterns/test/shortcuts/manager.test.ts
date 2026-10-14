import { describe, expect, it, vi } from 'vitest'

import {
  createShortcutManager,
  eventLetter,
  type ShortcutContext,
  type ShortcutKeyEvent,
} from '../../src/shortcuts/manager.ts'
import { ShortcutConflictError, shortcutRegistry } from '../../src/shortcuts/registry.ts'

const open: ShortcutContext = {
  allowCharacterShortcuts: () => true,
  allowChordShortcuts: () => true,
}

function press(key: string, init: Partial<ShortcutKeyEvent> = {}): ShortcutKeyEvent {
  const letter = /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : key
  return {
    key,
    code: letter,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    isComposing: false,
    ...init,
  }
}

function setup(options: { apple?: boolean; strict?: boolean } = {}) {
  let time = 0
  const manager = createShortcutManager(shortcutRegistry, {
    apple: options.apple ?? false,
    strict: options.strict ?? false,
    now: () => time,
  })
  return {
    manager,
    advance: (ms: number) => {
      time += ms
    },
  }
}

describe('sequences', () => {
  it('runs the handler when the second key follows the first', () => {
    const { manager } = setup()
    const handler = vi.fn()
    manager.register('nav.plans', handler)

    expect(manager.handleKeyDown(press('g'), open)).toBeUndefined()
    expect(manager.handleKeyDown(press('p'), open)).toBe('nav.plans')
    expect(handler).toHaveBeenCalledOnce()
  })

  it('accepts the second key up to a second later and not after', () => {
    const { manager, advance } = setup()
    const handler = vi.fn()
    manager.register('nav.plans', handler)

    manager.handleKeyDown(press('g'), open)
    advance(1000)
    expect(manager.handleKeyDown(press('p'), open)).toBe('nav.plans')

    manager.handleKeyDown(press('g'), open)
    advance(1001)
    expect(manager.handleKeyDown(press('p'), open)).toBeUndefined()
    expect(handler).toHaveBeenCalledOnce()
  })

  it('does nothing for a second key alone', () => {
    const { manager } = setup()
    const handler = vi.fn()
    manager.register('nav.plans', handler)

    expect(manager.handleKeyDown(press('p'), open)).toBeUndefined()
    expect(handler).not.toHaveBeenCalled()
  })

  it('lets a wrong second key start a new sequence', () => {
    const { manager } = setup()
    const plans = vi.fn()
    const production = vi.fn()
    manager.register('nav.plans', plans)
    manager.register('env.production', production)

    manager.handleKeyDown(press('g'), open)
    manager.handleKeyDown(press('g'), open)
    expect(manager.handleKeyDown(press('p'), open)).toBe('nav.plans')

    manager.handleKeyDown(press('g'), open)
    manager.handleKeyDown(press('e'), open)
    expect(manager.handleKeyDown(press('p'), open)).toBe('env.production')
    expect(plans).toHaveBeenCalledOnce()
    expect(production).toHaveBeenCalledOnce()
  })

  it('does not start a sequence with any other letter', () => {
    const { manager } = setup()
    const handler = vi.fn()
    manager.register('nav.plans', handler)

    manager.handleKeyDown(press('x'), open)
    expect(manager.handleKeyDown(press('p'), open)).toBeUndefined()
    expect(handler).not.toHaveBeenCalled()
  })

  it('does not run a sequence nobody handles, and reports nothing', () => {
    const { manager } = setup()

    manager.handleKeyDown(press('g'), open)
    expect(manager.handleKeyDown(press('p'), open)).toBeUndefined()
  })

  it('forgets the first key once the sequence ran', () => {
    const { manager } = setup()
    const handler = vi.fn()
    manager.register('nav.plans', handler)

    manager.handleKeyDown(press('g'), open)
    manager.handleKeyDown(press('p'), open)
    expect(manager.handleKeyDown(press('p'), open)).toBeUndefined()
    expect(handler).toHaveBeenCalledOnce()
  })

  it('ignores a modifier key pressed between the two keys', () => {
    const { manager } = setup()
    manager.register('nav.plans', vi.fn())

    manager.handleKeyDown(press('g'), open)
    expect(manager.handleKeyDown(press('Shift', { shiftKey: true }), open)).toBeUndefined()
    expect(manager.handleKeyDown(press('p'), open)).toBe('nav.plans')
  })

  it('ignores a key combined with Control, Command, Alt or Shift', () => {
    const { manager } = setup()
    manager.register('nav.plans', vi.fn())

    for (const init of [
      { ctrlKey: true },
      { metaKey: true },
      { altKey: true },
      { shiftKey: true },
    ]) {
      manager.handleKeyDown(press('g'), open)
      expect(manager.handleKeyDown(press('p', init), open)).toBeUndefined()
      manager.handleKeyDown(press('g', init), open)
      expect(manager.handleKeyDown(press('p'), open)).toBeUndefined()
    }
  })

  it('ignores key repeat and keys typed during text composition', () => {
    const { manager } = setup()
    manager.register('nav.plans', vi.fn())

    manager.handleKeyDown(press('g'), open)
    expect(manager.handleKeyDown(press('p', { repeat: true }), open)).toBeUndefined()
    expect(manager.handleKeyDown(press('p', { isComposing: true }), open)).toBeUndefined()
    expect(manager.handleKeyDown(press('p'), open)).toBe('nav.plans')
  })

  it('does not run in a text field, and a half-typed sequence does not survive it', () => {
    const { manager } = setup()
    const handler = vi.fn()
    manager.register('nav.plans', handler)
    const typing: ShortcutContext = { ...open, allowCharacterShortcuts: () => false }

    manager.handleKeyDown(press('g'), open)
    expect(manager.handleKeyDown(press('p'), typing)).toBeUndefined()
    expect(manager.handleKeyDown(press('p'), open)).toBeUndefined()
    expect(handler).not.toHaveBeenCalled()
  })

  it('does not look at the page for keys that cannot be a shortcut', () => {
    const { manager } = setup()
    const allowCharacterShortcuts = vi.fn(() => true)
    manager.register('nav.plans', vi.fn())

    manager.handleKeyDown(press('x'), { ...open, allowCharacterShortcuts })
    manager.handleKeyDown(press('Enter'), { ...open, allowCharacterShortcuts })
    expect(allowCharacterShortcuts).not.toHaveBeenCalled()

    manager.handleKeyDown(press('g'), { ...open, allowCharacterShortcuts })
    expect(allowCharacterShortcuts).toHaveBeenCalledOnce()
  })
})

describe('the question mark', () => {
  it('runs the help shortcut, typed with Shift', () => {
    const { manager } = setup()
    const handler = vi.fn()
    manager.register('help.open', handler)

    expect(manager.handleKeyDown(press('?', { shiftKey: true, code: 'Slash' }), open)).toBe(
      'help.open',
    )
    expect(handler).toHaveBeenCalledOnce()
  })

  it('does not run in a text field or with Control', () => {
    const { manager } = setup()
    const handler = vi.fn()
    manager.register('help.open', handler)

    manager.handleKeyDown(press('?'), { ...open, allowCharacterShortcuts: () => false })
    manager.handleKeyDown(press('?', { ctrlKey: true }), open)
    expect(handler).not.toHaveBeenCalled()
  })
})

describe('chords', () => {
  it('runs Mod+Enter and leaves Enter alone', () => {
    const { manager } = setup()
    const handler = vi.fn()
    manager.register('sql.run', handler)
    expect(manager.handleKeyDown(press('Enter'), open)).toBeUndefined()
    expect(
      manager.handleKeyDown(press('Enter', { shiftKey: true, ctrlKey: true }), open),
    ).toBeUndefined()
    expect(manager.handleKeyDown(press('Enter', { ctrlKey: true }), open)).toBe('sql.run')
    expect(handler).toHaveBeenCalledOnce()
  })

  it('runs Control+K on a platform that uses Control, and not Command+K', () => {
    const { manager } = setup({ apple: false })
    const handler = vi.fn()
    manager.register('palette.open', handler)

    expect(manager.handleKeyDown(press('k', { metaKey: true }), open)).toBeUndefined()
    expect(manager.handleKeyDown(press('k', { ctrlKey: true }), open)).toBe('palette.open')
    expect(handler).toHaveBeenCalledOnce()
  })

  it('runs Command+K on an Apple platform, and not Control+K', () => {
    const { manager } = setup({ apple: true })
    const handler = vi.fn()
    manager.register('palette.open', handler)

    expect(manager.handleKeyDown(press('k', { ctrlKey: true }), open)).toBeUndefined()
    expect(manager.handleKeyDown(press('k', { metaKey: true }), open)).toBe('palette.open')
    expect(handler).toHaveBeenCalledOnce()
  })

  it('ignores the chord with Shift or Alt added', () => {
    const { manager } = setup()
    const handler = vi.fn()
    manager.register('palette.open', handler)

    manager.handleKeyDown(press('k', { ctrlKey: true, shiftKey: true }), open)
    manager.handleKeyDown(press('k', { ctrlKey: true, altKey: true }), open)
    expect(handler).not.toHaveBeenCalled()
  })

  it('works in a text field but not over a dialog that is not the command menu', () => {
    const { manager } = setup()
    const handler = vi.fn()
    manager.register('palette.open', handler)

    const inField: ShortcutContext = { ...open, allowCharacterShortcuts: () => false }
    expect(manager.handleKeyDown(press('k', { ctrlKey: true }), inField)).toBe('palette.open')

    const overDialog: ShortcutContext = { ...open, allowChordShortcuts: () => false }
    expect(manager.handleKeyDown(press('k', { ctrlKey: true }), overDialog)).toBeUndefined()
    expect(handler).toHaveBeenCalledOnce()
  })

  it('cancels a half-typed sequence', () => {
    const { manager } = setup()
    manager.register('nav.plans', vi.fn())
    manager.register('palette.open', vi.fn())

    manager.handleKeyDown(press('g'), open)
    manager.handleKeyDown(press('k', { ctrlKey: true }), open)
    expect(manager.handleKeyDown(press('p'), open)).toBeUndefined()
  })
})

describe('letter shortcuts switched off', () => {
  it('stops sequences and the question mark but not chords', () => {
    const { manager } = setup()
    manager.register('nav.plans', vi.fn())
    manager.register('help.open', vi.fn())
    manager.register('palette.open', vi.fn())
    manager.setCharacterShortcuts(false)

    manager.handleKeyDown(press('g'), open)
    expect(manager.handleKeyDown(press('p'), open)).toBeUndefined()
    expect(manager.handleKeyDown(press('?'), open)).toBeUndefined()
    expect(manager.handleKeyDown(press('k', { ctrlKey: true }), open)).toBe('palette.open')

    manager.setCharacterShortcuts(true)
    manager.handleKeyDown(press('g'), open)
    expect(manager.handleKeyDown(press('p'), open)).toBe('nav.plans')
  })
})

describe('keyboard layouts', () => {
  it('reads the letter the layout produces', () => {
    expect(eventLetter({ key: 'p', code: 'KeyR' })).toBe('p')
    expect(eventLetter({ key: 'P', code: 'KeyP' })).toBe('p')
  })

  it('falls back to the physical key on a layout without Latin letters', () => {
    expect(eventLetter({ key: 'п', code: 'KeyG' })).toBe('g')
    expect(eventLetter({ key: 'Dead', code: 'KeyE' })).toBeUndefined()
    expect(eventLetter({ key: 'ArrowUp', code: 'ArrowUp' })).toBeUndefined()
    expect(eventLetter({ key: '1', code: 'Digit1' })).toBeUndefined()
  })

  it('runs a sequence typed on a Cyrillic layout', () => {
    const { manager } = setup()
    manager.register('nav.plans', vi.fn())

    manager.handleKeyDown({ ...press('п'), code: 'KeyG' }, open)
    expect(manager.handleKeyDown({ ...press('з'), code: 'KeyP' }, open)).toBe('nav.plans')
  })
})

describe('handlers', () => {
  it('lists the ids that have a handler, in the order of the list, and tells subscribers', () => {
    const { manager } = setup()
    const listener = vi.fn()
    manager.subscribe(listener)
    expect(manager.getActiveIds()).toEqual([])

    const removePlans = manager.register('nav.plans', vi.fn())
    const removeHelp = manager.register('help.open', vi.fn())
    expect(manager.getActiveIds()).toEqual(['help.open', 'nav.plans'])
    expect(listener).toHaveBeenCalledTimes(2)

    removePlans()
    removeHelp()
    expect(manager.getActiveIds()).toEqual([])
    expect(listener).toHaveBeenCalledTimes(4)
  })

  it('keeps the same array while the set of ids does not change', () => {
    const { manager } = setup()
    manager.register('nav.plans', vi.fn())
    const before = manager.getActiveIds()

    const remove = manager.register('nav.plans', vi.fn())
    expect(manager.getActiveIds()).toBe(before)
    remove()
    expect(manager.getActiveIds()).toBe(before)
  })

  it('stops notifying a listener that unsubscribed', () => {
    const { manager } = setup()
    const listener = vi.fn()
    const unsubscribe = manager.subscribe(listener)
    unsubscribe()

    manager.register('nav.plans', vi.fn())
    expect(listener).not.toHaveBeenCalled()
  })

  it('throws when a second handler registers for an id in strict mode', () => {
    const { manager } = setup({ strict: true })
    manager.register('nav.plans', vi.fn())

    expect(() => manager.register('nav.plans', vi.fn())).toThrow(ShortcutConflictError)
    expect(manager.getActiveIds()).toEqual(['nav.plans'])
  })

  it('allows the id again once its handler is removed in strict mode', () => {
    const { manager } = setup({ strict: true })
    const remove = manager.register('nav.plans', vi.fn())
    remove()

    expect(() => manager.register('nav.plans', vi.fn())).not.toThrow()
  })

  it('lets the newest handler win outside strict mode and restores the older one', () => {
    const { manager } = setup()
    const older = vi.fn()
    const newer = vi.fn()
    manager.register('nav.plans', older)
    const removeNewer = manager.register('nav.plans', newer)

    manager.handleKeyDown(press('g'), open)
    manager.handleKeyDown(press('p'), open)
    expect(newer).toHaveBeenCalledOnce()
    expect(older).not.toHaveBeenCalled()

    removeNewer()
    removeNewer()
    manager.handleKeyDown(press('g'), open)
    manager.handleKeyDown(press('p'), open)
    expect(older).toHaveBeenCalledOnce()
  })
})
