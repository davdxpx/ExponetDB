import { cn } from '@exponetdb/ui'
import type { ReactNode } from 'react'

import type { ReadSource } from '../readable.ts'
import { formatAge, type NowInput } from '../states/format.ts'

/** The label of each read source, as the chip shows it. */
export const SOURCE_LABELS: Readonly<Record<ReadSource, string>> = {
  live: 'Live',
  sampled: 'Sampled',
  cached: 'Cached',
  agent_reported: 'Reported by agent',
  inferred: 'Inferred',
}

/** What each read source means, for help text. */
export const SOURCE_DESCRIPTIONS: Readonly<Record<ReadSource, string>> = {
  live: 'Read from the target during this request.',
  sampled: 'Taken from a periodic sample.',
  cached: 'An earlier read served again.',
  agent_reported: 'Reported by the node agent; ExponetDB did not observe it directly.',
  inferred: 'Derived from other observations.',
}

/** The source inside a sentence: "live", "cached", "reported by agent". */
export function sourcePhrase(source: ReadSource): string {
  return SOURCE_LABELS[source].toLowerCase()
}

/**
 * Where an observation comes from and how old it is, as one phrase for a
 * tooltip or a sentence: "live, 4 min ago". Without a source only the age is
 * given; without either it is `undefined`. An observation time that is not a
 * date reads "time unknown".
 */
export function describeRead(
  source: ReadSource | undefined,
  observedAt: string | undefined,
  now: NowInput,
): string | undefined {
  const age = observedAt === undefined ? undefined : (formatAge(observedAt, now) ?? 'time unknown')
  if (source === undefined) return age
  return age === undefined ? sourcePhrase(source) : `${sourcePhrase(source)}, ${age}`
}

export interface SourceLabelProps {
  source: ReadSource
  className?: string
}

/**
 * A quiet chip naming where a value comes from (C-28): live, sampled, cached,
 * reported by the node agent or inferred. Text carries the meaning; the chip
 * has no color of its own.
 */
export function SourceLabel({ source, className }: SourceLabelProps): ReactNode {
  return (
    <span
      data-source={source}
      className={cn(
        'inline-flex items-center rounded-sm border border-default px-1.5 py-0.5 text-xs leading-none text-foreground-light',
        className,
      )}
    >
      {SOURCE_LABELS[source]}
    </span>
  )
}
