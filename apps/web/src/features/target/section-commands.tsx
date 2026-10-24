import { type IHrefCommand, isAppPath, useRegisterCommands } from '@exponetdb/ui-patterns'
import { type ReactNode, useMemo } from 'react'
import { t } from '../../lib/i18n/i18n.ts'
import { SCHEMA_KINDS } from '../../lib/navigation/links.ts'
import { TARGET_NAV, targetHref } from '../../shell/navigation.ts'
import type { TargetRoute } from './params.ts'

/**
 * The commands that open a section of the target the person is on: "Go to
 * schema", "Go to migrations", and so on for every section of `TARGET_NAV`
 * (the pages that wait for Wave 9 included: they open on their named "not
 * available yet" state, and the command says so), the schema kinds ("Schema:
 * tables"), and the two ways into the SQL page, "Query the database" and
 * "Draft a change" (`?mode=query` and `?mode=draft`, which the page opens its
 * mode from). They are listed under the target's path and exist for as long
 * as the target layout is mounted, so they leave with the target page.
 * Every address is built from the validated slugs and the fixed suffixes of
 * the navigation, never from data.
 */

/** The label in the middle of a sentence: "Migrations" becomes "migrations", "SQL" stays "SQL". */
function inSentence(label: string): string {
  return /^[A-Z]{2,}/.test(label) ? label : `${label.charAt(0).toLowerCase()}${label.slice(1)}`
}

export function buildSectionCommands(target: TargetRoute): readonly IHrefCommand[] {
  const commands: IHrefCommand[] = []
  // The second lock behind the typed pieces: an address that is no app path is left out.
  const add = (command: Omit<IHrefCommand, 'href'>, suffix: string): void => {
    const href = targetHref(target, suffix)
    if (isAppPath(href)) commands.push({ ...command, href })
  }
  for (const item of TARGET_NAV) {
    add(
      {
        id: `target.section.${item.id}`,
        name: t('target.command.goTo', { section: inSentence(item.label) }),
        keywords: [item.label, item.id, 'database', 'target'],
        ...(item.wave === undefined
          ? {}
          : {
              badge: () => (
                <span className="text-xs text-foreground-lighter">
                  {t('target.command.notAvailable')}
                </span>
              ),
            }),
      },
      item.suffix,
    )
  }
  for (const kind of SCHEMA_KINDS) {
    const words = kind.replaceAll('-', ' ')
    add(
      {
        id: `target.schema.${kind}`,
        name: t('target.command.schemaKind', { kind: words }),
        keywords: ['schema', words, kind],
      },
      `/schema/${kind}`,
    )
  }
  add(
    {
      id: 'target.sql.query',
      name: t('target.command.query'),
      keywords: ['sql', 'select', 'read', 'query', 'statement'],
    },
    '/sql?mode=query',
  )
  add(
    {
      id: 'target.sql.draft',
      name: t('target.command.draft'),
      keywords: ['sql', 'migration', 'ddl', 'change', 'write'],
    },
    '/sql?mode=draft',
  )
  return commands
}

export function TargetSectionCommands({ target }: { readonly target: TargetRoute }): ReactNode {
  const commands = useMemo(() => buildSectionCommands(target), [target])
  useRegisterCommands(target.path, commands, { deps: [target.path] })
  return null
}
