import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@exponetdb/ui'
import { UntrustedName, UntrustedText } from '@exponetdb/ui-patterns'
import type { ReactNode } from 'react'
import { t } from '../../lib/i18n/i18n.ts'
import { Observation } from './live-read.tsx'
import {
  blockingFacts,
  countByState,
  formatDuration,
  groupSessions,
  type LockGraph,
  type Session,
  type SessionList,
  stateLabel,
  stateOf,
} from './model.ts'
import { RawStatementButton } from './raw-statement.tsx'

/** Statements in a session row are cut short; the full redacted text is one "Show all" away. */
const ROW_STATEMENT_CODE_POINTS = 300
const ROW_STATEMENT_LINES = 3

/**
 * Sessions grouped by role and application, each with its state, how long it
 * has been in it (an idle-in-transaction session shows how long its
 * transaction has been open), what it waits for, its redacted statement and
 * the "View raw statement" action for a statement the server gave a digest
 * for. There is no cancel or terminate control here: both arrive as planned
 * operations in Wave 9 and the page says so.
 */
export function SessionsView(props: {
  readonly list: SessionList
  readonly locks: LockGraph | undefined
  readonly targetPath: string
}): ReactNode {
  const { list } = props
  const groups = groupSessions(list.sessions)
  const counts = countByState(list.sessions)
  return (
    <div className="flex flex-col gap-4">
      <Observation source={list.source} observedAt={list.observedAt} />
      <ul aria-label={t('connections.sessions.summary')} className="flex flex-wrap gap-2 text-sm">
        {counts.map(({ kind, count }) => (
          <li
            key={kind}
            data-state-count={kind}
            className="rounded-md border border-default px-2 py-1"
          >
            {t('connections.sessions.count', { count, state: stateLabel(kind).toLowerCase() })}
          </li>
        ))}
      </ul>
      {groups.map((group) => (
        <div
          key={group.role}
          className="flex flex-col gap-3 rounded-lg border border-default p-4"
          data-role-group=""
        >
          <h3 className="text-sm font-medium text-foreground">
            <span className="text-foreground-light">{t('connections.group.role')}: </span>
            <UntrustedName name={group.role} mono label={t('connections.group.role')} />
          </h3>
          {group.applications.map((application) => (
            <ApplicationTable
              key={application.application}
              role={group.role}
              application={application.application}
              sessions={application.sessions}
              locks={props.locks}
              targetPath={props.targetPath}
            />
          ))}
        </div>
      ))}
    </div>
  )
}

function ApplicationTable(props: {
  readonly role: string
  readonly application: string
  readonly sessions: readonly Session[]
  readonly locks: LockGraph | undefined
  readonly targetPath: string
}): ReactNode {
  return (
    <div className="flex flex-col gap-2" data-application-group="">
      <h4 className="text-xs font-medium text-foreground-light">
        {t('connections.group.application')}:{' '}
        {props.application === '' ? (
          t('connections.group.noApplication')
        ) : (
          <UntrustedName name={props.application} mono label={t('connections.group.application')} />
        )}
      </h4>
      <Table>
        <TableCaption className="sr-only">
          {t('connections.sessions.caption.application')}{' '}
          {props.application === '' ? (
            t('connections.group.noApplication')
          ) : (
            <UntrustedName name={props.application} label={t('connections.group.application')} />
          )}{' '}
          {t('connections.sessions.caption.role')}{' '}
          <UntrustedName name={props.role} label={t('connections.group.role')} />
        </TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">{t('connections.column.pid')}</TableHead>
            <TableHead scope="col">{t('connections.column.state')}</TableHead>
            <TableHead scope="col">{t('connections.column.timing')}</TableHead>
            <TableHead scope="col">{t('connections.column.wait')}</TableHead>
            <TableHead scope="col">{t('connections.column.statement')}</TableHead>
            <TableHead scope="col">{t('connections.column.operation')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {props.sessions.map((session) => (
            <SessionRow
              key={`${session.pid}:${session.backendStart}`}
              session={session}
              locks={props.locks}
              targetPath={props.targetPath}
            />
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

function SessionRow(props: {
  readonly session: Session
  readonly locks: LockGraph | undefined
  readonly targetPath: string
}): ReactNode {
  const { session } = props
  const kind = stateOf(session)
  const facts = blockingFacts(props.locks, session.pid)
  const statement = session.statement
  return (
    <TableRow data-pid={session.pid} data-state-kind={kind}>
      <TableCell className="font-mono text-xs">{session.pid}</TableCell>
      <TableCell>
        <span className="font-medium">{stateLabel(kind)}</span>
        {kind === 'other' ? (
          <>
            {' '}
            <UntrustedName name={session.state} mono label={t('connections.column.state')} />
          </>
        ) : null}
        {facts.blockedBy.length === 0 ? null : (
          <p className="text-xs text-foreground-light">
            {t('connections.blocking.blockedBy', { pids: facts.blockedBy.join(', ') })}
          </p>
        )}
        {facts.blocks === 0 ? null : (
          <p className="text-xs text-foreground-light">
            {t('connections.blocking.blocks', { count: facts.blocks })}
          </p>
        )}
      </TableCell>
      <TableCell className="text-xs">
        <Timing session={session} />
      </TableCell>
      <TableCell className="text-xs">
        {session.waitEvent === null ? (
          t('connections.wait.none')
        ) : (
          <UntrustedName
            name={t('connections.wait.event', {
              type: session.waitEvent.type,
              event: session.waitEvent.event,
            })}
            mono
            label={t('connections.column.wait')}
          />
        )}
      </TableCell>
      <TableCell className="min-w-64">
        {statement === null ? (
          <span className="text-xs text-foreground-light">{t('connections.statement.none')}</span>
        ) : (
          <div className="flex flex-col gap-1">
            <UntrustedText
              text={statement.redacted}
              mono
              maxCodePoints={ROW_STATEMENT_CODE_POINTS}
              maxLines={ROW_STATEMENT_LINES}
              label={t('connections.statement.label')}
            />
            {statement.truncated ? (
              <span className="text-xs text-foreground-light">
                {t('connections.statement.truncated')}
              </span>
            ) : null}
            {statement.digest === null ? null : (
              <RawStatementButton
                targetPath={props.targetPath}
                digest={statement.digest}
                pid={session.pid}
                backendStart={session.backendStart}
              />
            )}
          </div>
        )}
      </TableCell>
      <TableCell className="text-xs">
        {session.exponetdbOperationId === null ? (
          t('connections.operation.none')
        ) : (
          <UntrustedName
            name={session.exponetdbOperationId}
            mono
            label={t('connections.column.operation')}
          />
        )}
      </TableCell>
    </TableRow>
  )
}

function Timing({ session }: { readonly session: Session }): ReactNode {
  const lines: string[] = []
  if (session.stateAgeMs !== null) {
    lines.push(t('connections.timing.inState', { duration: formatDuration(session.stateAgeMs) }))
  }
  if (session.transactionAgeMs !== null) {
    lines.push(
      t('connections.timing.transaction', { duration: formatDuration(session.transactionAgeMs) }),
    )
  }
  if (session.queryAgeMs !== null && stateOf(session) === 'active') {
    lines.push(t('connections.timing.query', { duration: formatDuration(session.queryAgeMs) }))
  }
  if (lines.length === 0) return <span>{t('connections.timing.unknown')}</span>
  return (
    <>
      {lines.map((line) => (
        <p key={line}>{line}</p>
      ))}
    </>
  )
}
