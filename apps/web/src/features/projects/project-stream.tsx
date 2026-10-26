import type { MigrationStream } from '@exponetdb/sdk/operations'
import {
  cn,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@exponetdb/ui'
import { formatCount, ReadableView, TierChip, useLinkComponent } from '@exponetdb/ui-patterns'
import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useApi } from '../../lib/api/context.tsx'
import { t } from '../../lib/i18n/i18n.ts'
import { toReadable } from '../../lib/query/readable.ts'
import { targetHref } from '../../shell/navigation.ts'
import { promotionPath } from '../changes/model.ts'
import { streamMissing } from '../migrations/model.ts'
import { splitTargetPath } from '../target/params.ts'
import { streamQuery } from '../target-ops/keys.ts'
import { type StreamRow, streamRows } from './model.ts'

/**
 * The project's migration stream against its environments (`GET /projects/{id}/migrations`, the
 * Control Store mirrors, `source: cached`): how many bundles, whether the graph holds, and per
 * environment in evidence order how many bundles are verified, applied without a verification,
 * not applied, failed and unknown. A cell the mirror holds nothing for is unknown, never "not
 * applied". Each environment links to its migration centre; the stream links to the promotion
 * view, where bundles are planned on the next environment.
 */
export function ProjectStream({
  projectId,
  className,
}: {
  readonly projectId: string
  readonly product: string
  readonly project: string
  readonly className?: string
}): ReactNode {
  const { client } = useApi()
  const Link = useLinkComponent()
  const query = useQuery(streamQuery(client, projectId))
  const promotion = promotionPath(projectId)
  return (
    <section
      aria-labelledby="project-stream"
      className={cn('flex min-w-0 flex-col gap-3', className)}
    >
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="flex flex-col gap-1">
          <h2 id="project-stream" className="m-0 text-base font-medium">
            {t('project.stream.title')}
          </h2>
          <p className="m-0 text-xs text-foreground-light">{t('project.stream.description')}</p>
        </div>
        {promotion === undefined ? null : (
          <Link
            href={promotion}
            className="text-sm text-foreground-light hover:text-foreground focus-ring"
          >
            {t('project.stream.open')}
          </Link>
        )}
      </div>
      <ReadableView
        readable={toReadable(query, { missing: streamMissing })}
        what={t('project.stream.what')}
        onRetry={() => void query.refetch()}
        onRefresh={() => void query.refetch()}
        busy={query.isFetching}
        headingLevel={3}
        ready={(stream) => <StreamSummary stream={stream} />}
      />
    </section>
  )
}

function StreamSummary({ stream }: { readonly stream: MigrationStream }): ReactNode {
  const rows = streamRows(stream)
  return (
    <div className="flex flex-col gap-3">
      <p className="m-0 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm text-foreground-light">
        <span>
          <span className="text-xl font-semibold tabular-nums text-foreground">
            {formatCount(stream.bundleCount)}
          </span>{' '}
          {t('project.stream.bundlesLabel')}
        </span>
        <span>{t('project.stream.heads', { count: formatCount(stream.heads.length) })}</span>
        {stream.graph.valid ? null : (
          <span className="text-destructive">{t('project.stream.invalid')}</span>
        )}
      </p>
      <Table>
        <TableCaption className="sr-only">{t('project.stream.caption')}</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">{t('projects.column.environments')}</TableHead>
            <TableHead scope="col" className="text-right">
              {t('project.stream.column.verified')}
            </TableHead>
            <TableHead scope="col" className="text-right">
              {t('project.stream.column.applied')}
            </TableHead>
            <TableHead scope="col" className="text-right">
              {t('project.stream.column.notApplied')}
            </TableHead>
            <TableHead scope="col" className="text-right">
              {t('project.stream.column.failed')}
            </TableHead>
            <TableHead scope="col" className="text-right">
              {t('project.stream.column.unknown')}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <StreamTableRow key={row.slug} row={row} />
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

function StreamTableRow({ row }: { readonly row: StreamRow }): ReactNode {
  const Link = useLinkComponent()
  const route = row.targetPath === null ? undefined : splitTargetPath(row.targetPath)
  const count = (value: number, loud = false) => (
    <TableCell
      className={cn(
        'text-right tabular-nums',
        value === 0 ? 'text-foreground-lighter' : loud && 'text-destructive',
      )}
    >
      {formatCount(value)}
    </TableCell>
  )
  return (
    <TableRow data-stream-environment={row.slug}>
      <TableCell>
        <span className="flex flex-wrap items-center gap-2">
          {route === undefined ? (
            <span className="font-mono">{row.slug}</span>
          ) : (
            <Link
              href={targetHref(route, '/migrations')}
              className="font-mono hover:underline focus-ring"
            >
              {row.slug}
            </Link>
          )}
          <TierChip tier={row.tier} />
        </span>
      </TableCell>
      {count(row.verified)}
      {count(row.applied)}
      {count(row.notApplied)}
      {count(row.failed, true)}
      {count(row.unknown)}
    </TableRow>
  )
}
