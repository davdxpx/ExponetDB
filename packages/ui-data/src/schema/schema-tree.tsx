import { AlertTriangle, Clock, Loader2 } from '@exponetdb/icons'
import { Button, cn, type INodeRendererProps, TreeView, TreeViewItem } from '@exponetdb/ui'
import {
  type HeadingLevel,
  type NowInput,
  ObservedTime,
  type Readable,
  ReadableView,
  renderLine,
  sourcePhrase,
  takeCodePoints,
} from '@exponetdb/ui-patterns'
import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

import { ReadEmpty } from '../diff/read-empty.tsx'
import {
  DEFAULT_SCHEMA_TREE_CLASSES,
  type SchemaTreeClass,
  type SchemaTreeLoader,
  type SchemaTreeObject,
  type SchemaTreeSchema,
  type SchemaTreeSelection,
} from './schema-tree-types.ts'
import {
  type BranchLoad,
  buildSchemaTree,
  type SchemaTreeModel,
  type SchemaTreeNodeInfo,
  selectionOf,
  type TreeNodeId,
} from './tree-model.ts'

/** The longest name a row shows, in code points; the whole name goes to the selection callback. */
const MAX_NAME_CODE_POINTS = 120

/** What a person is told when a loader rejects: never the text of the exception. */
const LOAD_FAILURE = { code: 'UNKNOWN', message: 'The list could not be read.' } as const

type StatusInfo = Extract<SchemaTreeNodeInfo, { kind: 'status' }>

/**
 * A name from the database in a row: printable text as text, every hidden or
 * direction character as a visible code point, look-alike letters underlined
 * (the rules of `UntrustedName`), cut at a fixed length. A row is a tree item,
 * so there is no "Show all" button inside it; the selection callback hands the
 * whole name to the caller for a detail view.
 */
function TreeName({ name }: { name: string }): ReactNode {
  const shown = takeCodePoints(name, MAX_NAME_CODE_POINTS)
  const rendered = renderLine(shown.head, 'name')
  return (
    <span data-untrusted="name" dir="ltr" className="[unicode-bidi:isolate-override]">
      {name === '' ? <span className="italic text-foreground-muted">(empty)</span> : rendered.nodes}
      {shown.truncated && (
        <>
          <span aria-hidden="true">…</span>
          <span className="sr-only"> (name shortened)</span>
        </>
      )}
    </span>
  )
}

function ClassLabel({ label, count }: { label: string; count: number | null }): ReactNode {
  return (
    <>
      {label}
      {count !== null && (
        <span className="ml-2 text-foreground-muted">{count.toLocaleString('en-US')}</span>
      )}
    </>
  )
}

function StatusMessage({ info, now }: { info: StatusInfo; now?: NowInput }): ReactNode {
  const noun = info.label.toLowerCase()
  const status = info.status
  switch (status.type) {
    case 'loading':
      return (
        <>
          <Loader2
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 animate-spin motion-reduce:animate-none"
          />
          <span>{`Loading ${noun}…`}</span>
        </>
      )
    case 'refreshing':
      return (
        <>
          <Loader2
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 animate-spin motion-reduce:animate-none"
          />
          <span>{`Refreshing ${noun}…`}</span>
        </>
      )
    case 'failed':
      return (
        <>
          <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning-600" />
          <span className="flex min-w-0 flex-col gap-0.5">
            <span>
              <span className="font-medium text-foreground">{`Could not read ${noun}`}</span>
              {' in '}
              <TreeName name={info.schema} />
              {': '}
              {status.error.message.trim() === ''
                ? 'No reason was reported.'
                : status.error.message}
            </span>
            <span className="text-xs">
              {'Error code '}
              <code className="font-mono text-foreground">{status.error.code}</code>
              {`. This does not mean there are no ${noun}.`}
            </span>
          </span>
        </>
      )
    case 'stale':
      return (
        <>
          <Clock aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span className="min-w-0">
            <span className="font-medium text-foreground">{`Showing an earlier read of ${noun}`}</span>
            {`: ${sourcePhrase(status.source)}, `}
            <ObservedTime observedAt={status.observedAt} now={now} />
            {'. '}
            {status.empty ? `It found no ${noun}. ` : ''}
            {status.error === undefined ? null : (
              <>
                {`Could not refresh: ${status.error.message} `}
                <code className="font-mono text-foreground">{status.error.code}</code>
              </>
            )}
          </span>
        </>
      )
    case 'partial':
      return (
        <>
          <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning-600" />
          <span className="min-w-0">
            <span className="font-medium text-foreground">{`Showing part of the ${noun}`}</span>
            {`. Missing: ${status.missing.length === 0 ? 'not reported' : status.missing.join('; ')}`}
          </span>
        </>
      )
    case 'empty':
      return (
        <span>
          {`No ${noun} in `}
          <TreeName name={info.schema} />
          {'. The read succeeded.'}
        </span>
      )
  }
}

