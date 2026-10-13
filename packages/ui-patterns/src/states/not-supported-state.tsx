import { StatusIcon } from '@exponetdb/ui'
import type { ReactNode } from 'react'

import { UntrustedName } from '../untrusted/untrusted-name.tsx'
import type { HeadingLevel } from './heading.tsx'
import { StateMessage } from './state-message.tsx'

export interface NotSupportedStateProps {
  /** The feature, as a noun phrase: "Logical replication slots". */
  feature: string
  /** What it needs: "PostgreSQL 15 or later", "the backup.list capability". */
  requires: string
  /** What the target has, as reported by the target: "PostgreSQL 14.9". Shown as untrusted text. */
  found?: string
  headingLevel?: HeadingLevel
  className?: string
  /** What the person can do about it, if anything. */
  actions?: ReactNode
}

/**
 * A feature this target cannot offer (PostgreSQL version or missing capability).
 * It is a fact about the target, not an error and not an empty list: the page
 * says what is needed and what the target has.
 */
export function NotSupportedState({
  feature,
  requires,
  found,
  headingLevel,
  className,
  actions,
}: NotSupportedStateProps): ReactNode {
  return (
    <StateMessage
      data-state="not-supported"
      icon={<StatusIcon variant="info" decorative />}
      title="Not supported on this target"
      headingLevel={headingLevel}
      className={className}
      actions={actions}
    >
      <p>{`${feature} needs ${requires}.`}</p>
      {found !== undefined && (
        <p>
          This target has <UntrustedName name={found} label="target version" />.
        </p>
      )}
    </StateMessage>
  )
}
