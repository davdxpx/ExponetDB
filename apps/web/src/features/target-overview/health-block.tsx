import type { HealthCondition, ProbeResult } from '@exponetdb/sdk/operations'
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@exponetdb/ui'
import { ObservedTime, ReadableView, SourceLabel, UntrustedName } from '@exponetdb/ui-patterns'
import type { ReactNode } from 'react'
import { t } from '../../lib/i18n/i18n.ts'
import { readSourceOf } from '../target/gate.ts'
import { nounPhrase } from '../target/phrases.ts'
import type { TargetHealth, TargetRead } from '../target/queries.ts'
import { Block, HealthStateChip, NotObservedChip } from './block.tsx'
import {
  conditionKey,
  type GroupVerdict,
  type IncidentGroup,
  type IncidentGroupId,
  incidentGroups,
} from './health-model.ts'

const HEADING = 3

const GROUP_TITLE = {
  path: 'overview.health.group.path',
  answers: 'overview.health.group.answers',
  stuck: 'overview.health.group.stuck',
} as const

const GROUP_HINT = {
  path: 'overview.health.group.path.hint',
  answers: 'overview.health.group.answers.hint',
  stuck: 'overview.health.group.stuck.hint',
} as const

/** The first block of the overview: the latest health sample in incident order. */
export function HealthBlock(props: { readonly health: TargetRead<TargetHealth> }): ReactNode {
  const { health } = props
  return (
    <Block
      id="health"
      title={t('overview.health.title')}
      description={t('overview.health.description')}
    >
      <ReadableView
        readable={health.readable}
        what={nounPhrase('overview.health.what')}
        onRetry={health.refetch}
        onRefresh={health.refetch}
        busy={health.fetching}
        headingLevel={HEADING}
        ready={(value) => <HealthBody health={value} />}
      />
    </Block>
  )
}

function Observation(props: { readonly source: string; readonly observedAt: string }): ReactNode {
  const known = readSourceOf(props.source)
  return (
    <span className="inline-flex flex-wrap items-center gap-2 text-sm text-foreground-light">
      {known === undefined ? null : <SourceLabel source={known} />}
      <ObservedTime observedAt={props.observedAt} withDate />
    </span>
  )
}

function HealthBody({ health }: { readonly health: TargetHealth }): ReactNode {
  return (
    <div className="flex flex-col gap-5" data-state-of-target={health.state}>
      <div className="flex flex-wrap items-center gap-3">
        <span className="sr-only">{t('overview.health.state')}</span>
        <HealthStateChip state={health.state} />
        <Observation source={health.source} observedAt={health.observedAt} />
        <span className="text-sm text-foreground-light">
          {t('overview.health.lifecycle', { lifecycle: health.lifecycle })}
        </span>
      </div>
      {health.state === 'unknown' ? (
        <p className="text-sm" data-slot="unknown-because">
          {health.unknownBecause === null ? (
            t('overview.health.unknownBecauseNone')
          ) : (
            <UnknownBecause reason={health.unknownBecause} />
          )}
        </p>
      ) : null}
      <ol className="flex flex-col gap-4">
        {incidentGroups(health).map((group) => (
          <li key={group.id}>
            <GroupView group={group} />
          </li>
        ))}
      </ol>
      <Companions health={health} />
    </div>
  )
}

function UnknownBecause({ reason }: { readonly reason: string }): ReactNode {
  return (
    <>
      {t('overview.health.unknownBecause')}{' '}
      <UntrustedName name={reason} mono label={t('overview.health.unknownBecauseLabel')} />
    </>
  )
}

function verdictText(verdict: GroupVerdict): string {
  switch (verdict) {
    case 'ok':
      return t('overview.health.group.ok')
    case 'problem':
      return t('overview.health.group.problem')
    case 'overall_unknown':
      return t('overview.health.group.unknownOverall')
    case 'not_observed':
      return t('overview.health.group.notObserved.detail')
  }
}

function GroupView(props: { readonly group: IncidentGroup }): ReactNode {
  const { group } = props
  return (
    <section
      aria-labelledby={`health-group-${group.id}`}
      data-group={group.id}
      data-verdict={group.verdict}
      className="flex flex-col gap-2 rounded-md border border-default p-4"
    >
      <div className="flex flex-wrap items-center gap-3">
        <h3 id={`health-group-${group.id}`} className="text-base font-medium">
          {t(GROUP_TITLE[group.id])}
        </h3>
        <GroupChip group={group} />
      </div>
      <p className="text-sm text-foreground-light">{t(GROUP_HINT[group.id])}</p>
      <p className="text-sm">{verdictText(group.verdict)}</p>
      {group.probes.length === 0 ? null : <ProbeTable id={group.id} probes={group.probes} />}
      {group.conditions.length === 0 ? null : <ConditionList conditions={group.conditions} />}
    </section>
  )
}

