import {
  NotAvailableYetState,
  PageContainer,
  PageHeader,
  PageHeaderDescription,
  PageHeaderMeta,
  PageHeaderSummary,
  PageHeaderTitle,
  readableValue,
  TierChip,
} from '@exponetdb/ui-patterns'
import type { ReactNode } from 'react'
import { type MessageKey, t } from '../../lib/i18n/i18n.ts'
import { TARGET_NAV } from '../../shell/navigation.ts'
import { ContentWrapper } from '../target/content-wrapper.tsx'
import { useTargetScope } from '../target/scope.tsx'

/**
 * The pages whose server side arrives with Wave 9: statement statistics,
 * advisors and backups of a target, and the global backups page. Each is a
 * named "not available yet" state with the correct navigation and a short
 * description of what will come. They read nothing but the target itself (for
 * the page chrome and a suspended or decommissioned notice) and show no
 * number, list or chart, so there is nothing to mock and nothing that could
 * read as an empty or healthy result.
 */
type Wave9Section = 'performance' | 'advisors' | 'backups'

const COMING: Readonly<Record<Wave9Section, readonly MessageKey[]>> = {
  performance: ['wave9.performance.item1', 'wave9.performance.item2', 'wave9.performance.item3'],
  advisors: ['wave9.advisors.item1', 'wave9.advisors.item2'],
  backups: ['wave9.backups.item1', 'wave9.backups.item2', 'wave9.backups.item3'],
}

function ComingList(props: { readonly items: readonly MessageKey[] }): ReactNode {
  return (
    <section aria-labelledby="wave9-comes-title" className="flex flex-col gap-2">
      <h2 id="wave9-comes-title" className="text-base font-medium text-foreground">
        {t('wave9.comes.title')}
      </h2>
      <ul className="list-disc pl-5 text-sm text-foreground-light">
        {props.items.map((key) => (
          <li key={key}>{t(key)}</li>
        ))}
      </ul>
    </section>
  )
}

/** A Wave 9 page of one target (`/t/…/performance`, `/advisors`, `/backups`). */
export function Wave9TargetPage(props: { readonly section: Wave9Section }): ReactNode {
  const scope = useTargetScope()
  const label = TARGET_NAV.find((entry) => entry.id === props.section)?.label ?? props.section
  const value = readableValue(scope.read)
  return (
    <>
      <PageHeader size="large">
        <PageHeaderMeta>
          <PageHeaderSummary>
            <PageHeaderTitle
              productionCue={
                value !== undefined && value.tier === 'prod' ? <TierChip tier="prod" /> : undefined
              }
            >
              {label}
            </PageHeaderTitle>
          </PageHeaderSummary>
        </PageHeaderMeta>
      </PageHeader>
      <PageContainer size="large" className="flex flex-col gap-6 py-6">
        <ContentWrapper
          requires={[]}
          target={scope.read}
          feature={label}
          onRetry={scope.refetch}
          busy={scope.fetching}
        >
          <div className="flex flex-col gap-6">
            <NotAvailableYetState what={label} reason={t('wave9.reason')} headingLevel={2} />
            <ComingList items={COMING[props.section]} />
          </div>
        </ContentWrapper>
      </PageContainer>
    </>
  )
}

/** The global `/backups` page. */
export function GlobalBackupsPage(): ReactNode {
  return (
    <>
      <PageHeader size="large">
        <PageHeaderMeta>
          <PageHeaderSummary>
            <PageHeaderTitle>{t('wave9.global.title')}</PageHeaderTitle>
            <PageHeaderDescription>{t('wave9.global.description')}</PageHeaderDescription>
          </PageHeaderSummary>
        </PageHeaderMeta>
      </PageHeader>
      <PageContainer size="large" className="flex flex-col gap-6 py-6">
        <NotAvailableYetState
          what={t('wave9.global.title')}
          reason={t('wave9.reason')}
          headingLevel={2}
        />
        <ComingList items={['wave9.global.item1', 'wave9.global.item2', 'wave9.global.item3']} />
      </PageContainer>
    </>
  )
}
