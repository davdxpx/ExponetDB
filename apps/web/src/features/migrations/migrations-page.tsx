import type { MigrationStatus } from '@exponetdb/sdk/operations'
import { Skeleton } from '@exponetdb/ui'
import { formatCount, LinkCard, type LinkCardTone, PageNav } from '@exponetdb/ui-patterns'
import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useApi } from '../../lib/api/context.tsx'
import { type MessageKey, t } from '../../lib/i18n/i18n.ts'
import { stringifySearch } from '../../lib/navigation/search.ts'
import type { Target } from '../target/queries.ts'
import { useTargetScope } from '../target/scope.tsx'
import { ledgerQuery } from '../target-ops/keys.ts'
import { useTargetHref } from '../target-ops/links.ts'
import { TargetPage } from '../target-ops/target-page.tsx'
import { DriftSummary } from './drift-summary.tsx'
import {
  ledgerCounts,
  MIGRATION_VIEWS,
  type MigrationsSearch,
  type MigrationView,
  viewOf,
} from './history-model.ts'
import { LedgerSection, PendingSection } from './ledger-section.tsx'
import { LegacyImportSection } from './legacy-import.tsx'
import { PlansSection } from './plans-section.tsx'
import { PromoteSection, TimelineSection } from './timeline-section.tsx'

const VIEW_LABEL: Readonly<Record<MigrationView, MessageKey>> = {
  history: 'migrations.view.history',
  pending: 'migrations.view.pending',
  timeline: 'migrations.view.timeline',
  promote: 'migrations.view.promote',
  plans: 'migrations.view.plans',
  drift: 'migrations.view.drift',
  import: 'migrations.view.import',
}

/**
 * `/t/<product>/<project>/<environment>/migrations`: the migration centre of a target. On top,
 * the counters of the ledger (applied, verified, waiting for verification, failed, not applied),
 * each a card that is a link to the history filtered by it; then one view at a time, chosen in
 * the address (`?view=`): the history (the ledger in the target, the truth, paged and filtered),
 * the pending bundles, the timeline across environments, promotion, plans, drift and the legacy
 * import. Only the view on screen is in the document, so 500 imported migrations are one page
 * of rows, not an endless page. There is no "run now": a change is a plan.
 */
export function MigrationsPage({
  search,
  onSearch,
}: {
  readonly search: MigrationsSearch
  readonly onSearch: (next: MigrationsSearch) => void
}): ReactNode {
  return (
    <TargetPage section="migrations" description={t('migrations.description')}>
      {(target) => <MigrationCentre target={target} search={search} onSearch={onSearch} />}
    </TargetPage>
  )
}

function MigrationCentre({
  target,
  search,
  onSearch,
}: {
  readonly target: Target
  readonly search: MigrationsSearch
  readonly onSearch: (next: MigrationsSearch) => void
}): ReactNode {
  const route = useTargetScope().target
  const href = useTargetHref()
  const view = viewOf(search)
  const change = (next: Partial<MigrationsSearch>) => {
    const merged = { ...search, ...next }
    onSearch(
      Object.fromEntries(
        Object.entries(merged).filter(([, value]) => value !== undefined),
      ) as MigrationsSearch,
    )
  }
  const viewHref = (candidate: MigrationView) =>
    href(
      `/migrations${stringifySearch({
        view: candidate,
        ...(candidate === 'import' && search.report !== undefined ? { report: search.report } : {}),
      })}`,
    )
  return (
    <div className="flex flex-col gap-6">
      <Counters path={route.path} viewHref={href} />
      <PageNav
        label={t('migrations.views')}
        className="-mx-4 xl:-mx-4"
        items={MIGRATION_VIEWS.map((candidate) => ({
          label: t(VIEW_LABEL[candidate]),
          href: viewHref(candidate),
          active: candidate === view,
        }))}
      />
      <div data-migration-view={view} className="flex flex-col gap-8">
        {view === 'history' ? (
          <LedgerSection target={target} search={search} change={change} />
        ) : null}
        {view === 'pending' ? <PendingSection target={target} /> : null}
        {view === 'timeline' ? (
          <TimelineSection projectId={target.projectId} environment={route.environment} />
        ) : null}
        {view === 'promote' ? (
          <PromoteSection projectId={target.projectId} environment={route.environment} />
        ) : null}
        {view === 'plans' ? <PlansSection targetId={target.id} /> : null}
        {view === 'drift' ? <DriftSummary /> : null}
        {view === 'import' ? (
          <LegacyImportSection report={search.report} tier={target.tier} />
        ) : null}
      </div>
    </div>
  )
}

