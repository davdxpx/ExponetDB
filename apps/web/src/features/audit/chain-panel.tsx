import { Button } from '@exponetdb/ui'
import {
  type ChainVerification,
  ChainVerificationIndicator,
  type KeyValueItem,
  KeyValueList,
  NotPermittedState,
  type Readable,
  TimestampInfo,
} from '@exponetdb/ui-patterns'
import type { ReactNode } from 'react'
import { type MessageKey, t } from '../../lib/i18n/i18n.ts'
import { classifyFailure } from '../../lib/query/errors.ts'
import type { AuditChain } from './keys.ts'

/**
 * The chain verification indicator (audit.md §4, `GET /audit-events/chain`):
 * "verified up to sequence N at time T", the failure with its sequence and
 * reason, or "not verified yet" with why. A failed read says the state is not
 * known: it is never shown as intact. The facts below it are the server's
 * (head, scope of the check, the worker's runs, whose results are not kept,
 * and the exporters' progress); none of them is a verdict of its own.
 */
export function toVerification(chain: AuditChain): ChainVerification {
  const v = chain.verification
  switch (v.status) {
    case 'verified':
      return { status: 'verified', throughSequence: v.throughSeq, verifiedAt: v.verifiedAt }
    case 'broken':
      return { status: 'broken', atSequence: v.failingSeq, checkedAt: v.verifiedAt }
    case 'not_verified':
      return { status: 'not_checked' }
  }
}

export function chainReadable(read: Readable<AuditChain>): Readable<ChainVerification> {
  switch (read.state) {
    case 'loading':
    case 'failed':
      return read
    case 'stale':
      return { ...read, value: toVerification(read.value) }
    case 'partial':
      return { ...read, value: toVerification(read.value) }
    case 'ready':
      return { ...read, value: toVerification(read.value) }
  }
}

const BROKEN: Readonly<Record<string, MessageKey>> = {
  sequence_gap: 'audit.chain.broken.sequence_gap',
  prev_hash_mismatch: 'audit.chain.broken.prev_hash_mismatch',
  not_canonical: 'audit.chain.broken.not_canonical',
  invalid_event: 'audit.chain.broken.invalid_event',
  columns_mismatch: 'audit.chain.broken.columns_mismatch',
  hash_mismatch: 'audit.chain.broken.hash_mismatch',
  checkpoint_mismatch: 'audit.chain.broken.checkpoint_mismatch',
  anchor_missing: 'audit.chain.broken.anchor_missing',
}

function brokenReason(reason: string): string {
  const key = Object.hasOwn(BROKEN, reason) ? BROKEN[reason] : undefined
  return key === undefined ? t('audit.chain.reason.other', { code: reason }) : t(key)
}

/** One sentence on what the verification covered, failed on, or why it did not run. */
export function verificationDetail(chain: AuditChain): string {
  const v = chain.verification
  switch (v.status) {
    case 'verified':
      return v.scope === 'full'
        ? t('audit.chain.verified.full', { count: v.verifiedEvents, through: v.throughSeq })
        : t('audit.chain.verified.fromCheckpoint', {
            count: v.verifiedEvents,
            from: v.fromSeq,
            through: v.throughSeq,
          })
    case 'broken':
      return t('audit.chain.broken', { seq: v.failingSeq, reason: brokenReason(v.reason) })
    case 'not_verified':
      if (v.reason === 'too_many_events') {
        return t('audit.chain.notVerified.tooMany', { count: v.eventsSinceAnchor, limit: v.limit })
      }
      if (v.reason === 'empty_chain') return t('audit.chain.notVerified.empty')
      return t('audit.chain.notVerified.other', { code: v.reason })
  }
}

type Run = AuditChain['workerVerification']['full']

function runText(run: Run): ReactNode {
  if (run === null) return t('audit.chain.run.never')
  const outcome =
    run.outcome === 'succeeded'
      ? t('audit.chain.run.succeeded')
      : run.outcome === 'failed'
        ? t('audit.chain.run.failed', { code: run.reason ?? '' })
        : run.outcome === 'skipped'
          ? t('audit.chain.run.skipped')
          : t('audit.chain.run.notYet')
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-2">
      <span>{outcome}</span>
      {run.finishedAt === null ? null : <TimestampInfo timestamp={run.finishedAt} />}
      <span className="text-foreground-lighter">
        {t('audit.chain.run.next')} <TimestampInfo timestamp={run.nextRunAt} />
      </span>
    </span>
  )
}

export function ChainPanel({
  read,
  error,
  onRecheck,
  busy,
}: {
  readonly read: Readable<AuditChain>
  readonly error: unknown
  readonly onRecheck: () => void
  readonly busy: boolean
}): ReactNode {
  if (read.state === 'failed' && classifyFailure(error).kind === 'not_permitted') {
    return (
      <NotPermittedState what={t('audit.chain.what')} permission="audit.read" headingLevel={3} />
    )
  }
  const chain = read.state === 'loading' || read.state === 'failed' ? undefined : read.value
  const facts: KeyValueItem[] =
    chain === undefined
      ? []
      : [
          {
            id: 'head',
            label: t('audit.chain.head'),
            value:
              chain.head === null ? (
                t('audit.chain.head.none')
              ) : (
                <span className="inline-flex flex-wrap items-baseline gap-x-2">
                  <span>{t('audit.chain.head.value', { seq: chain.head.seq })}</span>
                  <TimestampInfo timestamp={chain.head.occurredAt} />
                </span>
              ),
          },
          {
            id: 'checkpoint',
            label: t('audit.chain.checkpoint'),
            value:
              chain.checkpoints[0] === undefined
                ? t('audit.chain.checkpoint.none')
                : t('audit.chain.checkpoint.value', {
                    seq: chain.checkpoints[0].seq,
                    count: chain.checkpoints.length,
                  }),
          },
          {
            id: 'worker-full',
            label: t('audit.chain.worker.full'),
            value: runText(chain.workerVerification.full),
          },
          {
            id: 'worker-incremental',
            label: t('audit.chain.worker.incremental'),
            value: runText(chain.workerVerification.incremental),
          },
          {
            id: 'exports',
            label: t('audit.chain.exports'),
            value:
              chain.exports.sinks.length === 0 ? (
                t('audit.chain.exports.none')
              ) : (
                <ul className="flex flex-col gap-0.5">
                  {chain.exports.sinks.map((sink, index) => (
                    <li key={`${sink.kind}-${String(index)}`}>
                      {t(
                        sink.state === 'up_to_date'
                          ? 'audit.chain.exports.upToDate'
                          : 'audit.chain.exports.behind',
                        {
                          kind: sink.kind,
                          seq: sink.lastExportedSeq ?? '—',
                          pending: sink.pendingCheckpoints,
                        },
                      )}
                    </li>
                  ))}
                </ul>
              ),
          },
        ]
  return (
    <div id="audit-chain" className="flex flex-col gap-3 rounded-lg border border-default p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <ChainVerificationIndicator verification={chainReadable(read)} />
        <Button type="button" size="tiny" variant="outline" loading={busy} onClick={onRecheck}>
          {t('audit.chain.recheck')}
        </Button>
      </div>
      {chain === undefined ? null : (
        <>
          <p className="chain-detail text-sm text-foreground-light">
            {chain.verification.status === 'not_verified'
              ? t('audit.chain.notVerified', { detail: verificationDetail(chain) })
              : verificationDetail(chain)}
          </p>
          <KeyValueList items={facts} />
          <p className="text-xs text-foreground-lighter">{t('audit.chain.notPersisted')}</p>
        </>
      )}
    </div>
  )
}
