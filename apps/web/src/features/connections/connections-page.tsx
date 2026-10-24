import { Button } from '@exponetdb/ui'
import {
  NotAvailableYetState,
  readableValue,
  StateMessage,
  useNavigate,
} from '@exponetdb/ui-patterns'
import { type ReactNode, useCallback, useMemo, useState } from 'react'
import { t } from '../../lib/i18n/i18n.ts'
import { nounPhrase } from '../target/phrases.ts'
import { useTargetHealth } from '../target/queries.ts'
import { useTargetScope } from '../target/scope.tsx'
import { useTargetHref } from '../target-ops/links.ts'
import { AttentionStrip } from './attention-strip.tsx'
import { EndpointsSection } from './endpoints-view.tsx'
import { LiveControls } from './live-controls.tsx'
import { LiveReadView } from './live-read.tsx'
import { LockGraphView } from './locks-view.tsx'
import {
  distinctValues,
  filterSessions,
  graphPids,
  hasServerFilter,
  type LocalFilterName,
  localOnlyFilters,
  observedAtOf,
  type Session,
  type SessionFilters,
  type SessionList,
  serverFilterOf,
} from './model.ts'
import { DiagnosticsFrame } from './page-frame.tsx'
import { SESSION_LIMIT, useLocks, useSessions } from './queries.ts'
import { type ConnectionsSearch, narrows, searchString } from './search.ts'
import { SessionFilterBar } from './session-filters.tsx'
import { SessionsView, sessionRowId } from './sessions-view.tsx'

const LOCAL_FILTER_NAMES = {
  role: 'connections.filters.name.role',
  text: 'connections.filters.name.text',
  state: 'connections.filters.name.state',
  view: 'connections.filters.name.view',
  application: 'connections.filters.name.application',
} as const satisfies Record<LocalFilterName, string>

/**
 * `/t/<product>/<project>/<environment>/connections` (order section 8,
 * Studio's database connections as a specification): what needs attention
 * first, the sessions of the target grouped by role and application with
 * their states and filters, who blocks whom, and the endpoints with their
 * probe results. The frame renders the unreachable and "cannot tell" states
 * before any of this (the page needs the target reachable); each read below
 * renders its own truthful state. Cancel and terminate are not controls:
 * they come as planned operations in Wave 9, and the page names that state.
 */
export function ConnectionsPage({ search }: { readonly search: ConnectionsSearch }): ReactNode {
  return (
    <DiagnosticsFrame section="connections" description={t('connections.page.description')}>
      <ConnectionsBody search={search} />
    </DiagnosticsFrame>
  )
}

