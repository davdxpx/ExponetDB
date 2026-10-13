import type { AuditEvent, OperationRead } from '@exponetdb/sdk/operations'
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@exponetdb/ui'
import { EventRow, ObservedTime, UntrustedName, useLinkComponent } from '@exponetdb/ui-patterns'
import { useInfiniteQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useApi } from '../../lib/api/context.tsx'
import { t } from '../../lib/i18n/i18n.ts'
import { planPath } from '../plans/plan-model.ts'
import { nounPhrase } from '../target/phrases.ts'
import type { Target } from '../target/queries.ts'
import { operationPath } from '../target-ops/ids.ts'
import { auditQuery, operationsQuery } from '../target-ops/keys.ts'
import { LoadMore, pagedQuery } from '../target-ops/paged.tsx'
import { ReadSection } from '../target-ops/read-section.tsx'
import { Section } from '../target-ops/section.tsx'
import { TargetPage } from '../target-ops/target-page.tsx'
import { actorText, auditClientText, auditOutcome } from './activity-model.ts'

/**
 * `/t/<product>/<project>/<environment>/activity`: what was done to the
 * target. Operations (`GET /operations?target=`) say what ran and how it
 * ended, with applied and verified kept apart; audit events
 * (`GET /audit-events?target=`, `audit.read`) say who asked for what. A
 * person without `audit.read` sees a named "not permitted" state, never an
 * empty list. Actors are pseudonyms and client names are the clients' own
 * words ("name not verified").
 */
export function ActivityPage(): ReactNode {
  return (
    <TargetPage section="activity" description={t('activity.description')}>
      {(target) => (
        <>
          <OperationsSection target={target} />
          <AuditSection target={target} />
        </>
      )}
    </TargetPage>
  )
}

function OperationsSection({ target }: { readonly target: Target }): ReactNode {
  const { client } = useApi()
  const query = useInfiniteQuery(operationsQuery(client, target.id))
  return (
    <Section
      id="operations"
      title={t('activity.operations.title')}
      description={t('activity.operations.description')}
    >
      <ReadSection
        query={pagedQuery(query)}
        what={nounPhrase('activity.operations.what')}
        permission="targets.read"
        missing={(value) => (value.more ? [t('activity.operations.more')] : undefined)}
        empty={{ isEmpty: (value) => value.items.length === 0 }}
        ready={(value) => (
          <>
            <OperationsTable operations={value.items} />
            <LoadMore
              more={value.more}
              loading={query.isFetchingNextPage}
              onLoad={() => void query.fetchNextPage()}
              label={t('activity.loadMore')}
            />
          </>
        )}
      />
    </Section>
  )
}

function OperationsTable({
  operations,
}: {
  readonly operations: readonly OperationRead[]
}): ReactNode {
  const Link = useLinkComponent()
  return (
    <Table>
      <TableCaption className="sr-only">{t('activity.operations.caption')}</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">{t('activity.operations.column.operation')}</TableHead>
          <TableHead scope="col">{t('activity.operations.column.state')}</TableHead>
          <TableHead scope="col">{t('activity.operations.column.applied')}</TableHead>
          <TableHead scope="col">{t('activity.operations.column.verified')}</TableHead>
          <TableHead scope="col">{t('activity.operations.column.actor')}</TableHead>
          <TableHead scope="col">{t('activity.operations.column.created')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {operations.map((operation) => {
          const href = operationPath(operation.id)
          const plan = planPath(operation.planId)
          return (
            <TableRow key={operation.id} data-operation={operation.id}>
              <TableCell>
                <UntrustedName
                  name={operation.kind}
                  mono
                  label={t('activity.operations.column.operation')}
                />
                <div className="text-xs">
                  {href === undefined ? (
                    <UntrustedName
                      name={operation.id}
                      mono
                      label={t('activity.operations.column.operation')}
                    />
                  ) : (
                    <Link href={href} className="font-mono text-primary underline focus-ring">
                      {operation.id}
                    </Link>
                  )}
                  {plan === undefined ? null : (
                    <>
                      {' '}
                      <Link href={plan} className="text-primary underline focus-ring">
                        {t('activity.viewPlan')}
                      </Link>
                    </>
                  )}
                </div>
              </TableCell>
              <TableCell>
                {operation.state}
                {operation.errorCode === null ? null : (
                  <div className="font-mono text-xs text-foreground-light">
                    {operation.errorCode}
                  </div>
                )}
              </TableCell>
              <TableCell>{operation.applyOutcome}</TableCell>
              <TableCell>{operation.verificationOutcome}</TableCell>
              <TableCell>
                <UntrustedName
                  name={actorText(operation.actor)}
                  label={t('activity.operations.column.actor')}
                />
              </TableCell>
              <TableCell>
                <ObservedTime observedAt={operation.createdAt} withDate />
              </TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}

function AuditSection({ target }: { readonly target: Target }): ReactNode {
  const { client } = useApi()
  const query = useInfiniteQuery(auditQuery(client, target.id))
  return (
    <Section
      id="audit"
      title={t('activity.audit.title')}
      description={t('activity.audit.description')}
    >
      <ReadSection
        query={pagedQuery(query)}
        what={nounPhrase('activity.audit.what')}
        permission="audit.read"
        missing={(value) => (value.more ? [t('activity.audit.more')] : undefined)}
        empty={{ isEmpty: (value) => value.items.length === 0 }}
        ready={(value) => (
          <>
            <ul className="m-0 list-none p-0" aria-label={t('activity.audit.caption')}>
              {value.items.map((event) => (
                <AuditItem key={event.id} event={event} />
              ))}
            </ul>
            <LoadMore
              more={value.more}
              loading={query.isFetchingNextPage}
              onLoad={() => void query.fetchNextPage()}
              label={t('activity.loadMore')}
            />
          </>
        )}
      />
    </Section>
  )
}

function AuditItem({ event }: { readonly event: AuditEvent }): ReactNode {
  const client = auditClientText(event)
  const plan = planPath(event.refs.planId)
  const operation = operationPath(event.refs.operationId)
  const errorCode = event.result.errorCode
  return (
    <li data-audit={event.id}>
      <EventRow
        actor={actorText(event.actor)}
        {...(client === undefined ? {} : { client })}
        action={`${event.action} (${event.phase})`}
        {...(event.subject.targetPath === null ? {} : { subject: event.subject.targetPath })}
        outcome={auditOutcome(event.result.status)}
        {...(errorCode === null ? {} : { errorCode })}
        occurredAt={event.occurredAt}
        links={{
          ...(plan === undefined ? {} : { plan }),
          ...(operation === undefined ? {} : { operation }),
        }}
      />
      {event.reason === null ? null : (
        <p className="m-0 border-b border-default px-3 py-1 text-xs text-foreground-light">
          {t('activity.audit.reason')}{' '}
          <UntrustedName
            name={event.reason}
            maxCodePoints={200}
            label={t('activity.audit.reason')}
          />
        </p>
      )}
    </li>
  )
}
