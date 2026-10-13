// Derived from supabase/supabase packages/ui-patterns/src/Chart/index.tsx @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.

import { Button, Card, cn, Skeleton, Tooltip, TooltipContent, TooltipTrigger } from '@exponetdb/ui'
import { Slot } from 'radix-ui'
import * as React from 'react'

import { ChartFailureText, ChartSourceNote } from '../charts/chart-states.tsx'
import { ClippedText, visibleText } from '../charts/clipped-text.tsx'
import { useChartNow } from '../charts/use-chart-now.ts'
import type { Readable } from '../readable.ts'
import { useLinkComponent } from '../seams/index.ts'

/*
 * The frame of a chart card: header, title, actions, headline metric, content
 * and footer. It lays things out and holds no data. The chart inside takes a
 * `Readable<T>` (src/charts/), so loading, a failed read, stale and partial
 * data are drawn by the chart itself and a failed read can never look empty
 * (C-28). Only the headline metric reads a value here, and it takes a
 * `Readable<string>` for the same reason.
 */

/* Chart Base */
type ChartProps = React.HTMLAttributes<HTMLDivElement>

const chartTableClasses = `[&_tr]:border-b [&_tr]:border-border [&_thead_tr]:bg-transparent! [&_thead_th]:py-2! [&_thead_th]:px-card! [&_thead_th]:h-auto [&_tbody_td]:py-2.5 [&_tbody_td]:px-card [&_tbody_td]:text-xs [&_table]:mb-1 [&_table]:border-b [&_table]:border-border`

const Chart = React.forwardRef<HTMLDivElement, ChartProps>(
  ({ children, className, ...props }, ref) => {
    return (
      <div ref={ref} className={cn('relative w-full', className)} {...props}>
        {children}
      </div>
    )
  },
)
Chart.displayName = 'Chart'

/* Chart Card */
interface ChartCardProps extends React.HTMLAttributes<HTMLDivElement> {
  asChild?: boolean
}

const ChartCard = React.forwardRef<HTMLDivElement, ChartCardProps>(
  ({ children, className, asChild, ...props }, ref) => {
    const Comp = asChild ? Slot.Slot : Card
    return (
      <Comp ref={ref} className={cn('relative w-full', className)} {...props}>
        {children}
      </Comp>
    )
  },
)
ChartCard.displayName = 'ChartCard'

/* Help */

/**
 * A "?" button with an explanation in a tooltip. A real button, so a keyboard
 * user reaches it and the tooltip opens on focus.
 */
function ChartHelp({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          className="focus-ring inline-flex size-4 shrink-0 cursor-help items-center justify-center rounded-full border text-[10px] leading-none text-foreground-lighter transition-colors hover:text-foreground-light"
        >
          <span aria-hidden="true">?</span>
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-72">{children}</TooltipContent>
    </Tooltip>
  )
}

/* Chart Header Components */
interface ChartHeaderProps extends React.HTMLAttributes<HTMLDivElement> {
  align?: 'start' | 'center'
}

const ChartHeader = React.forwardRef<HTMLDivElement, ChartHeaderProps>(
  ({ children, className, align = 'center', ...props }, ref) => {
    return (
      <div
        ref={ref}
        className={cn(
          'relative flex flex-row justify-between gap-2 space-y-0 border-b-0 p-card pb-0',
          align === 'center' ? 'items-center' : 'items-start',
          className,
        )}
        {...props}
      >
        {children}
      </div>
    )
  },
)
ChartHeader.displayName = 'ChartHeader'

interface ChartTitleProps extends React.HTMLAttributes<HTMLHeadingElement> {
  /** An explanation of what the chart shows, opened from a "?" button. */
  tooltip?: string
  /** The accessible name of that button (default "What this chart shows"). */
  helpLabel?: string
}

const ChartTitle = React.forwardRef<HTMLHeadingElement, ChartTitleProps>(
  ({ children, className, tooltip, helpLabel = 'What this chart shows', ...props }, ref) => {
    return (
      <h3
        ref={ref}
        className={cn('flex items-center gap-2 text-sm font-medium', className)}
        {...props}
      >
        <span>{children}</span>
        {tooltip ? <ChartHelp label={helpLabel}>{tooltip}</ChartHelp> : null}
      </h3>
    )
  },
)
ChartTitle.displayName = 'ChartTitle'

