import { CircleHelp } from '@exponetdb/icons'
import {
  cn,
  StatusIcon,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@exponetdb/ui'
import {
  ObservedTime,
  ReadableView,
  TierChip,
  UntrustedName,
  useLinkComponent,
} from '@exponetdb/ui-patterns'
import type { ReactNode } from 'react'
import { t } from '../../lib/i18n/i18n.ts'
import { targetHref } from '../../shell/navigation.ts'
import type { TargetRoute } from '../target/params.ts'
import { nounPhrase } from '../target/phrases.ts'
import { Block } from './block.tsx'
import {
  cellOf,
  MATRIX_BUNDLES,
  type MatrixColumn,
  matrixBundles,
  matrixColumns,
  type StreamState,
  stateKey,
  streamState,
} from './migrations-model.ts'
import {
  type BlockRead,
  type MigrationStream,
  type TargetMigrations,
  useMigrationStream,
  useTargetMigrations,
} from './queries.ts'

const HEADING = 3
const PENDING_SHOWN = 5

/**
 * The migration head of this target and how the same bundles stand in the
 * other environments of the project. The two reads are separate: the ledger
 * status of the target, and the promotion stream of the project, which comes
 * from the Control Store mirrors (so a state that was not mirrored is
 * `unknown`, never "not applied").
 */
export function MigrationsBlock(props: {
  readonly target: TargetRoute
  readonly projectId: string
}): ReactNode {
  const Link = useLinkComponent()
  const status = useTargetMigrations(props.target.path)
  const stream = useMigrationStream(props.projectId, (value) =>
    value.truncated ? [t('overview.migrations.matrix.truncated')] : undefined,
  )
  return (
    <Block
      id="migrations"
      title={t('overview.migrations.title')}
      description={t('overview.migrations.description')}
    >
      <StatusView read={status} />
      <StreamView read={stream} path={props.target.path} />
      <Link
        href={targetHref(props.target, '/migrations')}
        className="text-sm text-foreground underline"
      >
        {t('overview.migrations.link')}
      </Link>
    </Block>
  )
}

export function StatusView(props: { readonly read: BlockRead<TargetMigrations> }): ReactNode {
  const { read } = props
  return (
    <ReadableView
      readable={read.readable}
      what={nounPhrase('overview.migrations.target.what')}
      onRetry={read.refetch}
      onRefresh={read.refetch}
      busy={read.fetching}
      headingLevel={HEADING}
      ready={(value) => <StatusBody status={value} />}
    />
  )
}

function StatusBody({ status }: { readonly status: TargetMigrations }): ReactNode {
  const last = status.applied.reduce<TargetMigrations['applied'][number] | undefined>(
    (best, entry) => (best === undefined || entry.appliedAt > best.appliedAt ? entry : best),
    undefined,
  )
  return (
    <div className="flex flex-col gap-3 text-sm" data-slot="migration-status">
      <p className="flex flex-wrap gap-x-4 gap-y-1">
        <span>{t('overview.migrations.applied', { count: status.applied.length })}</span>
        <span>{t('overview.migrations.pending', { count: status.pending.length })}</span>
        {last === undefined ? (
          <span>{t('overview.migrations.noneApplied')}</span>
        ) : (
          <span className="min-w-0 max-w-full">
            {t('overview.migrations.lastApplied')}{' '}
            <UntrustedName name={last.name} mono label={t('overview.migrations.title')} />{' '}
            <ObservedTime observedAt={last.appliedAt} />
          </span>
        )}
      </p>
      <p data-slot="mirror" data-in-sync={status.mirror.inSync}>
        {status.mirror.inSync
          ? t('overview.migrations.mirror.inSync')
          : t('overview.migrations.mirror.notInSync')}{' '}
        <ObservedTime observedAt={status.mirror.checkedAt} />
      </p>
      {status.incompleteNontransactional === undefined ||
      status.incompleteNontransactional.length === 0 ? null : (
        <p role="note" data-slot="incomplete">
          {t('overview.migrations.incomplete')}{' '}
          {status.incompleteNontransactional.map((id) => (
            <UntrustedName key={id} name={id} mono label={t('overview.migrations.title')} />
          ))}
        </p>
      )}
      {status.pending.length === 0 ? (
        <p>{t('overview.migrations.pending.none')}</p>
      ) : (
        <div>
          <h4 className="font-medium">{t('overview.migrations.pending.title')}</h4>
          <ul className="list-disc pl-5">
            {status.pending.slice(0, PENDING_SHOWN).map((entry) => (
              <li key={entry.migrationId}>
                <UntrustedName name={entry.name} mono label={t('overview.migrations.title')} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

export function StreamView(props: {
  readonly read: BlockRead<MigrationStream>
  readonly path: string
}): ReactNode {
  const { read } = props
  return (
    <ReadableView
      readable={read.readable}
      what={nounPhrase('overview.migrations.stream.what')}
      onRetry={read.refetch}
      onRefresh={read.refetch}
      busy={read.fetching}
      headingLevel={HEADING}
      empty={{
        isEmpty: (value) => value.bundles.length === 0,
        content: <p className="text-sm">{t('overview.migrations.matrix.noBundles')}</p>,
      }}
      ready={(value) => <Matrix stream={value} path={props.path} />}
    />
  )
}

function Matrix({
  stream,
  path,
}: {
  readonly stream: MigrationStream
  readonly path: string
}): ReactNode {
  const columns = matrixColumns(stream, path)
  const bundles = matrixBundles(stream)
  return (
    <div className="flex flex-col gap-2" data-slot="migration-matrix">
      {stream.graph.valid ? null : (
        <p role="note" className="text-sm">
          {t('overview.migrations.graphInvalid')}
        </p>
      )}
      <Table>
        <TableCaption className="sr-only">{t('overview.migrations.matrix.caption')}</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">{t('overview.migrations.matrix.column.bundle')}</TableHead>
            {columns.map((column) => (
              <TableHead key={column.slug} scope="col" data-env={column.slug}>
                <ColumnHeader column={column} />
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {bundles.map((bundle) => (
            <TableRow key={bundle.migrationId}>
              <TableCell>
                <UntrustedName
                  name={bundle.name}
                  mono
                  label={t('overview.migrations.matrix.column.bundle')}
                />
              </TableCell>
              {columns.map((column) => (
                <TableCell
                  key={column.slug}
                  className={cn(column.current && 'bg-surface-100')}
                  data-env={column.slug}
                >
                  <CellView state={streamState(cellOf(bundle, column.slug))} />
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <p className="text-xs text-foreground-light">
        {t('overview.migrations.heads', { count: stream.heads.length })}
        {stream.bundleCount > MATRIX_BUNDLES ? ` (${bundles.length}/${stream.bundleCount})` : ''}
      </p>
    </div>
  )
}

function ColumnHeader({ column }: { readonly column: MatrixColumn }): ReactNode {
  return (
    <span className="flex flex-col gap-1">
      <span className="inline-flex flex-wrap items-center gap-2">
        <UntrustedName
          name={column.displayName}
          label={t('overview.migrations.matrix.column.bundle')}
        />
        <TierChip tier={column.tier} />
      </span>
      {column.current ? (
        <span className="text-xs font-normal text-foreground-light">
          {t('overview.migrations.matrix.current')}
        </span>
      ) : null}
      {column.hasTarget ? null : (
        <span className="text-xs font-normal text-foreground-light">
          {t('overview.migrations.matrix.noTarget')}
        </span>
      )}
      {column.mirrorObservedAt === null ? (
        <span className="text-xs font-normal text-foreground-light">
          {t('overview.migrations.matrix.mirrorMissing')}
        </span>
      ) : (
        <span className="text-xs font-normal text-foreground-light">
          <ObservedTime observedAt={column.mirrorObservedAt} />
        </span>
      )}
      {column.divergent ? (
        <span className="text-xs font-normal">{t('overview.migrations.matrix.divergent')}</span>
      ) : null}
    </span>
  )
}

function CellView({ state }: { readonly state: StreamState }): ReactNode {
  return (
    <span className="inline-flex flex-wrap items-center gap-1" data-state={state.state}>
      <CellGlyph state={state.state} />
      {t(stateKey(state.state))}
      {state.checksumDiffers ? (
        <span className="text-xs text-foreground-light">
          ({t('overview.migrations.cell.checksumDiffers')})
        </span>
      ) : null}
    </span>
  )
}

function CellGlyph({ state }: { readonly state: StreamState['state'] }): ReactNode {
  switch (state) {
    case 'verified':
      return <StatusIcon variant="success" hideBackground decorative />
    case 'applied':
      return <StatusIcon variant="success" hideBackground decorative className="opacity-60" />
    case 'failed':
    case 'divergent':
      return <StatusIcon variant="destructive" hideBackground decorative />
    case 'reverted':
      return <StatusIcon variant="warning" hideBackground decorative />
    case 'not_applied':
      return (
        <span
          aria-hidden="true"
          className="inline-block size-2 rounded-full border border-default"
        />
      )
    case 'unknown':
    case 'other':
      return <CircleHelp aria-hidden="true" className="size-3 text-foreground-light" />
  }
}
