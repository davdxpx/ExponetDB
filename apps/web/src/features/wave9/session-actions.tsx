import type { Operation } from '@exponetdb/sdk/operations'
import { Label, Textarea } from '@exponetdb/ui'
import { ConfirmDialog, UntrustedName } from '@exponetdb/ui-patterns'
import { useQueryClient } from '@tanstack/react-query'
import { type ReactNode, useId, useState } from 'react'
import type { ResponseOf } from '../../lib/api/client.ts'
import { useApi } from '../../lib/api/context.tsx'
import { t } from '../../lib/i18n/i18n.ts'
import { nounPhrase } from '../target/phrases.ts'
import { useGuardedPlan } from '../targets/plan-request.ts'
import { FormDialog } from './form-dialog.tsx'
import { ActionButton, SelectField, StartedNotice, useHolds, useInlineOperation } from './parts.tsx'

type Session = ResponseOf<'listSessions'>['sessions'][number]

const CONDITIONS = ['stalled', 'idle_in_transaction', 'long_running', 'any'] as const
type Condition = (typeof CONDITIONS)[number]
const CONDITION_KEYS = {
  stalled: 'wave9.session.condition.stalled',
  idle_in_transaction: 'wave9.session.condition.idle',
  long_running: 'wave9.session.condition.long',
  any: 'wave9.session.condition.any',
} as const
const KNOWN_STATES = new Set([
  'active',
  'idle',
  'idle in transaction',
  'idle in transaction (aborted)',
  'fastpath function call',
  'disabled',
])

function defaultCondition(session: Session): Condition {
  if (session.state.startsWith('idle in transaction')) return 'idle_in_transaction'
  if (session.state === 'active') return 'long_running'
  return 'any'
}

/**
 * Cancel and terminate on the Connections page (performance.md §5). One
 * session of the list the page shows is picked (by its process id, never by
 * text), then:
 *
 * - "Cancel query" is an inline operation bound to the process, its backend
 *   start and the start of the query the person saw: it acts only while that
 *   same query runs, and the answer is an operation that started;
 * - "Terminate session" is a plan bound to the process and its backend start,
 *   with the condition that must still hold, re-checked in the terminating
 *   statement; its review page shows who must approve it.
 *
 * ExponetDB's own sessions, replication and backup sessions are refused by
 * the server; the page offers neither action for a session ExponetDB marks
 * as its own. Both need `connections.operate`.
 */
