import type { SavedQuery } from '@exponetdb/sdk/operations'
import { Button, KeyboardShortcut } from '@exponetdb/ui'
import type { EditorHandle, SqlDiagnostic } from '@exponetdb/ui-data'
import {
  Admonition,
  LoadingState,
  MarkedCode,
  TierChip,
  takeCodePoints,
  useShortcut,
} from '@exponetdb/ui-patterns'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useRouterState } from '@tanstack/react-router'
import {
  lazy,
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useApi } from '../../lib/api/context.tsx'
import { ApiError } from '../../lib/api/errors.ts'
import { withReauth } from '../../lib/api/reauth.ts'
import { describeError, t } from '../../lib/i18n/i18n.ts'
import { useMe } from '../../lib/session/guard.tsx'
import { actionError } from '../plans/failure.ts'
import type { TargetRoute } from '../target/params.ts'
import { nounPhrase } from '../target/phrases.ts'
import type { Target } from '../target/queries.ts'
import { ClassificationPanel, type ClassificationView } from './classification-panel.tsx'
import { createCompletionProvider } from './completion.ts'
import { DraftPanel } from './draft-panel.tsx'
import { classifiable, classifyQuery, sqlKeys } from './keys.ts'
import {
  type CancelState,
  ResultsPanel,
  type RunState,
  type RunWhat,
  WriteExplanation,
} from './results-panel.tsx'
import { SaveDialog, type SaveInput } from './save-dialog.tsx'
import { SidePanel } from './side-panel.tsx'
import {
  activeTab,
  addTab,
  CLASSIFY_MAX_BYTES,
  classificationDiagnostics,
  closeTab,
  hiddenCharacterCount,
  LINK_MAX_CHARS,
  lineCount,
  newTab,
  newUlid,
  normalizeBreaks,
  parseSqlLink,
  postgresMajorOf,
  queryVerdict,
  type SavedRef,
  type SqlMode,
  type SqlTab,
  type TabsState,
  updateTab,
  utf8Bytes,
} from './sql-model.ts'
import { loadTabs, saveTabs } from './tab-storage.ts'

/**
 * The SQL section of a target (information-architecture.md §4, order §8 "SQL",
 * modelled on Studio's SQL editor): query tabs per target, the editor
 * (CodeMirror 6 in a shadow root, loaded lazily), two modes and no third.
 *
 * - Query: one read-only statement sent to the data-read endpoint when the
 *   person presses Run or Mod+Enter; the server admits it (permission, tier,
 *   the target's `data.read` setting, the parser) and its refusal is shown as
 *   it is. A text the server's classification calls a write is not sent; the
 *   page explains and offers a draft.
 * - Draft a change: the same editor; the server classifies the text live;
 *   "Create migration" builds a bundle draft whose plan is reviewed on the
 *   plan page. Nothing is applied here.
 *
 * Text from a link (`?sql=`), the history or a saved query opens in a new tab
 * and is never run on opening.
 */
const SqlEditor = lazy(async () => {
  const module = await import('@exponetdb/ui-data/editor/sql-editor')
  return { default: module.SqlEditor }
})

const IDLE: RunState = { kind: 'idle' }
const NO_CANCEL: CancelState = { kind: 'none' }
const CLASSIFY_DEBOUNCE_MS = 400
const TAB_TITLE_MAX = 28

type LinkNote = { readonly kind: 'too_long'; readonly length: number } | undefined

type SaveNote =
  | { readonly tabId: string; readonly kind: 'saved' }
  | { readonly tabId: string; readonly kind: 'conflict' }
  | { readonly tabId: string; readonly kind: 'failed'; readonly message: string }
  | undefined

function savedRefOf(saved: SavedQuery): SavedRef {
  return {
    id: saved.id,
    name: saved.name,
    revision: saved.revision,
    visibility: saved.visibility,
    owned: saved.ownedByCaller,
  }
}