function ConnectionsBody({ search }: { readonly search: ConnectionsSearch }): ReactNode {
  const scope = useTargetScope()
  const path = scope.target.path
  const navigate = useNavigate()
  const href = useTargetHref()
  // Held for this visit only: the pause, and the filters the data fills in or the person types.
  const [live, setLive] = useState(true)
  const [role, setRole] = useState<string | undefined>(undefined)
  const [application, setApplication] = useState<string | undefined>(undefined)
  const [text, setText] = useState('')
  const [highlight, setHighlight] = useState<number | undefined>(undefined)

  const sessions = useSessions(path, { live })
  const locks = useLocks(path, { live })
  const health = useTargetHealth(path)
  const base = readableValue(sessions.readable)
  const graph = readableValue(locks.readable)
  const target = readableValue(scope.read)

  const blockersView = search.view === 'blockers'
  const pidsOfGraph = useMemo(
    () => (blockersView && graph !== undefined ? graphPids(graph.waits) : undefined),
    [blockersView, graph],
  )
  const filters: SessionFilters = {
    state: search.state,
    role,
    application,
    minAgeSeconds: search.minAge,
    text,
    graphPids: pidsOfGraph,
  }
  // When the unfiltered list was cut, the target applies what it can filter by instead of this
  // page filtering a sample of the sessions.
  const serverFilter = useMemo(
    () => serverFilterOf({ state: search.state, application, minAgeSeconds: search.minAge }),
    [search.state, application, search.minAge],
  )
  const askServer = base?.truncated === true && hasServerFilter(serverFilter)
  const filtered = useSessions(path, { live, filter: serverFilter, enabled: askServer })
  const listRead = askServer ? filtered : sessions
  const list = readableValue(listRead.readable)

  const shown = useMemo<readonly Session[]>(
    () =>
      list === undefined
        ? []
        : filterSessions(
            list.sessions,
            {
              state: search.state,
              role,
              application,
              minAgeSeconds: search.minAge,
              text,
              graphPids: pidsOfGraph,
            },
            { observedAt: list.observedAt, skipServerFilters: askServer },
          ),
    [list, search.state, role, application, search.minAge, text, pidsOfGraph, askServer],
  )
  // The blockers view cannot be drawn without the lock graph; nothing is shown in its place.
  const needsLocks = blockersView && graph === undefined
  const rendered = needsLocks ? [] : shown
  const listed = useMemo(() => new Set(rendered.map((session) => session.pid)), [rendered])
  const roles = useMemo(
    () => (base === undefined ? [] : distinctValues(base.sessions, 'role')),
    [base],
  )
  const applications = useMemo(
    () => (base === undefined ? [] : distinctValues(base.sessions, 'applicationName')),
    [base],
  )

  const active =
    role !== undefined || application !== undefined || text.trim() !== '' || narrows(search)
  const localNames = localOnlyFilters(filters)
  const cut = list?.truncated === true
  const missingFromList = useMemo(() => {
    if (pidsOfGraph === undefined || list === undefined) return 0
    const known = new Set(list.sessions.map((session) => session.pid))
    return [...pidsOfGraph].filter((pid) => !known.has(pid)).length
  }, [pidsOfGraph, list])

  const go = (next: ConnectionsSearch): void =>
    navigate(href(`/connections${searchString(next)}`), { replace: true })
  const reset = (): void => {
    setRole(undefined)
    setApplication(undefined)
    setText('')
    go({ sort: search.sort, layout: search.layout })
  }
  const refresh = (): void => {
    sessions.refetch()
    locks.refetch()
    health.refetch()
    if (askServer) filtered.refetch()
  }
  const unhighlight = useCallback(() => setHighlight(undefined), [])
  const jump = (pid: number): void => {
    const row = document.getElementById(sessionRowId(pid))
    if (row === null) return
    setHighlight(pid)
    row.scrollIntoView?.({ block: 'center' })
    row.focus({ preventScroll: true })
  }

  return (
    <>
      <section aria-labelledby="attention-title" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="attention-title" className="text-base font-medium text-foreground">
            {t('connections.attention.title')}
          </h2>
          <LiveControls
            live={live}
            onLiveChange={(next) => {
              setLive(next)
              // A resumed page reads at once instead of waiting out an interval.
              if (next) refresh()
            }}
            onRefresh={refresh}
            busy={sessions.fetching || locks.fetching || health.fetching || filtered.fetching}
            observedAt={[observedAtOf(sessions.readable), observedAtOf(locks.readable)]}
          />
        </div>
        <AttentionStrip
          sessions={sessions.readable}
          locks={locks.readable}
          health={health.readable}
          listed={listed}
          onJump={jump}
        />
      </section>
      <section aria-labelledby="sessions-title" className="flex flex-col gap-3">
        <h2 id="sessions-title" className="text-base font-medium text-foreground">
          {t('connections.sessions.title')}
        </h2>
        {base === undefined ? null : (
          <>
            <SessionFilterBar
              search={search}
              onSearchChange={go}
              role={role}
              onRoleChange={setRole}
              application={application}
              onApplicationChange={setApplication}
              text={text}
              onTextChange={setText}
              roles={roles}
              applications={applications}
              active={active}
              onReset={reset}
            />
            <FilterNotes
              baseCut={base.truncated}
              cap={base.cap}
              askServer={askServer}
              listCut={cut}
              listCap={list?.cap ?? SESSION_LIMIT}
              localNames={localNames}
              graphCut={blockersView && graph?.truncated === true}
              missingFromList={missingFromList}
            />
          </>
        )}
        {needsLocks ? (
          <>
            <p className="text-sm text-foreground-light">
              {t('connections.filters.blockersNeedLocks')}
            </p>
            <LiveReadView
              readable={locks.readable}
              what={nounPhrase('locks.what')}
              onRetry={locks.refetch}
              busy={locks.fetching}
              ready={() => null}
            />
          </>
        ) : (
          <LiveReadView
            readable={listRead.readable}
            what={nounPhrase(
              askServer ? 'connections.filters.serverWhat' : 'connections.sessions.what',
            )}
            onRetry={listRead.refetch}
            busy={listRead.fetching}
            // A list the target filtered is empty because nothing matched, not because the target is idle.
            {...(askServer ? {} : { isEmpty: (value: SessionList) => value.sessions.length === 0 })}
            empty={
              <p className="text-sm text-foreground-light">{t('connections.sessions.empty')}</p>
            }
            ready={(value) =>
              rendered.length === 0 ? (
                <NoMatch
                  total={base?.sessions.length ?? value.sessions.length}
                  cut={value.truncated}
                  cap={value.cap}
                  askServer={askServer}
                  onReset={reset}
                />
              ) : (
                <SessionsView
                  list={value}
                  shown={rendered}
                  locks={graph}
                  targetPath={path}
                  layout={search.layout === 'flat' ? 'flat' : 'grouped'}
                  order={search.sort === 'longest' ? 'longest' : 'default'}
                  highlight={highlight}
                  onUnhighlight={unhighlight}
                  summary={
                    active
                      ? t(
                          value.truncated
                            ? 'connections.filters.summaryLowerBound'
                            : 'connections.filters.summary',
                          { shown: rendered.length, total: value.sessions.length },
                        )
                      : undefined
                  }
                />
              )
            }
          />
        )}
        <NotAvailableYetState
          what={t('connections.operate.what')}
          reason={t('connections.operate.reason')}
          headingLevel={3}
        />
      </section>
      <section aria-labelledby="blocking-title" className="flex flex-col gap-3">
        <h2 id="blocking-title" className="text-base font-medium text-foreground">
          {t('connections.blocking.title')}
        </h2>
        <LiveReadView
          readable={locks.readable}
          what={nounPhrase('locks.what')}
          onRetry={locks.refetch}
          busy={locks.fetching}
          isEmpty={(value) => value.waits.length === 0}
          empty={<p className="text-sm text-foreground-light">{t('locks.empty')}</p>}
          ready={(value) => (
            <LockGraphView graph={value} headingLevel={3} sessions={sessions.readable} />
          )}
        />
      </section>
      {target === undefined ? null : (
        <EndpointsSection target={target} health={health.readable} onRetryHealth={health.refetch} />
      )}
    </>
  )
}

