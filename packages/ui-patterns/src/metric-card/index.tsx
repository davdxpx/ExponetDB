// Derived from supabase/supabase packages/ui-patterns/src/MetricCard/index.tsx @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import { ArrowDown, ArrowUp, ChevronRight } from '@exponetdb/icons'
import {
  Button,
  Card,
  CardContent,
  cn,
  Skeleton,
  StatusIcon,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@exponetdb/ui'
import { type ReactNode, useId } from 'react'

import { InfoTooltip } from '../info-tooltip.tsx'
import type { ReadFailure } from '../readable.ts'
import { useLinkComponent } from '../seams/index.ts'
import { TimestampInfo } from '../timestamp-info/index.tsx'

/** The change against the comparison period, as text the caller formatted ("+4%", "-12 ms"). */
export interface MetricDelta {
  readonly text: string
  /** Which way the number moved. Shown as an arrow and spoken, so color is never the only signal. */
  readonly direction: 'up' | 'down' | 'flat'
  /** Whether the move is good, bad or neither; it colors the text only. */
  readonly tone?: 'good' | 'bad' | 'neutral'
}

/**
 * What the card knows about its number. The union is the point (C-28): a card in the `failed`
 * state has no `value` to show, so a failed read can never render as a number or as zero.
 */
export type MetricCardState =
  | { readonly state: 'loading' }
  | { readonly state: 'ready'; readonly value: ReactNode }
  | {
      readonly state: 'stale'
      readonly value: ReactNode
      /** When the value was read (ISO 8601); shown as its age. */
      readonly observedAt: string
      /** Why it could not be refreshed, if a refresh failed. */
      readonly failure?: ReadFailure
    }
  | { readonly state: 'failed'; readonly failure: ReadFailure }

export type MetricCardProps = MetricCardState & {
  className?: string
  /** What is measured ("Open plans"). */
  label: string
  /** An explanation of the metric, in a tooltip next to the label. Text only. */
  help?: string
  icon?: ReactNode
  delta?: MetricDelta
  /** App path of the page that explains the number; rendered as a link through the link seam. */
  href?: string
  /** The accessible name of that link. Default: "View <label>". */
  linkLabel?: string
  /** The moment the age of a stale value counts from (tests, shared clocks). */
  now?: string | number | Date
}

const DELTA_TONE: Record<NonNullable<MetricDelta['tone']>, string> = {
  good: 'text-success',
  bad: 'text-destructive',
  neutral: 'text-foreground-light',
}

const DELTA_DIRECTION: Record<MetricDelta['direction'], string> = {
  up: 'Up',
  down: 'Down',
  flat: 'Unchanged',
}

/**
 * A number with its label, for the overview pages. It renders four honest states: a placeholder
 * while loading, the value when read, the value marked stale with its age, and the failure
 * (message and stable code) instead of a number when the read failed.
 */
export function MetricCard(props: MetricCardProps) {
  const { label, help, icon, delta, href, linkLabel, now, className } = props
  const labelId = useId()
  const Link = useLinkComponent()

  const linkName = linkLabel ?? `View ${label}`

  return (
    <Card
      role="group"
      aria-labelledby={labelId}
      aria-busy={props.state === 'loading' ? true : undefined}
      data-state={props.state}
      className={cn('relative transition-colors motion-reduce:transition-none', className)}
    >
      <CardContent className="flex h-full flex-col items-start gap-2 p-card">
        <div className="flex w-full items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2 text-foreground-light">
            {icon !== undefined && <span aria-hidden="true">{icon}</span>}
            <p id={labelId} className="font-mono text-xs uppercase">
              {label}
            </p>
            {help !== undefined && <InfoTooltip label={`About ${label}`}>{help}</InfoTooltip>}
          </div>
          {href !== undefined && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="text" size="tiny" className="shrink-0 px-1" asChild>
                  <Link href={href} aria-label={linkName}>
                    <ChevronRight aria-hidden="true" size={14} strokeWidth={1.5} />
                  </Link>
                </Button>
              </TooltipTrigger>
              <TooltipContent>{linkName}</TooltipContent>
            </Tooltip>
          )}
        </div>

        {props.state === 'loading' && (
          <>
            <Skeleton className="h-7 w-32" />
            <span className="sr-only">Loading</span>
          </>
        )}

        {(props.state === 'ready' || props.state === 'stale') && (
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="text-xl font-normal tabular-nums">{props.value}</span>
            {delta !== undefined && <Delta delta={delta} />}
          </div>
        )}

        {props.state === 'stale' && (
          <div className="flex flex-wrap items-center gap-x-1 text-xs text-foreground-lighter">
            <StatusIcon variant="warning" decorative hideBackground className="size-3.5" />
            <span>Stale, read</span>
            <TimestampInfo timestamp={props.observedAt} now={now} precision="minute" />
            {props.failure !== undefined && (
              <FailureText failure={props.failure} prefix="Refresh failed: " />
            )}
          </div>
        )}

        {props.state === 'failed' && (
          <div className="flex items-start gap-2 text-sm text-foreground">
            <StatusIcon variant="destructive" decorative hideBackground className="mt-0.5 size-4" />
            <div className="flex flex-col gap-0.5">
              <FailureText failure={props.failure} prefix="Could not read this metric: " />
              <span className="text-xs text-foreground-lighter">
                This does not mean the value is zero.
              </span>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function Delta({ delta }: { delta: MetricDelta }) {
  const Arrow =
    delta.direction === 'up' ? ArrowUp : delta.direction === 'down' ? ArrowDown : undefined
  return (
    <span
      className={cn(
        'inline-flex items-center gap-0.5 text-sm tabular-nums',
        DELTA_TONE[delta.tone ?? 'neutral'],
      )}
    >
      {Arrow !== undefined && <Arrow aria-hidden="true" size={12} strokeWidth={2} />}
      <span className="sr-only">{DELTA_DIRECTION[delta.direction]}: </span>
      {delta.text}
    </span>
  )
}

function FailureText({ failure, prefix }: { failure: ReadFailure; prefix: string }) {
  return (
    <span>
      {prefix}
      {failure.message}
      <span className="ml-1 font-mono text-xs text-foreground-lighter">{failure.code}</span>
    </span>
  )
}
