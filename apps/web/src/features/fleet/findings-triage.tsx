import type { Fleet, FleetFinding } from '@exponetdb/sdk/operations'
import { cn } from '@exponetdb/ui'
import {
  formatCount,
  LinkCard,
  ObservedTime,
  ReadableView,
  UntrustedName,
  UntrustedText,
  useLinkComponent,
} from '@exponetdb/ui-patterns'
import { useQuery } from '@tanstack/react-query'
import { type ReactNode, useId } from 'react'
import { useApi } from '../../lib/api/context.tsx'
import { type MessageKey, t } from '../../lib/i18n/i18n.ts'
import { toReadable } from '../../lib/query/readable.ts'
import { SeverityBadge } from '../target-ops/paged.tsx'
import { targetHrefOf } from '../targets/model.ts'
import { criticalFindingsQuery, fleetQuery } from './keys.ts'
import { FINDINGS_PATH } from './links.ts'

const SEVERITIES = ['critical', 'warning', 'info'] as const
type Severity = (typeof SEVERITIES)[number]

const SEGMENT: Readonly<Record<Severity, string>> = {
  critical: 'bg-destructive',
  warning: 'bg-warning',
  info: 'bg-info',
}

const LEGEND: Readonly<Record<Severity, MessageKey>> = {
  critical: 'globalFindings.severity.critical',
  warning: 'globalFindings.severity.warning',
  info: 'globalFindings.severity.info',
}

/**
 * What the open findings ask of a person, worst first: how the open findings split by severity
 * (from the fleet's counts, so 13,000 findings cost no more than three; the browser never loads
 * them to count), each severity a link to the filtered findings list, and the newest critical
 * findings, each a whole-row link to the findings of its database. Grouping by database or by
 * cause needs a summary read the server does not offer yet; the page says so instead of
 * aggregating a list it never read whole.
 */
export function FindingsTriage({ className }: { readonly className?: string }): ReactNode {
  const { client } = useApi()
  const Link = useLinkComponent()
  // The same cached read as the cards above (one request).
  const fleet = useQuery(fleetQuery(client))
  return (
    <section
      aria-labelledby="fleet-findings"
      className={cn('flex min-w-0 flex-col gap-4', className)}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="fleet-findings" className="m-0 text-base font-medium">
          {t('fleet.findings.title')}
        </h2>
        <Link
          href={FINDINGS_PATH}
          className="text-sm text-foreground-light hover:text-foreground focus-ring"
        >
          {t('fleet.findings.link')}
        </Link>
      </div>
      {fleet.data === undefined ? null : <SeverityMeter findings={fleet.data.findings} />}
      <CriticalList />
    </section>
  )
}

function SeverityMeter({ findings }: { readonly findings: Fleet['findings'] }): ReactNode {
  const Link = useLinkComponent()
  if (!findings.available) return null
  const counts = SEVERITIES.map((severity) => ({ severity, count: findings.bySeverity[severity] }))
  const at = (count: number): string =>
    findings.lowerBound
      ? t('fleet.count.atLeast', { count: formatCount(count) })
      : formatCount(count)
  return (
    <div className="flex flex-col gap-2" data-severity-meter>
      <p className="m-0 flex flex-wrap items-baseline gap-x-3 text-sm text-foreground-light">
        <span className="text-2xl font-semibold tabular-nums text-foreground">
          {at(findings.open)}
        </span>
        {t('fleet.findings.openCaption')}
      </p>
      <div
        role="img"
        aria-label={t('fleet.findings.severity', {
          critical: at(findings.bySeverity.critical),
          warning: at(findings.bySeverity.warning),
          info: at(findings.bySeverity.info),
        })}
        className="flex h-2 w-full gap-px overflow-hidden rounded-full bg-surface-300"
      >
        {counts.map((entry) =>
          entry.count === 0 ? null : (
            <span
              key={entry.severity}
              data-severity-segment={entry.severity}
              className={cn('h-full min-w-1 basis-0', SEGMENT[entry.severity])}
              style={{ flexGrow: entry.count }}
            />
          ),
        )}
      </div>
      <ul className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-sm">
        {counts.map((entry) => (
          <li key={entry.severity}>
            <Link
              href={`${FINDINGS_PATH}?severity=${entry.severity}`}
              aria-label={t('fleet.findings.legend.open', {
                count: at(entry.count),
                severity: t(LEGEND[entry.severity]).toLowerCase(),
              })}
              className="inline-flex items-center gap-1.5 rounded-sm text-foreground-light hover:text-foreground focus-ring"
            >
              <span
                aria-hidden="true"
                className={cn('size-2 rounded-full', SEGMENT[entry.severity])}
              />
              <span>{t(LEGEND[entry.severity])}</span>
              <span className="tabular-nums text-foreground">{at(entry.count)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}

function CriticalList(): ReactNode {
  const { client } = useApi()
  const Link = useLinkComponent()
  const findings = useQuery(criticalFindingsQuery(client))
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="m-0 text-sm font-medium">{t('fleet.critical.title')}</h3>
        <Link
          href={`${FINDINGS_PATH}?severity=critical`}
          className="text-xs text-foreground-light hover:text-foreground focus-ring"
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
        headingLevel={4}
        empty={{
          isEmpty: (value) => value.items.length === 0,
          content: <p className="m-0 text-sm text-foreground-light">{t('fleet.critical.empty')}</p>,
        }}
        ready={(value) => <FindingRows items={value.items} />}
      />
      <p className="m-0 text-xs text-foreground-lighter">{t('fleet.findings.grouping')}</p>
    </div>
  )
}

function FindingRows({ items }: { readonly items: readonly FleetFinding[] }): ReactNode {
  const baseId = useId()
  return (
    <ul aria-label={t('fleet.critical.caption')} className="m-0 flex list-none flex-col gap-2 p-0">
      {items.map((finding, index) => {
        const href = targetHrefOf(finding.targetPath, '/findings')
        const summaryId = `${baseId}-${index}`
        const body = (
          <>
            <span className="flex flex-wrap items-center gap-2">
              <SeverityBadge severity={finding.severity} />
              <UntrustedName
                name={finding.code}
                mono
                expandable={false}
                className="text-xs text-foreground-light"
                label="finding code"
              />
              <span className="ml-auto text-xs text-foreground-lighter">
                <ObservedTime observedAt={finding.lastSeenAt} />
              </span>
            </span>
            <UntrustedText
              id={summaryId}
              text={finding.summary}
              expandable={false}
              maxLines={2}
              maxCodePoints={240}
              className="text-sm"
            />
            <UntrustedName
              name={finding.targetPath}
              mono
              expandable={false}
              className="text-xs text-foreground-light"
              label={t('fleet.critical.column.target')}
            />
          </>
        )
        return (
          <li key={finding.id} data-finding={finding.id}>
            {href === undefined ? (
              // A path the page cannot link is shown as marked text, in a plain card.
              <div className="flex flex-col gap-1.5 rounded-lg border bg-surface-100 p-3">
                {body}
              </div>
            ) : (
              <LinkCard
                href={href}
                bare
                // The path is three slugs here (it is linkable) and the code a fixed grammar.
                aria-label={t('fleet.critical.open', { target: finding.targetPath })}
                aria-describedby={summaryId}
                className="gap-1.5 p-3"
              >
                {body}
              </LinkCard>
            )}
          </li>
        )
      })}
    </ul>
  )
}