interface StatusRowProps {
  readonly rendererProps: INodeRendererProps
  readonly info: StatusInfo
  readonly onReload: (branchId: TreeNodeId) => void
  readonly dispatch: INodeRendererProps['dispatch']
  readonly now?: NowInput
}

/**
 * The row under a branch that says how its read went (loading, failed, an
 * earlier read, part of the list, nothing found). It is a real tree item, so
 * the keyboard reaches it, but it cannot be selected, and Enter or Space on it
 * (or on its button) retries or refreshes instead of selecting.
 */
function StatusRow({ rendererProps, info, onReload, dispatch, now }: StatusRowProps): ReactNode {
  const props = rendererProps.getNodeProps({
    // The row is not selectable; a click only focuses it.
    onClick: () => {},
  })
  if (!('role' in props)) return null
  const { 'aria-selected': _selected, disabled: _disabled, className, tabIndex, ...rest } = props

  const action =
    info.status.type === 'failed' ? 'Try again' : info.status.type === 'stale' ? 'Refresh' : null
  const reload = (from: HTMLElement) => {
    // Focus goes to the branch being read again before this row changes, so it does not
    // vanish with the button (a focused element that is removed leaves focus on the page).
    from.closest<HTMLElement>('li[role="treeitem"]')?.focus()
    dispatch({ type: 'FOCUS', id: info.branchId, lastInteractedWith: info.branchId })
    onReload(info.branchId)
  }

  return (
    <div
      {...rest}
      role="treeitem"
      tabIndex={tabIndex}
      data-status={info.status.type}
      className={cn(
        className,
        'focus-inset flex min-h-[28px] items-start gap-2 py-1 pr-2 text-sm text-foreground-light',
      )}
      style={{ paddingLeft: 24 + ((rendererProps.level - 1) * 38) / 2 }}
      onKeyDown={(event) => {
        // Keys that reach the row from its own button are the button's.
        if (event.target !== event.currentTarget) return
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          event.stopPropagation()
          if (action !== null) reload(event.currentTarget)
        }
      }}
    >
      <StatusMessage info={info} now={now} />
      {action !== null && (
        <Button
          type="button"
          size="tiny"
          variant="outline"
          className="ml-auto shrink-0"
          onClick={(event) => {
            event.stopPropagation()
            reload(event.currentTarget)
          }}
          onKeyDown={(event) => {
            // The tree would take Enter and Space as a selection and cancel the press.
            if (event.key === 'Enter' || event.key === ' ') event.stopPropagation()
          }}
        >
          {action}
        </Button>
      )}
    </div>
  )
}

interface TreeBodyProps {
  readonly model: SchemaTreeModel
  readonly ariaLabel: string
  readonly expanded: RefObject<Set<string>>
  readonly selected: RefObject<string | null>
  readonly loads: Readonly<Record<string, BranchLoad>>
  readonly loadBranch: (id: string, schema: string, classId: string, label: string) => void
  readonly onSelect?: (selection: SchemaTreeSelection) => void
  readonly now?: NowInput
}

