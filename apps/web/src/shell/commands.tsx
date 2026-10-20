import {
  CommandPageType,
  type ICommand,
  isAppPath,
  useOpenShortcutHelp,
  useRegisterCommandPage,
  useRegisterCommands,
  useSetCommandPage,
} from '@exponetdb/ui-patterns'
import { type ReactNode, useLayoutEffect, useMemo, useRef } from 'react'
import { SwitchDatabasePage } from '../features/target/switch-database-page.tsx'
import { t } from '../lib/i18n/i18n.ts'
import { setThemePreference } from '../lib/preferences/theme.ts'
import { GLOBAL_NAV, NAV_SECTIONS } from './navigation.ts'

/**
 * The commands of every signed-in page: "Go to" for each section of the
 * rail (with its `G` sequence from the registry) and for each page of a
 * section menu (some with their own sequence), "Switch database…" (a command
 * page with a search over every database, wherever the person is), the theme
 * and the shortcut help. Pages register their own commands next to these.
 * Paths come from the IA data, never from a server answer.
 */
export function ShellCommands(): ReactNode {
  // The hook returns a new function on every render: the command reads the latest one.
  const openHelp = useOpenShortcutHelp()
  const help = useRef(openHelp)
  const setPage = useSetCommandPage()
  const openPage = useRef(setPage)
  useLayoutEffect(() => {
    help.current = openHelp
    openPage.current = setPage
  })
  const goTo = useMemo<ICommand[]>(
    () => [
      ...NAV_SECTIONS.filter((section) => isAppPath(section.path)).map(
        (section): ICommand => ({
          id: `nav.${section.id}`,
          name: `Go to ${section.label.toLowerCase()}`,
          keywords: [section.label],
          href: section.path as `/${string}`,
          shortcut: section.shortcut,
        }),
      ),
      // The pages of section menus, except the page a section itself goes to.
      ...GLOBAL_NAV.filter(
        (item) =>
          isAppPath(item.path) && !NAV_SECTIONS.some((section) => section.path === item.path),
      ).map(
        (item): ICommand => ({
          id: `nav.page.${item.id}`,
          name: `Go to ${item.label.toLowerCase()}`,
          keywords: [item.label, item.section],
          href: item.path as `/${string}`,
          ...(item.shortcut === undefined ? {} : { shortcut: item.shortcut }),
        }),
      ),
    ],
    [],
  )
  const general = useMemo<ICommand[]>(
    () => [
      {
        id: 'db.switch',
        name: t('target.switch.command'),
        keywords: ['database', 'target', 'project', 'environment', 'product', 'recent', 'switch'],
        // Opens the page and keeps the menu open: the choice happens there.
        action: () => openPage.current(t('target.switch.page')),
      },
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
  useRegisterCommandPage(t('target.switch.page'), {
    type: CommandPageType.Component,
    component: SwitchDatabasePage,
  })
  useRegisterCommands('Go to', goTo)
  useRegisterCommands('General', general)
  return null
}
