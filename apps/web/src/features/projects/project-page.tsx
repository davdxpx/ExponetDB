import { Database } from '@exponetdb/icons'
import { Button } from '@exponetdb/ui'
import {
  formatCount,
  PageContainer,
  PageHeader,
  PageHeaderAside,
  PageHeaderDescription,
  PageHeaderMeta,
  PageHeaderSummary,
  PageHeaderTitle,
  ReadableView,
  UntrustedName,
  useLinkComponent,
} from '@exponetdb/ui-patterns'
import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useApi } from '../../lib/api/context.tsx'
import { t } from '../../lib/i18n/i18n.ts'
import { toReadable } from '../../lib/query/readable.ts'
import { NotFoundPage } from '../../shell/not-found.tsx'
import { TargetConnectButton } from '../connect/target-connect-sheet.tsx'
import { isSlug } from '../target/params.ts'
import { productsQuery, projectsQuery } from '../targets/keys.ts'
import { findProject, type ProjectRow, projectRows } from './model.ts'
import { ProjectEnvironments } from './project-environments.tsx'
import { ProjectInfrastructure } from './project-infrastructure.tsx'
import { ProjectStream } from './project-stream.tsx'

/**
 * `/p/<product>/<project>`: one project's home (ADR-0035), between the fleet and one target.
 * The header names the project; below are its environments (each one database, production
 * marked), its migration stream against them and where they run. The project is found in the
 * same bounded projects read as the portfolio; slugs outside the grammar are "page not found"
 * without a request, and a project the read does not hold is not found (or, when the read was
 * cut, said to be beyond what was read).
 */
export function ProjectPage({
  product,
  project,
}: {
  readonly product: string
  readonly project: string
}): ReactNode {
  if (!isSlug(product) || !isSlug(project)) return <NotFoundPage />
  return <ProjectHome product={product} project={project} />
}

function ProjectHome({
  product,
  project,
}: {
  readonly product: string
  readonly project: string
}): ReactNode {
  const { client } = useApi()
  // Read again on every visit: a project registered after a cached portfolio read is not "not found".
  const projects = useQuery({ ...projectsQuery(client), refetchOnMount: 'always' })
  const products = useQuery(productsQuery(client))
  const rows =
    projects.data === undefined
      ? undefined
      : projectRows(projects.data.items, products.data?.items, [])
  const row = rows === undefined ? undefined : findProject(rows, product, project)
  const missing = projects.data !== undefined && row === undefined
  if (missing && !projects.isFetching && !projects.data.more) return <NotFoundPage />
  return (
    <>
      <ProjectHeader product={product} project={project} row={row} />
      <PageContainer size="large" className="flex flex-col gap-10 py-6">
        <ReadableView
          // A project missing from an earlier read waits for the new one before anything is said.
          readable={missing && projects.isFetching ? { state: 'loading' } : toReadable(projects)}
          what={t('project.what')}
          onRetry={() => void projects.refetch()}
          onRefresh={() => void projects.refetch()}
          busy={projects.isFetching}
          headingLevel={2}
          ready={() =>
            row === undefined ? (
              <p className="m-0 text-sm text-foreground-light" role="status">
                {t('project.notListed', { count: formatCount(1000) })}
              </p>
            ) : (
              <ProjectSections row={row} />
            )
          }
        />
      </PageContainer>
    </>
  )
}

function ProjectHeader({
  product,
  project,
  row,
}: {
  readonly product: string
  readonly project: string
  readonly row: ProjectRow | undefined
}): ReactNode {
  const Link = useLinkComponent()
  return (
    <PageHeader size="large">
      <PageHeaderMeta>
        <PageHeaderSummary>
          <PageHeaderTitle>
            {row === undefined ? (
              `${product}/${project}`
            ) : (
              <UntrustedName name={row.project.displayName} label={t('projects.column.project')} />
            )}
          </PageHeaderTitle>
          <PageHeaderDescription>
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="font-mono">
                {product}/{project}
              </span>
              {row?.productName === null || row === undefined ? null : (
                <span>
                  <UntrustedName name={row.productName} label={t('projects.column.product')} />
                </span>
              )}
            </span>
          </PageHeaderDescription>
        </PageHeaderSummary>
        <PageHeaderAside>
          <Button
            asChild
            size="small"
            variant="default"
            icon={<Database aria-hidden="true" strokeWidth={1.5} />}
          >
            <Link href={`/targets?product=${product}&project=${project}`}>
              {t('targets.title')}
            </Link>
          </Button>
          <TargetConnectButton product={product} project={project} />
        </PageHeaderAside>
      </PageHeaderMeta>
    </PageHeader>
  )
}

function ProjectSections({ row }: { readonly row: ProjectRow }): ReactNode {
  return (
    <>
      <ProjectEnvironments product={row.productSlug} project={row.projectSlug} />
      <div className="grid grid-cols-1 gap-x-8 gap-y-10 xl:grid-cols-5">
        <ProjectStream
          className="xl:col-span-3"
          projectId={row.project.id}
          product={row.productSlug}
          project={row.projectSlug}
        />
        <ProjectInfrastructure
          className="xl:col-span-2"
          product={row.productSlug}
          project={row.projectSlug}
        />
      </div>
    </>
  )
}
