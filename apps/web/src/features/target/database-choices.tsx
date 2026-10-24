import { Check } from '@exponetdb/icons'
import {
  Button,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
  Skeleton,
} from '@exponetdb/ui'
import { ObservedTime, type Readable, TierChip } from '@exponetdb/ui-patterns'
import type { ReactNode } from 'react'
import { t } from '../../lib/i18n/i18n.ts'
import {
  type Database,
  type DatabaseGroups,
  type RecentDatabase,
  recentDatabases,
} from './databases.ts'
import { lifecycleLabelKey } from './environments.ts'
import type { TargetRoute } from './params.ts'

/**
 * The databases to choose from, for the context bar's popover and the
 * "Switch database" command page: it renders the read of the target list in
 * each of its states and, once there is a list, the groups (recent databases
 * first, then each product and project with its environments and their tier
 * chips). It belongs inside a cmdk `Command`, whose input filters the items.
 *
 * - loading: a status line and skeletons; no item;
 * - failed: the failure with its code and a retry, never an empty list;
 * - stale: the earlier list under a note with its age and a refresh;
 * - partial: the list under a note that says what is missing; a search that
 *   finds nothing says others may exist;
 * - ready: the list, or "found no databases" after a read that succeeded.
 *
 * Every name shown is a slug that passed the registry grammar (the model
 * drops any other path), and everything is rendered as text.
 */
export interface DatabaseChoicesProps {
  readonly readable: Readable<DatabaseGroups>
  /** The path of the database the person is on, if any. */
  readonly current: string | undefined
  /** The recent target paths of this person, newest first. */
  readonly recent: readonly string[]
  /** What the person typed in the search field; recent databases are listed only while it is empty. */
  readonly search: string
  readonly onChoose: (route: TargetRoute) => void
  readonly onRetry: () => void
}

const NOTICE = 'px-3 py-2 text-xs text-foreground-light'

export function DatabaseChoices(props: DatabaseChoicesProps): ReactNode {
  const { readable, onRetry } = props
  switch (readable.state) {
    case 'loading':
      return (
        <div className="flex flex-col gap-2 px-3 py-3">
          <p role="status" className="text-sm text-foreground-light">
            {t('target.switch.loading')}
          </p>
          <Skeleton className="h-5 w-48" />
          <Skeleton className="h-5 w-40" />
        </div>
      )
    case 'failed':
      return (
        <div className="flex flex-col items-start gap-2 px-3 py-3">
          <p role="alert" className="text-sm text-foreground-light">
            {t('target.switch.failed', {
              reason: t('error.withCode', {
                message: readable.error.message,
                code: readable.error.code,
              }),
            })}
          </p>
          <Button type="button" variant="outline" size="tiny" onClick={onRetry}>
            {t('state.retry')}
          </Button>
        </div>
      )
    case 'stale':
      return (
        <>
          <div className={`${NOTICE} flex flex-wrap items-center gap-2`}>
            <p role="status">
              {t('target.switch.stale')} <ObservedTime observedAt={readable.observedAt} />.
              {readable.value.missing.length === 0 ? null : (
                <> {t('target.switch.partial', { missing: readable.value.missing.join(' ') })}</>
              )}
            </p>
            <Button type="button" variant="outline" size="tiny" onClick={onRetry}>
              {t('state.refresh')}
            </Button>
          </div>
          <Choices {...props} groups={readable.value} partial={readable.value.truncated} />
        </>
      )
    case 'partial':
      return (
        <>
          <p role="status" className={NOTICE}>
            {t('target.switch.partial', { missing: readable.missing.join(' ') })}
          </p>
          <Choices {...props} groups={readable.value} partial />
        </>
      )
    case 'ready':
      return <Choices {...props} groups={readable.value} partial={false} />
  }
}

function Choices(
  props: DatabaseChoicesProps & { readonly groups: DatabaseGroups; readonly partial: boolean },
): ReactNode {
  const { groups, partial, current, search, onChoose } = props
  // The recent list is a shortcut: it is hidden while the person searches, so a database never
  // shows twice in one result.
  const recent = search.trim() === '' ? recentDatabases(props.recent, groups) : []
  if (groups.groups.length === 0 && recent.length === 0) {
    // A partial read that holds nothing is not "no databases": what was not read may hold them.
    return partial ? null : (
      <p role="status" className="px-3 py-3 text-sm text-foreground-light">
        {t('target.switch.empty')}
      </p>
    )
  }
  return (
    <CommandList className="max-h-72">
      <CommandEmpty>
        {partial ? t('target.switch.noMatchPartial') : t('target.switch.noMatch')}
      </CommandEmpty>
      {recent.length === 0 ? null : (
        <CommandGroup heading={t('target.switch.recent')}>
          {recent.map((entry) => (
            <RecentItem
              key={entry.path}
              entry={entry}
              current={entry.path === current}
              onChoose={onChoose}
            />
          ))}
        </CommandGroup>
      )}
      {groups.groups.map((group) => (
        <CommandGroup key={group.key} heading={`${group.product} / ${group.project}`}>
          {group.databases.map((database) => (
            <DatabaseItem
              key={database.path}
              database={database}
              value={database.path}
              label={database.route.environment}
              current={database.path === current}
              onChoose={onChoose}
            />
          ))}
        </CommandGroup>
      ))}
    </CommandList>
  )
}

function CurrentMark(): ReactNode {
  return (
    <>
      <Check aria-hidden className="size-3.5" />
      <span className="sr-only">{t('target.switch.current')}</span>
    </>
  )
}

function DatabaseItem(props: {
  readonly database: Database
  readonly value: string
  readonly label: string
  readonly current: boolean
  readonly onChoose: (route: TargetRoute) => void
}): ReactNode {
  const { database, value, label, current, onChoose } = props
  const lifecycle = lifecycleLabelKey(database.state)
  const { route } = database
  return (
    <CommandItem
      value={value}
      keywords={[route.product, route.project, route.environment, database.path]}
      onSelect={() => onChoose(route)}
    >
      <span className="flex w-full min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {lifecycle === undefined ? null : (
          <span className="text-foreground-lighter">{t(lifecycle)}</span>
        )}
        <TierChip tier={database.tier} />
        {current ? <CurrentMark /> : null}
      </span>
    </CommandItem>
  )
}

function RecentItem(props: {
  readonly entry: RecentDatabase
  readonly current: boolean
  readonly onChoose: (route: TargetRoute) => void
}): ReactNode {
  const { entry, current, onChoose } = props
  if (entry.database !== undefined) {
    return (
      <DatabaseItem
        database={entry.database}
        value={`recent:${entry.path}`}
        label={entry.path}
        current={current}
        onChoose={onChoose}
      />
    )
  }
  // Opened lately but not in the part of the list that was read: its tier is not known, and the
  // chip says so instead of guessing.
  return (
    <CommandItem value={`recent:${entry.path}`} onSelect={() => onChoose(entry.route)}>
      <span className="flex w-full min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate">{entry.path}</span>
        <span className="rounded-md border border-strong px-2 py-0.5 text-xs text-foreground-light">
          {t('target.tier.unknown')}
        </span>
        {current ? <CurrentMark /> : null}
      </span>
    </CommandItem>
  )
}
