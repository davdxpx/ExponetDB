import {
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
  type Readable,
  readableValue,
  UntrustedName,
  UntrustedText,
} from '@exponetdb/ui-patterns'
import { type ReactNode, useMemo } from 'react'
import { t } from '../../lib/i18n/i18n.ts'
import { nounPhrase } from '../target/phrases.ts'
import { Observation } from './live-read.tsx'
import {
  type BlockingTree,
  buildBlockingTree,
  formatDuration,
  formatWait,
  type LockGraph,
  type Session,
  type SessionList,
  sessionsByPid,
  stateLabel,
  stateOf,
  type TreeNode,
  waitMillis,
} from './model.ts'

/** The statement of a blocker is cut short: the full redacted text is on the Connections page. */
const BLOCKER_STATEMENT_CODE_POINTS = 240
const BLOCKER_STATEMENT_LINES = 4

/** What the tree needs of the sessions read: the sessions by process number, when there are any. */
interface Join {
  readonly byPid: ReadonlyMap<number, Session> | undefined
}

/**
 * The lock graph of a target: who blocks whom as a tree (a process that holds
 * a lock at the root, the processes that wait for it below) and every wait as
 * a table row with its lock mode, relation and wait time. Relation names come
 * from the target's catalog and are untrusted text; nothing here is a link or
 * a button that acts on a session.
 *
 * Each blocker in the tree is joined to the sessions read by process number:
 * its state and for how long, its role and application, when its session
 * started and its redacted statement. The join is a convenience with a stated
 * limit: the two reads were made at different moments, a process number can
 * be reused, so the sessions read's time is shown as "as of" and the start
 * time of the session is shown to check against. When the sessions could not
 * be read the tree is shown from the lock graph alone and says so.
 */
