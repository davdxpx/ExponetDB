import { Alert, AlertDescription, Button } from '@exponetdb/ui'
import { type ReactNode, useId, useState } from 'react'

import { type HealthState, StateBadge } from '../badges/state-badge.tsx'
import type { ReadSource } from '../readable.ts'
import { KeyValueList } from '../records/key-value-list.tsx'
import { formatCount, type NowInput } from '../states/format.ts'
import type { HeadingLevel } from '../states/heading.tsx'
import { keyedStrings } from '../states/keyed.ts'
import { ObservedTime } from '../states/observed-time.tsx'
import { UntrustedName } from '../untrusted/untrusted-name.tsx'
import { InfraCard } from './infra-card.tsx'
import { versionRelation } from './version-skew.ts'

export interface NodeCardProps {
  /** The node's name or host name, as the node reported it. Shown as untrusted text. */
  name: string
  /** The agent version, as the agent reported it. Shown as untrusted text. */
  agentVersion: string
  /** The agent version ExponetDB expects. When it differs from `agentVersion`, a version skew warning is shown. */
  expectedAgentVersion?: string
  /** ISO 8601 time of the last heartbeat, or `null` when none was received. */
  lastHeartbeatAt: string | null
  /** The capability ids the agent reported. Shown as untrusted text. */
  capabilities: readonly string[]
  /** The health of the node; with `source` and `observedAt` the badge explains itself on hover and focus. */
  state?: HealthState
  source?: ReadSource
  observedAt?: string
  /** How many capabilities show before "Show all". Default 8. */
  maxCapabilities?: number
  now?: NowInput
  headingLevel?: HeadingLevel
  className?: string
}

const SKEW_WORDS = {
  older: 'which is older than',
  newer: 'which is newer than',
  different: 'which differs from',
} as const

function CapabilityList({
  capabilities,
  max,
}: {
  capabilities: readonly string[]
  max: number
}): ReactNode {
  const [showAll, setShowAll] = useState(false)
  const listId = useId()
  if (capabilities.length === 0) return <span>No capabilities reported</span>
  const limit = Math.max(1, Math.floor(max))
  const cut = !showAll && capabilities.length > limit
  const items = keyedStrings(cut ? capabilities.slice(0, limit) : capabilities)
  return (
    <>
      <ul id={listId} aria-label="Capabilities" className="flex flex-wrap gap-1.5">
        {items.map((item) => (
          <li key={item.key} className="rounded-sm border border-default px-1.5 py-0.5 text-xs">
            <UntrustedName name={item.text} mono maxCodePoints={48} label="capability" />
          </li>
        ))}
      </ul>
      {capabilities.length > limit && (
        <Button
          type="button"
          variant="link"
          size="tiny"
          className="mt-1"
          aria-controls={listId}
          onClick={() => setShowAll(!showAll)}
        >
          {showAll ? 'Show fewer' : `Show all (${formatCount(capabilities.length)} capabilities)`}
        </Button>
      )}
    </>
  )
}

/**
 * A node agent at a glance: its name and health, the agent version, the age of
 * the last heartbeat, the capabilities it reported, and a warning when the
 * version differs from the one ExponetDB expects. Everything the agent said
 * about itself is shown as untrusted text.
 */
export function NodeCard({
  name,
  agentVersion,
  expectedAgentVersion,
  lastHeartbeatAt,
  capabilities,
  state,
  source,
  observedAt,
  maxCapabilities = 8,
  now,
  headingLevel,
  className,
}: NodeCardProps): ReactNode {
  const relation =
    expectedAgentVersion === undefined
      ? 'same'
      : versionRelation(agentVersion, expectedAgentVersion)
  return (
    <InfraCard
      title={<UntrustedName name={name} label="node name" />}
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
            id: 'agent-version',
            label: 'Agent version',
            value: <UntrustedName name={agentVersion} mono label="agent version" />,
          },
          {
            id: 'heartbeat',
            label: 'Last heartbeat',
            value:
              lastHeartbeatAt === null ? (
                'No heartbeat received'
              ) : (
                <ObservedTime observedAt={lastHeartbeatAt} withDate seconds now={now} />
              ),
          },
          {
            id: 'capabilities',
            label: 'Capabilities',
            value: <CapabilityList capabilities={capabilities} max={maxCapabilities} />,
          },
        ]}
      />
      {relation !== 'same' && expectedAgentVersion !== undefined && (
        <Alert variant="warning" data-skew={relation} className="mt-3">
          <AlertDescription>
            <p>
              <strong>Version skew.</strong> The agent runs{' '}
              <UntrustedName name={agentVersion} mono label="agent version" />,{' '}
              {SKEW_WORDS[relation]} the expected{' '}
              <UntrustedName name={expectedAgentVersion} mono label="expected version" />.
            </p>
          </AlertDescription>
        </Alert>
      )}
    </InfraCard>
  )
}
