import { cn } from '@exponetdb/ui'
import {
  LinkCard,
  ReadableView,
  TierChip,
  UntrustedName,
  useLinkComponent,
} from '@exponetdb/ui-patterns'
import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useApi } from '../../lib/api/context.tsx'
import { type MessageKey, t } from '../../lib/i18n/i18n.ts'
import { toReadable } from '../../lib/query/readable.ts'
import {
  TARGET_MAX_PAGES,
  TARGET_PAGE_LIMIT,
  type TargetList,
  targetListQuery,
} from '../targets/keys.ts'
import { type HealthFilter, targetHrefOf, targetPathParts } from '../targets/model.ts'
import { HealthCell } from './health.tsx'
import { type Attention, needsAttention } from './model.ts'

const HEALTH_WORD: Readonly<Record<string, MessageKey>> = {
  healthy: 'health.healthy',
  degraded: 'health.degraded',
  unhealthy: 'health.unhealthy',
  unreachable: 'health.unreachable',
  unknown: 'health.unknown',
  suspended: 'health.suspended',
}

/**
 * The targets with the worst health, worst first (at most ten), from the
 * same list read as the Databases page (one cached read, however many
 * targets: no read per row). Each row links the target and carries its tier
 * and its health with source and age. When the list read stopped at its bound
 * the count is a floor and the page says "at least"; it never claims that
 * nothing needs attention about targets it did not read. A failed read is an
 * error, never an empty table.
 */
export function AttentionSection({ className }: { readonly className?: string }): ReactNode {
  const { client } = useApi()
  const list = useQuery(targetListQuery(client))
  return (
    <section
      aria-labelledby="fleet-attention"
      className={cn('flex min-w-0 flex-col gap-3', className)}
    >
      <div className="flex flex-col gap-1">
        <h2 id="fleet-attention" className="m-0 text-base font-medium">
          {t('fleet.attention.title')}
        </h2>
        <p className="m-0 text-xs text-foreground-light">{t('fleet.attention.description')}</p>
      </div>
      <ReadableView
        readable={toReadable(list, {
          missing: (value) =>
            value.more
              ? [t('fleet.attention.more', { count: TARGET_PAGE_LIMIT * TARGET_MAX_PAGES })]
              : undefined,
        })}
        what={t('targets.read.what')}
        onRetry={() => void list.refetch()}
        onRefresh={() => void list.refetch()}
        busy={list.isFetching}
        headingLevel={3}
        empty={{
          isEmpty: (value) => needsAttention(value.items).count === 0,
          content: (
            <p className="m-0 text-sm text-foreground-light">{t('fleet.attention.empty')}</p>
          ),
        }}
        ready={(value) => <AttentionBody list={value} />}
      />
    </section>
  )
}

function AttentionBody({ list }: { readonly list: TargetList }): ReactNode {
  const attention = needsAttention(list.items)
  if (attention.rows.length === 0) {
    // Only a cut-off list gets here empty (an empty complete list is the empty state above).
    return <p className="m-0 text-sm text-foreground-light">{t('fleet.attention.noneRead')}</p>
  }
  return (
    <div className="flex flex-col gap-3">
      <p role="status" className="m-0 text-xs text-foreground-light">
        {t(list.more ? 'fleet.attention.count.atLeast' : 'fleet.attention.count', {
          count: attention.count,
          total: list.items.length,
          shown: attention.rows.length,
        })}
      </p>
      <AttentionRows rows={attention.rows} />
      <ShowAll worst={attention.worst} />
    </div>
  )
}

/**
 * One row per target, each the whole row a link to the target (a table row cannot be a link,
 * so the rows are a list of cards); a path that is not three slugs is a plain row without one.
 */
function AttentionRows({ rows }: { readonly rows: Attention['rows'] }): ReactNode {
  return (
    <ul
      aria-label={t('fleet.attention.caption')}
      className="m-0 flex list-none flex-col gap-1.5 p-0"
    >
      {rows.map((target) => {
        const href = targetHrefOf(target.path)
        const body = (
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <UntrustedName
              name={target.path}
              mono
              expandable={false}
              className="min-w-0 text-sm"
              label={t('fleet.attention.column.target')}
            />
            <TierChip tier={target.tier} />
            <span className="ml-auto">
              <HealthCell health={target.health} />
            </span>
          </span>
        )
        return (
          <li key={target.id} data-target={target.id} data-tier={target.tier}>
            {href === undefined || targetPathParts(target.path) === undefined ? (
              <div className="rounded-lg border bg-surface-100 px-3 py-2">{body}</div>
            ) : (
              <LinkCard
                href={href}
                bare
                tone={target.tier === 'nonprod' ? 'neutral' : 'production'}
                aria-label={t('targets.open', { target: target.path })}
                className="px-3 py-2"
              >
                {body}
              </LinkCard>
            )}
          </li>
        )
      })}
    </ul>
  )
}

function ShowAll({ worst }: { readonly worst: HealthFilter | undefined }): ReactNode {
  const Link = useLinkComponent()
  if (worst === undefined) return null
  const word = HEALTH_WORD[worst]
  return (
    <p className="m-0 text-sm">
      <Link
        href={`/targets?health=${worst}`}
        className="text-foreground-light hover:text-foreground focus-ring"
      >
        {worst === 'none' || word === undefined
          ? t('fleet.attention.showAll.none')
          : t('fleet.attention.showAll', { state: t(word).toLowerCase() })}
      </Link>
    </p>
  )
}
