import { Label, RadioGroup, RadioGroupItem } from '@exponetdb/ui'
import { type Readable, ReadableView, type ReadFailure } from '@exponetdb/ui-patterns'
import { type ReactNode, useId, useState } from 'react'
import type { DemoDefinition } from '../types.ts'
import { NOW } from './support.tsx'

/**
 * What a query cache holds, reduced to what the mapping needs. The Web App maps the cache entry of
 * each query to a `Readable` in one place, so no page decides by itself what "loading" or "old"
 * means.
 */
interface CacheEntry {
  readonly data: readonly string[] | undefined
  readonly error: ReadFailure | undefined
  /** Seconds before the demo clock that the data arrived. */
  readonly ageSeconds: number
  readonly missing?: readonly string[]
}

/** Data older than two sampling intervals (the sampler writes every 15 seconds). */
const STALE_AFTER_SECONDS = 60

const CLOCK = Date.parse(NOW)

const VALUE: readonly string[] = ['shop/platform/production', 'shop/platform/staging']
const FAILURE: ReadFailure = {
  code: 'CONTROL_PLANE_DEGRADED',
  message: 'ExponetDB could not reach its own database.',
}

function toReadable(entry: CacheEntry): Readable<readonly string[]> {
  if (entry.data === undefined) {
    return entry.error === undefined
      ? { state: 'loading' }
      : { state: 'failed', error: entry.error }
  }
  const observedAt = new Date(CLOCK - entry.ageSeconds * 1000).toISOString()
  if (entry.error !== undefined || entry.ageSeconds > STALE_AFTER_SECONDS) {
    return {
      state: 'stale',
      value: entry.data,
      source: 'cached',
      observedAt,
      ...(entry.error === undefined ? {} : { error: entry.error }),
    }
  }
  if (entry.missing !== undefined && entry.missing.length > 0) {
    return {
      state: 'partial',
      value: entry.data,
      source: 'live',
      observedAt,
      missing: entry.missing,
    }
  }
  return { state: 'ready', value: entry.data, source: 'live', observedAt }
}

const SITUATIONS = [
  {
    id: 'pending',
    label: 'The first read is running',
    entry: { data: undefined, error: undefined, ageSeconds: 0 },
  },
  {
    id: 'failed',
    label: 'The first read failed',
    entry: { data: undefined, error: FAILURE, ageSeconds: 0 },
  },
  {
    id: 'fresh',
    label: 'Data arrived 20 seconds ago',
    entry: { data: VALUE, error: undefined, ageSeconds: 20 },
  },
  {
    id: 'old',
    label: 'Data arrived 5 minutes ago and nothing refreshed it',
    entry: { data: VALUE, error: undefined, ageSeconds: 300 },
  },
  {
    id: 'refresh-failed',
    label: 'Data arrived 40 seconds ago and the refresh failed',
    entry: { data: VALUE, error: FAILURE, ageSeconds: 40 },
  },
  {
    id: 'incomplete',
    label: 'The server marked its answer as incomplete',
    entry: {
      data: VALUE,
      error: undefined,
      ageSeconds: 10,
      missing: ['shop/billing/production: its node agent did not answer.'],
    },
  },
] as const

type SituationId = (typeof SITUATIONS)[number]['id']

function ReadableMapping(): ReactNode {
  const groupId = useId()
  const [selected, setSelected] = useState<SituationId>('refresh-failed')
  const situation = SITUATIONS.find((candidate) => candidate.id === selected) ?? SITUATIONS[0]
  const readable = toReadable(situation.entry)

  return (
    <div className="grid grid-cols-1 gap-6 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
      <RadioGroup
        aria-label="Cache entry of the query"
        value={selected}
        onValueChange={(value) => {
          const next = SITUATIONS.find((candidate) => candidate.id === value)
          if (next !== undefined) setSelected(next.id)
        }}
      >
        {SITUATIONS.map((candidate) => {
          const id = `${groupId}-${candidate.id}`
          return (
            <div key={candidate.id} className="flex items-start gap-2">
              <RadioGroupItem id={id} value={candidate.id} className="mt-0.5" />
              <Label htmlFor={id} className="leading-snug text-foreground">
                {candidate.label}
              </Label>
            </div>
          )
        })}
      </RadioGroup>
      <div className="flex min-w-0 flex-col gap-3">
        <p className="m-0 text-sm text-foreground-light">
          Becomes <code className="font-mono text-xs text-foreground">{readable.state}</code>
        </p>
        <ReadableView
          readable={readable}
          what="target list"
          now={NOW}
          onRetry={() => undefined}
          onRefresh={() => undefined}
          ready={(names) => (
            <ul className="m-0 list-disc pl-5 text-sm">
              {names.map((name) => (
                <li key={name} className="font-mono text-xs">
                  {name}
                </li>
              ))}
            </ul>
          )}
        />
      </div>
    </div>
  )
}

export const demos: readonly DemoDefinition[] = [
  {
    id: 'guidance/query-conventions/readable-mapping',
    title: 'One mapping turns the state of a query into a Readable',
    render: () => <ReadableMapping />,
  },
]
