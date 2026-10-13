import {
  ClassificationBadge,
  type HealthState,
  type ReadSource,
  SOURCE_DESCRIPTIONS,
  SOURCE_LABELS,
  SourceLabel,
  StateBadge,
  type StatementClassification,
  TierChip,
} from '@exponetdb/ui-patterns'
import type { ReactNode } from 'react'
import type { DemoDefinition } from '../types.ts'
import { minutesAgo, NOW } from './clock.ts'

const HEALTH: readonly HealthState[] = ['healthy', 'degraded', 'unhealthy', 'unknown', 'stale']
const SOURCES = Object.keys(SOURCE_LABELS) as ReadSource[]
const CLASSES: readonly StatementClassification[] = [
  'destructive',
  'rewrite',
  'non_transactional',
  'security',
  'read_only',
  'write',
]
// A class a newer server might send; the badge shows it by name instead of hiding it.
const FUTURE_CLASS: string = 'partition_move'

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <span className="w-48 shrink-0 text-xs text-foreground-lighter">{label}</span>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  )
}

export const demos: readonly DemoDefinition[] = [
  {
    id: 'ui-patterns/tier-chip/tiers',
    title: 'Tier chip: production in the reserved color and word, everything else neutral',
    render: () => (
      <div className="flex flex-col gap-3">
        <Row label="prod">
          <TierChip tier="prod" />
        </Row>
        <Row label="prod, named production">
          <TierChip tier="prod" name="production" />
        </Row>
        <Row label="prod, named live">
          <TierChip tier="prod" name="live" />
        </Row>
        <Row label="nonprod">
          <TierChip tier="nonprod" />
        </Row>
        <Row label="nonprod, named staging">
          <TierChip tier="nonprod" name="staging" />
        </Row>
        <Row label="nonprod, named prod">
          <TierChip tier="nonprod" name="prod" />
        </Row>
        <Row label="a tier that is not known">
          <TierChip tier="sandbox" />
        </Row>
      </div>
    ),
  },
  {
    id: 'ui-patterns/tier-chip/hostile-name',
    title: 'An environment name with a direction override and a zero-width space',
    render: () => <TierChip tier="prod" name={'stag\u{202E}ing\u{200B}'} />,
  },
  {
    id: 'ui-patterns/state-badge/states',
    title: 'State badge: a shape and a word for each state',
    render: () => (
      <div className="flex flex-wrap gap-2">
        {HEALTH.map((state) => (
          <StateBadge key={state} state={state} />
        ))}
      </div>
    ),
  },
  {
    id: 'ui-patterns/state-badge/with-source',
    title: 'State badge with a source and a time: focus or hover it for "live, 4 min ago"',
    render: () => (
      <div className="flex flex-wrap gap-2">
        <StateBadge state="healthy" source="live" observedAt={minutesAgo(4)} now={NOW} />
        <StateBadge state="degraded" source="sampled" observedAt={minutesAgo(12)} now={NOW} />
        <StateBadge state="unknown" source="agent_reported" observedAt={minutesAgo(90)} now={NOW} />
        <StateBadge state="stale" source="cached" observedAt={minutesAgo(1500)} now={NOW} />
      </div>
    ),
  },
  {
    id: 'ui-patterns/source-label/sources',
    title: 'Source label: the five sources a value can come from, with what each means',
    render: () => (
      <dl className="flex flex-col gap-2 text-sm">
        {SOURCES.map((source) => (
          <div key={source} className="flex flex-wrap items-center gap-3">
            <dt className="w-44 shrink-0">
              <SourceLabel source={source} />
            </dt>
            <dd className="m-0 text-foreground-light">{SOURCE_DESCRIPTIONS[source]}</dd>
          </div>
        ))}
      </dl>
    ),
  },
  {
    id: 'ui-patterns/classification-badge/classes',
    title: 'Classification badge: an icon and a name, and a sentence on focus or hover',
    render: () => (
      <div className="flex flex-wrap gap-2">
        {CLASSES.map((classification) => (
          <ClassificationBadge key={classification} classification={classification} />
        ))}
        <ClassificationBadge classification={FUTURE_CLASS as StatementClassification} />
      </div>
    ),
  },
]
