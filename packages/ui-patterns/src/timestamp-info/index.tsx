// Derived from supabase/supabase packages/ui-patterns/src/TimestampInfo/index.tsx @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import { cn, copyToClipboard, Tooltip, TooltipContent, TooltipTrigger, toast } from '@exponetdb/ui'

import {
  browserTimeZone,
  formatAbsolute,
  formatRelative,
  type InstantInput,
  parseInstant,
  resolveTimeZone,
  type TimestampPrecision,
} from './format.ts'
import { useTimestampInfoContext } from './timestamp-info-provider.tsx'

export {
  formatAbsolute,
  formatRelative,
  type InstantInput,
  parseInstant,
  type TimestampPrecision,
} from './format.ts'
export { TimestampInfoProvider } from './timestamp-info-provider.tsx'

export interface TimestampInfoProps {
  className?: string
  /**
   * The instant: an ISO 8601 string (one without a zone designator is read as UTC) or epoch
   * milliseconds. A value that is no instant is shown as it is, marked invalid.
   */
  timestamp: string | number
  /** The zone of the label: the viewer's own (default) or UTC. */
  displayAs?: 'local' | 'utc'
  /** How much of the time the label shows. */
  precision?: TimestampPrecision
  /** Replaces the formatted time as the visible text (an age, a name). The tooltip stays. */
  label?: string
  /**
   * IANA time zone to render in. Without it the zone of `TimestampInfoProvider` applies,
   * then the viewer's own.
   */
  timezone?: string
  /**
   * The moment the relative age counts from (default: the time the tooltip opens). Pass it in
   * tests and wherever the same moment must be shown on every row.
   */
  now?: InstantInput
}

/**
 * A time with its detail on demand. The label is the time in the viewer's zone (or UTC); the
 * tooltip, opened by hover or keyboard focus, gives UTC, the local zone, the age and the exact
 * instant. The label is a button: pressing it copies the UTC instant (ISO 8601) and says so in
 * a toast, which needs the app's `Toaster`; the tooltip needs the app's `TooltipProvider`.
 */
export const TimestampInfo = ({
  timestamp,
  className,
  displayAs = 'local',
  precision = 'second',
  label,
  timezone: timezoneProp,
  now,
}: TimestampInfoProps) => {
  const { timezone: timezoneFromContext } = useTimestampInfoContext()
  const date = parseInstant(timestamp)

  if (date === undefined) {
    return (
      // UntrustedText: the value is shown as received
      <span className={cn('text-xs text-foreground-lighter', className)}>
        {String(timestamp)} (invalid time)
      </span>
    )
  }

  const iso = date.toISOString()
  const zone = resolveTimeZone(timezoneProp ?? timezoneFromContext)
  const visible =
    label ??
    (displayAs === 'utc'
      ? formatAbsolute(date, 'UTC', precision)
      : formatAbsolute(date, zone, precision))

  const copy = async () => {
    const copied = await copyToClipboard(iso)
    if (copied) toast.success('Timestamp copied', { id: 'timestamp-copied', description: iso })
    else toast.warning('Could not copy the timestamp', { id: 'timestamp-copied' })
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => void copy()}
          className={cn(
            'focus-ring rounded-xs border-b border-transparent text-xs hover:border-dashed hover:border-foreground-light',
            className,
          )}
        >
          <time dateTime={iso}>{visible}</time>
        </button>
      </TooltipTrigger>
      <TooltipContent className="min-w-72 p-2 font-mono">
        <TimestampDetails date={date} iso={iso} zone={zone} now={now} />
      </TooltipContent>
    </Tooltip>
  )
}

function TimestampDetails({
  date,
  iso,
  zone,
  now,
}: {
  date: Date
  iso: string
  zone: string
  now: InstantInput | undefined
}) {
  const reference = (now === undefined ? undefined : parseInstant(now)) ?? new Date()
  const browserZone = browserTimeZone()
  const rows: { label: string; value: string }[] = [
    { label: 'UTC', value: formatAbsolute(date, 'UTC') },
  ]
  if (zone !== 'UTC') rows.push({ label: zone, value: formatAbsolute(date, zone) })
  // Keep "what time is it where I am" next to a zone picked for reading logs elsewhere.
  if (zone !== browserZone && browserZone !== 'UTC') {
    rows.push({ label: browserZone, value: formatAbsolute(date, browserZone) })
  }
  rows.push({ label: 'Relative', value: formatRelative(date, reference) })
  rows.push({ label: 'Instant', value: iso })

  return (
    <div className="flex flex-col gap-1">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
        {rows.map((row) => (
          <div key={row.label} className="contents">
            <dt className="text-foreground-lighter">{row.label}</dt>
            <dd className="whitespace-nowrap text-right text-foreground">{row.value}</dd>
          </div>
        ))}
      </dl>
      <p className="border-t pt-1 text-foreground-lighter">
        Select the time to copy the UTC instant.
      </p>
    </div>
  )
}
