import { ChevronsUpDown } from '@exponetdb/icons'
import {
  Button,
  Command,
  CommandInput,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@exponetdb/ui'
import { useNavigate } from '@exponetdb/ui-patterns'
import { type ReactNode, useState } from 'react'
import { t } from '../../lib/i18n/i18n.ts'
import { switchTarget } from '../../shell/navigation.ts'
import { DatabaseChoices } from './database-choices.tsx'
import type { TargetRoute } from './params.ts'
import { useDatabases } from './queries.ts'
import { readRecentTargets } from './recent-storage.ts'

/**
 * `shop / platform ▾` in the context bar: a popover with a search field and
 * every database the person may see (information-architecture.md section 3,
 * "Product ▾ / Project ▾"). Choosing one goes to the same page there (the
 * section and a schema kind stay, an object name does not) or to its overview
 * when the page has no counterpart. The list is read when the popover opens,
 * not before, and recent databases come first. Product and project are the
 * slugs of the route, which passed the grammar.
 */
export function DatabaseSwitcher(props: {
  readonly target: TargetRoute
  /** The signed-in person, whose recent databases are listed. */
  readonly identityId: string
  readonly pathname: string
}): ReactNode {
  const { target, identityId, pathname } = props
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="tiny"
          className="max-w-full"
          aria-label={`${t('target.switch.trigger')}: ${target.product} / ${target.project}`}
          iconRight={<ChevronsUpDown className="size-3" />}
        >
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate">{target.product}</span>
            <span className="text-foreground-lighter">/</span>
            <span className="truncate">{target.project}</span>
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        aria-label={t('target.switch.trigger')}
        className="w-80 max-w-[calc(100vw-1rem)] p-0"
      >
        <SwitcherBody
          target={target}
          identityId={identityId}
          pathname={pathname}
          close={() => setOpen(false)}
        />
      </PopoverContent>
    </Popover>
  )
}

/** Mounted only while the popover is open, so the list is requested then. */
function SwitcherBody(props: {
  readonly target: TargetRoute
  readonly identityId: string
  readonly pathname: string
  readonly close: () => void
}): ReactNode {
  const { target, identityId, pathname, close } = props
  const navigate = useNavigate()
  const databases = useDatabases()
  const [recent] = useState(() => readRecentTargets(identityId))
  const [search, setSearch] = useState('')
  return (
    <Command label={t('target.switch.search')} className="bg-transparent">
      <CommandInput
        value={search}
        onValueChange={setSearch}
        placeholder={t('target.switch.search')}
      />
      <DatabaseChoices
        readable={databases.readable}
        current={target.path}
        recent={recent}
        search={search}
        onRetry={databases.refetch}
        onChoose={(route) => {
          close()
          if (route.path !== target.path) navigate(switchTarget(pathname, route))
        }}
      />
    </Command>
  )
}
