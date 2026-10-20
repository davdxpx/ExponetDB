import {
  LoadingState,
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
import { lazy, type ReactNode, Suspense } from 'react'
import { t } from '../../lib/i18n/i18n.ts'
import { TARGET_NAV, type TargetSection } from '../../shell/navigation.ts'
import { ContentWrapper } from './content-wrapper.tsx'
import type { SchemaKind } from './params.ts'
import { useTargetHealth } from './queries.ts'
import { useTargetScope } from './scope.tsx'

// Each body is its own chunk, loaded when its section opens: a target page
// does not download the schema browser, the SQL workspace and the overview
// together (the bundle budget of `scripts/budgets.ts` checks it).
const TargetOverviewBody = lazy(async () => {
  const module = await import('../target-overview/overview-page.tsx')
  return { default: module.TargetOverviewBody }
})
const SchemaBody = lazy(async () => {
  const module = await import('../schema/schema-page.tsx')
  return { default: module.SchemaBody }
})
const SqlBody = lazy(async () => {
  const module = await import('../sql/sql-page.tsx')
  return { default: module.SqlBody }
})

/**
 * The page of one target section: the title, then `ContentWrapper` with the
 * section's requirements from `TARGET_NAV`, then the section's body. The
 * overview and the schema browser are built (Phase 10); a section whose screen
 * is not built yet says so in a named "not available yet" state, which shows
 * no data and no list, so it cannot show an empty or failed read as anything
 * else. The pages that wait for Wave 9 never reach the body: the wrapper
 * renders their own named state.
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
          <Suspense fallback={<LoadingState what={label} lines={6} />}>
            <SectionBody section={section} kind={kind} label={label} />
          </Suspense>
        </ContentWrapper>
      </PageContainer>
    </>
  )
}

/**
 * The content of a section once `ContentWrapper` lets it through. The overview
 * and the schema browser are built (Phase 10); every other section still says
 * that its page is not built, which shows no data and no list.
 */
function SectionBody(props: {
  readonly section: TargetSection
  readonly kind: SchemaKind | undefined
  readonly label: string
}): ReactNode {
  const scope = useTargetScope()
  const value = readableValue(scope.read)
  switch (props.section) {
    case 'overview':
      // The wrapper only opens with a target read that has a value.
      return value === undefined ? null : <TargetOverviewBody target={value} />
    case 'schema':
      return <SchemaBody target={scope.target} kind={props.kind} />
    case 'sql':
      return value === undefined ? null : <SqlBody route={scope.target} target={value} />
    default:
      return (
        <NotAvailableYetState
          what={props.label}
          reason={t('target.placeholder.reason')}
          headingLevel={2}
        />
      )
  }
}