/** The tabs on opening: the stored ones, plus a tab for the text of a `?sql=` link (never run). */
/** Applies a link to the tabs: its text opens in a new tab (never run); a mode alone switches an empty tab. */
function applyLink(state: TabsState, search: string): { tabs: TabsState; note: LinkNote } {
  const link = parseSqlLink(search)
  if (link.sql.kind === 'text') {
    return {
      tabs: addTab(state, newTab(link.mode ?? 'query', link.sql.sql, 'link')),
      note: undefined,
    }
  }
  const note: LinkNote =
    link.sql.kind === 'too_long' ? { kind: 'too_long', length: link.sql.length } : undefined
  if (link.mode === undefined) return { tabs: state, note }
  const current = activeTab(state)
  const tabs =
    current.sql.trim().length === 0
      ? updateTab(state, current.id, { mode: link.mode })
      : current.mode === link.mode
        ? state
        : addTab(state, newTab(link.mode))
  return { tabs, note }
}

/** The tabs on opening: the stored ones, plus what a `?sql=` or `?mode=` link asks for. */
function initialState(
  identityId: string,
  targetId: string,
  search: string,
): { tabs: TabsState; note: LinkNote } {
  const fresh = newTab(parseSqlLink(search).mode ?? 'query')
  return applyLink(loadTabs(identityId, targetId) ?? { tabs: [fresh], active: fresh.id }, search)
}

function useDebounced<T>(value: T, ms: number): T {
  const [current, setCurrent] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setCurrent(value), ms)
    return () => clearTimeout(timer)
  }, [value, ms])
  return current
}

