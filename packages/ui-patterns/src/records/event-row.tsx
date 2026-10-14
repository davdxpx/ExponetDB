import { Loader2 } from '@exponetdb/icons'
import { cn, StatusIcon } from '@exponetdb/ui'
import type { ReactNode } from 'react'
import { useLinkComponent } from '../seams/index.ts'
import type { NowInput } from '../states/format.ts'
import { ObservedTime } from '../states/observed-time.tsx'
import { UntrustedName } from '../untrusted/untrusted-name.tsx'
import { isAppPath } from './app-path.ts'

/** How an audited event ended. */
export type EventOutcome = 'succeeded' | 'failed' | 'denied' | 'pending'

/** App paths the caller built from typed ids (`/changes/plans/pln_…`); never a link taken from content. */
export interface EventLinks {
  plan?: string
  operation?: string
  ledger?: string
}

export interface EventRowProps {
  /** Who acted: a pseudonymous label such as `human #3`. Shown as untrusted text. */
  actor: string
  /** The client the actor used, as the client named itself. Shown as untrusted text, marked "name not verified". */
  client?: string
  /** The audited action, `<domain>.<verb>`: `migrations.apply`. */
  action: string
  /** What the action was about, such as a target path. Shown as untrusted text. */
  subject?: string
  outcome: EventOutcome
  /** The stable error code of a failed or denied outcome. */
  errorCode?: string
  /** ISO 8601 time of the event. */
  occurredAt: string
  links?: EventLinks
  now?: NowInput
  /** The element: `li` inside a list, `div` otherwise. Default `div`. */
  as?: 'div' | 'li'
  className?: string
}

const OUTCOME_LABELS: Readonly<Record<EventOutcome, string>> = {
  succeeded: 'Succeeded',
  failed: 'Failed',
  denied: 'Denied',
  pending: 'Pending',
}

function OutcomeIcon({ outcome }: { outcome: EventOutcome }): ReactNode {
  switch (outcome) {
    case 'succeeded':
      return <StatusIcon variant="success" hideBackground decorative />
    case 'failed':
      return <StatusIcon variant="destructive" hideBackground decorative />
    case 'denied':
      return <StatusIcon variant="warning" hideBackground decorative />
    case 'pending':
      return (
        <Loader2
          aria-hidden="true"
          className="size-3 animate-spin text-foreground-lighter motion-reduce:animate-none"
        />
      )
  }
}

/**
 * One audited event: who acted (and with which client), the action, what it was
 * about, how it ended and when, with links to the plan, the operation and the
 * ledger. The actor, client and subject are untrusted text; the client carries
 * the marker "name not verified". The outcome is an icon of its own shape and a
 * word, with the stable error code when there is one.
 */
export function EventRow({
  actor,
  client,
  action,
  subject,
  outcome,
  errorCode,
  occurredAt,
  links,
  now,
  as: Tag = 'div',
  className,
}: EventRowProps): ReactNode {
  const Link = useLinkComponent()
  const candidates: { key: string; label: string; href: string }[] = []
  if (links?.plan !== undefined)
    candidates.push({ key: 'plan', label: 'View plan', href: links.plan })
  if (links?.operation !== undefined) {
    candidates.push({ key: 'operation', label: 'View operation', href: links.operation })
  }
  if (links?.ledger !== undefined) {
    candidates.push({ key: 'ledger', label: 'View ledger entry', href: links.ledger })
  }
  // A target that is not an app path is left out: it is not made into a link.
  const targets = candidates.filter((target) => isAppPath(target.href))

  return (
    <Tag
      data-outcome={outcome}
      className={cn(
        'flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-default px-3 py-2 text-sm',
        className,
      )}
    >
      <span className="w-full shrink-0 text-foreground-lighter sm:w-48">
        <ObservedTime observedAt={occurredAt} withDate now={now} />
      </span>
      <span className="min-w-0 flex-1">
        <UntrustedName name={actor} label="actor" />
        {client !== undefined && (
          <>
            {' via '}
            <UntrustedName name={client} unverified label="client name" />
          </>
        )}{' '}
        <code className="font-mono break-all text-foreground">{action}</code>
        {subject !== undefined && (
          <>
            {' on '}
            <UntrustedName name={subject} mono label="subject" />
          </>
        )}
      </span>
      <span className="inline-flex items-center gap-1 rounded-md border border-default px-2 py-0.5 text-xs leading-4 whitespace-nowrap">
        <OutcomeIcon outcome={outcome} />
        {Object.hasOwn(OUTCOME_LABELS, outcome) ? (
          OUTCOME_LABELS[outcome]
        ) : (
          // An outcome this version does not know is shown by its name, never as an empty badge.
          <UntrustedName name={outcome} maxCodePoints={40} label="outcome" />
        )}
        {errorCode !== undefined && (
          <code className="font-mono text-foreground-light">{errorCode}</code>
        )}
      </span>
      {targets.length > 0 && (
        <span className="inline-flex gap-3">
          {targets.map((target) => (
            <Link key={target.key} href={target.href} className="text-foreground underline">
              {target.label}
            </Link>
          ))}
        </span>
      )}
    </Tag>
  )
}
