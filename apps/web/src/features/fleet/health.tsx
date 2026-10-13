import { CircleHelp, Clock } from '@exponetdb/icons'
import { cn, StatusIcon } from '@exponetdb/ui'
import { ObservedTime, UntrustedName } from '@exponetdb/ui-patterns'
import type { ReactNode } from 'react'
import { type MessageKey, t } from '../../lib/i18n/i18n.ts'

/**
 * The health of a target as a chip: a glyph of its own shape and the word,
 * never color alone (C-28). `unknown`, a missing sample and any state the
 * page does not know are rendered as "Unknown" or "No health sample" in the
 * neutral colors; nothing that was not observed is ever green.
 */
export const HEALTH_STATES = [
  'unhealthy',
  'unreachable',
  'degraded',
  'unknown',
  'suspended',
  'healthy',
] as const
export type HealthKey = (typeof HEALTH_STATES)[number]

export function isHealthKey(value: unknown): value is HealthKey {
  return typeof value === 'string' && HEALTH_STATES.some((state) => state === value)
}

type ChipState = HealthKey | 'none'

const COLORS: Readonly<Record<ChipState, string>> = {
  healthy: 'border-state-healthy bg-state-healthy text-state-healthy-foreground',
  degraded: 'border-state-degraded bg-state-degraded text-state-degraded-foreground',
  unhealthy: 'border-state-unhealthy bg-state-unhealthy text-state-unhealthy-foreground',
  unreachable: 'border-state-unhealthy bg-state-unhealthy text-state-unhealthy-foreground',
  unknown: 'border-state-unknown bg-state-unknown text-state-unknown-foreground',
  suspended: 'border-state-stale bg-state-stale text-state-stale-foreground',
  none: 'border-state-unknown bg-state-unknown text-state-unknown-foreground',
}

const LABELS: Readonly<Record<ChipState, MessageKey>> = {
  healthy: 'health.healthy',
  degraded: 'health.degraded',
  unhealthy: 'health.unhealthy',
  unreachable: 'health.unreachable',
  unknown: 'health.unknown',
  suspended: 'health.suspended',
  none: 'health.notRead',
}

function Glyph({ state }: { readonly state: ChipState }): ReactNode {
  switch (state) {
    case 'healthy':
      return <StatusIcon variant="success" hideBackground decorative className="text-current" />
    case 'degraded':
      return <StatusIcon variant="warning" hideBackground decorative className="text-current" />
    case 'unhealthy':
    case 'unreachable':
      return <StatusIcon variant="destructive" hideBackground decorative className="text-current" />
    case 'suspended':
      return <Clock aria-hidden="true" className="size-3" />
    default:
      return <CircleHelp aria-hidden="true" className="size-3" />
  }
}

export function chipStateOf(state: string | null): ChipState {
  if (state === null) return 'none'
  return isHealthKey(state) ? state : 'unknown'
}

export function HealthChip(props: {
  /** `null` is a target with no health sample; a word the page does not know reads as unknown. */
  readonly state: string | null
  readonly className?: string
}): ReactNode {
  const state = chipStateOf(props.state)
  return (
    <span
      data-health={state}
      className={cn(
        'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs leading-4 font-medium whitespace-nowrap',
        COLORS[state],
        props.className,
      )}
    >
      <Glyph state={state} />
      {t(LABELS[state])}
    </span>
  )
}

export interface HealthRead {
  readonly state: string
  readonly source: string
  readonly observedAt: string
}

/** The chip with where the sample came from and how old it is, as text. */
export function HealthCell(props: { readonly health: HealthRead | null }): ReactNode {
  if (props.health === null) {
    return (
      <span className="flex flex-col items-start gap-1">
        <HealthChip state={null} />
      </span>
    )
  }
  return (
    <span className="flex flex-col items-start gap-1">
      <HealthChip state={props.health.state} />
      <span className="text-xs text-foreground-light">
        <UntrustedName name={props.health.source} mono maxCodePoints={24} label="source" />
        {', '}
        <ObservedTime observedAt={props.health.observedAt} />
      </span>
    </span>
  )
}
