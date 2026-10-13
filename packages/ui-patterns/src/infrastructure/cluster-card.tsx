import type { ReactNode } from 'react'

import { type HealthState, StateBadge } from '../badges/state-badge.tsx'
import type { ReadSource } from '../readable.ts'
import { KeyValueList } from '../records/key-value-list.tsx'
import { formatCount, type NowInput } from '../states/format.ts'
import type { HeadingLevel } from '../states/heading.tsx'
import { UntrustedName } from '../untrusted/untrusted-name.tsx'
import { InfraCard } from './infra-card.tsx'

export interface ClusterCardProps {
  /** The cluster's name. Shown as untrusted text. */
  name: string
  /** The PostgreSQL version, as the cluster reported it: `16.4`. Shown as untrusted text. */
  postgresVersion: string
  /** The cluster's role: `primary`, `replica`. Shown as untrusted text. */
  clusterRole: string
  /** How many placements (database placements on this cluster) it holds. */
  placements: number
  /** The health of the cluster; with `source` and `observedAt` the badge explains itself on hover and focus. */
  state?: HealthState
  source?: ReadSource
  observedAt?: string
  now?: NowInput
  headingLevel?: HeadingLevel
  className?: string
}

/** A cluster at a glance: its name and health, PostgreSQL version, role and the number of placements. */
export function ClusterCard({
  name,
  postgresVersion,
  clusterRole,
  placements,
  state,
  source,
  observedAt,
  now,
  headingLevel,
  className,
}: ClusterCardProps): ReactNode {
  return (
    <InfraCard
      title={<UntrustedName name={name} label="cluster name" />}
      headingLevel={headingLevel}
      className={className}
      status={
        state === undefined ? undefined : (
          <StateBadge state={state} source={source} observedAt={observedAt} now={now} />
        )
      }
    >
      <KeyValueList
        items={[
          {
            id: 'postgres-version',
            label: 'PostgreSQL version',
            value: <UntrustedName name={postgresVersion} mono label="PostgreSQL version" />,
          },
          { id: 'role', label: 'Role', value: <UntrustedName name={clusterRole} label="role" /> },
          { id: 'placements', label: 'Placements', value: formatCount(placements) },
        ]}
      />
    </InfraCard>
  )
}
