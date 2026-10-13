import { formatAge, formatUtc, type NowInput } from '@exponetdb/ui-patterns'

import { MARKER_META } from './migration-marker.tsx'
import type { ResolvedCell } from './model.ts'

/** A state whose "when" is worth saying: the others (not applied, pending, unknown) have no time. */
const STATES_WITH_TIME: ReadonlySet<string> = new Set([
  'applied',
  'verified',
  'failed',
  'drifted',
  'reverted',
])

function when(iso: string, now: NowInput): string | undefined {
  const utc = formatUtc(iso)
  if (utc === undefined) return undefined
  const age = formatAge(iso, now)
  return age === undefined ? utc : `${utc} (${age})`
}

/**
 * What the hover and focus text of a cell says besides the meaning of its state, as sentences: why
 * the state is unknown when the read holds no (or several) cells, when the state was reached, and
 * when the mirror was last written. A time that is not a date is said to be unknown, never replaced
 * by a plausible one.
 */
export function describeCellTimes(
  cell: Pick<ResolvedCell, 'state' | 'at' | 'observedAt' | 'recorded' | 'conflicting'>,
  now: NowInput,
): readonly string[] {
  if (cell.conflicting) return ['The read holds more than one record for this environment.']
  if (!cell.recorded) return ['The read holds no record for this environment.']

  const sentences: string[] = []
  const label = MARKER_META[cell.state]?.label ?? 'Reached'
  if (cell.at !== undefined) {
    const text = when(cell.at, now)
    sentences.push(text === undefined ? `${label} at an unknown time.` : `${label} at ${text}.`)
  } else if (STATES_WITH_TIME.has(cell.state)) {
    sentences.push('The time of this state was not recorded.')
  }
  if (cell.observedAt !== undefined) {
    const text = when(cell.observedAt, now)
    sentences.push(
      text === undefined
        ? 'The mirror was last written at an unknown time.'
        : `The mirror was last written at ${text}.`,
    )
  } else {
    sentences.push('The time the mirror was last written was not recorded.')
  }
  return sentences
}
