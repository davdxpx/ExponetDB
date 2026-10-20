import type { HealthCondition } from '@exponetdb/sdk/operations'
import { ObservedTime, type Readable, SourceLabel } from '@exponetdb/ui-patterns'
import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import type { ResponseOf } from '../../lib/api/client.ts'
import { useApi } from '../../lib/api/context.tsx'
import { t } from '../../lib/i18n/i18n.ts'
import { isNodeId, nodeQuery } from '../infrastructure/keys.ts'
import { formatBytes } from '../schema/schema-model.ts'
import { readSourceOf } from '../target/gate.ts'
import { nounPhrase } from '../target/phrases.ts'
import type { Target, TargetHealth } from '../target/queries.ts'
import { ReadSection } from '../target-ops/read-section.tsx'

type Placement = NonNullable<Target['placement']>
type Node = ResponseOf<'getNode'>

const SEVERITY_KEYS = {
  info: 'overview.health.severity.info',
  warning: 'overview.health.severity.warning',
  critical: 'overview.health.severity.critical',
} as const

/** The severity the server gave `disk_high`, when the health sample carries it; the page judges no percentage itself. */
function diskSeverity(health: TargetHealth): HealthCondition['severity'] | undefined {
  let worst: HealthCondition['severity'] | undefined
  const rank = { info: 0, warning: 1, critical: 2 } as const
  for (const condition of health.conditions) {
    if (condition.condition !== 'disk_high') continue
    if (worst === undefined || rank[condition.severity] > rank[worst]) worst = condition.severity
  }
  return worst
}

/**
 * The value of the "Host" row of the target facts: what the node agent of an
 * agent-managed placement reports about its host (load, memory and disk),
 * with the source and age of the report. The node comes from the health
 * read's companion (`node.nodeId`); the values from `GET /nodes/{id}`.
 *
 * Each case says what it is:
 * - an external cluster has no agent: "not reported", a fact of the
 *   placement, not an error;
 * - a health read that failed, or is running, cannot name the node: said so,
 *   and that this does not mean the host is fine;
 * - an agent placement without a bound node, a node that has reported no
 *   host values, and a node read that failed or is old are each their own
 *   state, never a zero.
 */
export function HostValue(props: {
  readonly placement: Placement
  readonly health: Readable<TargetHealth>
}): ReactNode {
  const { placement, health } = props
  if (placement.managementMode !== 'agent') {
    return <span data-slot="host-external">{t('overview.host.external')}</span>
  }
  switch (health.state) {
    case 'loading':
      return <span data-slot="host-locating">{t('overview.host.locating')}</span>
    case 'failed':
      return (
        <span data-slot="host-not-located">
          {t('overview.host.healthFailed', {
            reason: t('error.withCode', {
              message: health.error.message,
              code: health.error.code,
            }),
          })}
        </span>
      )
    default: {
      const node = health.value.node
      if (node === null) return <span data-slot="host-no-node">{t('overview.host.noNode')}</span>
      if (!isNodeId(node.nodeId)) {
        return <span data-slot="host-bad-node">{t('overview.host.badNode')}</span>
      }
      return <HostNode nodeId={node.nodeId} disk={diskSeverity(health.value)} />
    }
  }
}

function HostNode(props: {
  readonly nodeId: string
  readonly disk: HealthCondition['severity'] | undefined
}): ReactNode {
  const { client } = useApi()
  const query = useQuery(nodeQuery(client, props.nodeId))
  return (
    <ReadSection
      query={query}
      what={nounPhrase('overview.host.what')}
      permission="nodes.read"
      ready={(node) => <HostFacts node={node} disk={props.disk} />}
    />
  )
}

function HostFacts(props: {
  readonly node: Node
  readonly disk: HealthCondition['severity'] | undefined
}): ReactNode {
  const { node } = props
  const source = readSourceOf(node.source)
  const host = node.host
  return (
    <span className="flex flex-col gap-1" data-slot="host" data-node-state={node.state}>
      {host === null ? (
        <span data-slot="host-none">{t('overview.host.notReported')}</span>
      ) : (
        <span data-slot="host-values">
          {t('overview.host.value', {
            load: host.loadAverage1m.toFixed(2),
            memory: formatBytes(host.memoryUsedBytes),
            disk: host.diskUsedPercent.toFixed(0),
          })}
          {props.disk === undefined ? null : (
            <span className="text-foreground-light" data-slot="host-disk-condition">
              {' '}
              {t('overview.host.diskCondition', { severity: t(SEVERITY_KEYS[props.disk]) })}
            </span>
          )}
        </span>
      )}
      <span className="flex flex-wrap items-center gap-2 text-xs text-foreground-light">
        {source === undefined ? null : <SourceLabel source={source} />}
        <span>
          {host === null ? t('overview.host.checked') : t('overview.host.reported')}{' '}
          <ObservedTime observedAt={node.observedAt} seconds />
        </span>
        {node.state === 'active' ? null : (
          <span data-slot="host-node-state">
            {t('overview.host.nodeState', { state: node.state })}
          </span>
        )}
      </span>
    </span>
  )
}
