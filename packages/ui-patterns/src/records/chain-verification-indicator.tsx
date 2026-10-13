import { CircleHelp, Loader2 } from '@exponetdb/icons'
import { cn, StatusIcon } from '@exponetdb/ui'
import type { ReactNode } from 'react'

import type { Readable } from '../readable.ts'
import { formatCount, type NowInput } from '../states/format.ts'
import { ObservedTime } from '../states/observed-time.tsx'

/** The result of verifying the audit chain. */
export type ChainVerification =
  | {
      readonly status: 'verified'
      /** The last sequence number the verification covered. */
      readonly throughSequence: number
      /** ISO 8601 time of the verification. */
      readonly verifiedAt: string
    }
  | {
      readonly status: 'broken'
      /** The first sequence number at which the chain does not hold. */
      readonly atSequence: number
      /** ISO 8601 time of the verification, if known. */
      readonly checkedAt?: string
    }
  | { readonly status: 'not_checked' }

export interface ChainVerificationIndicatorProps {
  /** The verification as read. A failed read is shown as unreadable, never as "not checked". */
  verification: Readable<ChainVerification>
  now?: NowInput
  className?: string
}

interface VerdictParts {
  readonly icon: ReactNode
  readonly text: ReactNode
  readonly tone: 'ok' | 'bad' | 'neutral'
}

function verdictParts(result: ChainVerification, now?: NowInput): VerdictParts {
  switch (result.status) {
    case 'verified':
      return {
        tone: 'ok',
        icon: <StatusIcon variant="success" decorative />,
        text: (
          <>
            {`Chain verified up to sequence ${formatCount(result.throughSequence)}, `}
            <ObservedTime observedAt={result.verifiedAt} withDate now={now} />
          </>
        ),
      }
    case 'broken':
      return {
        tone: 'bad',
        icon: <StatusIcon variant="destructive" decorative />,
        text: (
          <>
            {`Chain broken at sequence ${formatCount(result.atSequence)}`}
            {result.checkedAt !== undefined && (
              <>
                {', checked '}
                <ObservedTime observedAt={result.checkedAt} withDate now={now} />
              </>
            )}
          </>
        ),
      }
    case 'not_checked':
      return {
        tone: 'neutral',
        icon: <CircleHelp aria-hidden="true" className="size-4 text-foreground-lighter" />,
        text: 'Chain not checked',
      }
  }
}

/**
 * Whether the audit chain was verified (audit is hash-chained and append-only):
 * "verified up to sequence N at time T", "broken at sequence N" or "not
 * checked", each with its own icon and in words. A loading read says so, and a
 * failed read says the verification could not be read, which is neither
 * "intact" nor "broken". A broken chain is announced at once.
 */
export function ChainVerificationIndicator({
  verification,
  now,
  className,
}: ChainVerificationIndicatorProps): ReactNode {
  const base = cn('inline-flex flex-wrap items-center gap-x-2 gap-y-1 text-sm', className)
  switch (verification.state) {
    case 'loading':
      return (
        <p role="status" className={base} data-chain="loading">
          <Loader2
            aria-hidden="true"
            className="size-4 animate-spin text-foreground-lighter motion-reduce:animate-none"
          />
          Checking the audit chain
        </p>
      )
    case 'failed':
      return (
        <p role="alert" className={base} data-chain="unreadable">
          <StatusIcon variant="warning" decorative />
          <span>
            {`Could not read the chain verification: ${verification.error.message} `}
            <code className="font-mono">{verification.error.code}</code>
            {'. This does not mean the chain is intact or broken.'}
          </span>
        </p>
      )
    case 'stale':
    case 'partial': {
      const { icon, text, tone } = verdictParts(verification.value, now)
      const note =
        verification.state === 'stale'
          ? 'Earlier read, '
          : `Partial read (${verification.missing.join('; ')}), `
      return (
        <p
          role={tone === 'bad' ? 'alert' : 'status'}
          className={base}
          data-chain={verification.value.status}
        >
          {icon}
          <span>
            {note}
            {text}
          </span>
        </p>
      )
    }
    case 'ready': {
      const { icon, text, tone } = verdictParts(verification.value, now)
      return (
        <p
          role={tone === 'bad' ? 'alert' : 'status'}
          className={base}
          data-chain={verification.value.status}
        >
          {icon}
          <span>{text}</span>
        </p>
      )
    }
    default:
      return (
        <p role="alert" className={base} data-chain="unreadable">
          <StatusIcon variant="warning" decorative />
          <span>The chain verification could not be read: its state was not recognized.</span>
        </p>
      )
  }
}
