import type { ExplainResult, QueryResult } from '@exponetdb/sdk/operations'
import { Button, copyToClipboard, toast } from '@exponetdb/ui'
import { type CellValue, cellFromWire, ExplainView, type GridColumn } from '@exponetdb/ui-data'
import {
  Admonition,
  ClassificationBadge,
  FailedReadState,
  formatCount,
  LoadingState,
  type ReadFailure,
  UntrustedName,
} from '@exponetdb/ui-patterns'
import { lazy, type ReactNode, Suspense, useMemo, useState } from 'react'
import { t } from '../../lib/i18n/i18n.ts'
import { ROW_LIMITS } from '../../lib/storage/sql-prefs.ts'
import { nounPhrase } from '../target/phrases.ts'
import { markHidden, type RunScope, type StatementClass } from './sql-model.ts'

/**
 * The lower half of Query mode: the result of the last run of the tab as a
 * truthful state. Nothing runs from here; a run is started by the person
 * (Run, Mod+Enter) and can be canceled while it runs.
 */
const DataGrid = lazy(async () => {
  const module = await import('@exponetdb/ui-data/grid/data-grid')
  return { default: module.DataGrid }
})

export type CancelState =
  | { readonly kind: 'none' }
  | { readonly kind: 'requested' }
  | { readonly kind: 'canceled' }
  | { readonly kind: 'finished' }
  | { readonly kind: 'failed'; readonly failure: ReadFailure }

export type RunWhat = 'query' | 'explain'

/**
 * The state of the last run of a tab. Each state past `idle` says which text
 * was sent (`scope`): all of it, the selection or one statement of several.
 */
export type RunState =
  | { readonly kind: 'idle' }
  | {
      readonly kind: 'running'
      readonly what: RunWhat
      readonly queryId: string
      readonly cancel: CancelState
      readonly scope: RunScope
    }
  | {
      readonly kind: 'result'
      readonly result: QueryResult
      readonly receivedAt: string
      /** The row limit the run asked for. */
      readonly maxRows: number
      readonly scope: RunScope
    }
  | {
      readonly kind: 'explain'
      readonly result: ExplainResult
      readonly receivedAt: string
      readonly scope: RunScope
    }
  | {
      readonly kind: 'failed'
      readonly what: RunWhat
      readonly queryId: string
      readonly failure: ReadFailure
      /** The SQLSTATE of a failed read, only when the server sent a valid one. */
      readonly sqlstate?: string
      readonly cancel: CancelState
      readonly scope: RunScope
    }
  | {
      readonly kind: 'blocked'
      readonly classes: readonly StatementClass[]
      readonly scope: RunScope
    }

/** The highest row limit a person may choose. */
const MAX_ROW_LIMIT = ROW_LIMITS[ROW_LIMITS.length - 1] ?? 5000

/** Server codes that mean the text is not a read: the page offers a draft instead. */
const NOT_A_READ = new Set(['QUERY_NOT_READ_ONLY'])

export function ResultsPanel(props: {
  readonly run: RunState
  readonly onCancel: () => void
  readonly onDraft: () => void
}): ReactNode {
  const { run } = props
  return (
    <section
      aria-labelledby="sql-result-title"
      className="flex min-w-0 flex-col gap-3"
      data-block="sql-result"
      data-state={run.kind}
    >
      <h2 id="sql-result-title" className="text-sm font-medium">
        {t('sql.result.title')}
      </h2>
      <ResultBody {...props} />
    </section>
  )
}

function ResultBody(props: {
  readonly run: RunState
  readonly onCancel: () => void
  readonly onDraft: () => void
}): ReactNode {
  const { run } = props
  switch (run.kind) {
    case 'idle':
      return <p className="text-sm text-foreground-light">{t('sql.result.idle')}</p>
    case 'blocked':
      return (
        <div className="flex flex-col gap-3">
          <ScopeNote scope={run.scope} held />
          <WriteExplanation classes={run.classes} onDraft={props.onDraft} sent={false} />
        </div>
      )
    case 'running':
      return (
        <div className="flex flex-col gap-3">
          <ScopeNote scope={run.scope} />
          <LoadingState
            what={
              run.what === 'query' ? nounPhrase('sql.result.what') : nounPhrase('sql.explain.what')
            }
            lines={3}
          />
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="outline"
              size="tiny"
              onClick={props.onCancel}
              disabled={run.cancel.kind === 'requested'}
            >
              {t('sql.run.cancel')}
            </Button>
            <CancelNote cancel={run.cancel} />
          </div>
        </div>
      )
    case 'failed':
      return (
        <div className="flex flex-col gap-3">
          <ScopeNote scope={run.scope} />
          <FailedReadState
            what={
              run.what === 'query' ? nounPhrase('sql.result.what') : nounPhrase('sql.explain.what')
            }
            error={{ code: run.failure.code, message: markHidden(run.failure.message) }}
            headingLevel={3}
          >
            <CancelNote cancel={run.cancel} />
            <FailureFacts failure={run.failure} sqlstate={run.sqlstate} />
          </FailedReadState>
          {NOT_A_READ.has(run.failure.code) ? (
            <WriteExplanation classes={[]} onDraft={props.onDraft} sent />
          ) : null}
        </div>
      )
    case 'result':
      return (
        <div className="flex min-w-0 flex-col gap-3">
          <ScopeNote scope={run.scope} />
          <QueryResultView result={run.result} receivedAt={run.receivedAt} maxRows={run.maxRows} />
        </div>
      )
    case 'explain':
      return (
        <div className="flex min-w-0 flex-col gap-3">
          <ScopeNote scope={run.scope} />
          <ExplainResultView result={run.result} receivedAt={run.receivedAt} />
        </div>
      )
  }
}

