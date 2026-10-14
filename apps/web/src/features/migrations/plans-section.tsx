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
import { ObservedTime, UntrustedName, useLinkComponent } from '@exponetdb/ui-patterns'
import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useApi } from '../../lib/api/context.tsx'
import { t } from '../../lib/i18n/i18n.ts'
import { planPath } from '../plans/plan-model.ts'
import { nounPhrase } from '../target/phrases.ts'
import { targetPlansQuery } from '../target-ops/keys.ts'
import { ReadSection } from '../target-ops/read-section.tsx'
import { Section } from '../target-ops/section.tsx'

/**
 * The newest plans for this target (`GET /plans?target=`), each linked to its
 * review page: a plan is where a change is reviewed, applied and followed.
 * One page of the list; a longer list says so and links to all plans.
 */
export function PlansSection({ targetId }: { readonly targetId: string }): ReactNode {
  const { client } = useApi()
  const query = useQuery(targetPlansQuery(client, targetId))
  const Link = useLinkComponent()
  return (
    <Section
      id="plans"
      title={t('migrations.plans.title')}
      description={t('migrations.plans.description')}
    >
      <ReadSection
        query={query}
        what={nounPhrase('migrations.plans.what')}
        permission="plans.approve"
        missing={(page) => (page.nextCursor === null ? undefined : [t('migrations.plans.more')])}
        empty={{ isEmpty: (page) => page.items.length === 0 }}
        ready={(page) => <PlanRows plans={page.items} />}
      />
      <p className="m-0 text-sm">
        <Link href="/changes/plans" className="text-primary underline focus-ring">
          {t('migrations.plans.all')}
        </Link>
      </p>
    </Section>
  )
}

function PlanRows({ plans }: { readonly plans: readonly PlanRead[] }): ReactNode {
  const Link = useLinkComponent()
  return (
    <Table>
      <TableCaption className="sr-only">{t('migrations.plans.caption')}</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">{t('migrations.plans.column.plan')}</TableHead>
          <TableHead scope="col">{t('migrations.plans.column.change')}</TableHead>
          <TableHead scope="col">{t('migrations.plans.column.state')}</TableHead>
          <TableHead scope="col">{t('migrations.plans.column.created')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {plans.map((plan) => {
          const href = planPath(plan.id)
          return (
            <TableRow key={plan.id} data-plan={plan.id}>
              <TableCell className="font-mono text-xs">
                {href === undefined ? (
                  <UntrustedName name={plan.id} mono label={t('migrations.plans.column.plan')} />
                ) : (
                  <Link href={href} className="text-primary underline focus-ring">
                    {plan.id}
                  </Link>
                )}
              </TableCell>
              <TableCell>
                <UntrustedName name={plan.kind} mono label={t('migrations.plans.column.change')} />{' '}
                <span className="text-xs text-foreground-light">
                  {t('approvals.item.class', { class: plan.class })}
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