export function SqlBody(props: {
  readonly route: TargetRoute
  readonly target: Target
}): ReactNode {
  const { route, target } = props
  const { client, confirmIdentity } = useApi()
  const queryClient = useQueryClient()
  const search = useRouterState({ select: (state) => state.location.searchStr })
  // The tabs are kept per person and target: another person on this browser never sees them.
  const identityId = useMe().identity.id
  const [initial] = useState(() => initialState(identityId, target.id, search))
  const [tabs, setTabs] = useState<TabsState>(initial.tabs)
  const [linkNote, setLinkNote] = useState<LinkNote>(initial.note)
  const [runs, setRuns] = useState<ReadonlyMap<string, RunState>>(() => new Map())
  const [draftOpen, setDraftOpen] = useState<string | undefined>(undefined)
  const [saveOpen, setSaveOpen] = useState(false)
  const [saveNote, setSaveNote] = useState<SaveNote>(undefined)
  const [analyze, setAnalyze] = useState(false)
  const editorRef = useRef<EditorHandle>(null)
  const inFlight = useRef(new Set<string>())

  useEffect(() => saveTabs(identityId, target.id, tabs), [identityId, target.id, tabs])

  // A later link on the same page (the page stays mounted) opens its text the same way, never run.
  const appliedSearch = useRef(search)
  useEffect(() => {
    if (appliedSearch.current === search) return
    appliedSearch.current = search
    setTabs((current) => {
      const next = applyLink(current, search)
      if (next.note !== undefined) setLinkNote(next.note)
      return next.tabs
    })
  }, [search])

  const tab = activeTab(tabs)
  const run = runs.get(tab.id) ?? IDLE
  const major = postgresMajorOf(target.placement?.postgresVersion)

  const setRun = useCallback(
    (tabId: string, next: RunState | ((previous: RunState) => RunState)) =>
      setRuns((previous) => {
        const map = new Map(previous)
        map.set(tabId, typeof next === 'function' ? next(previous.get(tabId) ?? IDLE) : next)
        return map
      }),
    [],
  )

  // --- Live classification of the text (the server's parse; never "safe" by absence). ----------
  const debounced = useDebounced(tab.sql, CLASSIFY_DEBOUNCE_MS)
  const classification = useQuery(classifyQuery(client, major, debounced))
  const classView: ClassificationView = useMemo(() => {
    if (tab.sql.trim().length === 0) return { state: 'idle' }
    if (utf8Bytes(tab.sql) > CLASSIFY_MAX_BYTES) return { state: 'too_large' }
    if (debounced !== tab.sql) return { state: 'loading' }
    if (classification.data !== undefined) {
      return { state: 'ready', text: debounced, value: classification.data }
    }
    if (classification.isError) {
      const failure = actionError(classification.error)
      return {
        state: 'failed',
        error: { code: failure.code, message: failure.message },
        retry: () => void classification.refetch(),
      }
    }
    return { state: 'loading' }
  }, [
    tab.sql,
    debounced,
    classification.data,
    classification.isError,
    classification.error,
    classification.refetch,
  ])

  const diagnostics = useMemo<readonly SqlDiagnostic[]>(
    () =>
      classView.state === 'ready'
        ? classificationDiagnostics(tab.sql, classView.text, classView.value, {
            statement: (index, label, classes) =>
              t('sql.diag.statement', { n: index, label, classes }),
            noClass: t('sql.diag.noClass'),
            parseError: t('sql.diag.parseError'),
          })
        : [],
    [classView, tab.sql],
  )
  const liveVerdict = classView.state === 'ready' ? queryVerdict(classView.value) : undefined

  const completion = useMemo(
    () => createCompletionProvider(client, queryClient, route.path),
    [client, queryClient, route.path],
  )

  // --- Tabs. ---------------------------------------------------------------------------------
  const openTab = useCallback((next: SqlTab) => setTabs((current) => addTab(current, next)), [])
  const changeText = useCallback(
    (sql: string) => setTabs((current) => updateTab(current, current.active, { sql })),
    [],
  )
  const setMode = (mode: SqlMode) =>
    setTabs((current) => updateTab(current, current.active, { mode }))
  const draftAsMigration = () => setMode('draft')

  // --- Run, explain and cancel (Query mode only). ---------------------------------------------
  const startRun = async (what: RunWhat): Promise<void> => {
    if (tab.mode !== 'query' || run.kind === 'running' || inFlight.current.has(tab.id)) return
    const selected = editorRef.current?.getSelectionText() ?? ''
    const text = normalizeBreaks(selected.trim().length > 0 ? selected : tab.sql)
    if (text.trim().length === 0) return
    const tabId = tab.id
    inFlight.current.add(tabId)
    try {
      // The server's classification of exactly this text: a write is held back, not sent as a read.
      if (classifiable(text)) {
        try {
          const verdict = queryVerdict(
            await queryClient.fetchQuery(classifyQuery(client, major, text)),
          )
          if (verdict.kind === 'write') {
            setRun(tabId, { kind: 'blocked', classes: verdict.classes })
            return
          }
        } catch {
          // Not classified: the data-read endpoint's own admission decides.
        }
      }
      const queryId = `qry_${newUlid()}`
      setRun(tabId, { kind: 'running', what, queryId, cancel: NO_CANCEL })
      const receivedAt = () => new Date().toISOString()
      try {
        if (what === 'query') {
          const result = await client.operation('runQuery', {
            params: { target: route.path },
            body: { sql: text, queryId },
          })
          setRun(tabId, { kind: 'result', result, receivedAt: receivedAt() })
        } else {
          const result = await client.operation('explainQuery', {
            params: { target: route.path },
            body: { sql: text, queryId, ...(analyze ? { analyze: true } : {}) },
          })
          setRun(tabId, { kind: 'explain', result, receivedAt: receivedAt() })
        }
        void queryClient.invalidateQueries({ queryKey: sqlKeys.history(route.path) })
      } catch (error) {
        const failure = actionError(error)
        setRun(tabId, (previous) => ({
          kind: 'failed',
          what,
          queryId,
          failure: { code: failure.code, message: failure.message },
          cancel: previous.kind === 'running' ? previous.cancel : NO_CANCEL,
        }))
        void queryClient.invalidateQueries({ queryKey: sqlKeys.history(route.path) })
      }
    } finally {
      inFlight.current.delete(tabId)
    }
  }

  const patchCancel =
    (queryId: string, cancel: CancelState) =>
    (previous: RunState): RunState =>
      (previous.kind === 'running' || previous.kind === 'failed') && previous.queryId === queryId
        ? { ...previous, cancel }
        : previous

  const cancelRun = async (): Promise<void> => {
    if (run.kind !== 'running' || run.cancel.kind === 'requested') return
    const { queryId } = run
    const tabId = tab.id
    setRun(tabId, patchCancel(queryId, { kind: 'requested' }))
    try {
      const answer = await client.operation('cancelQuery', {
        params: { target: route.path, queryId },
      })
      setRun(
        tabId,
        patchCancel(
          queryId,
          answer.outcome === 'canceled' ? { kind: 'canceled' } : { kind: 'finished' },
        ),
      )
    } catch (error) {
      const failure = actionError(error)
      setRun(
        tabId,
        patchCancel(queryId, {
          kind: 'failed',
          failure: { code: failure.code, message: failure.message },
        }),
      )
    }
  }

  // --- Saved queries (Web App only; saving never runs). ---------------------------------------
  const invalidateSaved = () =>
    void queryClient.invalidateQueries({ queryKey: sqlKeys.saved(route.path) })

  const createSaved = async (input: SaveInput): Promise<SavedQuery> => {
    const tabId = tab.id
    const sql = tab.sql
    const saved = await withReauth(client, confirmIdentity, () =>
      client.operation('createSavedQuery', {
        body: {
          name: input.name,
          sql,
          visibility: input.visibility,
          scope:
            input.scope === 'target'
              ? { kind: 'target', target: route.path }
              : { kind: 'project', projectId: target.projectId },
        },
      }),
    )
    setTabs((current) => updateTab(current, tabId, { saved: savedRefOf(saved) }))
    setSaveNote({ tabId, kind: 'saved' })
    invalidateSaved()
    return saved
  }

  const updateSaved = async (saved: SavedRef): Promise<void> => {
    const tabId = tab.id
    try {
      const next = await withReauth(client, confirmIdentity, () =>
        client.operation('updateSavedQuery', {
          params: { savedQueryId: saved.id },
          body: {
            name: saved.name,
            sql: tab.sql,
            visibility: saved.visibility,
            revision: saved.revision,
          },
        }),
      )
      setTabs((current) => updateTab(current, tabId, { saved: savedRefOf(next) }))
      setSaveNote({ tabId, kind: 'saved' })
      invalidateSaved()
    } catch (error) {
      if (error instanceof ApiError && error.code === 'CONFLICT') {
        setSaveNote({ tabId, kind: 'conflict' })
      } else {
        setSaveNote({ tabId, kind: 'failed', message: describeError(error) })
      }
    }
  }

  const save = () => {
    if (tab.sql.trim().length === 0) return
    if (tab.saved?.owned === true) void updateSaved(tab.saved)
    else setSaveOpen(true)
  }

  const openStoredVersion = async (saved: SavedRef): Promise<void> => {
    const tabId = tab.id
    try {
      const stored = await client.operation('getSavedQuery', { params: { savedQueryId: saved.id } })
      openTab(newTab('query', stored.sql, 'saved', savedRefOf(stored)))
      setSaveNote(undefined)
    } catch (error) {
      setSaveNote({ tabId, kind: 'failed', message: describeError(error) })
    }
  }

  // --- Shortcuts (registered centrally; shown in the shortcut sheet). --------------------------
  useShortcut('sql.run', () => void startRun('query'), { enabled: tab.mode === 'query' })
  useShortcut('sql.save', save)

  const note = saveNote !== undefined && saveNote.tabId === tab.id ? saveNote : undefined
  const prod = target.tier === 'prod'

  return (
    <div
      className="grid min-w-0 gap-6 lg:grid-cols-[16rem_minmax(0,1fr)]"
      data-page="sql"
      data-mode={tab.mode}
    >
      <SidePanel
        path={route.path}
        onOpenText={(sql, origin) => openTab(newTab('query', normalizeBreaks(sql), origin))}
        onOpenSaved={(saved) =>
          openTab(newTab('query', normalizeBreaks(saved.sql), 'saved', savedRefOf(saved)))
        }
      />
      <div className="flex min-w-0 flex-col gap-4">
        {linkNote === undefined ? null : (
          <Admonition
            type="warning"
            title={t('sql.link.tooLongTitle')}
            description={t('sql.link.tooLong', {
              length: linkNote.length,
              max: LINK_MAX_CHARS,
            })}
            actions={
              <Button variant="outline" size="tiny" onClick={() => setLinkNote(undefined)}>
                {t('sql.note.dismiss')}
              </Button>
            }
          />
        )}
        <TabStrip
          tabs={tabs}
          onSelect={(id) => setTabs((current) => ({ ...current, active: id }))}
          onClose={(id) =>
            setTabs((current) => closeTab(current, id, current.tabs[0]?.mode ?? 'query'))
          }
          onNew={() => openTab(newTab(tab.mode))}
        />
        <div className="flex flex-wrap items-center gap-2" data-block="sql-toolbar">
          <fieldset className="flex items-center gap-1 rounded-md border border-default p-0.5">
            <legend className="sr-only">{t('sql.mode.label')}</legend>
            <ModeButton current={tab.mode} mode="query" onSelect={setMode} />
            <ModeButton current={tab.mode} mode="draft" onSelect={setMode} />
          </fieldset>
          {tab.mode === 'query' ? (
            <>
              <Button
                variant="primary"
                size="tiny"
                onClick={() => void startRun('query')}
                disabled={run.kind === 'running'}
                iconRight={<KeyboardShortcut keys={['Meta', 'Enter']} variant="inline" />}
              >
                {t('sql.run.run')}
              </Button>
              <Button
                variant="default"
                size="tiny"
                onClick={() => void startRun('explain')}
                disabled={run.kind === 'running'}
              >
                {t('sql.run.explain')}
              </Button>
              <label className="flex items-center gap-1.5 text-xs">
                <input
                  type="checkbox"
                  checked={analyze}
                  onChange={(event) => setAnalyze(event.target.checked)}
                />
                {t('sql.run.analyze')}
              </label>
              {run.kind === 'running' ? (
                <Button
                  variant="outline"
                  size="tiny"
                  onClick={() => void cancelRun()}
                  disabled={run.cancel.kind === 'requested'}
                >
                  {t('sql.run.cancel')}
                </Button>
              ) : null}
            </>
          ) : (
            <Button
              variant="primary"
              size="tiny"
              onClick={() => setDraftOpen(tab.id)}
              disabled={tab.sql.trim().length === 0}
            >
              {t('sql.draft.create')}
            </Button>
          )}
          <Button
            variant="default"
            size="tiny"
            onClick={save}
            disabled={tab.sql.trim().length === 0}
            iconRight={<KeyboardShortcut keys={['Meta', 's']} variant="inline" />}
          >
            {tab.saved?.owned === true ? t('sql.save.update') : t('sql.save.open')}
          </Button>
        </div>
        {prod ? (
          <p className="flex flex-wrap items-center gap-2 text-sm" data-production-cue="true">
            <TierChip tier="prod" />
            <span>
              {tab.mode === 'query' ? t('sql.production.query') : t('sql.production.draft')}
            </span>
          </p>
        ) : null}
        <p className="text-xs text-foreground-lighter">
          {tab.mode === 'query' ? t('sql.mode.queryHint') : t('sql.mode.draftHint')}
        </p>
        <OriginNote
          tab={tab}
          onDismiss={() => setTabs((current) => updateTab(current, tab.id, { origin: 'new' }))}
        />
        {note === undefined ? null : (
          <SaveNoteView
            note={note}
            saved={tab.saved}
            onSaveAsNew={() => setSaveOpen(true)}
            onOpenStored={(saved) => void openStoredVersion(saved)}
            onDismiss={() => setSaveNote(undefined)}
          />
        )}
        <Suspense fallback={<LoadingState what={nounPhrase('sql.editor.what')} lines={8} />}>
          <SqlEditor
            key={tab.id}
            ref={editorRef}
            value={tab.sql}
            onChange={changeText}
            mode={tab.mode}
            diagnostics={diagnostics}
            completion={completion}
            {...(tab.mode === 'query' ? { onRun: () => void startRun('query') } : {})}
            label={tab.mode === 'query' ? t('sql.editor.labelQuery') : t('sql.editor.labelDraft')}
            minLines={10}
            maxLines={28}
            placeholder={
              tab.mode === 'query'
                ? t('sql.editor.placeholderQuery')
                : t('sql.editor.placeholderDraft')
            }
          />
        </Suspense>
        <p className="text-xs text-foreground-lighter">{t('sql.editor.noFormatter')}</p>
        {tab.mode === 'query' ? (
          <>
            {liveVerdict?.kind === 'write' && run.kind !== 'blocked' ? (
              <WriteExplanation
                classes={liveVerdict.classes}
                onDraft={draftAsMigration}
                sent={false}
              />
            ) : null}
            <ResultsPanel run={run} onCancel={() => void cancelRun()} onDraft={draftAsMigration} />
            <details className="rounded-md border border-default p-3">
              <summary className="cursor-pointer text-sm">{t('sql.class.details')}</summary>
              <div className="pt-3">
                <ClassificationPanel
                  view={classView}
                  onGoTo={(line, column) => editorRef.current?.setSelection(line, column)}
                />
              </div>
            </details>
          </>
        ) : (
          <>
            <ClassificationPanel
              view={classView}
              onGoTo={(line, column) => editorRef.current?.setSelection(line, column)}
              headingLevel={2}
            />
            {draftOpen === tab.id ? (
              <DraftPanel
                key={tab.id}
                path={route.path}
                projectId={target.projectId}
                tier={target.tier}
                postgresMajor={major}
                upSql={tab.sql}
                classification={classView.state === 'ready' ? classView.value : undefined}
                Editor={SqlEditor}
                onClose={() => setDraftOpen(undefined)}
              />
            ) : null}
          </>
        )}
      </div>
      {saveOpen ? (
        <SaveDialog
          open={saveOpen}
          onOpenChange={setSaveOpen}
          initialName={tab.saved?.name ?? ''}
          onSave={async (input) => {
            try {
              return await createSaved(input)
            } catch (error) {
              throw actionError(error)
            }
          }}
        />
      ) : null}
    </div>
  )
}