interface CounterSpec {
  readonly id: string
  readonly label: MessageKey
  readonly count: number
  readonly sub?: string
  readonly href: string
  readonly tone: LinkCardTone
}

/**
 * The ledger's counters, from the same read as the history (one cache entry). While it is read
 * they are placeholders; a failed read draws none here (the history says what failed).
 */
function Counters({
  path,
  viewHref,
}: {
  readonly path: string
  readonly viewHref: (suffix: string) => string
}): ReactNode {
  const { client } = useApi()
  const ledger = useQuery(ledgerQuery(client, path))
  if (ledger.data === undefined) {
    return ledger.isPending ? (
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5" aria-hidden="true">
        {[0, 1, 2, 3, 4].map((index) => (
          <Skeleton key={index} className="h-24 rounded-lg" />
        ))}
      </div>
    ) : null
  }
  return <CounterCards status={ledger.data} viewHref={viewHref} />
}

function CounterCards({
  status,
  viewHref,
}: {
  readonly status: MigrationStatus
  readonly viewHref: (suffix: string) => string
}): ReactNode {
  const counts = ledgerCounts(status)
  const history = (filter: Record<string, string>) =>
    viewHref(`/migrations${stringifySearch({ view: 'history', ...filter })}`)
  const specs: readonly CounterSpec[] = [
    {
      id: 'applied',
      label: 'migrations.counter.applied',
      count: counts.applied,
      sub:
        counts.imported === 0
          ? undefined
          : t('migrations.counter.imported', { count: formatCount(counts.imported) }),
      href: history({}),
      tone: 'neutral',
    },
    {
      id: 'verified',
      label: 'migrations.counter.verified',
      count: counts.verified,
      href: history({ verification: 'passed' }),
      tone: 'neutral',
    },
    {
      id: 'pending-verification',
      label: 'migrations.counter.verificationPending',
      count: counts.verificationPending,
      href: history({ verification: 'pending' }),
      tone: counts.verificationPending > 0 ? 'warning' : 'neutral',
    },
    {
      id: 'failed',
      label: 'migrations.counter.failed',
      count: counts.failed,
      href: history({ verification: 'failed' }),
      tone: counts.failed > 0 ? 'critical' : 'neutral',
    },
    {
      id: 'not-applied',
      label: 'migrations.counter.notApplied',
      count: counts.notApplied,
      href: viewHref(`/migrations${stringifySearch({ view: 'pending' })}`),
      tone: counts.notApplied > 0 ? 'info' : 'neutral',
    },
  ]
  return (
    <ul
      aria-label={t('migrations.counters')}
      className="m-0 grid list-none grid-cols-2 gap-3 p-0 md:grid-cols-3 xl:grid-cols-5"
    >
      {specs.map((spec) => (
        <li key={spec.id} data-counter={spec.id} className="min-w-0">
          <LinkCard href={spec.href} tone={spec.tone} className="h-full gap-1.5 p-3">
            <span className="eyebrow pr-6 text-xs text-foreground-light">{t(spec.label)}</span>
            <span className="text-2xl leading-none font-semibold tabular-nums">
              {formatCount(spec.count)}
            </span>
            {spec.sub === undefined ? null : (
              <span className="text-xs text-foreground-lighter">{spec.sub}</span>
            )}
          </LinkCard>
        </li>
      ))}
    </ul>
  )
}
