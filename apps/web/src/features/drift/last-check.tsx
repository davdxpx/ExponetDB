import type { DriftCheckSummary } from '@exponetdb/sdk/operations'
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@exponetdb/ui'
import { KeyValueList, MarkedCode, ObservedTime, UntrustedName } from '@exponetdb/ui-patterns'
import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useApi } from '../../lib/api/context.tsx'
import { type MessageKey, t } from '../../lib/i18n/i18n.ts'
import { nounPhrase } from '../target/phrases.ts'
import type { Target } from '../target/queries.ts'
import { driftChecksQuery } from '../target-ops/keys.ts'
import { useTargetPath } from '../target-ops/links.ts'
import { ReadSection } from '../target-ops/read-section.tsx'
import {
  type CheckStatus,
  type CountName,
  checkStatusOf,
  compared,
  countsOf,
} from './drift-model.ts'

const STATUS_LABEL: Readonly<Record<CheckStatus, MessageKey>> = {
  clean: 'drift.last.status.clean',
  drifted: 'drift.last.status.drifted',
  incomplete: 'drift.last.status.incomplete',
  no_baseline: 'drift.last.status.no_baseline',
  not_comparable: 'drift.last.status.not_comparable',
  failed: 'drift.last.status.failed',
}

/** What a status that compared nothing means, so a check that did not compare is never read as a clean one. */
const STATUS_NOTE: Readonly<Partial<Record<CheckStatus, MessageKey>>> = {
  incomplete: 'drift.last.status.incomplete.note',
  no_baseline: 'drift.last.status.no_baseline.note',
  not_comparable: 'drift.last.status.not_comparable.note',
  failed: 'drift.last.status.failed.note',
}

const COUNT_LABEL: Readonly<Record<CountName, MessageKey>> = {
  drifted: 'drift.count.drifted',
  unmanaged: 'drift.count.unmanaged',
  matched: 'drift.count.matched',
  opened: 'drift.count.opened',
  updated: 'drift.count.updated',
  resolved: 'drift.count.resolved',
}

/**
 * The last drift check ExponetDB recorded for the target, and the few before
 * it. Read from the Control Store on mount, so the page says when the target
 * was last checked and by whom without anyone pressing a button; a failed
 * read is a failed read, and "no check recorded" is said only after a
 * successful read that found none. The findings of a check are not stored
 * with it: the page says so and points at the open findings it does keep.
 */
export function LastCheck({ target }: { readonly target: Target }): ReactNode {
  const { client } = useApi()
  const path = useTargetPath()
  const query = useQuery(driftChecksQuery(client, path))
  return (
    <div className="flex flex-col gap-2" data-slot="last-check">
      <h3 className="m-0 text-sm font-medium">{t('drift.last.title')}</h3>
      <ReadSection
        query={query}
        what={nounPhrase('drift.last.what')}
        permission="diagnostics.read"
        empty={{
          isEmpty: (value) => value.items.length === 0,
          content: (
            <p className="m-0 text-sm text-foreground-light" data-slot="last-check-none">
              {t('drift.last.none')}
            </p>
          ),
        }}
        ready={(value) => {
          const [latest, ...earlier] = value.items
          if (latest === undefined) return null
          return (
            <div className="flex flex-col gap-3">
              <Latest check={latest} target={target} />
              <p className="m-0 text-xs text-foreground-light">{t('drift.last.findingsNote')}</p>
              {earlier.length === 0 ? null : (
                <History checks={value.items} more={value.nextCursor !== null} />
              )}
            </div>
          )
        }}
      />
    </div>
  )
}

/** Who ran a check: the schedule, or the identity (a person or a service account) as untrusted text. */
function Requester({ check }: { readonly check: DriftCheckSummary }): ReactNode {
  const by = check.requestedBy
  switch (by.kind) {
    case 'schedule':
      return <span>{t('drift.by.schedule')}</span>
    case 'identity':
      return (
        <span className="inline-flex flex-wrap items-center gap-x-1">
          {t('drift.by.identity')}
          <UntrustedName name={by.identityId} mono label={t('drift.history.column.by')} />
        </span>
      )
    default:
      return <span>{t('drift.by.unknown')}</span>
  }
}

function StatusText({ status }: { readonly status: string }): ReactNode {
  const known = checkStatusOf(status)
  return known === undefined ? (
    <UntrustedName name={status} label={t('drift.check.status')} />
  ) : (
    <span>{t(STATUS_LABEL[known])}</span>
  )
}

