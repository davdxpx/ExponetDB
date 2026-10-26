import { ArrowDown, Database, Network, Server } from '@exponetdb/icons'
import type { Target } from '@exponetdb/sdk/operations'
import { cn } from '@exponetdb/ui'
import {
  formatCount,
  LinkCard,
  ObservedTime,
  TierChip,
  UntrustedName,
  useLinkComponent,
} from '@exponetdb/ui-patterns'
import type { ReactNode } from 'react'
import { t } from '../../lib/i18n/i18n.ts'
import { clusterPath } from '../infrastructure/model.ts'
import { lifecycleLabelKey } from '../target/environments.ts'
import type { TargetRoute } from '../target/params.ts'
import { useTargetHref } from '../target-ops/links.ts'

/**
 * The top of a target's overview, as Studio's project home has one but in ExponetDB's model:
 * on the left who the target is (its path, tier and lifecycle) and the few facts a person asks
 * first, each a link where it has a page (migrations, findings); on the right where it runs,
 * drawn as the layers the registry records (server, cluster, this database) and a link to the
 * cluster. Only recorded facts are drawn: no region, size or capacity the registry does not
 * hold, and a placement that is not recorded says so instead of a picture of one. Backups say
 * "not observed yet" until Wave 9 reads them; unknown is not safe.
 */
export function TargetHero({
  target,
  route,
}: {
  readonly target: Target
  readonly route: TargetRoute
}): ReactNode {
  const lifecycle = lifecycleLabelKey(target.state)
  return (
    <section
      aria-labelledby="target-hero"
      data-block="hero"
      className="grid grid-cols-1 gap-6 rounded-xl border bg-surface-75 p-5 lg:grid-cols-5 lg:p-6"
    >
      <div className="flex min-w-0 flex-col gap-5 lg:col-span-3">
        <div className="flex flex-col gap-2">
          <span className="eyebrow text-xs text-foreground-lighter">
            {t('overview.hero.eyebrow')}
          </span>
          <h2 id="target-hero" className="m-0 flex flex-wrap items-center gap-3 font-mono text-xl">
            <span className="min-w-0 break-all">{route.path}</span>
            <TierChip tier={target.tier} />
            {lifecycle === undefined ? null : (
              <span className="rounded-md border px-2 py-0.5 font-sans text-xs text-foreground-light">
                {t(lifecycle)}
              </span>
            )}
          </h2>
        </div>
        <Facts target={target} />
      </div>
      <Topology target={target} className="lg:col-span-2" />
    </section>
  )
}

function Facts({ target }: { readonly target: Target }): ReactNode {
  const href = useTargetHref()
  const Link = useLinkComponent()
  const ledger = target.ledger
  return (
    <dl className="m-0 grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
      <Fact label={t('overview.hero.version')}>
        {target.placement?.postgresVersion == null ? (
          <span className="text-foreground-light">{t('overview.health.fact.none')}</span>
        ) : (
          <UntrustedName name={target.placement.postgresVersion} mono />
        )}
      </Fact>
      <Fact label={t('overview.hero.migrations')}>
        <Link href={href('/migrations')} className="rounded-sm hover:underline focus-ring">
          {ledger === null
            ? t('overview.health.fact.ledgerNone')
            : t('overview.hero.applied', { count: formatCount(ledger.appliedCount) })}
        </Link>
        {ledger?.lastAppliedAt == null ? null : (
          <span className="block text-xs text-foreground-lighter">
            {t('overview.hero.last')} <ObservedTime observedAt={ledger.lastAppliedAt} />
          </span>
        )}
      </Fact>
      <Fact label={t('overview.hero.findings')}>
        <Link
          href={href('/findings')}
          className={cn(
            'rounded-sm hover:underline focus-ring',
            target.openFindingCount > 0 && 'text-warning-600',
          )}
        >
          {t('overview.hero.open', { count: formatCount(target.openFindingCount) })}
        </Link>
      </Fact>
      <Fact label={t('overview.hero.backups')}>
        <span className="text-foreground-light">{t('overview.hero.backups.state')}</span>
      </Fact>
    </dl>
  )
}

function Fact({
  label,
  children,
}: {
  readonly label: string
  readonly children: ReactNode
}): ReactNode {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className="eyebrow text-xs text-foreground-lighter">{label}</dt>
      <dd className="m-0 text-sm">{children}</dd>
    </div>
  )
}

function Layer({
  icon: Icon,
  label,
  children,
  current = false,
}: {
  readonly icon: typeof Server
  readonly label: string
  readonly children: ReactNode
  readonly current?: boolean
}): ReactNode {
  return (
    <span
      className={cn(
        'flex min-w-0 items-center gap-3 rounded-md border bg-surface-100 px-3 py-2',
        current && 'border-primary bg-primary-200/30',
      )}
    >
      <Icon
        aria-hidden="true"
        strokeWidth={1.5}
        className="size-4 shrink-0 text-foreground-light"
      />
      <span className="flex min-w-0 flex-col">
        <span className="text-[11px] text-foreground-lighter">{label}</span>
        <span className="min-w-0 truncate text-sm">{children}</span>
      </span>
    </span>
  )
}

const Connector = () => (
  <span aria-hidden="true" className="flex justify-center py-0.5 text-foreground-muted">
    <ArrowDown className="size-3.5" strokeWidth={1.5} />
  </span>
)

/** Where the target runs, as recorded: server, cluster, this database. */
function Topology({
  target,
  className,
}: {
  readonly target: Target
  readonly className?: string
}): ReactNode {
  const placement = target.placement
  if (placement === null) {
    return (
      <div
        data-topology="none"
        className={cn(
          'flex flex-col justify-center gap-2 rounded-lg border border-dashed p-4 text-sm text-foreground-light',
          className,
        )}
      >
        <span className="font-medium text-foreground">{t('overview.hero.topology')}</span>
        {t('overview.health.fact.noPlacement')}
      </div>
    )
  }
  const href = clusterPath(placement.clusterId)
  const layers = (
    <span className="flex flex-col">
      <span className="mb-2 pr-6 text-sm font-medium">{t('overview.hero.topology')}</span>
      <Layer icon={Server} label={t('overview.health.fact.server')}>
        {placement.serverName === null ? (
          <span className="text-foreground-light">{t('overview.hero.noServer')}</span>
        ) : (
          <UntrustedName name={placement.serverName} expandable={false} maxCodePoints={48} />
        )}
      </Layer>
      <Connector />
      <Layer icon={Network} label={t('overview.health.fact.cluster')}>
        <UntrustedName name={placement.clusterName} expandable={false} maxCodePoints={48} />{' '}
        <span className="text-xs text-foreground-lighter">
          {t(
            placement.managementMode === 'agent'
              ? 'project.infra.mode.agent'
              : 'project.infra.mode.external',
          )}
        </span>
      </Layer>
      <Connector />
      <Layer icon={Database} label={t('overview.hero.database')} current>
        {t('overview.hero.thisDatabase')}
      </Layer>
      <span className="mt-2 text-xs text-foreground-lighter">
        {t('overview.hero.since')} <ObservedTime observedAt={placement.since} withDate />
      </span>
    </span>
  )
  return href === undefined ? (
    <div data-topology="placed" className={cn('rounded-lg border bg-surface-100 p-4', className)}>
      {layers}
    </div>
  ) : (
    <LinkCard href={href} data-topology="placed" className={cn('p-4', className)}>
      {layers}
    </LinkCard>
  )
}
