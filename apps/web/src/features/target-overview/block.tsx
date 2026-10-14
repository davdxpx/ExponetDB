import { CircleHelp, Clock, ShieldAlert, Unlink } from '@exponetdb/icons'
import { cn, StatusIcon } from '@exponetdb/ui'
import {
  PageSection,
  PageSectionContent,
  PageSectionDescription,
  PageSectionMeta,
  PageSectionSummary,
  PageSectionTitle,
} from '@exponetdb/ui-patterns'
import type { ReactNode } from 'react'
import { t } from '../../lib/i18n/i18n.ts'
import { stateLabelKey, type TargetHealthStateName } from './health-model.ts'

/** One block of the overview: its own heading, description and content. The content is a read with its own failure. */
export function Block(props: {
  readonly id: string
  readonly title: string
  readonly description?: string
  readonly aside?: ReactNode
  readonly children: ReactNode
}): ReactNode {
  return (
    <PageSection data-block={props.id}>
      <PageSectionMeta>
        <PageSectionSummary>
          <PageSectionTitle>{props.title}</PageSectionTitle>
          {props.description === undefined ? null : (
            <PageSectionDescription>{props.description}</PageSectionDescription>
          )}
        </PageSectionSummary>
        {props.aside}
      </PageSectionMeta>
      <PageSectionContent className="flex flex-col gap-4">{props.children}</PageSectionContent>
    </PageSection>
  )
}

const COLORS: Readonly<Record<TargetHealthStateName, string>> = {
  healthy: 'border-state-healthy bg-state-healthy text-state-healthy-foreground',
  degraded: 'border-state-degraded bg-state-degraded text-state-degraded-foreground',
  unhealthy: 'border-state-unhealthy bg-state-unhealthy text-state-unhealthy-foreground',
  unreachable: 'border-state-unhealthy bg-state-unhealthy text-state-unhealthy-foreground',
  unknown: 'border-state-unknown bg-state-unknown text-state-unknown-foreground',
  suspended: 'border-state-stale bg-state-stale text-state-stale-foreground',
}

function Glyph({ state }: { readonly state: TargetHealthStateName }): ReactNode {
  switch (state) {
    case 'healthy':
      return <StatusIcon variant="success" hideBackground decorative className="text-current" />
    case 'degraded':
      return <StatusIcon variant="warning" hideBackground decorative className="text-current" />
    case 'unhealthy':
      return <StatusIcon variant="destructive" hideBackground decorative className="text-current" />
    case 'unreachable':
      return <Unlink aria-hidden="true" className="size-3" />
    case 'suspended':
      return <ShieldAlert aria-hidden="true" className="size-3" />
    case 'unknown':
      return <CircleHelp aria-hidden="true" className="size-3" />
  }
}

/**
 * The state of a target in words, with a glyph of its own shape per state, so
 * the color is never the only signal. `unknown` is its own neutral state and
 * never looks like `healthy`; an `unreachable` target says so in words.
 */
export function HealthStateChip(props: {
  readonly state: TargetHealthStateName
  readonly className?: string
}): ReactNode {
  return (
    <span
      data-health={props.state}
      className={cn(
        'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs leading-4 font-medium whitespace-nowrap',
        COLORS[props.state],
        props.className,
      )}
    >
      <Glyph state={props.state} />
      {t(stateLabelKey(props.state))}
    </span>
  )
}

/** A quiet "not observed" chip: no probe says anything, so nothing is reported as fine. */
export function NotObservedChip(props: { readonly children: ReactNode }): ReactNode {
  return (
    <span
      data-health="not-observed"
      className="inline-flex items-center gap-1 rounded-md border border-default px-2 py-0.5 text-xs leading-4 font-medium text-foreground-light"
    >
      <Clock aria-hidden="true" className="size-3" />
      {props.children}
    </span>
  )
}
