import type { MigrationStream, Project } from '@exponetdb/sdk/operations'
import { cn } from '@exponetdb/ui'
import { MigrationTimeline, type MigrationTimelineData } from '@exponetdb/ui-data'
import {
  PageContainer,
  PageHeader,
  PageHeaderDescription,
  PageHeaderMeta,
  PageHeaderSummary,
  PageHeaderTitle,
  type Readable,
  ReadableView,
  UntrustedName,
  useLinkComponent,
} from '@exponetdb/ui-patterns'
import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useApi } from '../../lib/api/context.tsx'
import { t } from '../../lib/i18n/i18n.ts'
import { toReadable } from '../../lib/query/readable.ts'
import { PromotePanel } from '../migrations/promote-panel.tsx'
import { projectsQuery } from '../targets/keys.ts'
import { migrationStreamQuery } from './keys.ts'
import { type PromotionSearch, promotionPath, timelineOf } from './model.ts'

/**
 * The promotion view (`/changes/promotion?project=prj_…`): the migration
 * stream of one project, bundles in dependency order against the product's
 * environments in evidence order, each cell the state the Control Store's
 * mirror holds for the project's target there (`GET
 * /projects/{id}/migrations`, source `cached` with the time of each mirror).
 * A cell the mirror does not hold is `unknown`, never "not applied". The
 * project is picked from the projects the person may read. Under the
 * timeline, the bundles not applied on an environment are planned there by
 * id ("Plan on <environment>", the plan review page opens), with their SQL
 * and the evidence environment's state, and the environment is compared
 * with its evidence environment on the compare page.
 */
export function PromotionPage({ search }: { readonly search: PromotionSearch }): ReactNode {
  const { client } = useApi()
  const projects = useQuery(projectsQuery(client))
  const projectId = search.project
  return (
    <>
      <PageHeader size="large">
        <PageHeaderMeta>
          <PageHeaderSummary>
            <PageHeaderTitle>{t('changes.promotion.title')}</PageHeaderTitle>
            <PageHeaderDescription>{t('changes.promotion.description')}</PageHeaderDescription>
          </PageHeaderSummary>
        </PageHeaderMeta>
      </PageHeader>
      <PageContainer
        size="large"
        className="grid grid-cols-1 gap-6 py-6 lg:grid-cols-[16rem_minmax(0,1fr)]"
      >
        <nav aria-label={t('changes.promotion.projects')} className="flex min-w-0 flex-col gap-2">
          <h2 className="text-sm font-medium">{t('changes.promotion.projects')}</h2>
          <ReadableView
            readable={toReadable(projects, {
              missing: (value) => (value.more ? [t('changes.promotion.projectsMore')] : undefined),
            })}
            what={t('changes.promotion.projects.what')}
            onRetry={() => void projects.refetch()}
            onRefresh={() => void projects.refetch()}
            busy={projects.isFetching}
            headingLevel={3}
            empty={{ isEmpty: (value) => value.items.length === 0 }}
            ready={(value) => <ProjectList projects={value.items} selected={projectId} />}
          />
        </nav>
        <section aria-labelledby="promotion-stream" className="flex min-w-0 flex-col gap-3">
          <h2 id="promotion-stream" className="text-sm font-medium">
            {t('changes.promotion.stream')}
          </h2>
          {projectId === undefined ? (
            <p className="text-sm text-foreground-light">{t('changes.promotion.pick')}</p>
          ) : (
            <ProjectStream projectId={projectId} />
          )}
        </section>
      </PageContainer>
    </>
  )
}

function ProjectList({
  projects,
  selected,
}: {
  readonly projects: readonly Project[]
  readonly selected: string | undefined
}): ReactNode {
  const Link = useLinkComponent()
  return (
    <ul className="flex flex-col gap-1 text-sm">
      {projects.map((project) => {
        const href = promotionPath(project.id)
        const current = project.id === selected
        return (
          <li key={project.id} data-project={project.id}>
            {href === undefined ? (
              <UntrustedName name={project.path} mono label={t('changes.promotion.project')} />
            ) : (
              <Link
                href={href}
                aria-current={current ? 'page' : undefined}
                className={cn(
                  'block rounded-md px-2 py-1 focus-ring hover:bg-surface-200',
                  current && 'bg-surface-200 font-medium',
                )}
              >
                <UntrustedName name={project.path} mono label={t('changes.promotion.project')} />
              </Link>
            )}
          </li>
        )
      })}
    </ul>
  )
}

/** The stream's read as timeline data; what the server says is incomplete is named. */
export function streamReadable(
  readable: Readable<MigrationStream>,
): Readable<MigrationTimelineData> {
  if (readable.state === 'loading' || readable.state === 'failed') return readable
  return { ...readable, value: timelineOf(readable.value) }
}

function streamMissing(stream: MigrationStream): readonly string[] | undefined {
  const missing: string[] = []
  if (stream.truncated) {
    missing.push(
      t('changes.promotion.truncated', {
        shown: stream.bundles.length,
        total: stream.bundleCount,
      }),
    )
  }
  if (!stream.graph.valid) {
    missing.push(
      t('changes.promotion.graphInvalid', {
        codes: stream.graph.errors
          .map((error) => (/^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? error.code : '?'))
          .join(', '),
      }),
    )
  }
  return missing.length === 0 ? undefined : missing
}

function ProjectStream({ projectId }: { readonly projectId: string }): ReactNode {
  const { client } = useApi()
  const stream = useQuery(migrationStreamQuery(client, projectId))
  return (
    <div className="flex flex-col gap-2" data-stream={projectId}>
      <p className="text-xs text-foreground-light">{t('changes.promotion.mirrorNote')}</p>
      <MigrationTimeline
        readable={streamReadable(toReadable(stream, { missing: streamMissing }))}
        what={t('changes.promotion.what')}
        onRetry={() => void stream.refetch()}
        onRefresh={() => void stream.refetch()}
        busy={stream.isFetching}
        headingLevel={3}
      />
      {stream.data === undefined ? null : <PromotePanel stream={stream.data} />}
    </div>
  )
}