function TreeBody({
  model,
  ariaLabel,
  expanded,
  selected,
  loads,
  loadBranch,
  onSelect,
  now,
}: TreeBodyProps): ReactNode {
  // What was open and selected when the tree was last drawn comes back after a remount
  // (the read behind the tree went from stale to ready and back).
  const [initial] = useState(() => ({
    expanded: model.data
      .filter((node) => expanded.current.has(String(node.id)))
      .map((node) => node.id),
    selected: model.data.filter((node) => selected.current === node.id).map((node) => node.id),
  }))

  const renderNode = (rendererProps: INodeRendererProps): ReactNode => {
    const { element, level, isExpanded, isSelected, getNodeProps, dispatch } = rendererProps
    const info = model.info.get(element.id)
    if (info === undefined) return null
    switch (info.kind) {
      case 'status':
        return (
          <StatusRow
            rendererProps={rendererProps}
            info={info}
            dispatch={dispatch}
            now={now}
            onReload={(branchId) => {
              const branch = model.branches.get(branchId)
              const classInfo = model.info.get(branchId)
              if (branch !== undefined && classInfo?.kind === 'class') {
                loadBranch(String(branchId), branch.schema, branch.classId, classInfo.label)
              }
            }}
          />
        )
      case 'schema':
        return (
          <TreeViewItem
            {...getNodeProps()}
            name={<TreeName name={info.schema} />}
            level={level}
            isBranch
            isExpanded={isExpanded}
            isSelected={isSelected}
          />
        )
      case 'class':
        return (
          <TreeViewItem
            {...getNodeProps()}
            name={<ClassLabel label={info.label} count={info.count} />}
            level={level}
            isBranch
            isExpanded={isExpanded}
            isSelected={isSelected}
            isLoading={info.loading}
          />
        )
      case 'object':
        return (
          <TreeViewItem
            {...getNodeProps()}
            name={<TreeName name={info.name} />}
            level={level}
            isBranch={false}
            isSelected={isSelected}
          />
        )
    }
  }

  return (
    <TreeView
      aria-label={ariaLabel}
      data={model.data}
      nodeRenderer={renderNode}
      defaultExpandedIds={initial.expanded}
      defaultSelectedIds={initial.selected}
      expandOnKeyboardSelect
      onExpand={({ element, isExpanded }) => {
        const info = model.info.get(element.id)
        if (info === undefined || (info.kind !== 'schema' && info.kind !== 'class')) return
        const id = String(element.id)
        if (!isExpanded) {
          expanded.current.delete(id)
          return
        }
        expanded.current.add(id)
        // The objects of a class are read the first time it opens, and only then.
        if (info.kind === 'class' && loads[id] === undefined) {
          loadBranch(id, info.schema, info.classId, info.label)
        }
      }}
      onSelect={({ element, isSelected }) => {
        if (!isSelected) return
        const selection = selectionOf(model.info.get(element.id))
        if (selection === null) return
        const id = String(element.id)
        if (selected.current === id) return
        selected.current = id
        onSelect?.(selection)
      }}
    />
  )
}

function announcement(label: string, readable: Readable<readonly SchemaTreeObject[]>): string {
  const noun = label.toLowerCase()
  switch (readable.state) {
    case 'ready':
      return `${label} loaded: ${readable.value.length.toLocaleString('en-US')}.`
    case 'partial':
      return `Part of the ${noun} loaded.`
    case 'stale':
      return `Showing an earlier read of ${noun}.`
    case 'failed':
      return `Could not read ${noun}.`
    default:
      return `Loading ${noun}.`
  }
}

/** A failed refresh keeps what was shown, as an earlier read; a first read that fails is failed. */
function afterRejection(
  previous: Readable<readonly SchemaTreeObject[]> | null | undefined,
): Readable<readonly SchemaTreeObject[]> {
  if (
    previous !== null &&
    previous !== undefined &&
    (previous.state === 'ready' || previous.state === 'stale' || previous.state === 'partial')
  ) {
    return {
      state: 'stale',
      value: previous.value,
      source: previous.source,
      observedAt: previous.observedAt,
      error: LOAD_FAILURE,
    }
  }
  return { state: 'failed', error: LOAD_FAILURE }
}

export interface SchemaTreeProps {
  /** The schemas, as a read: a failed read is a failed read, never an empty tree. */
  schemas: Readable<readonly SchemaTreeSchema[]>
  /**
   * Reads the objects of one class in one schema, the first time that class
   * opens. Give the component a new `key` when it reads from another database.
   */
  loadObjects: SchemaTreeLoader
  /** The classes under each schema. Default: tables, views, materialized views, foreign tables, functions, sequences, types, extensions. */
  classes?: readonly SchemaTreeClass[]
  /** Called when a person selects a schema, a class or an object (not a status row). */
  onSelect?: (selection: SchemaTreeSelection) => void
  /** Names the tree. Default "Database schemas". */
  'aria-label'?: string
  /** Reads the schemas again (failed read). */
  onRetry?: () => void
  /** Reads the schemas again (earlier read). */
  onRefresh?: () => void
  busy?: boolean
  now?: NowInput
  headingLevel?: HeadingLevel
  className?: string
}

