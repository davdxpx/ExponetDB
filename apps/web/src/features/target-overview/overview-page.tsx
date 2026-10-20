import type { Target } from '@exponetdb/sdk/operations'
import {
  type KeyValueItem,
  KeyValueList,
  ObservedTime,
  SourceLabel,
  UntrustedName,
} from '@exponetdb/ui-patterns'
import type { ReactNode } from 'react'
import { t } from '../../lib/i18n/i18n.ts'
import { readSourceOf } from '../target/gate.ts'
import { type TargetHealth, type TargetRead, useTargetHealth } from '../target/queries.ts'
import { useTargetScope } from '../target/scope.tsx'
import { FindingsBlock, OperationsBlock } from './activity-blocks.tsx'
import { Block } from './block.tsx'
import { HealthBlock } from './health-block.tsx'
import { HistoryBlock } from './history-block.tsx'
import { HostValue } from './host-row.tsx'
import { MigrationsBlock } from './migrations-block.tsx'
import { RefreshBar } from './overview-refresh.tsx'

/**
 * The body of the target overview (information-architecture.md §2.2): health
 * in incident order, what the target is, the health history, the migration
 * head against the other environments, recent operations and open findings.
 * Each block reads on its own and fails on its own; the target read the
 * layout started gates the page, so this body only renders once there is a
 * target to show.
 */
export function TargetOverviewBody(props: { readonly target: Target }): ReactNode {
  const scope = useTargetScope()
  const health = useTargetHealth(scope.target.path)
  return (
    <div className="flex flex-col gap-10" data-page="target-overview">
      <RefreshBar />
      <HealthBlock health={health} />
      <FactsBlock target={props.target} health={health} />
      <HistoryBlock path={scope.target.path} />
      <MigrationsBlock target={scope.target} projectId={props.target.projectId} />
      <OperationsBlock path={scope.target.path} />
      <FindingsBlock target={scope.target} openCount={props.target.openFindingCount} />
    </div>
  )
}

/** What the target record says about where the target lives and how far its ledger is. */
function FactsBlock({
  target,
  health,
}: {
  readonly target: Target
  readonly health: TargetRead<TargetHealth>
}): ReactNode {
  const placement = target.placement
  const known = target.ledger === null ? undefined : readSourceOf(target.ledger.source)
  const items: KeyValueItem[] =
    placement === null
      ? [
          {
            id: 'placement',
            label: t('overview.health.fact.placement'),
            value: t('overview.health.fact.noPlacement'),
          },
        ]
      : [
          {
            id: 'cluster',
            label: t('overview.health.fact.cluster'),
            value: (
              <UntrustedName
                name={placement.clusterName}
                label={t('overview.health.fact.cluster')}
              />
            ),
          },
          {
            id: 'clusterGeneration',
            label: t('overview.health.fact.clusterGeneration'),
            value: String(placement.generation),
          },
          {
            id: 'server',
            label: t('overview.health.fact.server'),
            value:
              placement.serverName === null ? (
                t('overview.health.fact.none')
              ) : (
                <UntrustedName
                  name={placement.serverName}
                  label={t('overview.health.fact.server')}
                />
              ),
          },
          {
            id: 'version',
            label: t('overview.health.fact.version'),
            value:
              placement.postgresVersion === null ? (
                t('overview.health.fact.none')
              ) : (
                <UntrustedName
                  name={placement.postgresVersion}
                  mono
                  label={t('overview.health.fact.version')}
                />
              ),
          },
          {
            id: 'mode',
            label: t('overview.health.fact.mode'),
            value: placement.managementMode,
          },
          {
            id: 'host',
            label: t('overview.health.fact.host'),
            value: <HostValue placement={placement} health={health.readable} />,
          },
        ]
  items.push(
    {
      id: 'generation',
      label: t('overview.health.fact.generation'),
      value: String(target.generation),
    },
    {
      id: 'ledger',
      label: t('overview.health.fact.ledger'),
      value:
        target.ledger === null ? (
          t('overview.health.fact.ledgerNone')
        ) : (
          <span className="inline-flex flex-wrap items-center gap-2">
            {target.ledger.lastAppliedAt === null ? (
              <>
                {t('overview.health.fact.ledgerCount', { count: target.ledger.appliedCount })}{' '}
                {t('overview.health.fact.ledgerNever')}
              </>
            ) : (
              <>
                {t('overview.health.fact.ledgerApplied', { count: target.ledger.appliedCount })}{' '}
                <ObservedTime observedAt={target.ledger.lastAppliedAt} />
              </>
            )}
            {known === undefined ? null : <SourceLabel source={known} />}
            <ObservedTime observedAt={target.ledger.observedAt} />
          </span>
        ),
    },
  )
  return (
    <Block id="facts" title={t('overview.health.facts.title')}>
      <KeyValueList items={items} />
      <p className="text-sm text-foreground-light">{t('overview.health.fact.size')}</p>
    </Block>
  )
}
