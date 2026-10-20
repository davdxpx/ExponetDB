import type { PlanRead, PlanView } from '@exponetdb/sdk/operations'
import { Button } from '@exponetdb/ui'
import { ConfirmDialog, MarkedCode } from '@exponetdb/ui-patterns'
import { useQueryClient } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useApi } from '../../lib/api/context.tsx'
import { withReauth } from '../../lib/api/reauth.ts'
import { t } from '../../lib/i18n/i18n.ts'
import type { PageMessage } from './decision-actions.tsx'
import { actionError } from './failure.ts'
import { planKeys } from './keys.ts'
import { subjectTextOf } from './plan-model.ts'

/**
 * Whether the page offers "Withdraw plan": the contract withdraws an own
 * active plan (`POST /plans/{id}/withdraw`), so the button is shown on an
 * active plan the signed-in person created. The server still decides: it
 * binds the withdrawal to the plan's identity and client (a plan an agent
 * made through MCP is withdrawn by that client), and a refusal is shown in
 * the dialog with its catalog text and code.
 */
export function canOfferWithdraw(
  plan: Pick<PlanView, 'state' | 'actor'>,
  identityId: string,
): boolean {
  return plan.state === 'active' && plan.actor.identityId === identityId
}

/**
 * "Withdraw plan": a confirmation that names the plan and its subject, then
 * the request with re-authentication when the server asks for it. Nothing
 * runs on the target; the plan can no longer be applied. Cancel sends
 * nothing. After the server's answer the page shows the withdrawn plan.
 */
export function WithdrawAction({
  plan,
  onMessage,
}: {
  readonly plan: PlanView
  readonly onMessage: PageMessage
}): ReactNode {
  const { client, confirmIdentity } = useApi()
  const queryClient = useQueryClient()
  const withdraw = async (): Promise<void> => {
    try {
      const after = await withReauth(client, confirmIdentity, () =>
        client.operation('withdrawPlan', { params: { planId: plan.id }, body: {} }),
      )
      // The answer is the withdrawn plan: the page shows it at once, then reads it again.
      queryClient.setQueryData<PlanRead>(planKeys.detail(plan.id), (old) =>
        old === undefined ? old : { ...old, ...after },
      )
      onMessage('status', t('plans.withdraw.done'))
    } catch (error) {
      throw actionError(error)
    }
    void queryClient.invalidateQueries({ queryKey: planKeys.all })
  }
  return (
    <ConfirmDialog
      trigger={
        <Button variant="default" size="small" data-withdraw-plan={plan.id}>
          {t('plans.withdraw.button')}
        </Button>
      }
      title={t('plans.withdraw.title')}
      description={
        <span className="flex flex-col gap-2">
          <span>{t('plans.withdraw.description')}</span>
          <MarkedCode text={subjectTextOf(plan)} />
        </span>
      }
      actionLabel={t('plans.withdraw.action')}
      destructive
      tier={plan.subject.tier === 'nonprod' ? 'nonprod' : 'prod'}
      onConfirm={withdraw}
    >
      <p className="m-0 py-2 text-xs text-foreground-light">{t('plans.withdraw.binding')}</p>
    </ConfirmDialog>
  )
}
