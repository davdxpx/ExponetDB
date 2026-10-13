import { CircleHelp, Dot, type LucideIcon, PencilLine, Plus, Trash2 } from '@exponetdb/icons'
import { cn } from '@exponetdb/ui'
import { UntrustedName } from '@exponetdb/ui-patterns'
import type { ReactNode } from 'react'

interface MarkerInfo {
  readonly label: string
  readonly icon: LucideIcon
  readonly className: string
}

const MARKERS: Readonly<Record<string, MarkerInfo>> = {
  added: {
    label: 'Added',
    icon: Plus,
    className: 'border-success-500 bg-success-200 text-success-600',
  },
  removed: {
    label: 'Removed',
    icon: Trash2,
    className: 'border-destructive-500 bg-destructive-200 text-destructive-600',
  },
  changed: {
    label: 'Changed',
    icon: PencilLine,
    className: 'border-warning-500 bg-warning-200 text-warning-600',
  },
  unchanged: {
    label: 'Unchanged',
    icon: Dot,
    className: 'border-default bg-transparent text-foreground-lighter',
  },
}

export interface ChangeMarkerProps {
  /** `added`, `removed`, `changed` or `unchanged`; any other word is shown as it is, marked as unknown. */
  readonly change: string
  readonly className?: string
}

/**
 * How an item changed, as an icon and a word (never color alone). A change this
 * version does not know is shown by its own name, never hidden or relabeled.
 */
export function ChangeMarker({ change, className }: ChangeMarkerProps): ReactNode {
  const known = Object.hasOwn(MARKERS, change) ? MARKERS[change] : undefined
  if (known === undefined) {
    return (
      <span
        data-change="unknown"
        className={cn(
          'inline-flex items-center gap-1 rounded-sm border border-warning-500 bg-warning-200 px-1.5 py-0.5 text-xs font-medium text-warning-600',
          className,
        )}
      >
        <CircleHelp aria-hidden="true" className="size-3" />
        <span>Unknown change</span>
        <UntrustedName name={change} mono maxCodePoints={24} label="change" />
      </span>
    )
  }
  const Icon = known.icon
  return (
    <span
      data-change={change}
      className={cn(
        'inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-xs font-medium',
        known.className,
        className,
      )}
    >
      <Icon aria-hidden="true" className="size-3" />
      <span>{known.label}</span>
    </span>
  )
}
