import {
  type ICommand,
  isAppPath,
  useOpenShortcutHelp,
  useRegisterCommands,
} from '@exponetdb/ui-patterns'
import { type ReactNode, useLayoutEffect, useMemo, useRef } from 'react'
import { setThemePreference } from '../lib/preferences/theme.ts'
import { GLOBAL_NAV } from './navigation.ts'

/**
 * The commands of every signed-in page: "Go to" for each section of the
 * global navigation (with its shortcut from the registry), the two change
 * lists, the theme and the shortcut help. Pages register their own commands
 * next to these. Paths come from the IA data, never from a server answer.
 */
const EXTRA_DESTINATIONS = [
  { id: 'nav.plans', name: 'Go to plans', href: '/changes/plans', shortcut: 'nav.plans' },
  {
    id: 'nav.operations',
    name: 'Go to operations',
    href: '/changes/operations',
    shortcut: 'nav.operations',
  },
] as const

export function ShellCommands(): ReactNode {
  // The hook returns a new function on every render: the command reads the latest one.
  const openHelp = useOpenShortcutHelp()
  const help = useRef(openHelp)
  useLayoutEffect(() => {
    help.current = openHelp
  })
  const goTo = useMemo<ICommand[]>(
    () => [
      ...GLOBAL_NAV.filter((item) => isAppPath(item.path)).map(
        (item): ICommand => ({
          id: `nav.${item.id}`,
          name: `Go to ${item.label.toLowerCase()}`,
          keywords: [item.label, item.group],
          href: item.path as `/${string}`,
          ...(item.shortcut === undefined ? {} : { shortcut: item.shortcut }),
        }),
      ),
      ...EXTRA_DESTINATIONS.map((d): ICommand => ({ ...d })),
    ],
    [],
  )
  const general = useMemo<ICommand[]>(
    () => [
      {
        id: 'theme.light',
        name: 'Use the light theme',
        keywords: ['theme', 'appearance'],
        action: () => setThemePreference('light', document.documentElement),
        closeOnSelect: true,
      },
      {
        id: 'theme.dark',
        name: 'Use the dark theme',
        keywords: ['theme', 'appearance'],
        action: () => setThemePreference('dark', document.documentElement),
        closeOnSelect: true,
      },
      {
        id: 'theme.system',
        name: 'Use the theme of the system',
        keywords: ['theme', 'appearance'],
        action: () => setThemePreference('system', document.documentElement),
        closeOnSelect: true,
      },
      {
        id: 'help.shortcuts',
        name: 'Show keyboard shortcuts',
        keywords: ['keys', 'help'],
        action: () => help.current?.(),
        closeOnSelect: true,
      },
    ],
    [],
  )
  useRegisterCommands('Go to', goTo)
  useRegisterCommands('General', general)
  return null
}