export function LockGraphView(props: {
  readonly graph: LockGraph
  readonly headingLevel: 3 | 4
  readonly sessions: Readable<SessionList>
}): ReactNode {
  const { graph } = props
  const tree = buildBlockingTree(graph.waits)
  const Heading = props.headingLevel === 3 ? 'h3' : 'h4'
  const list = readableValue(props.sessions)
  const byPid = useMemo(
    () => (list === undefined ? undefined : sessionsByPid(list.sessions)),
    [list],
  )
  const join: Join = { byPid }
  return (
    <div className="flex flex-col gap-4" data-lock-graph="">
      <Observation source={graph.source} observedAt={graph.observedAt} />
      <section aria-labelledby="lock-tree-title" className="flex flex-col gap-2">
        <Heading id="lock-tree-title" className="text-sm font-medium text-foreground">
          {t('locks.tree.title')}
        </Heading>
        <SessionJoinNote sessions={props.sessions} graphObservedAt={graph.observedAt} />
        <TreeView tree={tree} observedAt={graph.observedAt} join={join} />
      </section>
      <section aria-labelledby="lock-table-title" className="flex flex-col gap-2">
        <Heading id="lock-table-title" className="text-sm font-medium text-foreground">
          {t('locks.table.title')}
        </Heading>
        <Table>
          <TableCaption className="sr-only">{t('locks.table.caption')}</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">{t('locks.column.blocked')}</TableHead>
              <TableHead scope="col">{t('locks.column.blocking')}</TableHead>
              <TableHead scope="col">{t('locks.column.mode')}</TableHead>
              <TableHead scope="col">{t('locks.column.relation')}</TableHead>
              <TableHead scope="col">{t('locks.column.wait')}</TableHead>
              <TableHead scope="col">{t('locks.column.operation')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {graph.waits.map((wait) => (
              <TableRow key={wait.waitingPid} data-wait-pid={wait.waitingPid}>
                <TableCell className="font-mono text-xs">{wait.waitingPid}</TableCell>
                <TableCell className="font-mono text-xs">
                  {[...wait.blockingPids].sort((a, b) => a - b).join(', ')}
                </TableCell>
                <TableCell>
                  <UntrustedName name={wait.lockMode} mono label={t('locks.column.mode')} />
                </TableCell>
                <TableCell>
                  {wait.relation === null ? (
                    t('locks.relation.none')
                  ) : (
                    <UntrustedName name={wait.relation} mono label={t('locks.column.relation')} />
                  )}
                </TableCell>
                <TableCell>{formatWait(waitMillis(wait, graph.observedAt))}</TableCell>
                <TableCell>
                  {wait.exponetdbOperationId === null ? (
                    t('connections.operation.none')
                  ) : (
                    <UntrustedName
                      name={wait.exponetdbOperationId}
                      mono
                      label={t('locks.column.operation')}
                    />
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </section>
    </div>
  )
}

/** Seconds between two observation times, signed (positive: `later` is after `earlier`); `undefined` when either is not a date. */
function secondsBetween(earlier: string, later: string): number | undefined {
  const a = Date.parse(earlier)
  const b = Date.parse(later)
  return Number.isNaN(a) || Number.isNaN(b) ? undefined : Math.round((b - a) / 1_000)
}

/**
 * What the join with the sessions rests on: which read it is, how old, and
 * how far its moment is from the lock graph's. A read that failed or is still
 * running is said as that; the tree does not wait for it.
 */
function SessionJoinNote(props: {
  readonly sessions: Readable<SessionList>
  readonly graphObservedAt: string
}): ReactNode {
  const { sessions } = props
  if (sessions.state === 'loading') {
    return (
      <p className="text-xs text-foreground-light" data-slot="join" data-join="loading">
        {t('locks.join.loading')}
      </p>
    )
  }
  if (sessions.state === 'failed') {
    return (
      <p className="text-xs text-foreground-light" data-slot="join" data-join="failed">
        {t('locks.join.failed', {
          reason: t('error.withCode', {
            message: sessions.error.message,
            code: sessions.error.code,
          }),
        })}
      </p>
    )
  }
  const skew = secondsBetween(props.graphObservedAt, sessions.value.observedAt)
  return (
    <div
      className="flex flex-col gap-0.5 text-xs text-foreground-light"
      data-slot="join"
      data-join={sessions.state}
    >
      <p>
        {t('locks.join.asOf')} <ObservedTime observedAt={sessions.observedAt} seconds />
        {sessions.state === 'stale' ? ` (${nounPhrase('locks.join.stale')})` : null}.{' '}
        {t('locks.join.caveat')}
      </p>
      {skew === undefined || skew === 0 ? null : (
        <p>
          {skew > 0
            ? t('locks.join.skew.after', { seconds: skew })
            : t('locks.join.skew.before', { seconds: -skew })}
        </p>
      )}
      {sessions.value.truncated ? <p>{t('locks.join.cut', { cap: sessions.value.cap })}</p> : null}
    </div>
  )
}

function TreeView(props: {
  readonly tree: BlockingTree
  readonly observedAt: string
  readonly join: Join
}): ReactNode {
  const { tree, observedAt, join } = props
  return (
    <div className="flex flex-col gap-3">
      <ul aria-label={t('locks.tree.caption')} className="flex flex-col gap-2 text-sm">
        {tree.roots.map((node) => (
          <TreeItem key={node.pid} node={node} observedAt={observedAt} join={join} />
        ))}
      </ul>
      {tree.cycles.length === 0 ? null : (
        <div data-lock-cycle="" className="flex flex-col gap-1">
          <p className="text-sm text-foreground-light">{t('locks.tree.cycle')}</p>
          <ul className="flex flex-col gap-2 text-sm">
            {tree.cycles.map((node) => (
              <TreeItem key={node.pid} node={node} observedAt={observedAt} join={join} />
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function TreeItem(props: {
  readonly node: TreeNode
  readonly observedAt: string
  readonly join: Join
}): ReactNode {
  const { node, observedAt, join } = props
  const wait = node.wait
  const line =
    wait === undefined
      ? t('locks.tree.root', { pid: node.pid })
      : waitSentence(node.pid, formatWait(waitMillis(wait, observedAt)), wait.waitingSince !== null)
  const blocks = wait === undefined || node.children.length > 0
  return (
    <li data-pid={node.pid} className="rounded-md border border-default px-3 py-2">
      <span>{line}</span>
      {wait === undefined ? null : (
        <span className="text-foreground-light">
          {' '}
          (<UntrustedName name={wait.lockMode} mono label={t('locks.column.mode')} />
          {wait.relation === null ? null : (
            <>
              {', '}
              <UntrustedName name={wait.relation} mono label={t('locks.column.relation')} />
            </>
          )}
          )
        </span>
      )}
      {node.alsoBlockedBy.length === 0 ? null : (
        <span className="block text-xs text-foreground-light">
          {t('locks.tree.alsoBlockedBy', { pids: node.alsoBlockedBy.join(', ') })}
        </span>
      )}
      {blocks ? <BlockerDetails pid={node.pid} join={join} /> : null}
      {node.children.length === 0 ? null : (
        <ul className="mt-2 flex flex-col gap-2 border-l border-default pl-4">
          {node.children.map((child) => (
            <TreeItem key={child.pid} node={child} observedAt={observedAt} join={join} />
          ))}
        </ul>
      )}
    </li>
  )
}

/** What the session of a blocker is doing, in words: its state and for how long it has been in it. */
function stateSentence(session: Session): ReactNode {
  const kind = stateOf(session)
  const age = kind === 'active' || kind === 'waiting' ? session.queryAgeMs : session.stateAgeMs
  if (kind === 'other') {
    return <UntrustedName name={session.state} mono label={t('locks.join.state')} />
  }
  if (age === null) {
    return t('locks.join.stateUnknownAge', { state: stateLabel(kind) })
  }
  const duration = formatDuration(age)
  switch (kind) {
    case 'idle_in_transaction':
      return t('locks.join.idleFor', { duration })
    case 'idle_in_transaction_aborted':
      return t('locks.join.idleAbortedFor', { duration })
    case 'active':
      return t('locks.join.activeFor', { duration })
    case 'waiting':
      return t('locks.join.waitingFor', { duration })
    default:
      return t('locks.join.stateFor', { state: stateLabel(kind), duration })
  }
}

/**
 * The session behind a blocking process, from the sessions read. Shown only
 * when that read has produced sessions; a process the read does not list is
 * said to be missing (it may have ended, or the list was cut), never filled
 * in from anything else.
 */
function BlockerDetails(props: { readonly pid: number; readonly join: Join }): ReactNode {
  const { byPid } = props.join
  if (byPid === undefined) return null
  const session = byPid.get(props.pid)
  if (session === undefined) {
    return (
      <p className="mt-1 text-xs text-foreground-light" data-slot="blocker-missing">
        {t('locks.join.notListed')}
      </p>
    )
  }
  return (
    <div
      className="mt-2 flex flex-col gap-1 text-xs text-foreground-light"
      data-slot="blocker-details"
    >
      <p data-slot="blocker-state">{stateSentence(session)}</p>
      <p className="flex flex-wrap gap-x-4 gap-y-0.5">
        <span>
          {t('locks.join.role')}:{' '}
          <UntrustedName name={session.role} mono label={t('locks.join.role')} />
        </span>
        <span>
          {t('locks.join.application')}:{' '}
          {session.applicationName === '' ? (
            t('connections.group.noApplication')
          ) : (
            <UntrustedName
              name={session.applicationName}
              mono
              label={t('locks.join.application')}
            />
          )}
        </span>
        <span>
          {t('locks.join.started')} <ObservedTime observedAt={session.backendStart} withDate />
        </span>
      </p>
      {session.statement === null ? (
        <p>{t('locks.join.noStatement')}</p>
      ) : (
        <UntrustedText
          text={session.statement.redacted}
          mono
          maxCodePoints={BLOCKER_STATEMENT_CODE_POINTS}
          maxLines={BLOCKER_STATEMENT_LINES}
          label={t('locks.join.statementLabel')}
        />
      )}
    </div>
  )
}

function waitSentence(pid: number, wait: string, known: boolean): string {
  return known ? t('locks.tree.waiting', { pid, wait }) : t('locks.tree.waitingUnknown', { pid })
}