function ModeButton(props: {
  readonly current: SqlMode
  readonly mode: SqlMode
  readonly onSelect: (mode: SqlMode) => void
}): ReactNode {
  const selected = props.current === props.mode
  return (
    <Button
      variant={selected ? 'default' : 'text'}
      size="tiny"
      aria-pressed={selected}
      onClick={() => props.onSelect(props.mode)}
    >
      {props.mode === 'query' ? t('sql.mode.query') : t('sql.mode.draft')}
    </Button>
  )
}

/** The first line of a tab's text as its title (untrusted text, shown marked). */
function tabTitle(tab: SqlTab): string {
  if (tab.saved !== undefined) return tab.saved.name
  const first = tab.sql
    .split('\n')
    .find((line) => line.trim().length > 0)
    ?.trim()
  return first === undefined || first.length === 0
    ? tab.mode === 'query'
      ? t('sql.tabs.newQuery')
      : t('sql.tabs.newDraft')
    : first
}

/**
 * A tab's title inside its button: cut at 28 code points and marked like any
 * untrusted text (hidden and direction characters by code point), with no
 * control of its own, because a button may not hold another one.
 */
function TabTitle(props: { readonly text: string }): ReactNode {
  const cut = takeCodePoints(props.text, TAB_TITLE_MAX)
  return (
    <span className="min-w-0 truncate">
      <MarkedCode text={cut.head} className="bg-transparent p-0 font-sans text-xs" />
      {cut.truncated ? <span aria-hidden="true">…</span> : null}
    </span>
  )
}