/**
 * Which text the run sent, when it was not all of the text; for a text held
 * back (`held`) which text was not sent.
 */
function ScopeNote(props: { readonly scope: RunScope; readonly held?: boolean }): ReactNode {
  const { scope, held = false } = props
  if (scope.kind === 'all') return null
  const text =
    scope.kind === 'selection'
      ? held
        ? t('sql.run.heldSelection')
        : t('sql.run.scopeSelection')
      : held
        ? t('sql.run.heldStatement', { n: scope.n, count: scope.count, line: scope.line })
        : t('sql.run.scopeStatement', { n: scope.n, count: scope.count, line: scope.line })
  return (
    <p className="text-sm text-foreground-light" data-run-scope={scope.kind}>
      {text}
    </p>
  )
}

/**
 * What a failed run adds to the catalog message and code the failure state
 * shows: the SQLSTATE when the server sent one, and a button that copies the
 * code, the SQLSTATE and the catalog message, and nothing else.
 */
function FailureFacts(props: {
  readonly failure: ReadFailure
  readonly sqlstate: string | undefined
}): ReactNode {
  const { failure, sqlstate } = props
  const [copied, setCopied] = useState<'done' | 'failed' | undefined>(undefined)
  const copy = async (): Promise<void> => {
    const text =
      sqlstate === undefined
        ? t('sql.error.clipboard', { code: failure.code, message: failure.message })
        : t('sql.error.clipboardSqlstate', {
            code: failure.code,
            sqlstate,
            message: failure.message,
          })
    const done = await copyToClipboard(text)
    setCopied(done ? 'done' : 'failed')
    if (done) toast.success(t('sql.error.copied'))
    else toast.error(t('sql.error.copyFailed'))
  }
  return (
    <div className="flex flex-col gap-2 px-4 pb-3" data-block="sql-failure-facts">
      {sqlstate === undefined ? null : (
        <p className="m-0 text-sm" data-sqlstate={sqlstate}>
          {t('sql.error.sqlstate', { sqlstate })}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="outline" size="tiny" onClick={() => void copy()}>
          {t('sql.error.copy')}
        </Button>
        {copied === undefined ? null : (
          <p role="status" className="m-0 text-sm">
            {copied === 'done' ? t('sql.error.copied') : t('sql.error.copyFailed')}
          </p>
        )}
      </div>
    </div>
  )
}

function CancelNote(props: { readonly cancel: CancelState }): ReactNode {
  const { cancel } = props
  switch (cancel.kind) {
    case 'none':
      return null
    case 'requested':
      return (
        <p role="status" className="text-sm">
          {t('sql.cancel.requested')}
        </p>
      )
    case 'canceled':
      return (
        <p role="status" className="text-sm">
          {t('sql.cancel.canceled')}
        </p>
      )
    case 'finished':
      return (
        <p role="status" className="text-sm">
          {t('sql.cancel.finished')}
        </p>
      )
    case 'failed':
      return (
        <p role="status" className="text-sm">
          {t('sql.cancel.failed', { message: cancel.failure.message, code: cancel.failure.code })}
        </p>
      )
  }
}

/**
 * Why a write does not run in Query mode, and the way it can: a draft that
 * becomes a migration plan. `sent` says whether the server refused it (the
 * text went out) or the page held it back on the server's classification.
 */
export function WriteExplanation(props: {
  readonly classes: readonly StatementClass[]
  readonly onDraft: () => void
  readonly sent: boolean
}): ReactNode {
  return (
    <Admonition
      type="warning"
      title={t('sql.write.title')}
      description={
        <div
          className="flex flex-col gap-2"
          data-write-explanation={props.sent ? 'refused' : 'held'}
        >
          <p>{props.sent ? t('sql.write.refused') : t('sql.write.held')}</p>
          {props.classes.length === 0 ? null : (
            <p className="flex flex-wrap items-center gap-1.5">
              <span>{t('sql.write.classes')}</span>
              {props.classes.map((c) => (
                <ClassificationBadge key={c} classification={c} />
              ))}
            </p>
          )}
          <p>{t('sql.write.path')}</p>
        </div>
      }
      actions={
        <Button variant="default" size="tiny" onClick={props.onDraft}>
          {t('sql.write.draft')}
        </Button>
      }
    />
  )
}

/**
 * The notice of a cut result. A cut at the row limit names that limit, says
 * when the server's limit is lower than the one asked for and points to the
 * selector while a higher limit exists.
 */
function truncationText(result: QueryResult, maxRows: number): string | undefined {
  if (!result.truncated) return undefined
  const truncation = result.truncation
  if (truncation === null) return t('sql.result.truncatedUnknown')
  if (truncation.reason === 'bytes') {
    return t('sql.result.truncatedBytes', { cap: formatCount(truncation.cap) })
  }
  const parts = [t('sql.result.truncatedRows', { cap: formatCount(truncation.cap) })]
  if (truncation.cap < maxRows) {
    parts.push(
      t('sql.result.truncatedLowered', {
        requested: formatCount(maxRows),
        cap: formatCount(truncation.cap),
      }),
    )
  } else if (maxRows < MAX_ROW_LIMIT) {
    parts.push(t('sql.result.truncatedRaise'))
  }
  return parts.join(' ')
}

function QueryResultView(props: {
  readonly result: QueryResult
  readonly receivedAt: string
  readonly maxRows: number
}): ReactNode {
  const { result } = props
  const columns = useMemo<GridColumn[]>(
    () => result.columns.map((c) => ({ name: c.name, type: c.type, masked: c.masked })),
    [result.columns],
  )
  const rows = useMemo<CellValue[][]>(
    () =>
      result.rows.map((row) =>
        row.map((value, index) => cellFromWire(result.columns[index]?.type ?? 'text', value)),
      ),
    [result],
  )
  const truncated = truncationText(result, props.maxRows)
  const masked = result.columns.filter((c) => c.masked).length
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <p className="text-sm" data-result-meta="true">
        {t('sql.result.meta', {
          rows: formatCount(result.rowCount),
          ms: formatCount(result.durationMs),
        })}
      </p>
      {truncated === undefined ? null : (
        <p role="status" className="text-sm font-medium" data-truncated="true">
          {truncated}
        </p>
      )}
      {masked === 0 ? null : (
        <p className="text-sm text-foreground-light">{t('sql.result.masked', { count: masked })}</p>
      )}
      {result.rlsRelations.length === 0 ? null : (
        <div className="flex flex-col gap-1 text-sm text-foreground-light">
          <p>{t('sql.result.rls', { count: result.rlsRelations.length })}</p>
          <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
            {result.rlsRelations.slice(0, 20).map((relation) => (
              <li key={relation}>
                <UntrustedName name={relation} maxCodePoints={80} label="relation" />
              </li>
            ))}
          </ul>
        </div>
      )}
      <Suspense fallback={<LoadingState what={nounPhrase('sql.result.what')} lines={4} />}>
        <DataGrid
          label={t('sql.result.gridLabel')}
          columns={columns}
          rows={{ state: 'ready', value: rows, source: 'live', observedAt: props.receivedAt }}
          {...(truncated === undefined ? {} : { truncated: { reason: truncated } })}
          fileName="query-result"
          what={nounPhrase('sql.result.what')}
          maxHeight={420}
        />
      </Suspense>
    </div>
  )
}

function ExplainResultView(props: {
  readonly result: ExplainResult
  readonly receivedAt: string
}): ReactNode {
  const { result } = props
  const { summary } = result
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-foreground-light">{t('sql.explain.totalCost')}</dt>
        <dd className="m-0">{formatCount(summary.totalCost)}</dd>
        <dt className="text-foreground-light">{t('sql.explain.planRows')}</dt>
        <dd className="m-0">{formatCount(summary.planRows)}</dd>
        <dt className="text-foreground-light">{t('sql.explain.duration')}</dt>
        <dd className="m-0">{t('sql.explain.ms', { ms: formatCount(result.durationMs) })}</dd>
        <dt className="text-foreground-light">{t('sql.explain.seqScans')}</dt>
        <dd className="m-0">
          {summary.sequentialScans.length === 0 ? (
            t('sql.explain.none')
          ) : (
            <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
              {summary.sequentialScans.slice(0, 20).map((relation) => (
                <li key={relation}>
                  <UntrustedName name={relation} maxCodePoints={80} label="relation" />
                </li>
              ))}
            </ul>
          )}
        </dd>
      </dl>
      <ExplainView
        plan={{ state: 'ready', value: result.plan, source: 'live', observedAt: props.receivedAt }}
        headingLevel={3}
      />
    </div>
  )
}
