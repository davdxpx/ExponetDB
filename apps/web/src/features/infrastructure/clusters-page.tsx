import type { Cluster } from '@exponetdb/sdk/operations'
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@exponetdb/ui'
import { StateBadge, TierChip, UntrustedName } from '@exponetdb/ui-patterns'
import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useApi } from '../../lib/api/context.tsx'
import { t } from '../../lib/i18n/i18n.ts'
import { toReadable } from '../../lib/query/readable.ts'
import { ListView } from '../access/list-view.tsx'
import { clustersQuery } from './keys.ts'
import { clusterPath, serverPath } from './model.ts'
import { InfraPage, InfraSection, ObjectLink } from './parts.tsx'

/**
 * `/infrastructure/clusters`: the PostgreSQL clusters of the registry
 * (`GET /clusters`, `nodes.read`) with their management mode, state,
 * version, derived and declared tier (an undeclared cluster is treated as
 * production for registry authority, OD-22) and health with its source.
 */
export function ClustersPage(): ReactNode {
  const { client } = useApi()
  const list = useQuery(clustersQuery(client))
  return (
    <InfraPage title={t('infra.clusters.title')} description={t('infra.clusters.description')}>
      <InfraSection id="clusters" title={t('infra.clusters.list.title')}>
        <ListView
          readable={toReadable(list, {
            missing: (value) =>
              value.nextCursor === null ? undefined : [t('infra.list.more', { count: 200 })],
          })}
          error={list.error}
          what={t('infra.clusters.what')}
          permission="nodes.read"
          isEmpty={(value) => value.items.length === 0}
          emptyTitle={t('infra.clusters.empty.title')}
          emptyDescription={t('infra.clusters.empty.description')}
          onRetry={() => void list.refetch()}
          busy={list.isFetching}
        >
          {(value) => (value.items.length === 0 ? null : <ClusterTable clusters={value.items} />)}
        </ListView>
      </InfraSection>
    </InfraPage>
  )
}

/** The declared tier: a chip, or "undeclared, treated as production". */
export function DeclaredTier({ cluster }: { readonly cluster: Cluster }): ReactNode {
  const declared = cluster.declaredTier ?? null
  if (declared === null) {
    return (
      <span data-declared="undeclared" className="text-sm">
        {t('infra.cluster.tier.undeclared')}
      </span>
    )
  }
  return (
    <span data-declared={declared}>
      <TierChip tier={declared} />
    </span>
  )
}

/** A cluster's health: the badge with its source and time, or "not known" (never green). */
export function ClusterHealth({ cluster }: { readonly cluster: Cluster }): ReactNode {
  const health = cluster.health
  if (health === null) {
    return <StateBadge state="unknown" />
  }
  const state =
    health.state === 'healthy'
      ? 'healthy'
      : health.state === 'degraded'
        ? 'degraded'
        : health.state === 'unhealthy' || health.state === 'unreachable'
          ? 'unhealthy'
          : 'unknown'
  const source =
    health.source === 'live' ||
    health.source === 'sampled' ||
    health.source === 'cached' ||
    health.source === 'agent_reported' ||
    health.source === 'inferred'
      ? health.source
      : undefined
  return (
    <StateBadge
      state={state}
      observedAt={health.observedAt}
      {...(source === undefined ? {} : { source })}
    />
  )
}

function ClusterTable({ clusters }: { readonly clusters: readonly Cluster[] }): ReactNode {
  return (
    <Table>
      <TableCaption className="sr-only">{t('infra.clusters.caption')}</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">{t('infra.column.name')}</TableHead>
          <TableHead scope="col">{t('infra.column.id')}</TableHead>
          <TableHead scope="col">{t('infra.clusters.column.mode')}</TableHead>
          <TableHead scope="col">{t('infra.clusters.column.state')}</TableHead>
          <TableHead scope="col">{t('infra.clusters.column.version')}</TableHead>
          <TableHead scope="col">{t('infra.clusters.column.server')}</TableHead>
          <TableHead scope="col">{t('infra.clusters.column.derived')}</TableHead>
          <TableHead scope="col">{t('infra.clusters.column.declared')}</TableHead>
          <TableHead scope="col">{t('infra.clusters.column.health')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {clusters.map((cluster) => (
          <TableRow key={cluster.id} data-cluster={cluster.id}>
            <TableCell>
              <UntrustedName name={cluster.displayName} label={t('infra.column.name')} />
            </TableCell>
            <TableCell>
              <ObjectLink
                href={clusterPath(cluster.id)}
                text={cluster.id}
                label={t('infra.column.id')}
              />
            </TableCell>
            <TableCell>{t(`infra.cluster.mode.${cluster.managementMode}`)}</TableCell>
            <TableCell>{t(`infra.cluster.state.${cluster.state}`)}</TableCell>
            <TableCell>
              {cluster.postgresVersion === null ? (
                t('infra.value.notKnown')
              ) : (
                <UntrustedName
                  name={cluster.postgresVersion}
                  mono
                  label={t('infra.clusters.column.version')}
                />
              )}
            </TableCell>
            <TableCell>
              {cluster.serverId === null ? (
                t('infra.value.none')
              ) : (
                <ObjectLink
                  href={serverPath(cluster.serverId)}
                  text={cluster.serverId}
                  label={t('infra.clusters.column.server')}
                />
              )}
            </TableCell>
            <TableCell>
              {cluster.derivedTier === null ? (
                t('infra.tier.noneDerived')
              ) : (
                <TierChip tier={cluster.derivedTier} />
              )}
            </TableCell>
            <TableCell>
              <DeclaredTier cluster={cluster} />
            </TableCell>
            <TableCell>
              <ClusterHealth cluster={cluster} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