function TabStrip(props: {
  readonly tabs: TabsState
  readonly onSelect: (id: string) => void
  readonly onClose: (id: string) => void
  readonly onNew: () => void
}): ReactNode {
  return (
    <nav
      aria-label={t('sql.tabs.label')}
      className="flex min-w-0 items-center gap-2 border-b border-default pb-2"
    >
      <ul className="m-0 flex min-w-0 list-none items-center gap-1 overflow-x-auto p-0">
        {props.tabs.tabs.map((tab, index) => {
          const selected = tab.id === props.tabs.active
          return (
            <li
              key={tab.id}
              className="flex shrink-0 items-center rounded-md border border-default data-[selected=true]:bg-surface-200"
              data-selected={selected}
              data-origin={tab.origin}
            >
              <Button
                variant="text"
                size="tiny"
                aria-current={selected ? 'true' : undefined}
                onClick={() => props.onSelect(tab.id)}
                className="max-w-[14rem]"
              >
                <span className="sr-only">
                  {t('sql.tabs.position', {
                    n: index + 1,
                    mode: tab.mode === 'query' ? t('sql.mode.query') : t('sql.mode.draft'),
                  })}
                </span>
                <TabTitle text={tabTitle(tab)} />
              </Button>
              <Button
                variant="text"
                size="tiny"
                aria-label={t('sql.tabs.close', { n: index + 1 })}
                onClick={() => props.onClose(tab.id)}
              >
                <span aria-hidden="true">×</span>
              </Button>
            </li>
          )
        })}
      </ul>
      <Button variant="outline" size="tiny" onClick={props.onNew}>
        {t('sql.tabs.new')}
      </Button>
    </nav>
  )
}