/** What the person should know about how the filters ran over a list that was cut or filtered by the target. */
function FilterNotes(props: {
  readonly baseCut: boolean
  readonly cap: number
  readonly askServer: boolean
  readonly listCut: boolean
  readonly listCap: number
  readonly localNames: readonly LocalFilterName[]
  readonly graphCut: boolean
  readonly missingFromList: number
}): ReactNode {
  const notes: { readonly key: string; readonly text: string }[] = []
  if (props.baseCut) {
    notes.push({ key: 'options', text: t('connections.filters.optionsSample', { cap: props.cap }) })
  }
  if (props.askServer) {
    notes.push({ key: 'server', text: t('connections.filters.server', { cap: props.cap }) })
  }
  if (props.listCut && props.localNames.length > 0) {
    notes.push({
      key: 'sample',
      text: t('connections.filters.sample', {
        cap: props.listCap,
        filters: props.localNames.map((name) => nounPhrase(LOCAL_FILTER_NAMES[name])).join(', '),
      }),
    })
  }
  if (props.graphCut) {
    notes.push({ key: 'graph', text: t('connections.filters.blockersCut') })
  }
  if (props.missingFromList > 0) {
    notes.push({
      key: 'missing',
      text: t('connections.filters.blockersMissing', { count: props.missingFromList }),
    })
  }
  if (notes.length === 0) return null
  return (
    <ul className="flex flex-col gap-1 text-xs text-foreground-light" data-slot="filter-notes">
      {notes.map((note) => (
        <li key={note.key} data-note={note.key}>
          {note.text}
        </li>
      ))}
    </ul>
  )
}

/**
 * The filters matched no session of a read that returned sessions: said as
 * that, with the way back, and never as an idle target or an empty read.
 */
function NoMatch(props: {
  readonly total: number
  readonly cut: boolean
  readonly cap: number
  readonly askServer: boolean
  readonly onReset: () => void
}): ReactNode {
  return (
    <StateMessage
      data-state="no-match"
      title={t('connections.filters.noMatch.title')}
      headingLevel={3}
      actions={
        <Button type="button" size="tiny" variant="outline" onClick={props.onReset}>
          {t('connections.filters.reset')}
        </Button>
      }
    >
      <p>
        {props.askServer
          ? t('connections.filters.noMatch.server', { cap: props.cap })
          : t('connections.filters.noMatch.body', { total: props.total })}
      </p>
      {props.cut && !props.askServer ? (
        <p>{t('connections.filters.noMatch.cut', { cap: props.cap })}</p>
      ) : null}
    </StateMessage>
  )
}
