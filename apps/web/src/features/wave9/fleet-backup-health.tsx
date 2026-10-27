import { Card } from '@exponetdb/ui'
import { formatCount, useLinkComponent } from '@exponetdb/ui-patterns'
import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useApi } from '../../lib/api/context.tsx'
import { t } from '../../lib/i18n/i18n.ts'
import { nounPhrase } from '../target/phrases.ts'
import { ReadSection } from '../target-ops/read-section.tsx'
import { overviewCountsQuery } from './keys.ts'
import { backupsHref, PROTECTION_STATES, type ProtectionState } from './model.ts'
import { ProtectionBadge } from './parts.tsx'

const COUNT_KEYS = {
  protected: 'protected',
  at_risk: 'atRisk',
  unprotected: 'unprotected',
  unproven: 'unproven',
  unknown: 'unknown',
} as const

/**
 * The overview's backup slot (PRE-WAVE-11-REVIEW U9): how many clusters are
 * in each protection state, from `getBackupOverview` (counts cover every
 * cluster the person may read), each count a link to `/backups` filtered by
 * it. It reads its own data and renders its own truthful states: loading,
 * failed with the code (never zero), not permitted, stale with its age.
 * Only `protected` is drawn as good.
 */
export function FleetBackupHealth(): ReactNode {
  const { client } = useApi()
  const query = useQuery(overviewCountsQuery(client))
  const Link = useLinkComponent()
  return (
    <ReadSection
      query={{ ...query, refetch: () => query.refetch() }}
      what={nounPhrase('wave9.fleet.what')}
      permission="backups.read"
      ready={(value) => {
        const total = PROTECTION_STATES.reduce(
          (sum, state) => sum + value.counts[COUNT_KEYS[state]],
          0,
        )
        return (
          <Card className="flex flex-col gap-3 p-4" data-state="observed">
            {total === 0 ? (
              <p className="m-0 text-sm text-foreground-light" data-empty="clusters">
                {t('wave9.fleet.none')}
              </p>
            ) : (
              <ul className="m-0 flex flex-col gap-1.5 pl-0" aria-label={t('wave9.global.counts')}>
                {PROTECTION_STATES.map((state: ProtectionState) => (
                  <li
                    key={state}
                    className="flex list-none items-center justify-between gap-3"
                    data-count={state}
                  >
                    <Link href={backupsHref(state)} className="rounded-sm focus-ring">
                      <ProtectionBadge state={state} />
                    </Link>
                    <span className="text-sm tabular-nums">
                      {formatCount(value.counts[COUNT_KEYS[state]])}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <Link href="/backups" className="text-xs text-primary underline focus-ring">
              {t('wave9.fleet.open')}
            </Link>
          </Card>
        )
      }}
    />
  )
}
