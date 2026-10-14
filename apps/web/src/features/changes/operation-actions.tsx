import type { OperationRead } from '@exponetdb/sdk/operations'
import { Button } from '@exponetdb/ui'
import {
  ConfirmDialog,
  PlanConfirmDialog,
  type PlanConfirmFacts,
  TypedConfirmDialog,
} from '@exponetdb/ui-patterns'
import { useQueryClient } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useApi } from '../../lib/api/context.tsx'
import { withReauth } from '../../lib/api/reauth.ts'
import { t } from '../../lib/i18n/i18n.ts'
import type { PageMessage } from '../plans/decision-actions.tsx'
import { actionError } from '../plans/failure.ts'
import { operationKeys } from '../plans/keys.ts'
import { nounPhrase } from '../target/phrases.ts'
import { CANCELABLE_STATES, verifyAgainRung } from './model.ts'

/**
 * The actions of an operation: "Verify again" and cancel. Each goes through a
 * dialog of the confirmation ladder and `withReauth`; a dialog's action runs
 * once while it is pending, so a double press sends one request. Whether the
 * action is allowed is the server's answer; a refusal shows in the dialog with
 * its catalog text and stable code.
 */
function useRefreshOperation(operationId: string): () => Promise<void> {
  const queryClient = useQueryClient()
  return async () => {
    await queryClient.invalidateQueries({ queryKey: operationKeys.all })
    await queryClient.invalidateQueries({ queryKey: operationKeys.detail(operationId) })
  }
}

export interface VerifyAgainActionProps {
  readonly operation: OperationRead
  /** The confirmation facts of the plan that made the change, when it was read. */
  readonly planFacts: PlanConfirmFacts | undefined
  readonly onMessage: PageMessage
}

/**
 * "Verify again" (`POST /operations/{id}/retry-verification`): offered by the
 * caller only when the server says `retryable: true` on a fresh reading. The
 * change is never run again; only its verification. Production uses the plan
 * confirmation (`verifyAgainRung`).
 */
export function VerifyAgainAction({
  operation,
  planFacts,
  onMessage,
}: VerifyAgainActionProps): ReactNode {
  const { client, confirmIdentity } = useApi()
  const refresh = useRefreshOperation(operation.id)
  const rung = verifyAgainRung(operation, planFacts)
  const run = async (): Promise<void> => {
    try {
      await withReauth(client, confirmIdentity, () =>
        client.operation('retryOperationVerification', {
          params: { operationId: operation.id },
          body: {},
        }),
      )
    } catch (error) {
      throw actionError(error)
    }
    onMessage('status', t('plans.verifyAgain.done', { id: operation.id }))
    void refresh()
  }
  const trigger = (
    <Button type="button" variant="default" size="small" data-action="verify-again">
      {t('changes.verifyAgain.button')}
    </Button>
  )
  const common = {
    trigger,
    title: t('changes.verifyAgain.title'),
    description: t('changes.verifyAgain.description'),
    actionLabel: t('changes.verifyAgain.action'),
  }
  if (rung.kind === 'plan') {
    return <PlanConfirmDialog {...common} plan={rung.facts} onConfirm={run} />
  }
  if (rung.kind === 'typed') {
    return (
      <TypedConfirmDialog
        {...common}
        tier="prod"
        expectedText={rung.targetPath}
        expectedTextName={nounPhrase('changes.confirm.targetPath')}
        resetKey={operation.id}
        onConfirm={run}
      />
    )
  }
  return <ConfirmDialog {...common} tier="nonprod" onConfirm={run} />
}

/** Whether the page offers cancel: only before the operation started, as the server allows. */
export function cancelOffered(operation: OperationRead): boolean {
  return CANCELABLE_STATES.has(operation.state)
}

/**
 * Cancel (`POST /operations/{id}/cancel`) of an operation that has not
 * started. Only the actor that applied the plan may cancel it; the server
 * says so with `PLAN_BINDING_ACTOR` otherwise.
 */
export function CancelOperationAction({
  operation,
  onMessage,
}: {
  readonly operation: OperationRead
  readonly onMessage: PageMessage
}): ReactNode {
  const { client, confirmIdentity } = useApi()
  const refresh = useRefreshOperation(operation.id)
  const run = async (): Promise<void> => {
    try {
      await withReauth(client, confirmIdentity, () =>
        client.operation('cancelOperation', { params: { operationId: operation.id }, body: {} }),
      )
    } catch (error) {
      throw actionError(error)
    }
    onMessage('status', t('changes.cancel.done', { id: operation.id }))
    void refresh()
  }
  return (
    <ConfirmDialog
      trigger={
        <Button type="button" variant="default" size="small" data-action="cancel">
          {t('changes.cancel.button')}
        </Button>
      }
      title={t('changes.cancel.title')}
      description={t('changes.cancel.description')}
      actionLabel={t('changes.cancel.action')}
      destructive
      tier={operation.subject.tier === 'nonprod' ? 'nonprod' : 'prod'}
      onConfirm={run}
    />
  )
}
