import { CircleHelp, Clock } from '@exponetdb/icons'
import { cn, Skeleton, StatusIcon, Tooltip, TooltipContent, TooltipTrigger } from '@exponetdb/ui'
import {
  describeRead,
  type Readable,
  type ReadSource,
  readableValue,
  useResolvedNow,
} from '@exponetdb/ui-patterns'
import type { ReactNode } from 'react'
import { type MessageKey, t } from '../../lib/i18n/i18n.ts'
import type { Target } from './queries.ts'

/**
 * The health of the target the person is on, as a chip in the context bar.
 * It reads what the layout already reads (the target, polled every 30
 * seconds) and claims only what that read proves (C-28):
 *
 * - a read that failed is "Health not read", neutral, never green: the target
 *   may be fine or not, the bar cannot tell;
 * - a read that failed after an earlier success is "Health out of date": the
 *   earlier state is named in the tooltip with its age, never shown as
 *   current;
 * - a target without a sample yet is "No health sample", neutral;
 * - a sample is its state word with a glyph of its own shape; hovering or
 *   focusing the chip says where the sample came from and how old it is.
 *
 * Below `lg` the word leaves the screen (the glyph and the tooltip stay, the
 * word stays for assistive technology) and below `md` the chip leaves the
 * header, which has no room for it on a phone.
 */
type SampleState = NonNullable<Target['health']>['state']

type ChipState = SampleState | 'none' | 'notRead' | 'outdated'

const COLORS: Readonly<Record<ChipState, string>> = {
  healthy: 'border-state-healthy bg-state-healthy text-state-healthy-foreground',
  degraded: 'border-state-degraded bg-state-degraded text-state-degraded-foreground',
  unhealthy: 'border-state-unhealthy bg-state-unhealthy text-state-unhealthy-foreground',
  unreachable: 'border-state-unhealthy bg-state-unhealthy text-state-unhealthy-foreground',
  unknown: 'border-state-unknown bg-state-unknown text-state-unknown-foreground',
  suspended: 'border-state-stale bg-state-stale text-state-stale-foreground',
  none: 'border-state-unknown bg-state-unknown text-state-unknown-foreground',
  notRead: 'border-state-unknown bg-state-unknown text-state-unknown-foreground',
  outdated: 'border-state-stale bg-state-stale text-state-stale-foreground',
}

const LABELS: Readonly<Record<ChipState, MessageKey>> = {
  healthy: 'health.healthy',
  degraded: 'health.degraded',
  unhealthy: 'health.unhealthy',
  unreachable: 'health.unreachable',
  unknown: 'health.unknown',
  suspended: 'health.suspended',
  none: 'target.health.noSample',
  notRead: 'target.health.notRead',
  outdated: 'target.health.stale',
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
    case 'outdated':
      return <Clock aria-hidden="true" className="size-3" />
    default:
      return <CircleHelp aria-hidden="true" className="size-3" />
  }
}

/** A state the page does not know reads as unknown, in the neutral colors. */
function sampleState(state: string): SampleState {
  switch (state) {
    case 'healthy':
    case 'degraded':
    case 'unhealthy':
    case 'unreachable':
    case 'suspended':
      return state
    default:
      return 'unknown'
  }
}

/** What the chip shows for a read of the target, and the sentence that explains it. */
export type HealthView =
  | { readonly kind: 'loading' }
  | { readonly kind: 'chip'; readonly state: ChipState; readonly explanation: Explanation }

type Explanation =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'sample'; readonly source: string; readonly observedAt: string }
  | {
      readonly kind: 'earlier'
      readonly state: SampleState | undefined
      readonly source: string | undefined
      readonly observedAt: string | undefined
    }

export function healthViewOf(read: Readable<Target>): HealthView {
  switch (read.state) {
    case 'loading':
      return { kind: 'loading' }
    case 'failed':
      return {
        kind: 'chip',
        state: 'notRead',
        explanation: { kind: 'text', text: t('target.health.notReadWhy') },
      }
    case 'stale': {
      const earlier = read.value.health
      return {
        kind: 'chip',
        state: 'outdated',
        explanation: {
          kind: 'earlier',
          state: earlier === null ? undefined : sampleState(earlier.state),
          source: earlier?.source,
          observedAt: earlier?.observedAt,
        },
      }
    }
    case 'partial':
    case 'ready': {
      const health = readableValue(read)?.health
      if (health === null || health === undefined) {
        return {
          kind: 'chip',
          state: 'none',
          explanation: { kind: 'text', text: t('target.health.noSampleWhy') },
        }
      }
      return {
        kind: 'chip',
        state: sampleState(health.state),
        explanation: { kind: 'sample', source: health.source, observedAt: health.observedAt },
      }
    }
  }
}

const SOURCES: readonly ReadSource[] = ['live', 'sampled', 'cached', 'agent_reported', 'inferred']

function readSource(value: string | undefined): ReadSource | undefined {
  return SOURCES.find((source) => source === value)
}

function ExplanationText({ explanation }: { readonly explanation: Explanation }): ReactNode {
  const now = useResolvedNow()
  switch (explanation.kind) {
    case 'text':
      return explanation.text
    case 'sample':
      return (
        describeRead(readSource(explanation.source), explanation.observedAt, now) ??
        t('target.health.noSampleWhy')
      )
    case 'earlier': {
      if (explanation.state === undefined || explanation.observedAt === undefined) {
        return t('target.health.notReadWhy')
      }
      return t('target.health.staleWhy', {
        state: t(LABELS[explanation.state]).toLowerCase(),
        source:
          describeRead(readSource(explanation.source), explanation.observedAt, now) ??
          'time unknown',
      })
    }
  }
}

export function TargetHealthChip({ read }: { readonly read: Readable<Target> }): ReactNode {
  const view = healthViewOf(read)
  if (view.kind === 'loading') {
    return <Skeleton className="h-5 w-8 max-md:hidden lg:w-20" />
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          // biome-ignore lint/a11y/noNoninteractiveTabindex: the chip explains itself on keyboard focus
          tabIndex={0}
          data-slot="target-health"
          data-health={view.state}
          className="inline-flex shrink-0 rounded-md focus-ring max-md:hidden"
        >
          <span
            className={cn(
              'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs leading-4 font-medium whitespace-nowrap lg:px-2',
              COLORS[view.state],
            )}
          >
            <Glyph state={view.state} />
            <span className="max-lg:sr-only">
              <span className="sr-only">{t('target.health.label')}: </span>
              {t(LABELS[view.state])}
            </span>
          </span>
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-80">
        <ExplanationText explanation={view.explanation} />
      </TooltipContent>
    </Tooltip>
  )
}
