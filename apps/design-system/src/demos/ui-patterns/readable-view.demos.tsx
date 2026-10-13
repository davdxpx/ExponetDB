import { ReadableView } from '@exponetdb/ui-patterns'
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
]
