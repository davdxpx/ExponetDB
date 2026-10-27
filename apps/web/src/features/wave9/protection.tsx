import { ObservedTime, UntrustedName } from '@exponetdb/ui-patterns'
import type { ReactNode } from 'react'
import { t } from '../../lib/i18n/i18n.ts'
import {
  DRILL_STATE_KEYS,
  formatSeconds,
  type Protection,
  protectionStateOf,
  RPO_BASIS_KEYS,
  reasonKey,
  rpoWithinObjective,
  type WalCoverage,
} from './model.ts'
import { Fact, Facts, Missing, ProtectionBadge } from './parts.tsx'

/**
 * A cluster's protection as the server computed it from the catalog mirror
 * (C-30): the state and every reason it is not `protected`; the recovery
 * point with its basis and uncertainty against the objective (unknown when
 * it was not measured); the recovery time only from the last passed drill;
 * the point-in-time window; the last verified backup; the drill state. Only
 * `protected` is drawn as good.
 */
export function ProtectionView({ protection }: { readonly protection: Protection }): ReactNode {
  const state = protectionStateOf(protection.state)
  const { rpo, rto } = protection
  const within = rpoWithinObjective(rpo)
  return (
    <div className="flex flex-col gap-4" data-protection-view={state}>
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm font-medium">{t('wave9.protection.state')}</span>
        <ProtectionBadge state={state} />
      </div>
      {protection.reasons.length === 0 ? null : (
        <ul
          className="m-0 flex list-disc flex-col gap-1 pl-5 text-sm"
          aria-label={t('wave9.protection.reasons')}
        >
          {protection.reasons.map((code) => {
            const key = reasonKey(code)
            return (
              <li key={code} data-reason-code={code}>
                {key === undefined ? <UntrustedName name={code} mono /> : t(key)}
              </li>
            )
          })}
        </ul>
      )}
      <Facts>
        <Fact label={t('wave9.protection.rpo')} data-fact="rpo">
          {rpo.achievableSeconds === null ? (
            <Missing>{t('wave9.protection.rpo.unknown')}</Missing>
          ) : (
            <span>
              {formatSeconds(rpo.achievableSeconds)}
              {rpo.uncertaintySeconds === null
                ? ` ${t('wave9.protection.rpo.uncertaintyUnknown')}`
                : ` ${t('wave9.protection.rpo.uncertainty', { value: formatSeconds(rpo.uncertaintySeconds) })}`}
            </span>
          )}
          <span className="block text-xs text-foreground-light">
            {t(RPO_BASIS_KEYS[rpo.basis])}
          </span>
          <span className="block text-xs text-foreground-light">
            {rpo.objectiveSeconds === null
              ? t('wave9.protection.objective.none')
              : t('wave9.protection.objective', { value: formatSeconds(rpo.objectiveSeconds) })}
            {within === undefined
              ? null
              : ` ${within ? t('wave9.protection.rpo.within') : t('wave9.protection.rpo.above')}`}
          </span>
        </Fact>
        <Fact label={t('wave9.protection.rto')} data-fact="rto">
          {rto.measuredSeconds === null ? (
            <Missing>{t('wave9.protection.rto.unknown')}</Missing>
          ) : (
            <span>
              {formatSeconds(rto.measuredSeconds)}{' '}
              <span className="block text-xs text-foreground-light">
                {t('wave9.protection.rto.fromDrill')}
                {rto.drillAt === null ? null : (
                  <>
                    {' '}
                    <ObservedTime observedAt={rto.drillAt} withDate />
                  </>
                )}
              </span>
            </span>
          )}
          <span className="block text-xs text-foreground-light">
            {rto.objectiveSeconds === null
              ? t('wave9.protection.objective.none')
              : t('wave9.protection.objective', { value: formatSeconds(rto.objectiveSeconds) })}
          </span>
        </Fact>
        <Fact label={t('wave9.protection.pitr')} data-fact="pitr">
          {protection.pitrWindow === null ? (
            <Missing>{t('wave9.protection.pitr.none')}</Missing>
          ) : (
            <span>
              <ObservedTime observedAt={protection.pitrWindow.from} withDate /> –{' '}
              <ObservedTime observedAt={protection.pitrWindow.to} withDate />
            </span>
          )}
        </Fact>
        <Fact label={t('wave9.protection.lastVerified')} data-fact="verified">
          {protection.lastVerifiedBackupAt === null ? (
            <Missing>{t('wave9.protection.lastVerified.none')}</Missing>
          ) : (
            <ObservedTime observedAt={protection.lastVerifiedBackupAt} withDate />
          )}
        </Fact>
        <Fact label={t('wave9.protection.drill')} data-fact="drill">
          <span data-drill-state={protection.drill.state}>
            {t(DRILL_STATE_KEYS[protection.drill.state])}
          </span>
          {protection.drill.lastPassedAt === null ? null : (
            <span className="block text-xs text-foreground-light">
              {t('wave9.protection.drill.lastPassed')}{' '}
              <ObservedTime observedAt={protection.drill.lastPassedAt} withDate />
            </span>
          )}
          {protection.drill.cadenceDays === null ? null : (
            <span className="block text-xs text-foreground-light">
              {t('wave9.protection.drill.cadence', { days: protection.drill.cadenceDays })}
            </span>
          )}
        </Fact>
      </Facts>
    </div>
  )
}

const LSN = /^[0-9A-F]{1,8}\/[0-9A-F]{1,8}$/

/** An LSN as the server sent it when it has the LSN grammar, else a marker (the text is never shown raw). */
function lsn(value: string): string {
  return LSN.test(value) ? value : t('wave9.wal.badLsn')
}

/** The archived WAL each repository covers, with every gap named (a gap breaks recovery across it). */
export function WalCoverageList({
  coverage,
}: {
  readonly coverage: readonly WalCoverage[]
}): ReactNode {
  if (coverage.length === 0) {
    return (
      <p className="m-0 text-sm text-foreground-light" data-wal="none">
        {t('wave9.wal.none')}
      </p>
    )
  }
  return (
    <ul className="m-0 flex flex-col gap-2 pl-0 text-sm">
      {coverage.map((range) => (
        <li
          key={`${range.repositoryId}-${String(range.timeline)}`}
          className="list-none"
          data-wal={range.repositoryId}
        >
          <span>
            {t('wave9.wal.range', {
              timeline: range.timeline,
              from: lsn(range.from.lsn),
              to: lsn(range.to.lsn),
              repository: range.repositoryId,
            })}
          </span>{' '}
          <span className="text-xs text-foreground-light">
            {t('wave9.wal.observed')} <ObservedTime observedAt={range.observedAt} />
          </span>
          {range.gaps.length === 0 ? null : (
            <span
              className="block text-xs text-warning-600"
              data-wal-gaps={String(range.gaps.length)}
            >
              {t('wave9.wal.gaps', {
                count: range.gaps.length,
                list: range.gaps.map((gap) => `${lsn(gap.fromLsn)}–${lsn(gap.toLsn)}`).join(', '),
              })}
            </span>
          )}
        </li>
      ))}
    </ul>
  )
}
