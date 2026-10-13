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
import { useTargetHealth } from '../target/queries.ts'
import { useTargetScope } from '../target/scope.tsx'

/**
 * The frame of a live diagnostics page of a target: the title with the
 * production cue (from the contract tier), then `ContentWrapper` with the
 * requirements of the section from `TARGET_NAV`, which renders the unreachable,
 * "cannot tell", suspended and decommissioned states instead of the page.
 * Reads the health only when the section needs it (the wrapper's own
 * decision), and shares that read with the page through `health`.
 */
export function DiagnosticsFrame(props: {
  readonly section: TargetSection
  readonly description: string
  readonly children: ReactNode
}): ReactNode {
  const scope = useTargetScope()
  const item = TARGET_NAV.find((entry) => entry.id === props.section)
  const requires = item?.requires ?? []
  const label = item?.label ?? props.section
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
            <PageHeaderDescription>{props.description}</PageHeaderDescription>
          </PageHeaderSummary>
        </PageHeaderMeta>
      </PageHeader>
      <PageContainer size="large" className="flex flex-col gap-6 py-6">
        <ContentWrapper
          requires={requires}
          target={scope.read}
          health={needsHealth ? health.readable : undefined}
          feature={label}
          onRetry={scope.refetch}
          onRetryHealth={health.refetch}
          busy={scope.fetching}
        >
          {props.children}
        </ContentWrapper>
      </PageContainer>
    </>
  )
}
