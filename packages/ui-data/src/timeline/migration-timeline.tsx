import {
  Button,
  cn,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@exponetdb/ui'
import {
  EmptyState,
  formatCount,
  type HeadingLevel,
  isAppPath,
  type NowInput,
  ObservedTime,
  type Readable,
  ReadableView,
  type ReadMeta,
  SourceLabel,
  TierChip,
  UntrustedName,
  useLinkComponent,
  useResolvedNow,
} from '@exponetdb/ui-patterns'
import {
  type FocusEvent,
  type KeyboardEvent,
  memo,
  type ReactNode,
  useCallback,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react'

import { describeCellTimes } from './cell-details.ts'
import { MARKER_META, MigrationMarker } from './migration-marker.tsx'
import {
  buildTimelineModel,
  DEFAULT_MAX_BUNDLES,
  type DependencyHint,
  type ModelIssue,
  type ResolvedCell,
  type TimelineModel,
  type TimelineRow,
} from './model.ts'
import {
  MIGRATION_MARKER_STATES,
  type MigrationTimelineData,
  type TimelineEnvironment,
} from './types.ts'

export interface MigrationTimelineProps {
  /** The stream of a project, read from the Control Store mirror. A failed read never renders as empty. */
  readable: Readable<MigrationTimelineData>
  /** What is read, as a noun phrase for the state messages. Default "migration timeline". */
  what?: string
  /** Most bundles shown (the last ones in dependency order). Default 1,000, the contract's cap. */
  maxBundles?: number
  /** Dependencies named under a bundle before "Show all". Default 3. */
  maxDependencyHints?: number
  onRetry?: () => void
  onRefresh?: () => void
  busy?: boolean
  now?: NowInput
  headingLevel?: HeadingLevel
  className?: string
}

const DEFAULT_MAX_DEPENDENCY_HINTS = 3
const MAX_CYCLE_IDS_SHOWN = 8

// ---------------------------------------------------------------------------
// Notes about the data
// ---------------------------------------------------------------------------

function plural(count: number, noun: string): string {
  return `${formatCount(count)} ${noun}${count === 1 ? '' : 's'}`
}

function IssueNote({ issue }: { issue: ModelIssue }): ReactNode {
  switch (issue.kind) {
    case 'duplicate_id':
      return (
        <li>
          Bundle id <UntrustedName name={issue.id} mono maxCodePoints={40} label="bundle id" />{' '}
          appears {formatCount(issue.dropped + 1)} times in this read. Only the first is shown.
        </li>
      )
    case 'cycle': {
      const shown = issue.ids.slice(0, MAX_CYCLE_IDS_SHOWN)
      const rest = issue.ids.length - shown.length
      return (
        <li>
          {plural(issue.ids.length, 'bundle')} could not be placed in dependency order because of a
          dependency cycle. They follow the ordered bundles, sorted by id:{' '}
          {shown.map((id, index) => (
            <span key={id}>
              {index > 0 && ', '}
              <UntrustedName name={id} mono maxCodePoints={40} label="bundle id" />
            </span>
          ))}
          {rest > 0 && ` and ${formatCount(rest)} more`}.
        </li>
      )
    }
    case 'duplicate_environment':
      return (
        <li>
          Environment{' '}
          <UntrustedName name={issue.id} mono maxCodePoints={40} label="environment id" /> is listed{' '}
          {formatCount(issue.dropped + 1)} times. Only the first column is shown.
        </li>
      )
    case 'unlisted_environment':
      return (
        <li>
          {formatCount(issue.count)} {issue.count === 1 ? 'cell belongs' : 'cells belong'} to an
          environment this read does not list and {issue.count === 1 ? 'is' : 'are'} not shown.
        </li>
      )
  }
}

function TimelineNotes({ model }: { model: TimelineModel }): ReactNode {
  const hasNotes =
    model.issues.length > 0 ||
    model.hiddenEarlier > 0 ||
    model.omittedByServer > 0 ||
    model.environments.length === 0
  if (!hasNotes) return null
  const shownCount = model.rows.length
  return (
    <div role="note" className="rounded-md border border-default bg-surface-75 px-3 py-2 text-xs">
      <ul className="flex list-disc flex-col gap-1 pl-4 text-foreground-light">
        {model.omittedByServer > 0 && (
          <li>
            This read lists the last {formatCount(model.totalBundles - model.omittedByServer)} of{' '}
            {formatCount(model.totalBundles)} bundles in dependency order.{' '}
            {formatCount(model.omittedByServer)} earlier bundles are not in it.
          </li>
        )}
        {model.hiddenEarlier > 0 && (
          <li>
            Showing the last {formatCount(shownCount)} bundles in dependency order.{' '}
            {formatCount(model.hiddenEarlier)} earlier bundles are not shown.
          </li>
        )}
        {model.environments.length === 0 && (
          <li>This read lists no environments, so there is no column to show a state in.</li>
        )}
        {model.issues.map((issue) => (
          <IssueNote key={issueKey(issue)} issue={issue} />
        ))}
      </ul>
    </div>
  )
}

function issueKey(issue: ModelIssue): string {
  switch (issue.kind) {
    case 'duplicate_id':
    case 'duplicate_environment':
      return `${issue.kind}:${issue.id}`
    case 'cycle':
      return `cycle:${issue.ids.join(',')}`
    case 'unlisted_environment':
      return issue.kind
  }
}

// ---------------------------------------------------------------------------
// Legend
// ---------------------------------------------------------------------------

function Legend(): ReactNode {
  return (
    <details className="text-xs text-foreground-light">
      <summary className="cursor-pointer rounded-sm focus-ring">What the markers mean</summary>
      <dl className="mt-2 grid grid-cols-[max-content_1fr] items-center gap-x-3 gap-y-1.5">
        {MIGRATION_MARKER_STATES.map((state) => (
          <div key={state} className="contents">
            <dt>
              <MigrationMarker state={state} />
            </dt>
            <dd>{MARKER_META[state].description}</dd>
          </div>
        ))}
      </dl>
    </details>
  )
}

// ---------------------------------------------------------------------------
// Cells
// ---------------------------------------------------------------------------

interface MarkerCellProps {
  cell: ResolvedCell
  row: number
  col: number
  /** This marker is the one tab stop of the grid. */
  isTabStop: boolean
  now: number
  rowHeaderId: string
  columnHeaderId: string
  register: (key: string, node: HTMLSpanElement | null) => void
}

function MarkerCell({
  cell,
  row,
  col,
  isTabStop,
  now,
  rowHeaderId,
  columnHeaderId,
  register,
}: MarkerCellProps): ReactNode {
  const Link = useLinkComponent()
  const linkId = useId()
  const meta = MARKER_META[cell.state] ?? MARKER_META.unknown
  const times = describeCellTimes(cell, now)
  const evidence = cell.evidencePath

  return (
    <div className="flex flex-col items-start gap-1.5">
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            tabIndex={isTabStop ? 0 : -1}
            data-marker-row={row}
            data-marker-col={col}
            ref={(node) => register(`${row}:${col}`, node)}
            className="inline-flex rounded-md focus-ring"
          >
            <MigrationMarker state={cell.state} />
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">
          <p className="font-medium">{meta.label}</p>
          <p>{meta.description}</p>
          {times.map((sentence) => (
            <p key={sentence} className="mt-1">
              {sentence}
            </p>
          ))}
        </TooltipContent>
      </Tooltip>
      <span className="sr-only">
        {meta.description} {times.join(' ')}
      </span>
      {evidence !== undefined &&
        (isAppPath(evidence) ? (
          <Link
            id={linkId}
            href={evidence}
            aria-labelledby={`${linkId} ${rowHeaderId} ${columnHeaderId}`}
            className="rounded-xs text-xs text-foreground-light underline underline-offset-2 hover:text-foreground focus-ring"
          >
            Evidence
          </Link>
        ) : (
          <span className="text-xs text-foreground-lighter">Evidence link not shown</span>
        ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Row header
// ---------------------------------------------------------------------------

function dependencyLabel(dependency: DependencyHint): ReactNode {
  switch (dependency.kind) {
    case 'bundle':
      return (
        <UntrustedName
          name={dependency.name ?? dependency.id}
          mono
          maxCodePoints={32}
          label="dependency name"
        />
      )
    case 'baseline':
      return (
        <>
          <UntrustedName name={dependency.id} mono maxCodePoints={32} label="baseline id" />
          <span className="text-foreground-lighter"> (baseline)</span>
        </>
      )
    case 'unlisted':
      return (
        <>
          <UntrustedName name={dependency.id} mono maxCodePoints={32} label="dependency id" />
          <span className="text-foreground-lighter"> (not listed)</span>
        </>
      )
  }
}

function DependencyHints({
  dependencies,
  limit,
}: {
  dependencies: readonly DependencyHint[]
  limit: number
}): ReactNode {
  const [expanded, setExpanded] = useState(false)
  if (dependencies.length === 0) {
    return <p className="mt-1 text-xs font-normal text-foreground-lighter">No dependencies</p>
  }
  const shown = expanded ? dependencies : dependencies.slice(0, Math.max(0, limit))
  return (
    <div className="mt-1 text-xs font-normal text-foreground-light">
      <p>Depends on {formatCount(dependencies.length)}:</p>
      <ul className="flex flex-col gap-0.5">
        {shown.map((dependency) => (
          <li key={dependency.id}>{dependencyLabel(dependency)}</li>
        ))}
      </ul>
      {dependencies.length > limit && (
        <Button
          type="button"
          variant="link"
          size="tiny"
          className="h-auto px-0 py-0"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? 'Show fewer' : `Show all ${formatCount(dependencies.length)}`}
        </Button>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// The grid
// ---------------------------------------------------------------------------

function EnvironmentHeader({
  environment,
  index,
  id,
  nameOf,
}: {
  environment: TimelineEnvironment
  index: number
  id: string
  nameOf: ReadonlyMap<string, string>
}): ReactNode {
  const from = environment.evidenceFrom
  return (
    <TableHead
      scope="col"
      id={id}
      data-environment-index={index}
      className="h-auto min-w-40 px-3 py-2 align-top font-sans tracking-normal normal-case text-foreground"
    >
      <div className="flex flex-col items-start gap-1">
        <UntrustedName name={environment.name} maxCodePoints={40} label="environment name" />
        <TierChip tier={environment.tier} />
        {from !== null && from !== undefined && (
          <span className="text-xs font-normal text-foreground-light">
            Evidence from{' '}
            <UntrustedName
              name={nameOf.get(from) ?? from}
              maxCodePoints={32}
              label="environment name"
            />
          </span>
        )}
      </div>
    </TableHead>
  )
}

function TimelineGrid({
  model,
  now,
  dependencyHintLimit,
}: {
  model: TimelineModel
  now: number
  dependencyHintLimit: number
}): ReactNode {
  const baseId = useId()
  const { environments, rows } = model
  const rowCount = rows.length
  const colCount = environments.length

  const [active, setActive] = useState({ row: 0, col: 0 })
  const markers = useRef(new Map<string, HTMLSpanElement>())
  const register = useCallback((key: string, node: HTMLSpanElement | null) => {
    if (node === null) markers.current.delete(key)
    else markers.current.set(key, node)
  }, [])

  const tabRow = Math.min(active.row, Math.max(0, rowCount - 1))
  const tabCol = Math.min(active.col, Math.max(0, colCount - 1))
  const columnHeaderIds = useMemo(
    () => environments.map((_, index) => `${baseId}-e${index}`),
    [environments, baseId],
  )

  const environmentNames = useMemo(
    () => new Map(environments.map((environment) => [environment.id, environment.name])),
    [environments],
  )

  // The marker that has focus becomes the tab stop (focus events bubble in React).
  const onFocus = (event: FocusEvent<HTMLTableSectionElement>): void => {
    const row = event.target.getAttribute('data-marker-row')
    const col = event.target.getAttribute('data-marker-col')
    if (row === null || col === null) return
    setActive({ row: Number(row), col: Number(col) })
  }

  // The markers are one tab stop; the arrow keys, Home and End move between them (Ctrl+Home and
  // Ctrl+End go to the first and last marker). Links in the cells keep their own keys.
  const onKeyDown = (event: KeyboardEvent<HTMLTableSectionElement>): void => {
    const target = event.target
    if (!(target instanceof HTMLElement)) return
    const rowAttribute = target.getAttribute('data-marker-row')
    const colAttribute = target.getAttribute('data-marker-col')
    if (rowAttribute === null || colAttribute === null) return
    if (event.altKey || event.metaKey || event.shiftKey) return
    let row = Number(rowAttribute)
    let col = Number(colAttribute)
    switch (event.key) {
      case 'ArrowRight':
        col = Math.min(col + 1, colCount - 1)
        break
      case 'ArrowLeft':
        col = Math.max(col - 1, 0)
        break
      case 'ArrowDown':
        row = Math.min(row + 1, rowCount - 1)
        break
      case 'ArrowUp':
        row = Math.max(row - 1, 0)
        break
      case 'Home':
        col = 0
        if (event.ctrlKey) row = 0
        break
      case 'End':
        col = colCount - 1
        if (event.ctrlKey) row = rowCount - 1
        break
      default:
        return
    }
    event.preventDefault()
    setActive({ row, col })
    markers.current.get(`${row}:${col}`)?.focus()
  }

  return (
    <Table
      className="border-separate border-spacing-0"
      containerProps={{
        'aria-label': 'Migration timeline, scrollable',
        containerClassName: 'rounded-md border border-default',
      }}
    >
      <caption className="sr-only">
        Migration bundles in dependency order, with their state in each environment
      </caption>
      <TableHeader>
        <TableRow className="border-b">
          <TableHead
            scope="col"
            className="sticky left-0 z-20 h-auto min-w-56 border-b border-default bg-surface-100 px-3 py-2 align-top font-sans tracking-normal normal-case text-foreground"
          >
            Migration bundle
          </TableHead>
          {environments.map((environment, index) => (
            <EnvironmentHeader
              key={environment.id}
              environment={environment}
              index={index}
              id={`${baseId}-e${index}`}
              nameOf={environmentNames}
            />
          ))}
        </TableRow>
      </TableHeader>
      <TableBody onKeyDown={onKeyDown} onFocus={onFocus}>
        {rows.map((row, rowIndex) => (
          <TimelineRowView
            key={row.id}
            row={row}
            rowIndex={rowIndex}
            rowHeaderId={`${baseId}-r${rowIndex}`}
            columnHeaderIds={columnHeaderIds}
            tabCol={rowIndex === tabRow ? tabCol : -1}
            now={now}
            dependencyHintLimit={dependencyHintLimit}
            register={register}
          />
        ))}
      </TableBody>
    </Table>
  )
}

const TimelineRowView = memo(function TimelineRowView({
  row,
  rowIndex,
  rowHeaderId,
  columnHeaderIds,
  tabCol,
  now,
  dependencyHintLimit,
  register,
}: {
  row: TimelineRow
  rowIndex: number
  rowHeaderId: string
  columnHeaderIds: readonly string[]
  /** The column of the marker that is the tab stop in this row; -1 when the tab stop is in another row. */
  tabCol: number
  now: number
  dependencyHintLimit: number
  register: (key: string, node: HTMLSpanElement | null) => void
}): ReactNode {
  return (
    <TableRow className="align-top">
      <TableHead
        scope="row"
        className={cn(
          'sticky left-0 z-10 h-auto min-w-56 max-w-80 border-b border-default bg-surface-100 px-3 py-2 text-left align-top font-sans tracking-normal normal-case text-foreground whitespace-normal',
        )}
      >
        <div id={rowHeaderId} className="flex flex-col items-start gap-0.5">
          <UntrustedName name={row.slug} mono maxCodePoints={48} label="migration name" />
          <span className="text-xs font-normal text-foreground-lighter">
            <UntrustedName name={row.id} mono maxCodePoints={40} label="migration id" />
          </span>
        </div>
        <DependencyHints dependencies={row.dependencies} limit={dependencyHintLimit} />
      </TableHead>
      {row.cells.map((cell, colIndex) => (
        <TableCell key={cell.environmentId} className="border-b border-default px-3 py-2">
          <MarkerCell
            cell={cell}
            row={rowIndex}
            col={colIndex}
            isTabStop={colIndex === tabCol}
            now={now}
            rowHeaderId={rowHeaderId}
            columnHeaderId={columnHeaderIds[colIndex] ?? rowHeaderId}
            register={register}
          />
        </TableCell>
      ))}
    </TableRow>
  )
})

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

function TimelineBody({
  data,
  meta,
  now,
  maxBundles,
  maxDependencyHints,
}: {
  data: MigrationTimelineData
  meta: ReadMeta
  now: NowInput | undefined
  maxBundles: number
  maxDependencyHints: number
}): ReactNode {
  const model = useMemo(() => buildTimelineModel(data, maxBundles), [data, maxBundles])
  const current = useResolvedNow(now)

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-foreground-light">
        <SourceLabel source={meta.source} />
        <span>
          Observed <ObservedTime observedAt={meta.observedAt} now={now} withDate />
        </span>
        <span>
          Mirror of the ledgers in the targets. The ledger in each target is the source of truth for
          what is applied.
        </span>
      </div>
      <TimelineNotes model={model} />
      <TimelineGrid model={model} now={current} dependencyHintLimit={maxDependencyHints} />
      <Legend />
    </div>
  )
}

/**
 * The migration stream of a project as a grid: one row per bundle in dependency order (ties by
 * id), one column per environment in evidence order, and in each cell a marker with a word and an
 * icon of its own (applied, verified, failed, drifted, pending, not applied, reverted, unknown),
 * never color alone. Hovering or focusing a marker says when the state was reached and when the
 * mirror was last written; the same text is in the cell for a screen reader. The markers are one
 * tab stop; the arrow keys move between them. A bundle shows its name and id and what it depends
 * on; an evidence link goes to an app path the caller built, through the link seam.
 *
 * The data is the Control Store mirror, so the view says where it comes from and when it was
 * observed (`SourceLabel`, `ObservedTime`). A failed read renders only the failed state (C-28); a
 * cell the read does not hold is `unknown`, never `not applied` (C-30). Names and ids are
 * untrusted text (C-26). Needs the app's `TooltipProvider`.
 */
export function MigrationTimeline({
  readable,
  what = 'migration timeline',
  maxBundles = DEFAULT_MAX_BUNDLES,
  maxDependencyHints = DEFAULT_MAX_DEPENDENCY_HINTS,
  onRetry,
  onRefresh,
  busy,
  now,
  headingLevel,
  className,
}: MigrationTimelineProps): ReactNode {
  return (
    <ReadableView
      readable={readable}
      what={what}
      onRetry={onRetry}
      onRefresh={onRefresh}
      busy={busy}
      now={now}
      headingLevel={headingLevel}
      className={className}
      empty={{
        isEmpty: (data) => data.bundles.length === 0,
        content: (
          <EmptyState
            title="No migration bundles"
            description="The read succeeded and found no migration bundles for this project."
            headingLevel={headingLevel}
          />
        ),
      }}
      ready={(data, meta) => (
        <TimelineBody
          data={data}
          meta={meta}
          now={now}
          maxBundles={maxBundles}
          maxDependencyHints={maxDependencyHints}
        />
      )}
    />
  )
}