/** Where the text of the tab came from: a link, the history or a saved query, never run on opening. */
function OriginNote(props: { readonly tab: SqlTab; readonly onDismiss: () => void }): ReactNode {
  const { tab } = props
  const hidden = useMemo(() => hiddenCharacterCount(tab.sql), [tab.sql])
  if (tab.origin === 'new') return null
  const title =
    tab.origin === 'link'
      ? t('sql.link.title')
      : tab.origin === 'history'
        ? t('sql.history.openedTitle')
        : t('sql.saved.openedTitle')
  const body =
    tab.origin === 'link'
      ? t('sql.link.body')
      : tab.origin === 'history'
        ? t('sql.history.openedBody')
        : t('sql.saved.openedBody')
  return (
    <Admonition
      type={tab.origin === 'link' ? 'warning' : 'default'}
      title={title}
      description={
        <span className="flex flex-col gap-1" data-origin-note={tab.origin}>
          <span>{body}</span>
          <span>
            {t('sql.link.size', { lines: lineCount(tab.sql), characters: tab.sql.length })}
          </span>
          {hidden === 0 ? null : (
            <span className="font-medium" data-hidden-count={hidden}>
              {t('sql.link.hidden', { count: hidden })}
            </span>
          )}
        </span>
      }
      actions={
        <Button variant="outline" size="tiny" onClick={props.onDismiss}>
          {t('sql.note.dismiss')}
        </Button>
      }
    />
  )
}

