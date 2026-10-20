import type { FleetFinding, InstallationHealth } from '@exponetdb/sdk/operations'
import {
  Card,
  CardContent,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@exponetdb/ui'
import {
  NotAvailableYetState,
  ObservedTime,
  PageContainer,
  PageHeader,
  PageHeaderDescription,
  PageHeaderMeta,
  PageHeaderSummary,
  PageHeaderTitle,
  ReadableView,
  UntrustedName,
  UntrustedText,
  useLinkComponent,
  useResolvedNow,
} from '@exponetdb/ui-patterns'
import { useQuery } from '@tanstack/react-query'
import { type ReactNode, useId } from 'react'
import { useApi } from '../../lib/api/context.tsx'
import { t } from '../../lib/i18n/i18n.ts'
import { toReadable } from '../../lib/query/readable.ts'
import { targetHrefOf } from '../targets/model.ts'
import { AttentionSection } from './attention.tsx'
import { HEALTH_STATES, HealthChip } from './health.tsx'
import { controlPlaneQuery, criticalFindingsQuery, fleetQuery } from './keys.ts'
import { type FleetModel, fleetModel, type Part, partStale, unavailableKind } from './model.ts'

/** Where the operations list lives (information-architecture.md section 2: Changes, "Operations"). */
export const OPERATIONS_PATH = '/changes/operations'
export const APPROVALS_PATH = '/approvals'
export const FINDINGS_PATH = '/findings'

/**
 * The fleet overview (`/`): what the server counted across every target the
 * person may see, what needs a person (the targets with the worst health, the
 * newest critical findings, operations), and how the Control Plane itself is
 * doing. One request counts the fleet (`GET /fleet`), so the counts do not
 * cost more with the number of targets; the worst targets come from the one
 * cached list read of the Databases page. Every number carries its source and its
 * age; a count that is a floor says "at least"; a part the server could not
 * count says why and is never zero; a failed read is an error, not a card of
 * zeros (C-28).
 */
export function FleetPage(): ReactNode {
  const { client } = useApi()
  const fleet = useQuery(fleetQuery(client))
  return (
    <>
      <PageHeader size="large">
        <PageHeaderMeta>
          <PageHeaderSummary>
            <PageHeaderTitle>{t('fleet.title')}</PageHeaderTitle>
            <PageHeaderDescription>{t('fleet.description')}</PageHeaderDescription>
          </PageHeaderSummary>
        </PageHeaderMeta>
      </PageHeader>
      <PageContainer size="large" className="flex flex-col gap-8 py-6">
        <ReadableView
          readable={toReadable(fleet)}
          what={t('fleet.read.what')}
          onRetry={() => void fleet.refetch()}
          onRefresh={() => void fleet.refetch()}
          busy={fleet.isFetching}
          headingLevel={2}
          ready={(value) => <FleetCards model={fleetModel(value)} />}
        />
        <AttentionSection />
        <CriticalFindings />
        <ControlPlane />
      </PageContainer>
    </>
  )
}

function FleetCards({ model }: { readonly model: FleetModel }): ReactNode {
  const now = useResolvedNow()
  const targets = model.targets
  const withFindings = model.findings
  return (
    <div className="flex flex-col gap-6">
      <ul
        className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3"
        aria-label={t('fleet.title')}
      >
        <li>
          <Stat
            label={t('fleet.targets.label')}
            help={t('fleet.targets.help')}
            part={targets}
            now={now}
            href="/targets"
            linkLabel={t('targets.title')}
            details={
              <>
                <p>
                  {t('fleet.targets.tiers', {
                    prod: targets.byTier.prod,
                    nonprod: targets.byTier.nonprod,
                  })}
                </p>
                <p>{t('fleet.targets.decommissioned', { count: targets.decommissioned })}</p>
                <p>
                  {t('fleet.targets.sources', {
                    sampled: targets.bySource.sampled,
                    cached: targets.bySource.cached,
                    inferred: targets.bySource.inferred,
                  })}
                </p>
                <p>
                  {targets.oldestSampleAt === null ? (
                    t('fleet.targets.noSample')
                  ) : (
                    <>
                      {t('fleet.targets.oldest')}{' '}
                      <ObservedTime observedAt={targets.oldestSampleAt} withDate />
                    </>
                  )}
                </p>
              </>
            }
          />
        </li>
        <li>
          <Stat
            label={t('fleet.findings.label')}
            help={t('fleet.findings.help')}
            part={withFindings}
            now={now}
            href={FINDINGS_PATH}
            linkLabel={t('fleet.findings.link')}
            details={
              withFindings.kind === 'count' && withFindings.bySeverity !== undefined ? (
                <p>
                  {t('fleet.findings.severity', {
                    critical: withFindings.bySeverity.critical,
                    warning: withFindings.bySeverity.warning,
                    info: withFindings.bySeverity.info,
                  })}
                </p>
              ) : undefined
            }
          />
        </li>
        <li>
          <Stat
            label={t('fleet.operations.approval.label')}
            help={t('fleet.operations.approval.help')}
            part={model.approval}
            now={now}
            href={APPROVALS_PATH}
            linkLabel={t('fleet.operations.approval.link')}
          />
        </li>
        <li>
          <Stat
            label={t('fleet.operations.running.label')}
            help={t('fleet.operations.running.help')}
            part={model.running}
            now={now}
            href={`${OPERATIONS_PATH}?state=running`}
            linkLabel={t('fleet.operations.running.link')}
          />
        </li>
        <li>
          <Stat
            label={t('fleet.operations.attention.label')}
            help={t('fleet.operations.attention.help')}
            part={model.attention}
            now={now}
            href={`${OPERATIONS_PATH}?state=needs_attention`}
            linkLabel={t('fleet.operations.attention.link')}
          />
        </li>
        <li>
          <NotAvailableYetState
            what={t('fleet.backups.what')}
            reason={t('fleet.backups.reason')}
            headingLevel={3}
          />
        </li>
      </ul>
      <HealthGrid targets={targets} />
    </div>
  )
}

/** One number with its label, source and age; the states of a part, in words. */
function Stat(props: {
  readonly label: string
  readonly help: string
  readonly part: Part
  readonly now: number
  readonly details?: ReactNode
  readonly href?: string
  readonly linkLabel?: string
}): ReactNode {
  const labelId = useId()
  const Link = useLinkComponent()
  const { part } = props
  return (
    <Card role="group" aria-labelledby={labelId} data-part={part.kind} className="h-full">
      <CardContent className="flex h-full flex-col items-start gap-2 p-card">
        <p id={labelId} className="font-mono text-xs uppercase text-foreground-light">
          {props.label}
        </p>
        <p className="sr-only">{props.help}</p>
        {part.kind === 'unavailable' ? (
          <div className="flex flex-col gap-1 text-sm text-foreground">
            <p>
              {unavailableKind(part.reason) === 'permission_denied'
                ? t('fleet.part.unavailable.permission_denied')
                : t('fleet.part.unavailable.unknown')}
            </p>
            <p className="text-xs text-foreground-light">
              {t('fleet.part.unavailable')}{' '}
              <UntrustedName name={part.reason} mono maxCodePoints={48} label="reason" />
            </p>
          </div>
        ) : (
          <>
            <p className="text-xl font-normal tabular-nums" data-count={part.count}>
              {part.lowerBound ? t('fleet.count.atLeast', { count: part.count }) : part.count}
            </p>
            {part.lowerBound && part.lowerBoundReason !== null ? (
              <p className="text-xs text-foreground-light">
                {t('fleet.count.boundReason')}{' '}
                <UntrustedName name={part.lowerBoundReason} maxCodePoints={120} label="reason" />
              </p>
            ) : null}
            <div className="flex flex-col gap-0.5 text-xs text-foreground-light">
              {props.details}
            </div>
            <p className="text-xs text-foreground-lighter">
              {t('fleet.part.source')}{' '}
              <UntrustedName name={part.source} mono maxCodePoints={24} label="source" />
              {', '}
              <ObservedTime observedAt={part.observedAt} />
            </p>
            {partStale(part.observedAt, props.now) ? (
              <p role="status" className="text-xs text-foreground">
                {t('fleet.part.stale')}
              </p>
            ) : null}
          </>
        )}
        {props.href !== undefined ? (
          <Link href={props.href} className="mt-auto text-sm text-foreground underline focus-ring">
            {props.linkLabel}
          </Link>
        ) : null}
      </CardContent>
    </Card>
  )
}

function HealthGrid({ targets }: { readonly targets: FleetModel['targets'] }): ReactNode {
  const Link = useLinkComponent()
  return (
    <section aria-labelledby="fleet-health" className="flex flex-col gap-3">
      <h2 id="fleet-health" className="text-lg font-medium">
        {t('fleet.health.title')}
      </h2>
      <Table>
        <TableCaption className="sr-only">{t('fleet.health.caption')}</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">{t('fleet.health.column.state')}</TableHead>
            <TableHead scope="col">{t('fleet.health.column.count')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {HEALTH_STATES.map((state) => (
            <TableRow key={state} data-health-row={state}>
              <TableCell>
                <HealthChip state={state} />
              </TableCell>
              <TableCell className="tabular-nums">
                <Link
                  href={`/targets?health=${state}`}
                  className="underline focus-ring"
                  aria-label={t('fleet.health.open', { state })}
                >
                  {targets.lowerBound
                    ? t('fleet.count.atLeast', { count: targets.byHealth[state] })
                    : targets.byHealth[state]}
                </Link>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <p className="text-xs text-foreground-light">{t('fleet.health.unknownNote')}</p>
    </section>
  )
}

function CriticalFindings(): ReactNode {
  const { client } = useApi()
  const findings = useQuery(criticalFindingsQuery(client))
  const Link = useLinkComponent()
  return (
    <section aria-labelledby="fleet-critical" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="fleet-critical" className="text-lg font-medium">
          {t('fleet.critical.title')}
        </h2>
        <Link
          href={`${FINDINGS_PATH}?severity=critical`}
          className="text-sm text-foreground underline focus-ring"
        >
          {t('fleet.critical.all')}
        </Link>
      </div>
      <ReadableView
        readable={toReadable(findings, {
          missing: (value) => (value.nextCursor === null ? undefined : [t('fleet.critical.more')]),
        })}
        what={t('fleet.critical.what')}
        onRetry={() => void findings.refetch()}
        onRefresh={() => void findings.refetch()}
        busy={findings.isFetching}
        headingLevel={3}
        empty={{
          isEmpty: (value) => value.items.length === 0,
          content: <p className="text-sm text-foreground-light">{t('fleet.critical.empty')}</p>,
        }}
        ready={(value) => <FindingTable items={value.items} />}
      />
    </section>
  )
}

function FindingTable({ items }: { readonly items: readonly FleetFinding[] }): ReactNode {
  const Link = useLinkComponent()
  return (
    <Table>
      <TableCaption className="sr-only">{t('fleet.critical.caption')}</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">{t('fleet.critical.column.target')}</TableHead>
          <TableHead scope="col">{t('fleet.critical.column.finding')}</TableHead>
          <TableHead scope="col">{t('fleet.critical.column.seen')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((finding) => {
          const href = targetHrefOf(finding.targetPath, '/findings')
          return (
            <TableRow key={finding.id} data-finding={finding.id}>
              <TableCell>
                {href === undefined ? (
                  <UntrustedName name={finding.targetPath} mono label="target" />
                ) : (
                  <Link
                    href={href}
                    className="underline focus-ring"
                    aria-label={t('fleet.critical.open', { target: finding.targetPath })}
                  >
                    <UntrustedName name={finding.targetPath} mono label="target" />
                  </Link>
                )}
              </TableCell>
              <TableCell>
                <UntrustedName name={finding.code} mono label="finding code" />{' '}
                <UntrustedText text={finding.summary} />
              </TableCell>
              <TableCell>
                <ObservedTime observedAt={finding.lastSeenAt} />
              </TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}

function ControlPlane(): ReactNode {
  const { client } = useApi()
  const health = useQuery(controlPlaneQuery(client))
  return (
    <section aria-labelledby="fleet-cp" className="flex flex-col gap-3">
      <h2 id="fleet-cp" className="text-lg font-medium">
        {t('fleet.cp.title')}
      </h2>
      <ReadableView
        readable={toReadable(health, {
          missing: (value) =>
            (value.unobserved ?? []).length === 0
              ? undefined
              : (value.unobserved ?? []).map((u) =>
                  t('fleet.cp.unobserved.row', { component: u.component, reason: u.reason }),
                ),
        })}
        what={t('fleet.cp.what')}
        onRetry={() => void health.refetch()}
        onRefresh={() => void health.refetch()}
        busy={health.isFetching}
        headingLevel={3}
        ready={(value) => <ControlPlaneBody health={value} />}
      />
    </section>
  )
}

const CP_CHIP = { operational: 'healthy', degraded: 'degraded', down: 'unhealthy' } as const

function ControlPlaneBody({ health }: { readonly health: InstallationHealth }): ReactNode {
  const unobserved = health.unobserved ?? []
  return (
    <div className="flex flex-col gap-3">
      <p className="flex items-center gap-2 text-sm">
        <HealthChip state={CP_CHIP[health.state]} />
        <span>{t('fleet.cp.state', { state: t(`fleet.cp.state.${health.state}`) })}</span>
      </p>
      {health.components.length === 0 ? (
        <p className="text-sm text-foreground-light">{t('fleet.cp.none')}</p>
      ) : (
        <Table>
          <TableCaption className="sr-only">{t('fleet.cp.caption')}</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">{t('fleet.cp.column.component')}</TableHead>
              <TableHead scope="col">{t('fleet.cp.column.state')}</TableHead>
              <TableHead scope="col">{t('fleet.cp.column.source')}</TableHead>
              <TableHead scope="col">{t('fleet.cp.column.observed')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {health.components.map((component) => (
              <TableRow key={component.component}>
                <TableCell>
                  <UntrustedName name={component.component} mono label="component" />
                </TableCell>
                <TableCell>
                  <div className="flex flex-col items-start gap-1">
                    <HealthChip state={CP_CHIP[component.state]} />
                    {(component.reasons ?? []).map((reason) => (
                      <UntrustedText key={reason} text={reason} className="text-xs" />
                    ))}
                  </div>
                </TableCell>
                <TableCell>
                  <UntrustedName name={component.source} mono maxCodePoints={24} label="source" />
                </TableCell>
                <TableCell>
                  <ObservedTime observedAt={component.observedAt} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {unobserved.length === 0 ? null : (
        <div data-unobserved className="flex flex-col gap-1 rounded-md border border-strong p-3">
          <h4 className="text-sm font-medium">{t('fleet.cp.unobserved.title')}</h4>
          <p className="text-xs text-foreground-light">{t('fleet.cp.unobserved.body')}</p>
          <ul className="flex flex-col gap-1 text-sm">
            {unobserved.map((u) => (
              <li key={u.component} className="flex flex-wrap items-center gap-2">
                <HealthChip state="unknown" />
                <UntrustedName name={u.component} mono label="component" />
                <UntrustedText text={u.reason} className="text-xs" />
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
