import { KeyValueList, ReadableView, TierChip, UntrustedName } from '@exponetdb/ui-patterns'
import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useApi } from '../../lib/api/context.tsx'
import { t } from '../../lib/i18n/i18n.ts'
import { classifyFailure } from '../../lib/query/errors.ts'
import { toReadable } from '../../lib/query/readable.ts'
import { NotFoundPage } from '../../shell/not-found.tsx'
import { EnrollmentTokens, EnrollNodeButton } from './enrollment.tsx'
import { clustersQuery, isServerId, nodesQuery, serverQuery } from './keys.ts'
import { clusterPath, nodePath } from './model.ts'
import { InfraPage, InfraSection, NodeStateBadge, ObjectLink } from './parts.tsx'
import { ProviderName } from './provider.tsx'
import { RetiredBadge, RetirementSection } from './retirement.tsx'
import { ServerFacts } from './servers-page.tsx'

/**
 * `/infrastructure/servers/<srv_…>`: one server (`GET /servers/{id}`), the
 * nodes and clusters registered on it (from the node and cluster lists), and
 * its enrollment: "Plan enrollment" and the tokens the person may reveal.
 * An id outside the grammar, or a server the person cannot see, is "page not
 * found" without a request.
 */
export function ServerDetailPage({ serverId }: { readonly serverId: string }): ReactNode {
  if (!isServerId(serverId)) return <NotFoundPage />
  return <ServerDetail serverId={serverId} />
}

function ServerDetail({ serverId }: { readonly serverId: string }): ReactNode {
  const { client } = useApi()
  const server = useQuery(serverQuery(client, serverId))
  const nodes = useQuery(nodesQuery(client))
  const clusters = useQuery(clustersQuery(client))
  if (server.isError && classifyFailure(server.error).kind === 'not_found') return <NotFoundPage />
  const value = server.data
  return (
    <InfraPage
      title={
        value === undefined ? (
          t('infra.server.title')
        ) : (
          <span className="inline-flex flex-wrap items-center gap-2">
            <UntrustedName name={value.displayName} label={t('infra.column.name')} />
            {value.state === 'retired' ? <RetiredBadge /> : null}
          </span>
        )
      }
      description={t('infra.server.description')}
      production={value !== undefined && value.derivedTier === 'prod'}
    >
      <InfraSection id="server-facts" title={t('infra.server.facts.title')}>
        <ReadableView
          readable={toReadable(server)}
          what={t('infra.server.what')}
          onRetry={() => void server.refetch()}
          onRefresh={() => void server.refetch()}
          busy={server.isFetching}
          headingLevel={3}
          ready={(s) => (
            <KeyValueList
              items={[
                {
                  id: 'id',
                  label: t('infra.column.id'),
                  value: <code className="font-mono text-xs">{s.id}</code>,
                },
                {
                  id: 'provider',
                  label: t('infra.servers.column.provider'),
                  value: <ProviderName provider={s.provider} />,
                },
                {
                  id: 'location',
                  label: t('infra.servers.column.location'),
                  value:
                    s.location === null ? (
                      t('infra.value.none')
                    ) : (
                      <UntrustedName name={s.location} label={t('infra.servers.column.location')} />
                    ),
                },
                {
                  id: 'tier',
                  label: t('infra.column.tier'),
                  value:
                    s.derivedTier === null ? (
                      t('infra.tier.noneDerived')
                    ) : (
                      <TierChip tier={s.derivedTier} />
                    ),
                },
                {
                  id: 'facts',
                  label: t('infra.servers.column.facts'),
                  value: <ServerFacts server={s} />,
                },
              ]}
            />
          )}
        />
      </InfraSection>
      <InfraSection id="server-nodes" title={t('infra.server.nodes.title')}>
        <ReadableView
          readable={toReadable(nodes, {
            missing: (v) =>
              v.nextCursor === null ? undefined : [t('infra.list.more', { count: 200 })],
          })}
          what={t('infra.nodes.what')}
          onRetry={() => void nodes.refetch()}
          onRefresh={() => void nodes.refetch()}
          busy={nodes.isFetching}
          headingLevel={3}
          empty={{
            isEmpty: (v) => v.items.every((node) => node.serverId !== serverId),
            content: (
              <p className="text-sm text-foreground-light">{t('infra.server.nodes.none')}</p>
            ),
          }}
          ready={(v) => (
            <ul className="flex flex-col gap-2">
              {v.items
                .filter((node) => node.serverId === serverId)
                .map((node) => (
                  <li key={node.id} className="flex flex-wrap items-center gap-3 text-sm">
                    <ObjectLink
                      href={nodePath(node.id)}
                      text={node.id}
                      label={t('infra.column.id')}
                    />
                    <NodeStateBadge state={node.state} />
                  </li>
                ))}
            </ul>
          )}
        />
      </InfraSection>
      <InfraSection id="server-clusters" title={t('infra.server.clusters.title')}>
        <ReadableView
          readable={toReadable(clusters, {
            missing: (v) =>
              v.nextCursor === null ? undefined : [t('infra.list.more', { count: 200 })],
          })}
          what={t('infra.clusters.what')}
          onRetry={() => void clusters.refetch()}
          onRefresh={() => void clusters.refetch()}
          busy={clusters.isFetching}
          headingLevel={3}
          empty={{
            isEmpty: (v) => v.items.every((cluster) => cluster.serverId !== serverId),
            content: (
              <p className="text-sm text-foreground-light">{t('infra.server.clusters.none')}</p>
            ),
          }}
          ready={(v) => (
            <ul className="flex flex-col gap-2">
              {v.items
                .filter((cluster) => cluster.serverId === serverId)
                .map((cluster) => (
                  <li key={cluster.id} className="flex flex-wrap items-center gap-3 text-sm">
                    <UntrustedName name={cluster.displayName} label={t('infra.column.name')} />
                    <ObjectLink
                      href={clusterPath(cluster.id)}
                      text={cluster.id}
                      label={t('infra.column.id')}
                    />
                  </li>
                ))}
            </ul>
          )}
        />
      </InfraSection>
      {value?.state === 'retired' ? null : (
        <InfraSection
          id="server-enroll"
          title={t('infra.enroll.title')}
          description={t('infra.enroll.description')}
        >
          <EnrollNodeButton serverId={serverId} />
          <EnrollmentTokens serverId={serverId} />
        </InfraSection>
      )}
      {value === undefined ? null : (
        <InfraSection
          id="server-retire"
          title={t('infra.retire.title')}
          description={t('infra.retire.description')}
        >
          <RetirementSection
            subject={{
              kind: 'server',
              id: value.id,
              state: value.state ?? 'active',
              retiredAt: value.retiredAt ?? null,
              // A server that may host production is production (registry.md §4.1).
              tier: value.derivedTier === 'nonprod' ? 'nonprod' : 'prod',
            }}
          />
        </InfraSection>
      )}
    </InfraPage>
  )
}
