import { AlertTriangle, Check, Circle, CircleHelp, Clock, RefreshCw, X } from '@exponetdb/icons'
import { cn } from '@exponetdb/ui'
import type { ReactNode } from 'react'

import type { MigrationMarkerState } from './types.ts'

export interface MarkerMeta {
  /** The word the marker shows. */
  readonly label: string
  /** What the state means, for the legend and for help text. */
  readonly description: string
}

/** The word and the meaning of each marker. Text carries the state; icon and color repeat it. */
export const MARKER_META: Readonly<Record<MigrationMarkerState, MarkerMeta>> = {
  not_applied: {
    label: 'Not applied',
    description: 'The mirror holds no ledger row for this bundle on this environment.',
  },
  pending: {
    label: 'Pending',
    description: 'A plan or operation for this bundle is queued or running and has not finished.',
  },
  applied: {
    label: 'Applied',
    description:
      'The ledger has a row for this bundle, and no passed verification is mirrored yet.',
  },
  verified: {
    label: 'Verified',
    description: 'Applied, and the latest mirrored verification passed.',
  },
  failed: {
    label: 'Failed',
    description: 'The latest apply or verification failed, was partial or ended in an error.',
  },
  drifted: {
    label: 'Drifted',
    description:
      "The target's ledger differs from the mirror or the bundle in a way no ExponetDB operation explains.",
  },
  reverted: {
    label: 'Reverted',
    description: 'The ledger row for this bundle was reverted.',
  },
  unknown: {
    label: 'Unknown',
    description:
      'The mirror holds no record of this environment at its current generation. This does not mean the bundle is absent.',
  },
}

/** Applied and verified differ by one check mark; every other state has a shape of its own. */
function Glyph({ state }: { state: MigrationMarkerState }): ReactNode {
  switch (state) {
    case 'not_applied':
      return <Circle aria-hidden="true" className="size-3 text-foreground-lighter" />
    case 'pending':
      return <Clock aria-hidden="true" className="size-3 text-foreground-light" />
    case 'applied':
      return <Check aria-hidden="true" className="size-3 text-foreground-light" />
    case 'verified':
      return (
        <span aria-hidden="true" className="inline-flex items-center text-success">
          <Check className="size-3" />
          <Check className="-ml-1.5 size-3" />
        </span>
      )
    case 'failed':
      return <X aria-hidden="true" className="size-3 text-destructive" />
    case 'drifted':
      return <AlertTriangle aria-hidden="true" className="size-3 text-warning" />
    case 'reverted':
      return <RefreshCw aria-hidden="true" className="size-3 text-foreground-light" />
    case 'unknown':
      return <CircleHelp aria-hidden="true" className="size-3 text-foreground-lighter" />
  }
}

export interface MigrationMarkerProps {
  state: MigrationMarkerState
  className?: string
}

/**
 * The state of one bundle on one environment: an icon of its own shape and the word (Verified,
 * Applied, Failed, Drifted, Pending, Not applied, Reverted, Unknown). Never color alone. `unknown`
 * is never drawn like `not applied`: it means the mirror cannot say.
 */
export function MigrationMarker({ state, className }: MigrationMarkerProps): ReactNode {
  const meta = MARKER_META[state] ?? MARKER_META.unknown
  return (
    <span
      data-marker-state={state}
      className={cn(
        'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs leading-4 font-medium whitespace-nowrap text-foreground',
        state === 'not_applied' || state === 'unknown' ? 'border-dashed' : 'border-solid',
        'border-default',
        className,
      )}
    >
      <Glyph state={state} />
      {meta.label}
    </span>
  )
}
