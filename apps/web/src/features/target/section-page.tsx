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
import { t } from '../../lib/i18n/i18n.ts'
import { TARGET_NAV, type TargetSection } from '../../shell/navigation.ts'
import { ContentWrapper } from './content-wrapper.tsx'
import type { SchemaKind } from './params.ts'
import { useTargetHealth } from './queries.ts'
import { useTargetScope } from './scope.tsx'

/**
 * The page of one target section until its screen is built (Phases 10 to
 * 12): the title, then `ContentWrapper` with the section's requirements from
 * `TARGET_NAV`, then a named "not available yet" state that says the page is
 * not built. The pages that wait for Wave 9 never reach the placeholder: the
 * wrapper renders their own named state. A placeholder shows no data and no
 * list, so it cannot show an empty or failed read as anything else.
 */
export function TargetSectionPage({
  section,
  kind,
}: {
  readonly section: TargetSection
  /** The kind of schema object below `/schema/<kind>` (already validated). */
  readonly kind?: SchemaKind
}): ReactNode {
  const scope = useTargetScope()
  const item = TARGET_NAV.find((entry) => entry.id === section)
  // Every section is in TARGET_NAV; a missing one would be a bug that shows as a page without gates.
  const requires = item?.requires ?? []
  const label = item?.label ?? section
  const needsHealth = requires.some((r) => r === 'target.reachable' || r === 'node.online')
  const health = useTargetHealth(scope.target.path, needsHealth)
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
            {kind === undefined ? null : (
              <PageHeaderDescription>{t('target.schema.kind', { kind })}</PageHeaderDescription>
            )}
          </PageHeaderSummary>
        </PageHeaderMeta>
      </PageHeader>
      <PageContainer size="large" className="py-6">
        <ContentWrapper
          requires={requires}
          target={scope.read}
          health={needsHealth ? health.readable : undefined}
          feature={label}
          onRetry={scope.refetch}
          onRetryHealth={health.refetch}
          busy={scope.fetching}
        >
          <NotAvailableYetState
            what={label}
            reason={t('target.placeholder.reason')}
            headingLevel={2}
          />
        </ContentWrapper>
      </PageContainer>
    </>
  )
}
