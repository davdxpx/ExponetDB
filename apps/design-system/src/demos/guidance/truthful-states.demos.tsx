import { Button, Skeleton } from '@exponetdb/ui'
import {
  EmptyState,
  NotAvailableYetState,
  NotPermittedState,
  NotSupportedState,
  ObservedTime,
  ReadableView,
  SourceLabel,
  StateBadge,
} from '@exponetdb/ui-patterns'
import type { ReactNode } from 'react'
import type { DemoDefinition } from '../types.ts'
import { NOW, OBSERVED, OBSERVED_EARLIER } from './support.tsx'

function Targets({ names }: { readonly names: readonly string[] }): ReactNode {
  return (
    <ul className="m-0 list-disc pl-5 text-sm text-foreground">
      {names.map((name) => (
        <li key={name} className="font-mono text-xs">
          {name}
        </li>
      ))}
    </ul>
  )
}

const NAMES: readonly string[] = ['shop/platform/production', 'shop/platform/staging']

/** The skeleton has the shape of the list it stands for, so the page does not jump. */
const TARGET_SKELETON = (
  <div className="flex flex-col gap-2">
    <Skeleton className="h-4 w-56" />
    <Skeleton className="h-4 w-48" />
  </div>
)

export const demos: readonly DemoDefinition[] = [
  {
    id: 'guidance/truthful-states/loading',
    title: 'Loading: a skeleton in the shape of the list, no numbers',
    render: () => (
      <ReadableView<readonly string[]>
        readable={{ state: 'loading' }}
        what="target list"
        loading={TARGET_SKELETON}
        ready={(names) => <Targets names={names} />}
      />
    ),
  },
  {
    id: 'guidance/truthful-states/ready',
    title: 'Ready: the value with its source and its age',
    render: () => (
      <ReadableView
        readable={{ state: 'ready', value: NAMES, source: 'live', observedAt: OBSERVED }}
        what="target list"
        now={NOW}
        ready={(names, meta) => (
          <div className="flex flex-col gap-3">
            <Targets names={names} />
            <p className="m-0 flex items-center gap-2 text-xs text-foreground-lighter">
              <SourceLabel source={meta.source} />
              <span>
                Observed <ObservedTime observedAt={meta.observedAt} now={NOW} />
              </span>
            </p>
          </div>
        )}
      />
    ),
  },
  {
    id: 'guidance/truthful-states/empty',
    title: 'Empty: only after a read that succeeded and found nothing',
    render: () => (
      <ReadableView<readonly string[]>
        readable={{ state: 'ready', value: [], source: 'live', observedAt: OBSERVED }}
        what="target list"
        now={NOW}
        empty={{
          isEmpty: (names) => names.length === 0,
          content: (
            <EmptyState
              title="No targets registered"
              description="The read succeeded and found no targets. Register a target to manage its database."
            >
              <Button variant="primary">Register target</Button>
            </EmptyState>
          ),
        }}
        ready={(names) => <Targets names={names} />}
      />
    ),
  },
  {
    id: 'guidance/truthful-states/failed',
    title: 'Failed: what failed, the stable code, a retry. Never an empty list',
    render: () => (
      <ReadableView<readonly string[]>
        readable={{
          state: 'failed',
          error: {
            code: 'CONTROL_PLANE_DEGRADED',
            message: 'ExponetDB could not reach its own database.',
          },
        }}
        what="target list"
        now={NOW}
        onRetry={() => undefined}
        empty={{ isEmpty: (names) => names.length === 0 }}
        ready={(names) => <Targets names={names} />}
      />
    ),
  },
  {
    id: 'guidance/truthful-states/stale',
    title: 'Stale: the earlier value stays, under a banner with its age and the reason',
    render: () => (
      <ReadableView
        readable={{
          state: 'stale',
          value: NAMES,
          source: 'cached',
          observedAt: OBSERVED_EARLIER,
          error: {
            code: 'CONTROL_PLANE_DEGRADED',
            message: 'ExponetDB could not reach its own database.',
          },
        }}
        what="target list"
        now={NOW}
        onRefresh={() => undefined}
        ready={(names) => <Targets names={names} />}
      />
    ),
  },
  {
    id: 'guidance/truthful-states/partial',
    title: 'Partial: the part that was read, and what is missing and why',
    render: () => (
      <ReadableView
        readable={{
          state: 'partial',
          value: NAMES,
          source: 'live',
          observedAt: OBSERVED,
          missing: ['shop/billing/production: its node agent did not answer.'],
        }}
        what="target list"
        now={NOW}
        empty={{ isEmpty: (names) => names.length === 0 }}
        ready={(names) => <Targets names={names} />}
      />
    ),
  },
  {
    id: 'guidance/truthful-states/named-states',
    title: 'Not available yet, not permitted and not supported are named states',
    render: () => (
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <NotAvailableYetState
          what="Backups"
          reason="Backup pages arrive in a later release. Until then this page shows no data."
          headingLevel={4}
          className="py-6"
        />
        <NotPermittedState
          what="approvals"
          permission="plans.approve"
          scope="plans.approve:prod"
          headingLevel={4}
          className="py-6"
        />
        <NotSupportedState
          feature="Logical replication slots"
          requires="PostgreSQL 15 or later"
          found="PostgreSQL 14.9"
          headingLevel={4}
          className="py-6"
        />
      </div>
    ),
  },
  {
    id: 'guidance/truthful-states/health-badges',
    title: 'Health badges: a shape and a word each, and unknown is never green',
    render: () => (
      <ul className="m-0 flex list-none flex-wrap gap-3 p-0">
        {(['healthy', 'degraded', 'unhealthy', 'unknown', 'stale'] as const).map((state) => (
          <li key={state}>
            <StateBadge
              state={state}
              source={state === 'unknown' ? 'inferred' : 'sampled'}
              observedAt={OBSERVED}
              now={NOW}
            />
          </li>
        ))}
      </ul>
    ),
  },
]