/** The chip of a group. A group with a problem is unhealthy when a probe failed or a condition is critical, else degraded. */
function GroupChip({ group }: { readonly group: IncidentGroup }): ReactNode {
  switch (group.verdict) {
    case 'problem': {
      const failed = group.probes.some((probe) => probe.outcome !== 'ok')
      const critical = group.conditions.some((condition) => condition.severity === 'critical')
      return <HealthStateChip state={failed || critical ? 'unhealthy' : 'degraded'} />
    }
    case 'ok':
      return <HealthStateChip state="healthy" />
    case 'overall_unknown':
      return <HealthStateChip state="unknown" />
    case 'not_observed':
      return <NotObservedChip>{t('overview.health.group.notObserved')}</NotObservedChip>
  }
}

function ProbeTable(props: {
  readonly id: IncidentGroupId
  readonly probes: readonly ProbeResult[]
}): ReactNode {
  return (
    <Table>
      <TableCaption className="sr-only">{t('overview.health.probe.caption')}</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">{t('overview.health.probe.column.probe')}</TableHead>
          <TableHead scope="col">{t('overview.health.probe.column.endpoint')}</TableHead>
          <TableHead scope="col">{t('overview.health.probe.column.outcome')}</TableHead>
          <TableHead scope="col">{t('overview.health.probe.column.duration')}</TableHead>
          <TableHead scope="col">{t('overview.health.probe.column.tls')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {props.probes.map((probe, index) => (
          // A probe repeats per endpoint; the list is fixed by the read and never reorders.
          // biome-ignore lint/suspicious/noArrayIndexKey: probes have no id of their own
          <TableRow key={`${props.id}-${probe.probe}-${index}`}>
            <TableCell className="font-mono text-xs">{probe.probe}</TableCell>
            <TableCell>
              <UntrustedName
                name={probe.endpoint.label}
                label={t('overview.health.probe.column.endpoint')}
              />{' '}
              <span className="text-xs text-foreground-light">
                {probe.endpoint.verified
                  ? t('overview.health.probe.verified')
                  : t('overview.health.probe.unverified')}
              </span>
            </TableCell>
            <TableCell>{outcomeText(probe.outcome)}</TableCell>
            <TableCell>
              {probe.durationMs === null
                ? t('overview.health.probe.noDuration')
                : `${probe.durationMs} ms`}
            </TableCell>
            <TableCell>{tlsText(probe.tls)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

function outcomeText(outcome: ProbeResult['outcome']): string {
  switch (outcome) {
    case 'ok':
      return t('overview.health.outcome.ok')
    case 'failed':
      return t('overview.health.outcome.failed')
    case 'timeout':
      return t('overview.health.outcome.timeout')
  }
}

function tlsText(tls: ProbeResult['tls']): string {
  switch (tls) {
    case 'verified':
      return t('overview.health.tls.verified')
    case 'failed':
      return t('overview.health.tls.failed')
    case 'not_reached':
      return t('overview.health.tls.not_reached')
  }
}

function severityText(severity: HealthCondition['severity']): string {
  switch (severity) {
    case 'info':
      return t('overview.health.severity.info')
    case 'warning':
      return t('overview.health.severity.warning')
    case 'critical':
      return t('overview.health.severity.critical')
  }
}

function ConditionList(props: { readonly conditions: readonly HealthCondition[] }): ReactNode {
  return (
    <ul className="flex flex-col gap-1 text-sm" aria-label={t('overview.health.conditions')}>
      {props.conditions.map((condition, index) => {
        const key = conditionKey(condition.condition)
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: a condition repeats per endpoint
          <li key={`${condition.condition}-${index}`} data-severity={condition.severity}>
            <span className="font-medium">{severityText(condition.severity)}:</span>{' '}
            {key === undefined ? (
              <>
                {t('overview.health.condition.unknown')}{' '}
                <UntrustedName
                  name={condition.condition}
                  mono
                  label={t('overview.health.condition.unknown')}
                />
              </>
            ) : (
              t(key)
            )}
            {condition.count === null ? null : (
              <span className="text-foreground-light">
                {' '}
                ({t('overview.health.condition.count', { count: condition.count })})
              </span>
            )}
          </li>
        )
      })}
    </ul>
  )
}

/** The node and the backup protection that come with the sample, each with its own source and age. */
function Companions({ health }: { readonly health: TargetHealth }): ReactNode {
  return (
    <div className="flex flex-col gap-2 text-sm text-foreground-light">
      {health.node === null ? (
        <p>{t('overview.health.noNode')}</p>
      ) : (
        <p data-slot="node">
          {t('overview.health.node', { state: health.node.state, source: health.node.source })}{' '}
          <ObservedTime observedAt={health.node.observedAt} />
        </p>
      )}
      {health.backups === null ? (
        <p>{t('overview.health.backups.none')}</p>
      ) : (
        <p data-slot="backups">
          {t('overview.health.backups', {
            state: health.backups.state,
            source: health.backups.source,
          })}{' '}
          <ObservedTime observedAt={health.backups.observedAt} />
        </p>
      )}
    </div>
  )
}
