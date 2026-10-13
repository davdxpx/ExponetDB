import {
  Button,
  StatusIcon,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@exponetdb/ui'
import {
  type KeyValueItem,
  KeyValueList,
  TierChip,
  TimestampInfo,
  UntrustedName,
  UntrustedText,
  useLinkComponent,
} from '@exponetdb/ui-patterns'
import type { ReactNode } from 'react'
import { t } from '../../lib/i18n/i18n.ts'
import { actorKindLabel, eventLinks, outcomeLabel, phaseLabel } from './event-model.ts'
import type { AuditEvent } from './keys.ts'

/**
 * The audit events of a search as a table (newest first, as the server
 * sends them) and the details of one event. Everything an event carries that
 * a person or a client wrote (the actor's label, the reason, a denial's
 * reason, a target path) is untrusted text; ids and codes are shown as code.
 * Links go only to the plan, the operation and the ledger, built from typed
 * ids through the allowlist (`eventLinks`).
 */
export function EventTable({
  events,
  selected,
  onSelect,
}: {
  readonly events: readonly AuditEvent[]
  readonly selected: string | undefined
  readonly onSelect: (id: string) => void
}): ReactNode {
  return (
    <Table id="audit-events">
      <TableCaption className="sr-only">{t('audit.events.caption')}</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">{t('audit.column.time')}</TableHead>
          <TableHead scope="col">{t('audit.column.actor')}</TableHead>
          <TableHead scope="col">{t('audit.column.action')}</TableHead>
          <TableHead scope="col">{t('audit.column.target')}</TableHead>
          <TableHead scope="col">{t('audit.column.outcome')}</TableHead>
          <TableHead scope="col">
            <span className="sr-only">{t('audit.column.details')}</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {events.map((event) => (
          <TableRow
            key={event.id}
            data-event={event.id}
            data-outcome={event.result.status}
            data-selected={selected === event.id ? '' : undefined}
          >
            <TableCell className="whitespace-nowrap">
              <TimestampInfo timestamp={event.occurredAt} />
            </TableCell>
            <TableCell>
              <UntrustedName name={event.actor.label} label={t('audit.column.actor')} />
            </TableCell>
            <TableCell>
              <code className="font-mono text-xs">{event.action}</code>
            </TableCell>
            <TableCell>
              {event.subject.targetPath === null ? (
                <span className="text-foreground-lighter">{t('audit.target.none')}</span>
              ) : (
                <span className="inline-flex flex-wrap items-center gap-2">
                  <UntrustedName
                    name={event.subject.targetPath}
                    mono
                    label={t('audit.column.target')}
                  />
                  {event.subject.tier === 'prod' ? <TierChip tier="prod" /> : null}
                </span>
              )}
            </TableCell>
            <TableCell>
              <Outcome event={event} />
            </TableCell>
            <TableCell>
              <Button
                type="button"
                variant="text"
                size="tiny"
                aria-controls="audit-event-details"
                aria-expanded={selected === event.id}
                aria-label={t('audit.details.open', { id: event.id })}
                onClick={() => onSelect(event.id)}
              >
                {t('audit.details.show')}
              </Button>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

function Outcome({ event }: { readonly event: AuditEvent }): ReactNode {
  const status = event.result.status
  return (
    <span className="inline-flex items-center gap-1 text-xs whitespace-nowrap">
      <StatusIcon
        variant={
          status === 'succeeded' ? 'success' : status === 'failed' ? 'destructive' : 'warning'
        }
        hideBackground
        decorative
      />
      {outcomeLabel(status)}
      {event.result.errorCode === null ? null : (
        <code className="font-mono text-foreground-light">{event.result.errorCode}</code>
      )}
    </span>
  )
}

const code = (value: string | null): ReactNode =>
  value === null ? (
    <span className="text-foreground-lighter">{t('audit.details.none')}</span>
  ) : (
    <code className="break-all font-mono text-xs">{value}</code>
  )

export function EventDetails({
  event,
  onClose,
}: {
  readonly event: AuditEvent | undefined
  readonly onClose: () => void
}): ReactNode {
  const Link = useLinkComponent()
  if (event === undefined) {
    return (
      <section
        id="audit-event-details"
        aria-label={t('audit.details.title')}
        className="rounded-lg border border-dashed border-default p-4 text-sm text-foreground-lighter"
      >
        {t('audit.details.empty')}
      </section>
    )
  }
  const links = eventLinks(event)
  const facts: KeyValueItem[] = [
    { id: 'id', label: t('audit.details.id'), value: code(event.id), copyText: event.id },
    {
      id: 'time',
      label: t('audit.details.time'),
      value: <TimestampInfo timestamp={event.occurredAt} />,
    },
    { id: 'action', label: t('audit.details.action'), value: code(event.action) },
    { id: 'phase', label: t('audit.details.phase'), value: phaseLabel(event.phase) },
    { id: 'outcome', label: t('audit.details.outcome'), value: <Outcome event={event} /> },
    {
      id: 'actor',
      label: t('audit.details.actor'),
      value: (
        <span className="inline-flex flex-wrap items-baseline gap-x-2">
          <UntrustedName name={event.actor.label} label={t('audit.details.actor')} />
          <span className="text-foreground-light">{actorKindLabel(event.actor.kind)}</span>
          {event.actor.identityId === null ? null : code(event.actor.identityId)}
        </span>
      ),
    },
    {
      id: 'client',
      label: t('audit.details.client'),
      value:
        event.client === null ? (
          <span className="text-foreground-lighter">{t('audit.details.none')}</span>
        ) : (
          <span className="flex flex-col gap-0.5">
            <span>{t('audit.details.clientKind', { kind: event.client.kind })}</span>
            {event.client.clientId === null ? null : code(event.client.clientId)}
            {event.client.grantId === null
              ? null
              : t('audit.details.grant', { id: event.client.grantId })}
          </span>
        ),
    },
    {
      id: 'target',
      label: t('audit.details.target'),
      value:
        event.subject.targetPath === null ? (
          code(event.subject.targetId)
        ) : (
          <span className="inline-flex flex-wrap items-center gap-2">
            <UntrustedName name={event.subject.targetPath} mono label={t('audit.details.target')} />
            {event.subject.tier === null ? null : <TierChip tier={event.subject.tier} />}
          </span>
        ),
    },
    ...(event.subject.clusterId === null
      ? []
      : [
          {
            id: 'cluster',
            label: t('audit.details.cluster'),
            value: code(event.subject.clusterId),
          },
        ]),
    ...(event.subject.nodeId === null
      ? []
      : [{ id: 'node', label: t('audit.details.node'), value: code(event.subject.nodeId) }]),
    {
      id: 'reason',
      label: t('audit.details.reason'),
      value:
        event.reason === null ? (
          <span className="text-foreground-lighter">{t('audit.details.none')}</span>
        ) : (
          <UntrustedText text={event.reason} maxLines={12} label={t('audit.details.reason')} />
        ),
    },
    ...(event.denial === null
      ? []
      : [
          {
            id: 'denial',
            label: t('audit.details.denial'),
            value: (
              <span className="flex flex-col gap-1">
                {code(event.denial.action)}
                {event.denial.tool === null ? null : code(event.denial.tool)}
                <UntrustedText
                  text={event.denial.reason}
                  maxLines={8}
                  label={t('audit.details.denial')}
                />
              </span>
            ),
          },
        ]),
    { id: 'plan-hash', label: t('audit.details.planHash'), value: code(event.refs.planHash) },
    { id: 'job', label: t('audit.details.job'), value: code(event.refs.jobId) },
  ]
  return (
    <section
      id="audit-event-details"
      aria-label={t('audit.details.title')}
      className="flex flex-col gap-3 rounded-lg border border-default bg-surface-100 p-4"
      data-event={event.id}
    >
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-base font-medium text-foreground">{t('audit.details.title')}</h2>
        <Button type="button" variant="text" size="tiny" onClick={onClose}>
          {t('audit.details.close')}
        </Button>
      </div>
      <KeyValueList items={facts} layout="stacked" />
      {links.plan === undefined &&
      links.operation === undefined &&
      links.ledger === undefined ? null : (
        <nav aria-label={t('audit.details.links')} className="flex flex-wrap gap-3 text-sm">
          {links.plan === undefined ? null : (
            <Link href={links.plan} className="text-foreground underline">
              {t('audit.details.link.plan')}
            </Link>
          )}
          {links.operation === undefined ? null : (
            <Link href={links.operation} className="text-foreground underline">
              {t('audit.details.link.operation')}
            </Link>
          )}
          {links.ledger === undefined ? null : (
            <Link href={links.ledger} className="text-foreground underline">
              {t('audit.details.link.ledger')}
            </Link>
          )}
        </nav>
      )}
    </section>
  )
}
