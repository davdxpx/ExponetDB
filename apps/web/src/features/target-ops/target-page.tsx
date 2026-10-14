import {
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
import { TARGET_NAV, type TargetSection } from '../../shell/navigation.ts'
import { ContentWrapper } from '../target/content-wrapper.tsx'
import type { Target } from '../target/queries.ts'
import { useTargetScope } from '../target/scope.tsx'

/**
 * The frame of a target page that reads what the Control Store keeps: the
 * title with the production cue, then `ContentWrapper` with the section's
 * requirements from `TARGET_NAV` (the status gate: loading, failed,
 * decommissioned, suspended, not permitted), then the page with the target
 * the gate let through. The production frame itself is the layout's.
 */
export function TargetPage({
  section,
  description,
  children,
}: {
  readonly section: TargetSection
  readonly description?: string
  readonly children: (target: Target) => ReactNode
}): ReactNode {
  const scope = useTargetScope()
  const item = TARGET_NAV.find((entry) => entry.id === section)
  const label = item?.label ?? section
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
            {description === undefined ? null : (
              <PageHeaderDescription>{description}</PageHeaderDescription>
            )}
          </PageHeaderSummary>
        </PageHeaderMeta>
      </PageHeader>
      <PageContainer size="large" className="flex flex-col gap-8 py-6">
        <ContentWrapper
          requires={item?.requires ?? []}
          target={scope.read}
          feature={label}
          onRetry={scope.refetch}
          busy={scope.fetching}
        >
          {value === undefined ? null : children(value)}
        </ContentWrapper>
      </PageContainer>
    </>
  )
}
