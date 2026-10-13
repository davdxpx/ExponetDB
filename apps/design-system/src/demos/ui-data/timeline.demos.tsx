import {
  MARKER_META,
  MIGRATION_MARKER_STATES,
  MigrationMarker,
  type MigrationMarkerState,
  MigrationTimeline,
  type MigrationTimelineData,
  type TimelineBundle,
  type TimelineCell,
} from '@exponetdb/ui-data'
import type { DemoDefinition } from '../types.ts'
import { minutesAgo, NOW } from '../ui-patterns/clock.ts'
import { DemoLinks } from '../ui-patterns/demo-links.tsx'

const OBSERVED = minutesAgo(3)

function cell(
  environmentId: string,
  state: MigrationMarkerState,
  atMinutes?: number,
  evidencePath?: string,
): TimelineCell {
  return {
    environmentId,
    state,
    observedAt: OBSERVED,
    ...(atMinutes === undefined ? {} : { at: minutesAgo(atMinutes) }),
    ...(evidencePath === undefined ? {} : { evidencePath }),
  }
}

const IDS = {
  users: '01JAAAAAAAAAAAAAAAAAAAAAAA',
  orders: '01JBBBBBBBBBBBBBBBBBBBBBBB',
  index: '01JCCCCCCCCCCCCCCCCCCCCCCC',
  notes: '01JDDDDDDDDDDDDDDDDDDDDDDD',
  archive: '01JEEEEEEEEEEEEEEEEEEEEEEE',
} as const

const BUNDLES: readonly TimelineBundle[] = [
  {
    id: IDS.users,
    slug: 'create_users',
    dependsOn: [],
    cells: [
      cell('development', 'verified', 4000),
      cell('staging', 'verified', 3000),
      cell('production', 'verified', 2000, '/changes/operations/op_users'),
    ],
  },
  {
    id: IDS.orders,
    slug: 'create_orders',
    dependsOn: [IDS.users],
    cells: [
      cell('development', 'verified', 1500),
      cell('staging', 'verified', 1200),
      cell('production', 'applied', 600, '/changes/operations/op_orders'),
    ],
  },
  {
    id: IDS.index,
    slug: 'index_orders_customer',
    dependsOn: [IDS.orders],
    cells: [
      cell('development', 'verified', 300),
      cell('staging', 'failed', 120, '/changes/operations/op_index'),
      cell('production', 'not_applied'),
    ],
  },
  {
    id: IDS.notes,
    slug: 'add_order_notes',
    dependsOn: [IDS.orders],
    cells: [
      cell('development', 'drifted', 90),
      cell('staging', 'pending'),
      cell('production', 'unknown'),
    ],
  },
  {
    id: IDS.archive,
    slug: 'drop\u{202E}_archive',
    dependsOn: [IDS.index, IDS.notes],
    cells: [cell('development', 'reverted', 20), cell('staging', 'not_applied')],
  },
]

const DATA: MigrationTimelineData = {
  environments: [
    { id: 'development', name: 'Development', tier: 'nonprod' },
    { id: 'staging', name: 'Staging', tier: 'nonprod', evidenceFrom: 'development' },
    { id: 'production', name: 'Production', tier: 'prod', evidenceFrom: 'staging' },
  ],
  bundles: BUNDLES,
}

function ready(value: MigrationTimelineData) {
  return { state: 'ready' as const, value, source: 'cached' as const, observedAt: OBSERVED }
}

export const demos: readonly DemoDefinition[] = [
  {
    id: 'ui-data/migration-timeline/stream',
    title:
      'Migration timeline: bundles in dependency order, one column per environment, a marker in each cell',
    render: () => (
      <DemoLinks>
        <MigrationTimeline readable={ready(DATA)} now={NOW} headingLevel={3} />
      </DemoLinks>
    ),
  },
  {
    id: 'ui-data/migration-timeline/markers',
    title: 'The eight markers: every state has a shape of its own and a word',
    render: () => (
      <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-[max-content_1fr]">
        {MIGRATION_MARKER_STATES.map((state) => (
          <div key={state} className="contents">
            <dt>
              <MigrationMarker state={state} />
            </dt>
            <dd className="m-0 text-foreground-light">{MARKER_META[state].description}</dd>
          </div>
        ))}
      </dl>
    ),
  },
  {
    id: 'ui-data/migration-timeline/failed',
    title: 'A failed read of the stream is never an empty timeline',
    render: () => (
      <MigrationTimeline
        readable={{
          state: 'failed',
          error: { code: 'MIRROR_UNAVAILABLE', message: 'The migration mirror could not be read.' },
        }}
        onRetry={() => undefined}
        now={NOW}
        headingLevel={3}
      />
    ),
  },
  {
    id: 'ui-data/migration-timeline/cycle',
    title:
      'A dependency cycle is named, and the bundles that could not be placed follow the ordered ones',
    render: () => (
      <MigrationTimeline
        readable={ready({
          environments: DATA.environments,
          bundles: [
            {
              id: IDS.users,
              slug: 'a',
              dependsOn: [IDS.orders],
              cells: [cell('development', 'applied')],
            },
            {
              id: IDS.orders,
              slug: 'b',
              dependsOn: [IDS.users],
              cells: [cell('development', 'applied')],
            },
          ],
        })}
        now={NOW}
        headingLevel={3}
      />
    ),
  },
]