export type ChartAction = {
  /** Accessible name and tooltip of the (icon) button. */
  label: string
  icon?: React.ReactNode
  onClick?: () => void
  /** An app path the caller built from typed values; the button then renders as a link. */
  href?: string
  className?: string
}

interface ChartActionsProps extends React.HTMLAttributes<HTMLDivElement> {
  actions?: ChartAction[]
}

const ChartActions = React.forwardRef<HTMLDivElement, ChartActionsProps>(
  ({ actions, children, className, ...props }, ref) => {
    const Link = useLinkComponent()

    if (children) {
      return (
        <div ref={ref} className={cn('flex items-center gap-2', className)} {...props}>
          {children}
        </div>
      )
    }

    if (actions && actions.length > 0) {
      return (
        <div ref={ref} className={cn('flex items-center gap-2', className)} {...props}>
          {actions.map((action) => {
            const isLink = action.href !== undefined && action.href !== ''

            return (
              <Tooltip key={action.label}>
                <TooltipTrigger asChild>
                  <Button
                    size="tiny"
                    className={cn('px-1.5 text-foreground-lighter', action.className)}
                    {...(action.onClick ? { onClick: action.onClick } : {})}
                    asChild={isLink}
                  >
                    {isLink ? (
                      <Link href={action.href ?? ''}>
                        {action.icon}
                        <span className="sr-only">{action.label}</span>
                      </Link>
                    ) : (
                      <>
                        {action.icon}
                        <span className="sr-only">{action.label}</span>
                      </>
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top">{action.label}</TooltipContent>
              </Tooltip>
            )
          })}
        </div>
      )
    }

    return null
  },
)
ChartActions.displayName = 'ChartActions'

/* Chart Metric */
export type ChartMetricStatus = 'healthy' | 'degraded' | 'unhealthy' | 'unknown'

const STATUS_DOT: Record<ChartMetricStatus, string> = {
  healthy: 'bg-state-healthy',
  degraded: 'bg-state-degraded',
  unhealthy: 'bg-state-unhealthy',
  unknown: 'bg-state-unknown',
}

const STATUS_WORD: Record<ChartMetricStatus, string> = {
  healthy: 'Healthy',
  degraded: 'Degraded',
  unhealthy: 'Unhealthy',
  unknown: 'Unknown',
}

interface ChartMetricProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'children'> {
  /** What is measured. */
  label: string
  /** The headline value as a read: loading, failed, stale, partial or ready. */
  value: Readable<string>
  diffValue?: string | number | null | undefined
  /** A state with a dot and a word: the color is never the only signal. */
  status?: ChartMetricStatus
  align?: 'start' | 'end'
  /** An explanation of the metric, opened from a "?" button. */
  tooltip?: string
  /** Current time in ms since the epoch; fixes the age shown (tests). */
  now?: number
  /** IANA zone of the time shown; UTC by default. */
  timeZone?: string
}

function parseDiff(diffValue: string | number | null | undefined) {
  if (diffValue === null || diffValue === undefined) {
    return { variant: 'default' as const, text: null }
  }

  const numValue = typeof diffValue === 'string' ? Number.parseFloat(diffValue) : diffValue

  if (Number.isNaN(numValue)) {
    return { variant: 'default' as const, text: String(diffValue) }
  }

  const variant: 'positive' | 'negative' | 'default' =
    numValue > 0 ? 'positive' : numValue < 0 ? 'negative' : 'default'

  return { variant, text: numValue > 0 ? `+${diffValue}` : String(diffValue) }
}

const ChartMetric = React.forwardRef<HTMLDivElement, ChartMetricProps>(
  (
    {
      label,
      value,
      diffValue,
      className,
      status,
      align = 'start',
      tooltip,
      now,
      timeZone,
      ...props
    },
    ref,
  ) => {
    const current = useChartNow(now)
    const diff = parseDiff(diffValue)
    const shownLabel = visibleText(label)
    const timeProps = timeZone === undefined ? {} : { timeZone }

    return (
      <div
        ref={ref}
        className={cn(
          'flex flex-col gap-0.5',
          align === 'start' ? 'items-start' : 'items-end',
          className,
        )}
        data-state={value.state}
        {...props}
      >
        <div className="flex items-center gap-2">
          {status ? (
            <span className="flex items-center gap-1.5 text-xs text-foreground-lighter">
              <span
                aria-hidden="true"
                className={cn('size-1.5 shrink-0 rounded-full', STATUS_DOT[status])}
              />
              {STATUS_WORD[status]}
            </span>
          ) : null}
          <h3 className="my-0 flex items-center gap-1.5 eyebrow text-xs text-foreground-light">
            <span>{shownLabel}</span>
            {tooltip ? <ChartHelp label={`About ${shownLabel}`}>{tooltip}</ChartHelp> : null}
          </h3>
        </div>
        {value.state === 'loading' ? (
          <span role="status">
            <span className="sr-only">Loading {shownLabel}</span>
            <Skeleton className="h-6 w-12" />
          </span>
        ) : value.state === 'failed' ? (
          <>
            <span className="text-xl text-foreground-light">Not read</span>
            <div className="max-w-64 text-xs text-foreground-lighter" role="alert">
              <ChartFailureText name={label} error={value.error} />
            </div>
          </>
        ) : (
          <>
            <span className="text-xl tabular-nums text-foreground">{value.value}</span>
            {diff.text !== null ? (
              <ChartValueDifferential variant={diff.variant}>{diff.text}</ChartValueDifferential>
            ) : null}
            {value.state === 'stale' ? (
              <p className="text-xs font-medium text-foreground-light">
                Stale
                {value.error ? `, refreshing failed (${value.error.code})` : ''}
              </p>
            ) : null}
            {value.state === 'partial' ? (
              <div className="max-w-64 text-xs text-foreground-light">
                <p className="font-medium">Partial. Missing:</p>
                <ul className="list-disc pl-4">
                  {value.missing.map((item, index) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: entries may repeat and never reorder
                    <li key={`${index}-${item}`}>
                      {/* UntrustedText: an entry is text from the caller. */}
                      <ClippedText text={item} limit={120} />
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <ChartSourceNote readable={value} now={current} {...timeProps} />
          </>
        )}
      </div>
    )
  },
)
ChartMetric.displayName = 'ChartMetric'

/* Chart Content */
type ChartContentProps = React.HTMLAttributes<HTMLDivElement>

/** The padded body of a chart card. */
const ChartContent = React.forwardRef<HTMLDivElement, ChartContentProps>(
  ({ children, className, ...props }, ref) => {
    return (
      <div ref={ref} className={cn('p-card', chartTableClasses, className)} {...props}>
        {children}
      </div>
    )
  },
)
ChartContent.displayName = 'ChartContent'

/* Chart Footer */
type ChartFooterProps = React.HTMLAttributes<HTMLDivElement>

const ChartFooter = React.forwardRef<HTMLDivElement, ChartFooterProps>(
  ({ children, className, ...props }, ref) => {
    return (
      <div ref={ref} className={cn('border-t', className, chartTableClasses)} {...props}>
        {children}
      </div>
    )
  },
)
ChartFooter.displayName = 'ChartFooter'

/* Metric Chart Components */
interface ChartValueDifferentialProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: 'positive' | 'negative' | 'default'
}

/** A change next to a metric. The sign is part of the text, so the color is not the only signal. */
const ChartValueDifferential = React.forwardRef<HTMLSpanElement, ChartValueDifferentialProps>(
  ({ className, variant = 'default', ...props }, ref) => {
    return (
      <span
        ref={ref}
        className={cn(
          variant === 'positive'
            ? 'text-success'
            : variant === 'negative'
              ? 'text-destructive'
              : 'text-foreground-light',
          'text-sm tabular-nums',
          className,
        )}
        {...props}
      />
    )
  },
)
ChartValueDifferential.displayName = 'ChartValueDifferential'

/* Exports */
export {
  Chart,
  ChartActions,
  ChartCard,
  ChartContent,
  ChartFooter,
  ChartHeader,
  ChartMetric,
  ChartTitle,
  ChartValueDifferential,
}
