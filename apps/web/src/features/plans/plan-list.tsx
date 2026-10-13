import type { PlanRead } from '@exponetdb/sdk/operations'
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@exponetdb/ui'
import {
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
} from '@exponetdb/ui-patterns'
import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useApi } from '../../lib/api/context.tsx'
import { t } from '../../lib/i18n/i18n.ts'
import { toReadable } from '../../lib/query/readable.ts'
import { planListQuery } from './keys.ts'
import { planPath } from './plan-model.ts'

/**
 * The plans the person may read (`/changes/plans`), newest first, one page
 * of the list read, each with a link to its review page. A list longer than
 * one read says so: the page never presents the first page as the whole
 * list. Filters and paging arrive with the Changes screens.
 */
export function PlanListPage(): ReactNode {
  const { client } = useApi()
  const list = useQuery(planListQuery(client))
  return (
    <>
      <PageHeader size="large">
        <PageHeaderMeta>
          <PageHeaderSummary>
            <PageHeaderTitle>{t('plans.list.title')}</PageHeaderTitle>
            <PageHeaderDescription>{t('plans.list.description')}</PageHeaderDescription>
          </PageHeaderSummary>
        </PageHeaderMeta>
      </PageHeader>
      <PageContainer size="large" className="flex flex-col gap-4 py-6">
        <ReadableView
          readable={toReadable(list, {
            missing: (value) => (value.nextCursor === null ? undefined : [t('plans.list.more')]),
          })}
          what={t('plans.list.what')}
          onRetry={() => void list.refetch()}
          onRefresh={() => void list.refetch()}
          busy={list.isFetching}
          headingLevel={2}
          empty={{ isEmpty: (value) => value.items.length === 0 }}
          ready={(value) => <PlanTable plans={value.items} />}
        />
      </PageContainer>
    </>
  )
}

function PlanTable({ plans }: { readonly plans: readonly PlanRead[] }): ReactNode {
  const Link = useLinkComponent()
  return (
    <Table>
      <TableCaption className="sr-only">{t('plans.list.caption')}</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">{t('plans.list.column.plan')}</TableHead>
          <TableHead scope="col">{t('plans.list.column.change')}</TableHead>
          <TableHead scope="col">{t('plans.list.column.target')}</TableHead>
          <TableHead scope="col">{t('plans.list.column.state')}</TableHead>
          <TableHead scope="col">{t('plans.list.column.created')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {plans.map((plan) => {
          const href = planPath(plan.id)
          return (
            <TableRow key={plan.id} data-plan={plan.id}>
              <TableCell className="font-mono text-xs">
                {href === undefined ? (
                  <UntrustedName name={plan.id} mono label={t('plans.list.column.plan')} />
                ) : (
                  <Link href={href} className="text-primary underline focus-ring">
                    {plan.id}
                  </Link>
                )}
              </TableCell>
              <TableCell>
                <UntrustedName name={plan.kind} mono label={t('plans.list.column.change')} />{' '}
                <span className="text-xs text-foreground-light">
                  {t('approvals.item.class', { class: plan.class })}
                </span>
              </TableCell>
              <TableCell>
                <span className="inline-flex flex-wrap items-center gap-2">
                  {plan.subject.targetPath === null ? (
                    t('approvals.item.noTarget')
                  ) : (
                    <UntrustedName
                      name={plan.subject.targetPath}
                      mono
                      label={t('plans.list.column.target')}
                    />
                  )}
                  {plan.subject.tier === null ? null : <TierChip tier={plan.subject.tier} />}
                </span>
              </TableCell>
              <TableCell>{plan.state}</TableCell>
              <TableCell>
                <ObservedTime observedAt={plan.createdAt} withDate />
              </TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}
