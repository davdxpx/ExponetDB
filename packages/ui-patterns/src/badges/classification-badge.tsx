import {
  Eye,
  type LucideIcon,
  PencilLine,
  RefreshCw,
  ShieldAlert,
  Trash2,
  Unlink,
} from '@exponetdb/icons'
import { Badge, cn, Tooltip, TooltipContent, TooltipTrigger } from '@exponetdb/ui'
import type { ReactNode } from 'react'

/**
 * Classes of a migration statement (destructive, rewrite, non-transactional,
 * security) and of SQL in the editor (read-only, write).
 */
export type StatementClassification =
  | 'destructive'
  | 'rewrite'
  | 'non_transactional'
  | 'security'
  | 'read_only'
  | 'write'

interface ClassificationInfo {
  readonly label: string
  /** One sentence for the tooltip. */
  readonly explanation: string
  readonly variant: 'default' | 'warning' | 'destructive'
  readonly icon: LucideIcon | undefined
}

const CLASSIFICATIONS: Readonly<Record<StatementClassification, ClassificationInfo>> = {
  destructive: {
    icon: Trash2,
    label: 'Destructive',
    explanation: 'Removes data or objects that only a backup can bring back.',
    variant: 'destructive',
  },
  rewrite: {
    icon: RefreshCw,
    label: 'Rewrite',
    explanation: 'Rewrites a whole table and holds a lock on it until the rewrite ends.',
    variant: 'warning',
  },
  non_transactional: {
    icon: Unlink,
    label: 'Non-transactional',
    explanation: 'Runs outside a transaction, so a failure can leave the change half applied.',
    variant: 'warning',
  },
  security: {
    icon: ShieldAlert,
    label: 'Security',
    explanation: 'Changes roles, grants, policies or other access to data.',
    variant: 'warning',
  },
  read_only: {
    icon: Eye,
    label: 'Read-only',
    explanation: 'Reads data and changes nothing.',
    variant: 'default',
  },
  write: {
    icon: PencilLine,
    label: 'Write',
    explanation: 'Changes data or the schema.',
    variant: 'warning',
  },
}

function isKnownClassification(value: string): value is StatementClassification {
  return Object.hasOwn(CLASSIFICATIONS, value)
}

function classificationInfo(classification: string): ClassificationInfo {
  if (isKnownClassification(classification)) return CLASSIFICATIONS[classification]
  // A class this version does not know is shown by its name, never hidden.
  return {
    label: classification,
    explanation: 'This version of the Web App does not know this class.',
    variant: 'warning',
    icon: undefined,
  }
}

export interface ClassificationBadgeProps {
  readonly classification: StatementClassification
  readonly className?: string
}

/**
 * A classification as a badge with an icon and its name (never color alone);
 * focusing or hovering it shows what the class means in one sentence. Needs a
 * `TooltipProvider` above it (the app has one).
 */
export function ClassificationBadge({
  classification,
  className,
}: ClassificationBadgeProps): ReactNode {
  const info = classificationInfo(classification)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* Focusable so the explanation opens from the keyboard too. */}
        <Badge
          tabIndex={0}
          variant={info.variant}
          data-classification={classification}
          className={cn('focus-ring', className)}
        >
          {info.icon === undefined ? null : <info.icon aria-hidden className="size-3" />}
          {/* UntrustedText: an unknown class is server text. */}
          <span>{info.label}</span>
        </Badge>
      </TooltipTrigger>
      <TooltipContent>{info.explanation}</TooltipContent>
    </Tooltip>
  )
}
