import type { ApprovalQueueItem } from '@exponetdb/sdk/operations'
import { cn } from '@exponetdb/ui'
import {
  Admonition,
  ObservedTime,
  PageContainer,
  PageHeader,
  PageHeaderDescription,
  PageHeaderMeta,
  PageHeaderSummary,
  PageHeaderTitle,
  ReadableView,
  TierChip,
  UntrustedName,
  useLinkComponent,
  useNavigate,
} from '@exponetdb/ui-patterns'
import { useQuery } from '@tanstack/react-query'
import { type ReactNode, useEffect } from 'react'
import { useApi } from '../../lib/api/context.tsx'
import { describeError, type MessageKey, t } from '../../lib/i18n/i18n.ts'
import { operationOf } from '../../lib/navigation/links.ts'
import { toReadable } from '../../lib/query/readable.ts'
import { approvalQueueQuery, operationQuery } from '../plans/keys.ts'
import { planPath } from '../plans/plan-model.ts'
import { useFragmentBinding } from './fragment-binding.ts'

/**
 * The approvals queue (`/approvals`, OD-9): the operations waiting for the
 * person's decision, each with what it changes and a link to its plan review
 * page, where the decision is taken. `/approvals#operation=op_…` (the link
 * the server, the CLI and MCP emit, ADR-0029) is a redirect to the review
 * page of that operation's plan: the queue item names the plan, and for an
 * operation that is not in the person's queue the operation view does. The
 * fragment is read once; another fragment reloads the page.
 */
export function ApprovalsPage(): ReactNode {
  const fragment = useFragmentBinding()
  const focus = operationOf(fragment)
  const { client } = useApi()
  const navigate = useNavigate()
  const queue = useQuery(approvalQueueQuery(client))
  const item =
    focus === undefined ? undefined : queue.data?.items.find((entry) => entry.operationId === focus)
  // Not in the person's queue (decided already, or not theirs to decide): the operation names its plan.
  const askOperation =
    focus !== undefined && (queue.isError || (queue.isSuccess && item === undefined))
  const operation = useQuery({
    ...operationQuery(client, focus ?? ''),
    enabled: askOperation,
  })
  const planId = item?.planId ?? (askOperation ? operation.data?.planId : undefined)
  const destination = focus === undefined ? undefined : planPath(planId)

  useEffect(() => {
    if (destination !== undefined) navigate(destination, { replace: true })
  }, [destination, navigate])

  let linkNote: ReactNode = null
  if (destination !== undefined) {
    linkNote = (
      <p role="status" className="text-sm text-foreground-light">
        {t('approvals.link.opening')}
      </p>
    )
  } else if (askOperation && operation.isError) {
    linkNote = (
      <Admonition
        type="warning"
        title={t('approvals.link.failed.title')}
        description={t('approvals.link.failed', { reason: describeError(operation.error) })}
      />
    )
  } else if (askOperation && operation.isSuccess) {
    linkNote = <Admonition type="warning" title={t('approvals.link.noPlan')} />
  }

  return (
    <>
      <PageHeader size="large">
        <PageHeaderMeta>
          <PageHeaderSummary>
            <PageHeaderTitle>{t('approvals.title')}</PageHeaderTitle>
            <PageHeaderDescription>{t('approvals.description')}</PageHeaderDescription>
          </PageHeaderSummary>
        </PageHeaderMeta>
      </PageHeader>
      <PageContainer size="large" className="flex flex-col gap-4 py-6">
        {linkNote}
        <ReadableView
          readable={toReadable(queue)}
          what={t('approvals.read.what')}
          onRetry={() => void queue.refetch()}
          onRefresh={() => void queue.refetch()}
          busy={queue.isFetching}
          headingLevel={2}
          empty={{
            isEmpty: (value) => value.items.length === 0,
            content: (
              <p id="no-approvals" className="text-sm">
                {t('approvals.empty')}
              </p>
            ),
          }}
          ready={(value) => (
            <ul
              id="approval-list"
              className="cards flex flex-col gap-3"
              aria-label={t('approvals.list.label')}
            >
              {value.items.map((entry) => (
                <QueueItem
                  key={entry.operationId}
                  item={entry}
                  focused={entry.operationId === focus}
                />
              ))}
            </ul>
          )}
        />
      </PageContainer>
    </>
  )
}

const CLIENTS: Readonly<Record<ApprovalQueueItem['actorClient'], MessageKey>> = {
  web: 'approvals.via.web',
  rest: 'approvals.via.rest',
  mcp: 'approvals.via.mcp',
  cli: 'approvals.via.cli',
  ci: 'approvals.via.ci',
  system: 'approvals.via.system',
}

function QueueItem({
  item,
  focused,
}: {
  readonly item: ApprovalQueueItem
  readonly focused: boolean
}): ReactNode {
  const Link = useLinkComponent()
  const href = planPath(item.planId)
  const targetPath = item.review?.plan.subject.targetPath ?? null
  const given = item.approvals.filter((approval) => approval.decision === 'approved').length
  const client = Object.hasOwn(CLIENTS, item.actorClient) ? CLIENTS[item.actorClient] : undefined
  const headingId = `approval-${item.operationId}`
  return (
    <li
      className={cn(
        'card flex flex-col gap-3 rounded-lg border border-default bg-surface-100 p-4',
        focused && 'focused border-strong ring-2 ring-ring',
      )}
      data-operation={item.operationId}
      aria-labelledby={headingId}
    >
      <h2 id={headingId} className="flex flex-wrap items-center gap-2 text-base font-medium">
        <UntrustedName name={item.kind} mono label={t('approvals.item.kind')} />
        <span className="rounded-sm border border-default px-1.5 text-xs text-foreground-light">
          {t('approvals.item.class', { class: item.class })}
        </span>
        {item.tier === null ? null : <TierChip tier={item.tier} />}
      </h2>
      <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-[minmax(0,11rem)_minmax(0,1fr)]">
        <dt className="text-foreground-lighter">{t('approvals.item.target')}</dt>
        <dd className="m-0 min-w-0">
          {targetPath === null ? (
            t('approvals.item.noTarget')
          ) : (
            <UntrustedName name={targetPath} mono label={t('approvals.item.target')} />
          )}
        </dd>
        <dt className="text-foreground-lighter">{t('approvals.item.requested')}</dt>
        <dd className="m-0">
          <ObservedTime observedAt={item.requestedAt} withDate />
        </dd>
        <dt className="text-foreground-lighter">{t('approvals.item.through')}</dt>
        <dd className="m-0">
          {client === undefined ? (
            <UntrustedName name={item.actorClient} mono label={t('approvals.item.through')} />
          ) : (
            t(client)
          )}
        </dd>
        <dt className="text-foreground-lighter">{t('approvals.item.approvals')}</dt>
        <dd className="m-0">{t('approvals.item.count', { given, required: item.required })}</dd>
      </dl>
      {item.actorClient === 'mcp' ? (
        <p role="note" className="text-sm text-warning-600">
          {t('approvals.item.agent')}
        </p>
      ) : null}
      {item.ownPlan ? (
        <p role="note" className="text-sm text-foreground-light">
          {t('approvals.item.own')}
        </p>
      ) : null}
      <p className="text-sm">
        {href === undefined ? (
          t('approvals.item.noPlan')
        ) : (
          <Link href={href} className="text-primary underline focus-ring">
            {t('approvals.item.review')}
          </Link>
        )}
      </p>
    </li>
  )
}
