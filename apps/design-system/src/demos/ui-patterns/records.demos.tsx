import {
  type ChainVerification,
  ChainVerificationIndicator,
  EventRow,
  KeyValueList,
  MarkedCode,
  type Readable,
  StateBadge,
  TierChip,
  UntrustedName,
} from '@exponetdb/ui-patterns'
import type { DemoDefinition } from '../types.ts'
import { minutesAgo, NOW } from './clock.ts'
import { DemoLinks } from './demo-links.tsx'

const HASH = `sha256:${'3f9c'.repeat(16)}`

function chain(value: ChainVerification): Readable<ChainVerification> {
  return { state: 'ready', value, source: 'live', observedAt: minutesAgo(2) }
}

export const demos: readonly DemoDefinition[] = [
  {
    id: 'ui-patterns/key-value-list/plan-facts',
    title: 'Key-value list: the facts of one plan, with a copy button on the hash',
    render: () => (
      <KeyValueList
        items={[
          {
            id: 'target',
            label: 'Target',
            value: (
              <span className="inline-flex flex-wrap items-center gap-2">
                <MarkedCode text="shop/platform/production" />
                <TierChip tier="prod" />
              </span>
            ),
          },
          { id: 'kind', label: 'Change', value: 'migration.apply' },
          { id: 'class', label: 'Plan class', value: 'High' },
          {
            id: 'creator',
            label: 'Created by',
            value: <UntrustedName name="human #3" label="creator" />,
          },
          { id: 'hash', label: 'Plan hash', value: <MarkedCode text={HASH} />, copyText: HASH },
        ]}
      />
    ),
  },
  {
    id: 'ui-patterns/key-value-list/stacked',
    title: 'Key-value list, stacked: labels above their values for a narrow column',
    render: () => (
      <div className="max-w-xs">
        <KeyValueList
          layout="stacked"
          items={[
            { id: 'cluster', label: 'Cluster', value: <UntrustedName name="pg-main" mono /> },
            { id: 'health', label: 'Health', value: <StateBadge state="healthy" /> },
            { id: 'version', label: 'PostgreSQL version', value: '17.2' },
          ]}
        />
      </div>
    ),
  },
  {
    id: 'ui-patterns/event-row/outcomes',
    title: 'Event rows: the four outcomes, each with its own shape and word',
    render: () => (
      <DemoLinks>
        <ul className="m-0 list-none p-0">
          <EventRow
            as="li"
            actor="human #3"
            client="Web App"
            action="migrations.apply"
            subject="shop/platform/staging"
            outcome="succeeded"
            occurredAt={minutesAgo(5)}
            now={NOW}
            links={{ plan: '/changes/plans/pln_01', operation: '/changes/operations/op_01' }}
          />
          <EventRow
            as="li"
            actor="service #1"
            client="Deploy bot"
            action="migrations.apply"
            subject="shop/platform/production"
            outcome="failed"
            errorCode="PLAN_STALE"
            occurredAt={minutesAgo(35)}
            now={NOW}
            links={{ plan: '/changes/plans/pln_02' }}
          />
          <EventRow
            as="li"
            actor="agent #2"
            client="Coding assistant"
            action="plans.approve"
            subject="shop/platform/production"
            outcome="denied"
            errorCode="AGENT_CANNOT_APPROVE"
            occurredAt={minutesAgo(150)}
            now={NOW}
          />
          <EventRow
            as="li"
            actor="human #3"
            client="Web App"
            action="sessions.terminate"
            subject="shop/platform/production"
            outcome="pending"
            occurredAt={minutesAgo(1)}
            now={NOW}
          />
        </ul>
      </DemoLinks>
    ),
  },
  {
    id: 'ui-patterns/event-row/hostile-names',
    title: 'Event row with a hostile client and subject: marked as text, client not verified',
    render: () => (
      <EventRow
        actor="human #3"
        client={'Trusted\u{202E}tools\u{200B}'}
        action="schema.inspect"
        subject={'public.ord\u{200B}ers'}
        outcome="succeeded"
        occurredAt={minutesAgo(9)}
        now={NOW}
        // A link target that is not an app path is left out instead of being linked.
        links={{ plan: '//elsewhere.invalid/plan' }}
      />
    ),
  },
  {
    id: 'ui-patterns/chain-verification/verified',
    title: 'Chain verified up to a sequence, with the time of the check',
    render: () => (
      <ChainVerificationIndicator
        now={NOW}
        verification={chain({
          status: 'verified',
          throughSequence: 18204,
          verifiedAt: minutesAgo(3),
        })}
      />
    ),
  },
  {
    id: 'ui-patterns/chain-verification/broken',
    title: 'Chain broken at a sequence: announced at once',
    render: () => (
      <ChainVerificationIndicator
        now={NOW}
        verification={chain({ status: 'broken', atSequence: 9120, checkedAt: minutesAgo(1) })}
      />
    ),
  },
  {
    id: 'ui-patterns/chain-verification/not-checked',
    title: 'Chain not checked',
    render: () => (
      <ChainVerificationIndicator now={NOW} verification={chain({ status: 'not_checked' })} />
    ),
  },
  {
    id: 'ui-patterns/chain-verification/failed-read',
    title: 'A failed read of the verification is neither intact nor broken',
    render: () => (
      <ChainVerificationIndicator
        now={NOW}
        verification={{
          state: 'failed',
          error: { code: 'AUDIT_UNAVAILABLE', message: 'The audit store did not answer.' },
        }}
      />
    ),
  },
]
