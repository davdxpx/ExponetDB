import { Server } from '@exponetdb/icons'
import { StateBadge, TierChip } from '@exponetdb/ui-patterns'
import type { ReactNode } from 'react'
import type { DemoDefinition } from '../types.ts'

// A fixed clock keeps the demos deterministic for the visual-regression host.
const NOW = '2026-10-13T12:00:00.000Z'
const OBSERVED = '2026-10-13T11:56:00.000Z'

function ProductionCues(): ReactNode {
  return (
    <div className="flex flex-col gap-5">
      <section aria-label="The tier chip" className="flex flex-col gap-2">
        <p className="text-xs font-medium text-foreground-light">The tier chip</p>
        <div className="flex flex-wrap items-center gap-3">
          <TierChip tier="prod" name="production" />
          <TierChip tier="nonprod" name="staging" />
          <TierChip tier="nonprod" />
        </div>
      </section>

      <section aria-label="A banner" className="flex flex-col gap-2">
        <p className="text-xs font-medium text-foreground-light">A banner</p>
        <div className="flex items-start gap-2 rounded-md border border-border-production bg-production-muted px-3 py-2 text-sm text-foreground">
          <Server aria-hidden className="mt-0.5 size-4 shrink-0 text-foreground" />
          <p>
            <strong className="font-medium">Production.</strong> This plan changes{' '}
            <code className="font-mono text-xs">shop/platform/production</code>.
          </p>
        </div>
      </section>

      <section aria-label="A frame" className="flex flex-col gap-2">
        <p className="text-xs font-medium text-foreground-light">The frame of a production page</p>
        <div className="rounded-lg bg-card p-4 ring-2 ring-production ring-inset">
          <div className="mb-3 flex items-center gap-2">
            <TierChip tier="prod" name="production" />
            <p className="text-sm text-foreground">Plan for shop/platform/production</p>
          </div>
          <p className="text-sm text-foreground-light">
            The ring is drawn inside the box, so it never shifts the layout.
          </p>
        </div>
      </section>
    </div>
  )
}

function States(): ReactNode {
  return (
    <div className="flex flex-col gap-3">
      <ul aria-label="The five states" className="flex flex-wrap items-center gap-3">
        <li>
          <StateBadge state="healthy" />
        </li>
        <li>
          <StateBadge state="degraded" />
        </li>
        <li>
          <StateBadge state="unhealthy" />
        </li>
        <li>
          <StateBadge state="unknown" />
        </li>
        <li>
          <StateBadge state="stale" />
        </li>
      </ul>
      <p className="text-sm text-foreground-light">
        Each state has its own shape and its own word. Hover or focus a badge that carries a source
        and a time to read them.
      </p>
      <ul
        aria-label="States with a source and a time"
        className="flex flex-wrap items-center gap-3"
      >
        <li>
          <StateBadge state="healthy" source="live" observedAt={OBSERVED} now={NOW} />
        </li>
        <li>
          <StateBadge state="stale" source="cached" observedAt={OBSERVED} now={NOW} />
        </li>
        <li>
          <StateBadge state="unknown" />
        </li>
      </ul>
    </div>
  )
}

const FILLS = [
  {
    name: 'state-healthy',
    className: 'bg-state-healthy text-state-healthy-foreground border-state-healthy',
  },
  {
    name: 'state-degraded',
    className: 'bg-state-degraded text-state-degraded-foreground border-state-degraded',
  },
  {
    name: 'state-unhealthy',
    className: 'bg-state-unhealthy text-state-unhealthy-foreground border-state-unhealthy',
  },
  {
    name: 'state-unknown',
    className: 'bg-state-unknown text-state-unknown-foreground border-state-unknown',
  },
  {
    name: 'state-stale',
    className: 'bg-state-stale text-state-stale-foreground border-state-stale',
  },
] as const

function StateFills(): ReactNode {
  return (
    <ul aria-label="State fills" className="grid gap-3 sm:grid-cols-2">
      {FILLS.map((fill) => (
        <li key={fill.name} className="flex items-center gap-3">
          <span
            aria-hidden
            className={`flex h-10 w-14 shrink-0 items-center justify-center rounded-md border text-sm font-medium ${fill.className}`}
          >
            Aa
          </span>
          <code className="font-mono text-xs text-foreground">{fill.name}</code>
        </li>
      ))}
    </ul>
  )
}

export const demos: readonly DemoDefinition[] = [
  {
    id: 'tokens/production-and-state/production',
    title: 'The production chip, banner and frame',
    render: () => <ProductionCues />,
  },
  {
    id: 'tokens/production-and-state/states',
    title: 'The five operational states, each with a shape and a word',
    render: () => <States />,
  },
  {
    id: 'tokens/production-and-state/fills',
    title: 'The state tokens as fills',
    render: () => <StateFills />,
  },
]
