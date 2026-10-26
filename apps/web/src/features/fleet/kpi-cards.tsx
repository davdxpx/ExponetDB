import {
  CircleAlert,
  Database,
  type LucideIcon,
  RefreshCw,
  ShieldAlert,
  Users,
} from '@exponetdb/icons'
import { Card, cn } from '@exponetdb/ui'
import {
  formatCount,
  LinkCard,
  type LinkCardTone,
  ObservedTime,
  UntrustedName,
  useResolvedNow,
} from '@exponetdb/ui-patterns'
import { type ReactNode, useId } from 'react'
import { t } from '../../lib/i18n/i18n.ts'
import { APPROVALS_PATH, FINDINGS_PATH, OPERATIONS_PATH } from './links.ts'
import { type CountPart, type FleetModel, type Part, partStale, unavailableKind } from './model.ts'

/** One key number of the overview: what it counts, where its card leads, how loud it is. */
interface KpiSpec {
  readonly id: string
  readonly label: string
  readonly icon: LucideIcon
  readonly part: Part
  readonly href: string
  readonly sub: string
  /** The tone of a counted part: a non-zero count of something that needs a person is loud. */
  readonly tone: (count: number) => LinkCardTone
}

const quietUnlessZero =
  (loud: LinkCardTone) =>
  (count: number): LinkCardTone =>
    count > 0 ? loud : 'neutral'

/**
 * The key numbers of the fleet, most important first: the databases, the critical findings, the
 * operations that stopped for a person, the plans that wait for a decision and what runs now.
 * Each counted card is one link to the list that explains its number, filtered the same way; a
 * part the server did not count is a plain card (no link, no pointer) that says why and is never
 * zero (C-28).
 */
export function KpiCards({ model }: { readonly model: FleetModel }): ReactNode {
  const findings = model.findings
  const critical: Part =
    findings.kind === 'count' && findings.bySeverity !== undefined
      ? { ...findings, count: findings.bySeverity.critical }
      : findings
  const specs: readonly KpiSpec[] = [
    {
      id: 'targets',
      label: t('fleet.kpi.targets'),
      icon: Database,
      part: model.targets,
      href: '/targets',
      sub: t('fleet.kpi.targets.sub', {
        prod: formatCount(model.targets.byTier.prod),
        nonprod: formatCount(model.targets.byTier.nonprod),
      }),
      tone: () => 'neutral',
    },
    {
      id: 'critical',
      label: t('fleet.kpi.critical'),
      icon: ShieldAlert,
      part: critical,
      href: `${FINDINGS_PATH}?severity=critical`,
      sub:
        findings.kind === 'count'
          ? t('fleet.kpi.critical.sub', { open: formatCount(findings.count) })
          : t('fleet.kpi.critical.subUnknown'),
      tone: quietUnlessZero('critical'),
    },
    {
      id: 'attention',
      label: t('fleet.operations.attention.label'),
      icon: CircleAlert,
      part: model.attention,
      href: `${OPERATIONS_PATH}?state=needs_attention`,
      sub: t('fleet.kpi.attention.sub'),
      tone: quietUnlessZero('critical'),
    },
    {
      id: 'approval',
      label: t('fleet.operations.approval.label'),
      icon: Users,
      part: model.approval,
      href: APPROVALS_PATH,
      sub: t('fleet.kpi.approval.sub'),
      tone: quietUnlessZero('warning'),
    },
    {
      id: 'running',
      label: t('fleet.operations.running.label'),
      icon: RefreshCw,
      part: model.running,
      href: `${OPERATIONS_PATH}?state=running`,
      sub: t('fleet.kpi.running.sub'),
      tone: quietUnlessZero('info'),
    },
  ]
  return (
    <ul
      aria-label={t('fleet.kpi.label')}
      className="m-0 grid list-none grid-cols-1 gap-3 p-0 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-5"
    >
      {specs.map((spec) => (
        <li key={spec.id} className="min-w-0" data-kpi={spec.id}>
          <KpiCard spec={spec} />
        </li>
      ))}
    </ul>
  )
}

function KpiCard({ spec }: { readonly spec: KpiSpec }): ReactNode {
  const labelId = useId()
  const Icon = spec.icon
  const heading = (
    <span className="flex items-center gap-2 pr-6 text-foreground-light">
      <Icon aria-hidden="true" strokeWidth={1.5} className="size-4 shrink-0" />
      <span id={labelId} className="eyebrow text-xs">
        {spec.label}
      </span>
    </span>
  )
  if (spec.part.kind === 'unavailable') {
    return (
      <Card
        role="group"
        aria-labelledby={labelId}
        data-part="unavailable"
        className="flex h-full flex-col gap-3 p-4"
      >
        {heading}
        <p className="m-0 text-sm text-foreground">
          {unavailableKind(spec.part.reason) === 'permission_denied'
            ? t('fleet.part.unavailable.permission_denied')
            : t('fleet.part.unavailable.unknown')}
        </p>
        <p className="m-0 text-xs text-foreground-lighter">
          {t('fleet.part.unavailable')}{' '}
          <UntrustedName name={spec.part.reason} mono maxCodePoints={48} label="reason" />
        </p>
      </Card>
    )
  }
  return <CountedCard spec={spec} part={spec.part} heading={heading} />
}

function CountedCard({
  spec,
  part,
  heading,
}: {
  readonly spec: KpiSpec
  readonly part: CountPart
  readonly heading: ReactNode
}): ReactNode {
  const now = useResolvedNow()
  const stale = partStale(part.observedAt, now)
  const tone = spec.tone(part.count)
  return (
    <LinkCard
      href={spec.href}
      tone={tone}
      data-part="count"
      data-count={part.count}
      className="h-full gap-3 p-4"
    >
      {heading}
      <span
        className={cn(
          'text-3xl leading-none font-semibold tracking-tight tabular-nums',
          tone === 'critical' && 'text-destructive',
        )}
      >
        {part.lowerBound
          ? t('fleet.count.atLeast', { count: formatCount(part.count) })
          : formatCount(part.count)}
      </span>
      <span className="text-xs text-foreground-light">{spec.sub}</span>
      {part.lowerBound && part.lowerBoundReason !== null ? (
        <span className="text-xs text-foreground-lighter">
          {t('fleet.count.boundReason')}{' '}
          <UntrustedName
            name={part.lowerBoundReason}
            maxCodePoints={120}
            expandable={false}
            label="reason"
          />
        </span>
      ) : null}
      {stale ? (
        <span data-stale className="text-xs text-foreground">
          {t('fleet.kpi.stale')} <ObservedTime observedAt={part.observedAt} />
        </span>
      ) : null}
    </LinkCard>
  )
}
