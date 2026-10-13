import { Lock } from '@exponetdb/icons'
import type { ReactNode } from 'react'

import type { HeadingLevel } from './heading.tsx'
import { StateMessage } from './state-message.tsx'

interface NotPermittedBase {
  /** What the person cannot do or see, as a noun phrase: "backup inventory", "approvals". */
  what: string
  headingLevel?: HeadingLevel
  className?: string
  /** What the person can do about it, if anything. */
  actions?: ReactNode
}

/** At least one of the permission and the scope is named: the state never says "denied" without saying what is missing. */
export type NotPermittedStateProps = NotPermittedBase &
  (
    | {
        /** The missing permission: `backups.read`. */
        permission: string
        /** The missing scope: `data.read:prod`. */
        scope?: string
      }
    | { permission?: string; scope: string }
  )

/** A page the person may not use, naming the permission or scope that is missing. */
export function NotPermittedState({
  what,
  permission,
  scope,
  headingLevel,
  className,
  actions,
}: NotPermittedStateProps): ReactNode {
  return (
    <StateMessage
      data-state="not-permitted"
      icon={<Lock aria-hidden className="size-5 text-foreground-light" />}
      title={`You do not have access to ${what}`}
      headingLevel={headingLevel}
      className={className}
      actions={actions}
    >
      {permission !== undefined && (
        <p>
          Missing permission: <code className="font-mono text-foreground">{permission}</code>
        </p>
      )}
      {scope !== undefined && (
        <p>
          Missing scope: <code className="font-mono text-foreground">{scope}</code>
        </p>
      )}
      <p>Ask someone who can grant it.</p>
    </StateMessage>
  )
}
