import {
  CommandHeader,
  CommandMenuBackButton,
  CommandMenuInput,
  CommandWrapper,
  useCommandMenuQuery,
  useNavigate,
  useSetCommandMenuOpen,
} from '@exponetdb/ui-patterns'
import { useRouterState } from '@tanstack/react-router'
import { type ReactNode, useState } from 'react'
import { t } from '../../lib/i18n/i18n.ts'
import { useMe } from '../../lib/session/guard.tsx'
import { switchTarget } from '../../shell/navigation.ts'
import { DatabaseChoices } from './database-choices.tsx'
import { targetOfPathname } from './params.ts'
import { useDatabases } from './queries.ts'
import { readRecentTargets } from './recent.ts'

/**
 * The command page "Switch database…" of the command menu: the same list as
 * the switcher of the context bar, for every page of the app (not only a
 * target page). It is a component page, rendered in place of the command list
 * while it is on top, so the list is requested when the person opens it and
 * not before. Choosing a database goes to the same page there when the person
 * is on a target page, else to its overview, and closes the menu.
 */
export function SwitchDatabasePage(): ReactNode {
  const navigate = useNavigate()
  const setOpen = useSetCommandMenuOpen()
  const search = useCommandMenuQuery()
  const databases = useDatabases()
  const identityId = useMe().identity.id
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const [recent] = useState(() => readRecentTargets(identityId))
  const current = targetOfPathname(pathname)
  return (
    <CommandWrapper label={t('target.switch.search')}>
      <CommandHeader>
        <CommandMenuBackButton />
        <CommandMenuInput placeholder={t('target.switch.search')} />
      </CommandHeader>
      <DatabaseChoices
        readable={databases.readable}
        current={current?.path}
        recent={recent}
        search={search}
        onRetry={databases.refetch}
        onChoose={(route) => {
          setOpen(false)
          if (route.path !== current?.path) navigate(switchTarget(pathname, route))
        }}
      />
    </CommandWrapper>
  )
}
