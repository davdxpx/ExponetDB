import type { OperationRead } from '@exponetdb/sdk/operations'
import { cn } from '@exponetdb/ui'
import {
  LinkCard,
  ObservedTime,
  ReadableView,
  TierChip,
  UntrustedName,
  useLinkComponent,
} from '@exponetdb/ui-patterns'
import { queryOptions, useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import type { ApiClient } from '../../lib/api/client.ts'
import { useApi } from '../../lib/api/context.tsx'
import { t } from '../../lib/i18n/i18n.ts'
import { toReadable } from '../../lib/query/readable.ts'
import { operationPath, stateTextKey } from '../changes/model.ts'
import { FLEET_POLL_MS, fleetKeys } from './keys.ts'
import { OPERATIONS_PATH } from './links.ts'

/** The operations the overview lists as stopped for a person. */
export const WORK_LIMIT = 5

export function workQueueQuery(client: ApiClient) {
  return queryOptions({
    queryKey: fleetKeys.work,
    queryFn: ({ signal }) =>
      client.operation('listOperations', {
        query: { state: 'needs_attention', limit: WORK_LIMIT },
        signal,
      }),
    refetchInterval: FLEET_POLL_MS,
  })
}

/**
 * The operations that stopped and wait for a person (`needs_attention`), newest first, each a
 * whole-row link to its operation page, where the next action is. Nothing runs again by itself
 * (C-14); this list only makes the work findable. One request of five, whatever the fleet's size.
 */
export function WorkQueue({ className }: { readonly className?: string }): ReactNode {
  const { client } = useApi()
  const Link = useLinkComponent()
  const work = useQuery(workQueueQuery(client))
  return (
    <section aria-labelledby="fleet-work" className={cn('flex min-w-0 flex-col gap-3', className)}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="fleet-work" className="m-0 text-base font-medium">
          {t('fleet.work.title')}
        </h2>
        <Link
          href={`${OPERATIONS_PATH}?state=needs_attention`}
          className="text-sm text-foreground-light hover:text-foreground focus-ring"
        >
          {t('fleet.operations.attention.link')}
        </Link>
      </div>
      <ReadableView
        readable={toReadable(work, {
          missing: (value) => (value.nextCursor === null ? undefined : [t('fleet.work.more')]),
        })}
        what={t('fleet.work.what')}
        onRetry={() => void work.refetch()}
        onRefresh={() => void work.refetch()}
        busy={work.isFetching}
        headingLevel={3}
        empty={{
          isEmpty: (value) => value.items.length === 0,
          content: <p className="m-0 text-sm text-foreground-light">{t('fleet.work.empty')}</p>,
        }}
        ready={(value) => <WorkRows items={value.items} />}
      />
    </section>
  )
}

function WorkRows({ items }: { readonly items: readonly OperationRead[] }): ReactNode {
  return (
    <ul aria-label={t('fleet.work.caption')} className="m-0 flex list-none flex-col gap-1.5 p-0">
      {items.map((operation) => {
        const href = operationPath(operation.id)
        const stateKey = stateTextKey(operation.state)
        const subject =
          operation.subject.targetPath ??
          operation.subject.targetId ??
          operation.subject.clusterId ??
          operation.subject.nodeId
        const body = (
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            <UntrustedName
              name={operation.kind}
              mono
              expandable={false}
              label={t('changes.column.kind')}
            />
            {subject === null ? null : (
              <UntrustedName
                name={subject}
                mono
                expandable={false}
                className="text-xs text-foreground-light"
                label={t('changes.column.target')}
              />
            )}
            {operation.subject.tier === null ? null : <TierChip tier={operation.subject.tier} />}
            <span className="ml-auto flex items-center gap-2 text-xs text-foreground-light">
              <span data-state={operation.state}>
                {stateKey === undefined ? operation.state : t(stateKey)}
              </span>
              <ObservedTime observedAt={operation.updatedAt} />
            </span>
          </span>
        )
        return (
          <li key={operation.id} data-operation={operation.id}>
            {href === undefined ? (
              <div className="rounded-lg border bg-surface-100 px-3 py-2">{body}</div>
            ) : (
              <LinkCard
                href={href}
                bare
                tone="critical"
                aria-label={t('fleet.work.open', { id: operation.id })}
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
