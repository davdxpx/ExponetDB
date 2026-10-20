import type { TargetSummary } from '@exponetdb/sdk/operations'
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@exponetdb/ui'
import { ReadableView, TierChip, UntrustedName, useLinkComponent } from '@exponetdb/ui-patterns'
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
export function AttentionSection(): ReactNode {
  const { client } = useApi()
  const list = useQuery(targetListQuery(client))
  return (
    <section aria-labelledby="fleet-attention" className="flex flex-col gap-3">
      <h2 id="fleet-attention" className="text-lg font-medium">
        {t('fleet.attention.title')}
      </h2>
      <p className="text-sm text-foreground-light">{t('fleet.attention.description')}</p>
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
          content: <p className="text-sm text-foreground-light">{t('fleet.attention.empty')}</p>,
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
    return <p className="text-sm text-foreground-light">{t('fleet.attention.noneRead')}</p>
  }
  return (
    <div className="flex flex-col gap-3">
      <p role="status" className="text-sm text-foreground-light">
        {t(list.more ? 'fleet.attention.count.atLeast' : 'fleet.attention.count', {
          count: attention.count,
          total: list.items.length,
          shown: attention.rows.length,
        })}
      </p>
      <AttentionTable rows={attention.rows} />
      <ShowAll worst={attention.worst} />
    </div>
  )
}

function AttentionTable({ rows }: { readonly rows: Attention['rows'] }): ReactNode {
  return (
    <Table>
      <TableCaption className="sr-only">{t('fleet.attention.caption')}</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">{t('fleet.attention.column.target')}</TableHead>
          <TableHead scope="col">{t('fleet.attention.column.tier')}</TableHead>
          <TableHead scope="col">{t('fleet.attention.column.health')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((target) => (
          <TableRow key={target.id} data-target={target.id} data-tier={target.tier}>
            <TableCell>
              <TargetPathLink target={target} />
            </TableCell>
            <TableCell>
              <TierChip tier={target.tier} />
            </TableCell>
            <TableCell>
              <HealthCell health={target.health} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

/** The target's page when its path is three slugs; otherwise the path as marked text. */
function TargetPathLink({ target }: { readonly target: TargetSummary }): ReactNode {
  const Link = useLinkComponent()
  const href = targetHrefOf(target.path)
  const parts = targetPathParts(target.path)
  const name = <UntrustedName name={target.path} mono label={t('fleet.attention.column.target')} />
  if (href === undefined || parts === undefined) return name
  return (
    <Link
      href={href}
      className="underline focus-ring"
      aria-label={t('targets.open', { target: target.path })}
    >
      {name}
    </Link>
  )
}

function ShowAll({ worst }: { readonly worst: HealthFilter | undefined }): ReactNode {
  const Link = useLinkComponent()
  if (worst === undefined) return null
  const word = HEALTH_WORD[worst]
  return (
    <p className="text-sm">
      <Link href={`/targets?health=${worst}`} className="underline focus-ring">
        {worst === 'none' || word === undefined
          ? t('fleet.attention.showAll.none')
          : t('fleet.attention.showAll', { state: t(word).toLowerCase() })}
      </Link>
    </p>
  )
}
