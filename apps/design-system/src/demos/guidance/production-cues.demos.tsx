import { cn } from '@exponetdb/ui'
import { TierChip } from '@exponetdb/ui-patterns'
import type { ReactNode } from 'react'
import type { DemoDefinition } from '../types.ts'

/** Each case: the contract's tier and the environment name, and what the chip must say. */
const CASES = [
  { tier: 'prod', name: 'production', note: 'tier prod, name production' },
  {
    tier: 'prod',
    name: 'live',
    note: 'tier prod, name live: the name is not production, the tier is',
  },
  { tier: 'nonprod', name: 'staging', note: 'tier nonprod, name staging' },
  {
    tier: 'nonprod',
    name: 'prod',
    note: 'tier nonprod, name prod: a name never makes a target production',
  },
  {
    tier: 'preview',
    name: 'preview',
    note: 'a tier the page does not know: treated as production',
  },
] as const

function TierCases(): ReactNode {
  return (
    <ul className="m-0 flex list-none flex-col gap-3 p-0">
      {CASES.map((entry) => (
        <li
          key={entry.note}
          className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-sm"
        >
          <span className="text-foreground-light">{entry.note}</span>
          <TierChip tier={entry.tier} name={entry.name} />
        </li>
      ))}
    </ul>
  )
}

function PlanSurface({
  production,
  path,
}: {
  readonly production: boolean
  readonly path: string
}): ReactNode {
  return (
    <section
      aria-label={`Plan review for ${path}`}
      data-production-frame={production ? '' : undefined}
      className={cn(
        'flex min-w-0 flex-col gap-3 rounded-md p-4',
        production ? 'border-2 border-production' : 'border border-default',
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="m-0 text-sm font-medium text-foreground">Plan review</h3>
        <TierChip tier={production ? 'prod' : 'nonprod'} />
      </div>
      <p className="m-0 text-sm text-foreground-light">
        Applies 2 migrations to <span className="font-mono text-xs text-foreground">{path}</span>.
      </p>
    </section>
  )
}

function Frames(): ReactNode {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <PlanSurface production path="shop/platform/production" />
      <PlanSurface production={false} path="shop/platform/staging" />
    </div>
  )
}

export const demos: readonly DemoDefinition[] = [
  {
    id: 'guidance/production-cues/tier-chip',
    title: 'The chip follows the tier, never the name, and fails closed',
    render: () => <TierCases />,
  },
  {
    id: 'guidance/production-cues/frame',
    title: 'A production page is framed with the reserved token and says "Production"',
    render: () => <Frames />,
  },
]
