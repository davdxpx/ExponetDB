import {
  type IHrefCommand,
  isAppPath,
  readableValue,
  useRegisterCommands,
} from '@exponetdb/ui-patterns'
import { useRouterState } from '@tanstack/react-router'
import { type ReactNode, useMemo } from 'react'
import { t } from '../../lib/i18n/i18n.ts'
import {
  type Environment,
  type EnvironmentShortcutId,
  environmentHref,
  environmentShortcuts,
} from './environments.ts'
import type { TargetRoute } from './params.ts'
import { useProjectEnvironments } from './queries.ts'

/**
 * The commands "Switch environment" of a target page: one per other
 * environment of the project, each going to the same page there (the section
 * stays, an object name does not), and the `E`-then-letter shortcuts bound
 * to the environments `environmentShortcuts` picks. The commands exist for
 * as long as the layout is mounted, so they leave with the target page. A
 * read that failed or has not arrived registers none: a shortcut is never
 * bound to a guess.
 */
export function buildEnvironmentCommands(
  target: TargetRoute,
  pathname: string,
  environments: readonly Environment[],
): readonly IHrefCommand[] {
  const shortcuts = environmentShortcuts(environments, target.environment)
  const commands: IHrefCommand[] = []
  for (const environment of environments) {
    if (environment.slug === target.environment) continue
    const href = environmentHref(target, pathname, environment.slug)
    if (!isAppPath(href)) continue
    const bound: EnvironmentShortcutId[] = shortcuts
      .filter((entry) => entry.environment.slug === environment.slug)
      .map((entry) => entry.shortcut)
    const [first, ...more] = bound
    const name = t('target.command.switch', { environment: environment.slug })
    const keywords = [environment.slug, environment.tier]
    commands.push({
      id: `env.switch.${environment.slug}`,
      name,
      keywords,
      href,
      ...(first === undefined ? {} : { shortcut: first }),
    })
    // A second shortcut for the same environment gets an entry of its own, shown only when searched.
    for (const shortcut of more) {
      commands.push({
        id: `env.switch.${environment.slug}.${shortcut}`,
        name,
        keywords,
        href,
        shortcut,
        defaultHidden: true,
      })
    }
  }
  return commands
}

export function EnvironmentCommands({ target }: { readonly target: TargetRoute }): ReactNode {
  const environments = useProjectEnvironments(target.product, target.project)
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const list = readableValue(environments.readable)?.environments
  const commands = useMemo(
    () => buildEnvironmentCommands(target, pathname, list ?? []),
    [target, pathname, list],
  )
  const signature = commands
    .map((command) => `${command.id}|${command.href}|${command.shortcut ?? ''}`)
    .join('\n')
  useRegisterCommands(t('target.commands.section'), commands, {
    deps: [signature],
    enabled: commands.length > 0,
  })
  return null
}
