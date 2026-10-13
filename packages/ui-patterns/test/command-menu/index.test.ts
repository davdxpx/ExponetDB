import { describe, expect, it } from 'vitest'

import * as commandMenu from '../../src/command-menu/index.ts'
import * as shortcuts from '../../src/shortcuts/index.ts'

describe('the public surface of the command menu and the shortcuts', () => {
  it('exports the components, hooks and helpers the app composes the menu from', () => {
    const names = [
      'CommandProvider',
      'CommandMenu',
      'CommandMenuTrigger',
      'CommandMenuTriggerInput',
      'CommandMenuInput',
      'CommandMenuList',
      'CommandMenuBackButton',
      'CommandWrapper',
      'CommandHeader',
      'TextHighlighter',
      'useRegisterCommands',
      'useRegisterCommandPage',
      'useSetCommandPage',
      'useCommandMenuOpen',
      'useRunCommand',
      'isAppPath',
    ]
    expect(Object.keys(commandMenu)).toEqual(expect.arrayContaining(names))
    expect(commandMenu.CommandPageType).toEqual({ Commands: 'commands', Component: 'component' })
  })

  it('exports the shortcut provider, hooks and definitions', () => {
    const names = [
      'ShortcutProvider',
      'ShortcutHelpDialog',
      'ShortcutKeys',
      'useShortcut',
      'useShortcutBindings',
      'useActiveShortcuts',
      'useOpenShortcutHelp',
      'defineShortcuts',
      'createShortcutManager',
      'shortcutRegistry',
      'SHORTCUT_DEFINITIONS',
    ]
    expect(Object.keys(shortcuts)).toEqual(expect.arrayContaining(names))
  })
})
