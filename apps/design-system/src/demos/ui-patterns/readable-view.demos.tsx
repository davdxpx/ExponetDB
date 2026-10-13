import { Skeleton } from '@exponetdb/ui'
import { ObservedTime, ReadableView } from '@exponetdb/ui-patterns'
import type { DemoDefinition } from '../types.ts'

// A fixed clock keeps the demos deterministic for the visual-regression host.
const NOW = '2026-10-13T12:00:00.000Z'
const OBSERVED = '2026-10-13T11:52:00.000Z'

function Targets({ names }: { readonly names: readonly string[] }) {
  return (
    <ul className="list-disc pl-5 text-sm">
      {names.map((name) => (
        <li key={name}>{name}</li>
      ))}
    </ul>
  )
}

export const demos: readonly DemoDefinition[] = [
  {
    id: 'ui-patterns/readable-view/ready',
    title: 'A ready read with its source and age',
    render: () => (
      <ReadableView
        readable={{
          state: 'ready',
          value: ['shop/platform/staging', 'shop/platform/production'],
          source: 'live',
          observedAt: OBSERVED,
        }}
        what="targets"
        now={NOW}
        ready={(names) => <Targets names={names} />}
      />
    ),
  },
  {
    id: 'ui-patterns/readable-view/failed',
    title: 'A failed read is never an empty list',
    render: () => (
      <ReadableView
        readable={{
          state: 'failed',
          error: { code: 'TARGET_UNREACHABLE', message: 'The target did not answer in time.' },
        }}
        what="targets"
        now={NOW}
        onRetry={() => undefined}
        ready={(names: readonly string[]) => <Targets names={names} />}
      />
    ),
  },
  {
    id: 'ui-patterns/readable-view/stale',
    title: 'A stale read keeps its value under a banner',
    render: () => (
      <ReadableView
        readable={{
          state: 'stale',
          value: ['shop/platform/staging'],
          source: 'cached',
          observedAt: OBSERVED,
        }}
        what="targets"
        now={NOW}
        onRefresh={() => undefined}
        ready={(names) => <Targets names={names} />}
      />
    ),
  },
  {
    id: 'ui-patterns/readable-view/loading',
    title: 'Loading: a skeleton shaped like the list, and a spoken status',
    render: () => (
      <ReadableView<readonly string[]>
        readable={{ state: 'loading' }}
        what="targets"
        now={NOW}
        loading={
          <div className="flex flex-col gap-2">
            <Skeleton className="h-5 w-64" />
            <Skeleton className="h-5 w-56" />
            <Skeleton className="h-5 w-60" />
          </div>
        }
        ready={(names) => <Targets names={names} />}
      />
    ),
  },
  {
    id: 'ui-patterns/readable-view/partial',
    title: 'Partial: the value under a banner that names what is missing',
    render: () => (
      <ReadableView
        readable={{
          state: 'partial',
          value: ['shop/platform/staging'],
          source: 'agent_reported',
          observedAt: OBSERVED,
          missing: ['shop/platform/production: the node agent did not answer'],
        }}
        what="targets"
        now={NOW}
        empty={{ isEmpty: (names) => names.length === 0 }}
        ready={(names) => <Targets names={names} />}
      />
    ),
  },
  {
    id: 'ui-patterns/readable-view/empty',
    title: 'Empty: only after a read that succeeded and found nothing',
    render: () => (
      <ReadableView
        readable={{
          state: 'ready',
          value: [] as readonly string[],
          source: 'live',
          observedAt: OBSERVED,
        }}
        what="targets"
        now={NOW}
        empty={{ isEmpty: (names) => names.length === 0 }}
        ready={(names) => <Targets names={names} />}
      />
    ),
  },
  {
    id: 'ui-patterns/readable-view/stale-refresh-failed',
    title: 'Stale after a failed refresh: the reason and the code are shown',
    render: () => (
      <ReadableView
        readable={{
          state: 'stale',
          value: ['shop/platform/staging'],
          source: 'cached',
          observedAt: OBSERVED,
          error: { code: 'TARGET_UNREACHABLE', message: 'The target did not answer in time.' },
        }}
        what="targets"
        now={NOW}
        onRefresh={() => undefined}
        ready={(names) => <Targets names={names} />}
      />
    ),
  },
  {
    id: 'ui-patterns/observed-time/ages',
    title: 'Observed time: an age with its absolute time, and "time unknown" for a bad value',
    render: () => (
      <ul className="flex flex-col gap-1.5 text-sm">
        <li>
          Just now: <ObservedTime observedAt="2026-10-13T11:59:58.000Z" now={NOW} />
        </li>
        <li>
          Minutes: <ObservedTime observedAt={OBSERVED} withDate now={NOW} />
        </li>
        <li>
          Days: <ObservedTime observedAt="2026-10-10T08:30:00.000Z" withDate now={NOW} />
        </li>
        <li>
          A clock ahead: <ObservedTime observedAt="2026-10-13T13:00:00.000Z" now={NOW} />
        </li>
        <li>
          Not a date: <ObservedTime observedAt="yesterday" now={NOW} />
        </li>
      </ul>
    ),
  },
]
