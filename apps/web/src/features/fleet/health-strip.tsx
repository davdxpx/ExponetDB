import { cn } from '@exponetdb/ui'
import { formatCount, useLinkComponent } from '@exponetdb/ui-patterns'
import type { ReactNode } from 'react'
import { type MessageKey, t } from '../../lib/i18n/i18n.ts'
import { HEALTH_STATES, HealthChip, type HealthKey } from './health.tsx'
import type { FleetModel } from './model.ts'

const BAR: Readonly<Record<HealthKey, string>> = {
  unhealthy: 'bg-state-unhealthy',
  unreachable: 'bg-destructive',
  degraded: 'bg-state-degraded',
  unknown: 'bg-state-unknown',
  suspended: 'bg-state-stale',
  healthy: 'bg-state-healthy',
}

const WORD: Readonly<Record<HealthKey, MessageKey>> = {
  healthy: 'health.healthy',
  degraded: 'health.degraded',
  unhealthy: 'health.unhealthy',
  unreachable: 'health.unreachable',
  unknown: 'health.unknown',
  suspended: 'health.suspended',
}

/**
 * The health of the fleet at a glance: one bar whose segments are as wide as the share of
 * targets in each state (worst first), then each state as a link to the list filtered by it,
 * with its count. The bar is an image with the counts as its name, so it never says more to the
 * eye than to a screen reader; unknown is its own grey segment and never part of healthy.
 */
export function HealthStrip({ targets }: { readonly targets: FleetModel['targets'] }): ReactNode {
  const Link = useLinkComponent()
  const counts = HEALTH_STATES.map((state) => ({ state, count: targets.byHealth[state] }))
  const counted = counts.reduce((sum, entry) => sum + entry.count, 0)
  const shown = (count: number): string =>
    targets.lowerBound
      ? t('fleet.count.atLeast', { count: formatCount(count) })
      : formatCount(count)
  const summary = counts
    .filter((entry) => entry.count > 0)
    .map((entry) => `${shown(entry.count)} ${t(WORD[entry.state]).toLowerCase()}`)
    .join(', ')
  return (
    <section aria-labelledby="fleet-health" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="fleet-health" className="m-0 text-base font-medium">
          {t('fleet.health.title')}
        </h2>
        <p className="m-0 text-xs text-foreground-light">{t('fleet.health.unknownNote')}</p>
      </div>
      <div
        role="img"
        aria-label={counted === 0 ? t('fleet.health.bar.none') : t('fleet.health.bar', { summary })}
        className="flex h-2.5 w-full gap-px overflow-hidden rounded-full bg-surface-300"
      >
        {counts.map((entry) =>
          entry.count === 0 ? null : (
            <span
              key={entry.state}
              data-health-segment={entry.state}
              className={cn('h-full min-w-1 basis-0', BAR[entry.state])}
              style={{ flexGrow: entry.count }}
            />
          ),
        )}
      </div>
      <ul aria-label={t('fleet.health.caption')} className="m-0 flex list-none flex-wrap gap-2 p-0">
        {counts.map((entry) => (
          <li key={entry.state} data-health-row={entry.state}>
            <Link
              href={`/targets?health=${entry.state}`}
              aria-label={t('fleet.health.openCount', {
                count: shown(entry.count),
                state: t(WORD[entry.state]).toLowerCase(),
              })}
              className={cn(
                'inline-flex items-center gap-2 rounded-md border border-default bg-surface-100 py-1 pr-2.5 pl-1.5 text-sm',
                'transition-colors hover:border-strong hover:bg-surface-200 focus-ring motion-reduce:transition-none',
                entry.count === 0 && 'text-foreground-lighter',
              )}
            >
              <HealthChip state={entry.state} />
              <span className="tabular-nums">{shown(entry.count)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}