function SaveNoteView(props: {
  readonly note: Exclude<SaveNote, undefined>
  readonly saved: SavedRef | undefined
  readonly onSaveAsNew: () => void
  readonly onOpenStored: (saved: SavedRef) => void
  readonly onDismiss: () => void
}): ReactNode {
  const { note, saved } = props
  const dismiss = (
    <Button variant="outline" size="tiny" onClick={props.onDismiss}>
      {t('sql.note.dismiss')}
    </Button>
  )
  switch (note.kind) {
    case 'saved':
      return (
        <p role="status" className="text-sm" data-save-note="saved">
          {t('sql.save.done', { revision: saved?.revision ?? 1 })}
        </p>
      )
    case 'failed':
      return (
        <Admonition
          type="destructive"
          title={t('sql.save.failedTitle')}
          description={<span data-save-note="failed">{note.message}</span>}
          actions={dismiss}
        />
      )
    case 'conflict':
      return (
        <Admonition
          type="warning"
          title={t('sql.save.conflictTitle')}
          description={
            <span data-save-note="conflict">
              {t('sql.save.conflictBody', { revision: saved?.revision ?? 0 })}
            </span>
          }
          actions={
            <span className="flex flex-wrap gap-2">
              {saved === undefined ? null : (
                <Button variant="outline" size="tiny" onClick={() => props.onOpenStored(saved)}>
                  {t('sql.save.openStored')}
                </Button>
              )}
              <Button variant="outline" size="tiny" onClick={props.onSaveAsNew}>
                {t('sql.save.asNew')}
              </Button>
              {dismiss}
            </span>
          }
        />
      )
  }
}
