import type { Node } from '@exponetdb/sdk/operations'
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@exponetdb/ui'
import { ObservedTime, UntrustedName } from '@exponetdb/ui-patterns'
import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useApi } from '../../lib/api/context.tsx'
import { t } from '../../lib/i18n/i18n.ts'
import { toReadable } from '../../lib/query/readable.ts'
import { ListView } from '../access/list-view.tsx'
import { EnrollmentTokens } from './enrollment.tsx'
import { nodesQuery } from './keys.ts'
import { nodePath, serverPath } from './model.ts'
import { ClockSkew, InfraPage, InfraSection, NodeStateBadge, ObjectLink } from './parts.tsx'

/**
 * `/infrastructure/nodes`: the node agents (`GET /nodes`, `nodes.read`) with
 * their state, agent version, last heartbeat and its age, clock skew and
 * capability count; and the enrollment tokens the person may reveal. A node
 * is enrolled from its server's page ("Plan enrollment").
 */
export function NodesPage(): ReactNode {
  const { client } = useApi()
  const list = useQuery(nodesQuery(client))
  return (
    <InfraPage title={t('infra.nodes.title')} description={t('infra.nodes.description')}>
      <InfraSection id="nodes" title={t('infra.nodes.list.title')}>
        <ListView
          readable={toReadable(list, {
            missing: (value) =>
              value.nextCursor === null ? undefined : [t('infra.list.more', { count: 200 })],
          })}
          error={list.error}
          what={t('infra.nodes.what')}
          permission="nodes.read"
          isEmpty={(value) => value.items.length === 0}
          emptyTitle={t('infra.nodes.empty.title')}
          emptyDescription={t('infra.nodes.empty.description')}
          onRetry={() => void list.refetch()}
          busy={list.isFetching}
        >
          {(value) => (value.items.length === 0 ? null : <NodeTable nodes={value.items} />)}
        </ListView>
      </InfraSection>
      <InfraSection
        id="node-enrollments"
        title={t('infra.enroll.tokens.title')}
        description={t('infra.enroll.description')}
      >
        <EnrollmentTokens />
      </InfraSection>
    </InfraPage>
  )
}

function NodeTable({ nodes }: { readonly nodes: readonly Node[] }): ReactNode {
  return (
    <Table>
      <TableCaption className="sr-only">{t('infra.nodes.caption')}</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">{t('infra.column.id')}</TableHead>
          <TableHead scope="col">{t('infra.nodes.column.server')}</TableHead>
          <TableHead scope="col">{t('infra.nodes.column.state')}</TableHead>
          <TableHead scope="col">{t('infra.nodes.column.version')}</TableHead>
          <TableHead scope="col">{t('infra.nodes.column.heartbeat')}</TableHead>
          <TableHead scope="col">{t('infra.nodes.column.skew')}</TableHead>
          <TableHead scope="col">{t('infra.nodes.column.capabilities')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {nodes.map((node) => (
          <TableRow key={node.id} data-node={node.id}>
            <TableCell>
              <ObjectLink href={nodePath(node.id)} text={node.id} label={t('infra.column.id')} />
            </TableCell>
            <TableCell>
              <ObjectLink
                href={serverPath(node.serverId)}
                text={node.serverId}
                label={t('infra.nodes.column.server')}
              />
            </TableCell>
            <TableCell>
              <NodeStateBadge state={node.state} />
            </TableCell>
            <TableCell>
              {node.agentVersion === null ? (
                t('infra.node.version.none')
              ) : (
                <UntrustedName
                  name={node.agentVersion}
                  mono
                  label={t('infra.nodes.column.version')}
                />
              )}
            </TableCell>
            <TableCell>
              {node.lastHeartbeatAt === null ? (
                t('infra.node.heartbeat.none')
              ) : (
                <ObservedTime observedAt={node.lastHeartbeatAt} withDate seconds />
              )}
            </TableCell>
            <TableCell>
              <ClockSkew skewMs={node.clockSkewMs} />
            </TableCell>
            <TableCell>
              {t('infra.node.capabilities.count', { count: node.capabilities.length })}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
