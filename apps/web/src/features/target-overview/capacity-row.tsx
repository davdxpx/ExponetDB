import { formatCount, ObservedTime, type Readable, SourceLabel } from '@exponetdb/ui-patterns'
import type { ReactNode } from 'react'
import { t } from '../../lib/i18n/i18n.ts'
import { readSourceOf } from '../target/gate.ts'
import type { TargetHealth } from '../target/queries.ts'

/**
 * The value of the "Connection slots" row of the target facts: how many client
 * connections the latest sample counted against the slots ordinary roles can
 * use, with the source and time of that measurement. The numbers come from
 * the health read (`capacity`); the page compares them with no limit, for the
 * server alone says when connections are high (the health block lists that).
 *
 * Each case says what it is:
 * - a health read that is running or failed cannot say: said so, and that this
 *   is not a count of zero;
 * - a sample without `capacity` did not measure it (never sampled, the target
 *   unreachable, a read that failed, or an older server): "not reported",
 *   never zero connections;
 * - an old health read keeps its figure and the age of the measurement beside it (the health
 *   block above says the read is an earlier one).
 */
export function CapacityValue(props: { readonly health: Readable<TargetHealth> }): ReactNode {
  const { health } = props
  switch (health.state) {
    case 'loading':
      return <span data-slot="capacity-locating">{t('overview.capacity.locating')}</span>
    case 'failed':
      return (
        <span data-slot="capacity-failed">
          {t('overview.capacity.healthFailed', {
            reason: t('error.withCode', {
              message: health.error.message,
              code: health.error.code,
            }),
          })}
        </span>
      )
    default: {
      const capacity = health.value.capacity
      if (capacity === undefined) {
        return (
          <span className="flex flex-col gap-1" data-slot="capacity-none">
            <span>{t('overview.capacity.none')}</span>
          </span>
        )
      }
      const source = readSourceOf(capacity.source)
      return (
        <span className="flex flex-col gap-1" data-slot="capacity">
          <span data-slot="capacity-value">
            {t('overview.capacity.value', {
              used: formatCount(capacity.clientBackends),
              usable: formatCount(capacity.usableSlots),
            })}
          </span>
          <span className="flex flex-wrap items-center gap-2 text-xs text-foreground-light">
            {source === undefined ? null : <SourceLabel source={source} />}
            <span>
              {t('overview.capacity.measured')}{' '}
              <ObservedTime observedAt={capacity.observedAt} seconds />
            </span>
          </span>
        </span>
      )
    }
  }
}