/**
 * Schemas, their object classes and the objects, as a tree (`TreeView`, the
 * WAI-ARIA tree pattern: arrow keys, Home, End, type-ahead, Enter to select).
 * The objects of a class are read when it opens; a branch that fails to load
 * says so inside the branch, with the error code and a retry, and never shows
 * as empty. An earlier read, a partial read and an empty read each have their
 * own row. Names are untrusted text. A row is never a link built from data.
 */
export function SchemaTree({
  schemas,
  loadObjects,
  classes = DEFAULT_SCHEMA_TREE_CLASSES,
  onSelect,
  'aria-label': ariaLabel = 'Database schemas',
  onRetry,
  onRefresh,
  busy,
  now,
  headingLevel,
  className,
}: SchemaTreeProps): ReactNode {
  const [loads, setLoads] = useState<Readonly<Record<string, BranchLoad>>>({})
  const [spoken, setSpoken] = useState('')
  const loadsRef = useRef(loads)
  const inFlight = useRef(new Set<string>())
  const mounted = useRef(true)
  const expanded = useRef(new Set<string>())
  const selected = useRef<string | null>(null)

  useEffect(() => {
    loadsRef.current = loads
  }, [loads])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const loadBranch = useCallback(
    (id: string, schema: string, classId: string, label: string) => {
      // One request per branch at a time, however often the tree asks.
      if (inFlight.current.has(id)) return
      inFlight.current.add(id)
      setLoads((previous) => ({
        ...previous,
        [id]: { readable: previous[id]?.readable ?? null, loading: true },
      }))
      const finish = (
        settle: (
          previous: Readable<readonly SchemaTreeObject[]> | null | undefined,
        ) => Readable<readonly SchemaTreeObject[]>,
      ) => {
        inFlight.current.delete(id)
        if (!mounted.current) return
        // One request per branch is open at a time, so the last state of the branch is current.
        const readable = settle(loadsRef.current[id]?.readable)
        setLoads((previous) => ({ ...previous, [id]: { readable, loading: false } }))
        setSpoken(announcement(label, readable))
      }
      let pending: Promise<Readable<readonly SchemaTreeObject[]>>
      try {
        pending = Promise.resolve(loadObjects({ schema, classId }))
      } catch {
        pending = Promise.reject(new Error('load failed'))
      }
      pending.then(
        (readable) => finish(() => readable),
        () => finish(afterRejection),
      )
    },
    [loadObjects],
  )

  return (
    <div className={className}>
      <ReadableView
        readable={schemas}
        what="schemas"
        onRetry={onRetry}
        onRefresh={onRefresh}
        busy={busy}
        now={now}
        headingLevel={headingLevel}
        ready={(value, meta) =>
          value.length === 0 ? (
            <ReadEmpty title="No schemas" noun="schemas" meta={meta} headingLevel={headingLevel} />
          ) : (
            <SchemaTreeContent
              schemas={value}
              classes={classes}
              ariaLabel={ariaLabel}
              expanded={expanded}
              selected={selected}
              loads={loads}
              loadBranch={loadBranch}
              onSelect={onSelect}
              now={now}
            />
          )
        }
      />
      {/* Settled loads are announced here; the text holds no name from the database. */}
      <div role="status" aria-live="polite" className="sr-only">
        {spoken}
      </div>
    </div>
  )
}

interface ContentProps {
  readonly schemas: readonly SchemaTreeSchema[]
  readonly classes: readonly SchemaTreeClass[]
  readonly ariaLabel: string
  readonly expanded: RefObject<Set<string>>
  readonly selected: RefObject<string | null>
  readonly loads: Readonly<Record<string, BranchLoad>>
  readonly loadBranch: (id: string, schema: string, classId: string, label: string) => void
  readonly onSelect?: (selection: SchemaTreeSelection) => void
  readonly now?: NowInput
}

function SchemaTreeContent({ schemas, classes, loads, ...rest }: ContentProps): ReactNode {
  const model = useMemo(() => buildSchemaTree(schemas, classes, loads), [schemas, classes, loads])
  return <TreeBody model={model} loads={loads} {...rest} />
}