export function SessionActions(props: {
  readonly sessions: readonly Session[]
  readonly targetPath: string
  readonly tier: 'prod' | 'nonprod'
}): ReactNode {
  const { client } = useApi()
  const holds = useHolds()
  const start = useInlineOperation()
  const createPlan = useGuardedPlan()
  const queryClient = useQueryClient()
  const id = useId()
  const [pid, setPid] = useState<string>('')
  const [cancelOpen, setCancelOpen] = useState(false)
  const [terminateOpen, setTerminateOpen] = useState(false)
  const [condition, setCondition] = useState<Condition | undefined>(undefined)
  const [reason, setReason] = useState('')
  const [started, setStarted] = useState<Operation | undefined>(undefined)
  const session = props.sessions.find((s) => String(s.pid) === pid) ?? props.sessions[0]
  const permitted = holds('connections.operate')
  if (session === undefined) {
    return (
      <p className="m-0 text-sm text-foreground-light" data-slot="session-actions">
        {t('wave9.session.none')}
      </p>
    )
  }
  const own = session.exponetdbOperationId !== null
  const notPermitted = permitted
    ? undefined
    : t('wave9.action.notPermitted', { permission: 'connections.operate' })
  const cancelReason =
    notPermitted ??
    (own
      ? t('wave9.session.own')
      : session.state !== 'active' || session.queryStart === null
        ? t('wave9.session.noQuery')
        : undefined)
  const terminateReason = notPermitted ?? (own ? t('wave9.session.own') : undefined)
  const chosen = condition ?? defaultCondition(session)
  const stateWord = KNOWN_STATES.has(session.state)
    ? session.state
    : nounPhrase('wave9.session.otherState')
  const refreshSessions = () =>
    void queryClient.invalidateQueries({ queryKey: ['diagnostics', 'sessions', props.targetPath] })
  return (
    <section
      aria-labelledby={`${id}-title`}
      className="flex flex-col gap-3 rounded-lg border border-default p-4"
      data-slot="session-actions"
    >
      <h3 id={`${id}-title`} className="m-0 text-sm font-medium">
        {t('wave9.session.title')}
      </h3>
      <p className="m-0 text-xs text-foreground-light">{t('wave9.session.description')}</p>
      <div className="flex flex-wrap items-end gap-4">
        <SelectField
          label={t('wave9.session.pick')}
          value={String(session.pid)}
          options={props.sessions.map((s) => ({
            value: String(s.pid),
            label: t('wave9.session.option', {
              pid: s.pid,
              state: KNOWN_STATES.has(s.state) ? s.state : nounPhrase('wave9.session.otherState'),
            }),
          }))}
          onChange={(value) => {
            setPid(value)
            setCondition(undefined)
            setStarted(undefined)
          }}
        />
        <p className="m-0 text-xs text-foreground-light" data-picked={String(session.pid)}>
          {t('wave9.session.picked', { pid: session.pid, state: stateWord })}{' '}
          <UntrustedName name={session.role} mono label={t('connections.group.role')} />{' '}
          <UntrustedName name={session.applicationName} mono />
        </p>
      </div>
      <div className="flex flex-wrap items-start gap-4">
        <ActionButton
          label={t('wave9.session.cancel')}
          disabledReason={cancelReason}
          onClick={() => setCancelOpen(true)}
          data-action="cancel-query"
        />
        <ActionButton
          label={t('wave9.session.terminate')}
          disabledReason={terminateReason}
          onClick={() => setTerminateOpen(true)}
          destructive
          data-action="terminate-session"
        />
      </div>
      <StartedNotice operation={started} message={t('wave9.session.cancelStarted')} />
      <ConfirmDialog
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        title={t('wave9.session.cancel.title', { pid: session.pid })}
        description={t('wave9.session.cancel.body')}
        actionLabel={t('wave9.session.cancel.action')}
        tier={props.tier}
        onConfirm={async () => {
          if (session.queryStart === null) return
          const queryStart = session.queryStart
          const operation = await start(() =>
            client.operation('cancelSessionQuery', {
              params: { target: props.targetPath, pid: session.pid },
              body: { backendStart: session.backendStart, queryStart },
            }),
          )
          setStarted(operation)
          refreshSessions()
        }}
      />
      <FormDialog
        open={terminateOpen}
        onOpenChange={setTerminateOpen}
        title={t('wave9.session.terminate.title', { pid: session.pid })}
        description={t('wave9.session.terminate.body')}
        submitLabel={t('wave9.session.terminate.submit')}
        destructive
        onSubmit={() =>
          createPlan(() =>
            client.operation('planSessionTermination', {
              params: { target: props.targetPath, pid: session.pid },
              body: {
                backendStart: session.backendStart,
                condition: chosen,
                ...(reason.trim() === '' ? {} : { reason: reason.trim() }),
              },
            }),
          )
        }
      >
        <SelectField
          label={t('wave9.session.condition')}
          value={chosen}
          options={CONDITIONS.map((value) => ({ value, label: t(CONDITION_KEYS[value]) }))}
          onChange={setCondition}
        />
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-reason`}>{t('wave9.session.reason')}</Label>
          <Textarea
            id={`${id}-reason`}
            rows={2}
            maxLength={500}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
          <p className="m-0 text-xs text-foreground-lighter">{t('audit.reason.warning')}</p>
        </div>
      </FormDialog>
    </section>
  )
}
