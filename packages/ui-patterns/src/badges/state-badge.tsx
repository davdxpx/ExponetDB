import { CircleHelp, Clock } from '@exponetdb/icons'
import { cn, StatusIcon, Tooltip, TooltipContent, TooltipTrigger } from '@exponetdb/ui'
import type { ReactNode } from 'react'

import type { ReadSource } from '../readable.ts'
import type { NowInput } from '../states/format.ts'
import { useResolvedNow } from '../states/use-now.ts'
import { describeRead } from './source-label.tsx'

export type HealthState = 'healthy' | 'degraded' | 'unhealthy' | 'unknown' | 'stale'

const LABELS: Readonly<Record<HealthState, string>> = {
  healthy: 'Healthy',
  degraded: 'Degraded',
  unhealthy: 'Unhealthy',
  unknown: 'Unknown',
  stale: 'Stale',
}

const COLORS: Readonly<Record<HealthState, string>> = {
  healthy: 'border-state-healthy bg-state-healthy text-state-healthy-foreground',
  degraded: 'border-state-degraded bg-state-degraded text-state-degraded-foreground',
  unhealthy: 'border-state-unhealthy bg-state-unhealthy text-state-unhealthy-foreground',
  unknown: 'border-state-unknown bg-state-unknown text-state-unknown-foreground',
  stale: 'border-state-stale bg-state-stale text-state-stale-foreground',
}

/** A different shape per state, so the color is never the only signal. */
function Glyph({ state }: { state: HealthState }): ReactNode {
  switch (state) {
    case 'healthy':
      return <StatusIcon variant="success" hideBackground decorative className="text-current" />
    case 'degraded':
      return <StatusIcon variant="warning" hideBackground decorative className="text-current" />
    case 'unhealthy':
      return <StatusIcon variant="destructive" hideBackground decorative className="text-current" />
    case 'unknown':
      return <CircleHelp aria-hidden="true" className="size-3" />
    case 'stale':
      return <Clock aria-hidden="true" className="size-3" />
  }
}

export interface StateBadgeProps {
  state: HealthState
  /** Where the state comes from. With `source` or `observedAt`, the badge explains itself on hover and focus. */
  source?: ReadSource
  /** ISO 8601 time of the observation. */
  observedAt?: string
  now?: NowInput
  className?: string
}

interface ChipProps {
  state: HealthState
  className?: string
}

function Chip({ state, className }: ChipProps): ReactNode {
  return (
    <span
      data-health={state}
      className={cn(
        'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs leading-4 font-medium whitespace-nowrap',
        COLORS[state],
        className,
      )}
    >
      <Glyph state={state} />
      {LABELS[state]}
    </span>
  )
}

/** The badge with its explanation. Separate so that only badges that show an age follow the clock. */
function ExplainedStateBadge({
  state,
  source,
  observedAt,
  now,
  className,
}: StateBadgeProps): ReactNode {
  const current = useResolvedNow(now)
  const explanation = describeRead(source, observedAt, current)
  if (explanation === undefined) return <Chip state={state} className={className} />
  return (
    <Tooltip>
      {/* Focusable so the explanation is reachable without a pointer. */}
      <TooltipTrigger asChild>
        <span
          // biome-ignore lint/a11y/noNoninteractiveTabindex: the badge explains itself on keyboard focus
          tabIndex={0}
          className="inline-flex rounded-md focus-ring"
        >
          <Chip state={state} className={className} />
        </span>
      </TooltipTrigger>
      <TooltipContent>{explanation}</TooltipContent>
    </Tooltip>
  )
}

/**
 * The health of a node, cluster, target or check: an icon of its own shape and
 * the word (Healthy, Degraded, Unhealthy, Unknown, Stale). Given a source or
 * a time, hovering or focusing the badge shows both in a tooltip, "live, 4 min
 * ago" (C-28). Needs a `TooltipProvider` above it, which the app shell provides.
 */
export function StateBadge(props: StateBadgeProps): ReactNode {
  if (props.source === undefined && props.observedAt === undefined) {
    return <Chip state={props.state} className={props.className} />
  }
  return <ExplainedStateBadge {...props} />
}
