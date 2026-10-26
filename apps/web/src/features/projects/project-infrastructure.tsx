import { Network, Server } from '@exponetdb/icons'
import { cn } from '@exponetdb/ui'
import {
  formatCount,
  LinkCard,
  LoadingState,
  ReadableView,
  UntrustedName,
} from '@exponetdb/ui-patterns'
import { useQueries, useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import type { ResponseOf } from '../../lib/api/client.ts'
import { useApi } from '../../lib/api/context.tsx'
import { t } from '../../lib/i18n/i18n.ts'
import { toReadable } from '../../lib/query/readable.ts'
import { clusterPath } from '../infrastructure/model.ts'
import { environmentsQuery, targetQuery } from '../target/keys.ts'
import { projectEnvironments } from './model.ts'

/** Targets whose placement the project page reads (each one cached read, shared with its pages). */
export const PLACEMENT_READS = 12

type Target = ResponseOf<'getTarget'>

export interface ClusterGroup {
  readonly clusterId: string
  readonly clusterName: string
  readonly serverName: string | null
  readonly managementMode: 'agent' | 'external'
  readonly postgresVersion: string | null
  readonly environments: readonly string[]
}

/** The clusters the environments are placed on, each with the environments it hosts. */
export function clusterGroups(targets: readonly Target[]): readonly ClusterGroup[] {
  const groups = new Map<string, ClusterGroup>()
  for (const target of targets) {
    const placement = target.placement
    if (placement === null) continue
    const environment = target.environment.slug
    const known = groups.get(placement.clusterId)
    groups.set(placement.clusterId, {
      clusterId: placement.clusterId,
      clusterName: placement.clusterName,
      serverName: placement.serverName,
      managementMode: placement.managementMode,
      postgresVersion: placement.postgresVersion,
      environments: [...(known?.environments ?? []), environment],
    })
  }
  return [...groups.values()].sort((a, b) => a.clusterName.localeCompare(b.clusterName))
}

/**
 * Where the project's environments run: the clusters (and their servers) the target records
 * name as placements, each a card that is a link to the cluster, with the environments it hosts.
 * A project is not a cluster: several environments may share one, and several clusters may serve
 * one project. The placements come from the target reads its pages make anyway (bounded to the
 * first twelve live environments, said when cut); a read that failed is counted, never dropped.
 */
export function ProjectInfrastructure({
  product,
  project,
  className,
}: {
  readonly product: string
  readonly project: string
  readonly className?: string
}): ReactNode {
  const { client } = useApi()
  const list = useQuery(environmentsQuery(client, product, project))
  const live = (
    list.data === undefined ? [] : projectEnvironments(list.data.items, product, project)
  ).filter((environment) => environment.target.state !== 'decommissioned')
  const paths = live.slice(0, PLACEMENT_READS).map((environment) => environment.target.path)
  const details = useQueries({ queries: paths.map((path) => targetQuery(client, path)) })
  const read = details.flatMap((query) => (query.data === undefined ? [] : [query.data]))
  const failed = details.filter((query) => query.isError && query.data === undefined).length
  const loading = details.some((query) => query.isPending)
  return (
    <section
      aria-labelledby="project-infra"
      className={cn('flex min-w-0 flex-col gap-3', className)}
    >
      <div className="flex flex-col gap-1">
        <h2 id="project-infra" className="m-0 text-base font-medium">
          {t('project.infra.title')}
        </h2>
        <p className="m-0 text-xs text-foreground-light">{t('project.infra.description')}</p>
      </div>
      <ReadableView
        readable={toReadable(list)}
        what={t('project.infra.what')}
        onRetry={() => void list.refetch()}
        onRefresh={() => void list.refetch()}
        busy={list.isFetching}
        headingLevel={3}
        ready={() =>
          loading ? (
            <LoadingState what={t('project.infra.what')} />
          ) : (
            <Placements
              groups={clusterGroups(read)}
              failed={failed}
              bounded={live.length > PLACEMENT_READS}
            />
          )
        }
      />
    </section>
  )
}

function Placements({
  groups,
  failed,
  bounded,
}: {
  readonly groups: readonly ClusterGroup[]
  readonly failed: number
  readonly bounded: boolean
}): ReactNode {
  return (
    <div className="flex flex-col gap-2">
      {groups.length === 0 && failed === 0 ? (
        <p className="m-0 text-sm text-foreground-light">{t('project.infra.none')}</p>
      ) : null}
      <ul aria-label={t('project.infra.title')} className="m-0 flex list-none flex-col gap-2 p-0">
        {groups.map((group) => {
          const href = clusterPath(group.clusterId)
          const body = (
            <>
              <span className="flex items-center gap-2 pr-6">
                <Network
                  aria-hidden="true"
                  strokeWidth={1.5}
                  className="size-4 text-foreground-light"
                />
                <UntrustedName
                  name={group.clusterName}
                  expandable={false}
                  maxCodePoints={64}
                  className="text-sm font-medium"
                />
                {group.postgresVersion === null ? null : (
                  <span className="font-mono text-xs text-foreground-lighter">
                    PostgreSQL {group.postgresVersion}
                  </span>
                )}
              </span>
              <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-foreground-light">
                <span className="inline-flex items-center gap-1">
                  <Server aria-hidden="true" strokeWidth={1.5} className="size-3.5" />
                  {group.serverName === null ? (
                    t('project.infra.noServer')
                  ) : (
                    <UntrustedName name={group.serverName} expandable={false} maxCodePoints={48} />
                  )}
                </span>
                <span>
                  {t(
                    group.managementMode === 'agent'
                      ? 'project.infra.mode.agent'
                      : 'project.infra.mode.external',
                  )}
                </span>
                <span className="font-mono">
                  {t('project.infra.environments', { list: group.environments.join(', ') })}
                </span>
              </span>
            </>
          )
          return (
            <li key={group.clusterId} data-cluster={group.clusterId}>
              {href === undefined ? (
                <div className="flex flex-col gap-2 rounded-lg border bg-surface-100 p-3">
                  {body}
                </div>
              ) : (
                // The card's name is its content (an untrusted name, rendered as marked text).
                <LinkCard href={href} className="gap-2 p-3">
                  {body}
                </LinkCard>
              )}
            </li>
          )
        })}
      </ul>
      {failed > 0 ? (
        <p className="m-0 text-xs text-foreground" role="status">
          {failed === 1
            ? t('project.infra.unreadOne')
            : t('project.infra.unread', { count: formatCount(failed) })}
        </p>
      ) : null}
      {bounded ? (
        <p className="m-0 text-xs text-foreground-lighter">
          {t('project.infra.bounded', { count: formatCount(PLACEMENT_READS) })}
        </p>
      ) : null}
    </div>
  )
}
