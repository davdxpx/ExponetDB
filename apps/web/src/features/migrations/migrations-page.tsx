import type { ReactNode } from 'react'
import { t } from '../../lib/i18n/i18n.ts'
import { useTargetScope } from '../target/scope.tsx'
import { TargetPage } from '../target-ops/target-page.tsx'
import { DriftSummary } from './drift-summary.tsx'
import { LedgerSection } from './ledger-section.tsx'
import { LegacyImportSection } from './legacy-import.tsx'
import { PlansSection } from './plans-section.tsx'
import { PromoteSection, TimelineSection } from './timeline-section.tsx'

/**
 * `/t/<product>/<project>/<environment>/migrations`: where this target is in
 * its migration history. The ledger in the target is the truth (applied and
 * pending, with checksum, who and when, and whether each was verified); the
 * timeline shows the same bundles across the project's environments from the
 * Control Store mirrors; below are the plans for this target, its drift
 * findings and the legacy import. There is no "run now": a change is a plan
 * (the SQL editor and the CLI draft migrations; the plan page applies them).
 * Stored bundles open as SQL in a side panel and are planned on an
 * environment by id ("Plan on <environment>"), which opens the plan review.
 */
export function MigrationsPage({ report }: { readonly report: string | undefined }): ReactNode {
  const route = useTargetScope().target
  return (
    <TargetPage section="migrations" description={t('migrations.description')}>
      {(target) => (
        <>
          <LedgerSection target={target} />
          <TimelineSection projectId={target.projectId} environment={route.environment} />
          <PromoteSection projectId={target.projectId} environment={route.environment} />
          <PlansSection targetId={target.id} />
          <DriftSummary />
          <LegacyImportSection report={report} tier={target.tier} />
        </>
      )}
    </TargetPage>
  )
}