function Fingerprint({ value }: { readonly value: string | null }): ReactNode {
  return value === null ? (
    <span className="text-foreground-light">{t('drift.last.notRecorded')}</span>
  ) : (
    <MarkedCode text={value} />
  )
}

function Latest({
  check,
  target,
}: {
  readonly check: DriftCheckSummary
  readonly target: Target
}): ReactNode {
  const known = checkStatusOf(check.status)
  const note = known === undefined ? undefined : STATUS_NOTE[known]
  const didCompare = compared(check.status)
  return (
    <div className="flex flex-col gap-2 text-sm" data-drift-last={check.id}>
      <p className="m-0">
        {t('drift.last.checked')} <ObservedTime observedAt={check.finishedAt} withDate />
      </p>
      <KeyValueList
        items={[
          {
            id: 'by',
            label: t('drift.history.column.by'),
            value: <Requester check={check} />,
          },
          {
            id: 'status',
            label: t('drift.check.status'),
            value: <StatusText status={check.status} />,
          },
          ...(check.errorCode === null
            ? []
            : [
                {
                  id: 'error',
                  label: t('drift.check.errorCode'),
                  value: <code className="font-mono">{check.errorCode}</code>,
                },
              ]),
          // The counts of a check that compared nothing are not a result: the row is left out, never zeros.
          ...(didCompare
            ? [
                {
                  id: 'counts',
                  label: t('drift.last.counts'),
                  value: (
                    <ul className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0">
                      {countsOf(check).map(([name, count]) => (
                        <li key={name}>
                          {t(COUNT_LABEL[name])}: <strong>{count}</strong>
                        </li>
                      ))}
                    </ul>
                  ),
                },
              ]
            : []),
          {
            id: 'baseline',
            label: t('drift.last.baseline'),
            value: <Fingerprint value={check.baselineFingerprint} />,
          },
          {
            id: 'current',
            label: t('drift.last.current'),
            value: <Fingerprint value={check.currentFingerprint} />,
          },
        ]}
      />
      {didCompare ? null : (
        <p role="note" className="m-0" data-slot="last-check-status-note">
          {note === undefined
            ? t('drift.last.status.unknown')
            : `${t(note)} ${t('drift.last.status.nothing')}`}
        </p>
      )}
      {check.generation === target.generation ? null : (
        <p role="note" className="m-0" data-slot="last-check-generation">
          {t('drift.last.otherGeneration', {
            generation: check.generation,
            current: target.generation,
          })}
        </p>
      )}
    </div>
  )
}

/** The last checks, newest first, in a fold: the page opens on the last one alone. */
function History({
  checks,
  more,
}: {
  readonly checks: readonly DriftCheckSummary[]
  readonly more: boolean
}): ReactNode {
  return (
    <details className="rounded-md border border-default" data-slot="check-history">
      <summary className="cursor-pointer px-3 py-2 text-sm font-medium focus-ring">
        {t('drift.history.title', { count: checks.length })}
      </summary>
      <div className="flex flex-col gap-2 p-3">
        <Table>
          <TableCaption className="sr-only">{t('drift.history.caption')}</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">{t('drift.history.column.checked')}</TableHead>
              <TableHead scope="col">{t('drift.history.column.by')}</TableHead>
              <TableHead scope="col">{t('drift.history.column.status')}</TableHead>
              <TableHead scope="col">{t('drift.history.column.result')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {checks.map((check) => (
              <TableRow key={check.id} data-check={check.id}>
                <TableCell>
                  <ObservedTime observedAt={check.finishedAt} withDate />
                </TableCell>
                <TableCell>
                  <Requester check={check} />
                </TableCell>
                <TableCell>
                  <StatusText status={check.status} />
                </TableCell>
                <TableCell>
                  {compared(check.status) ? (
                    t('drift.history.result', {
                      drifted: check.counts.drifted,
                      unmanaged: check.counts.unmanaged,
                      matched: check.counts.matched,
                    })
                  ) : (
                    <span className="text-foreground-light">{t('drift.history.noResult')}</span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {more ? (
          <p className="m-0 text-xs text-foreground-light">
            {t('drift.history.older', { count: checks.length })}
          </p>
        ) : null}
      </div>
    </details>
  )
}
