import type { PlanView } from '@exponetdb/sdk/operations'
import { Button } from '@exponetdb/ui'
import type { ApprovalBinding } from '@exponetdb/ui-data'
import { ConfirmDialog, formatUtc, PlanConfirmDialog } from '@exponetdb/ui-patterns'
import { useQueryClient } from '@tanstack/react-query'
import { type ReactNode, useId } from 'react'
import { useApi } from '../../lib/api/context.tsx'
import { withReauth } from '../../lib/api/reauth.ts'
import { t } from '../../lib/i18n/i18n.ts'
import { actionError } from './failure.ts'
import { approvalKeys, operationKeys, planKeys } from './keys.ts'
import { confirmFactsOf } from './plan-model.ts'

/**
 * The actions of the plan review page. Every one goes through a dialog of
 * the confirmation ladder that shows the plan hash the request then sends,
 * exactly as the page showed it (`PlanBinding`), and through `withReauth`:
 * when the server answers `REAUTH_REQUIRED` the person confirms with a
 * passkey or an authenticator code and the action runs once more. Whether
 * the action is allowed is the server's answer; a refusal is shown in the
 * dialog with its catalog text and stable code.
 */
export type PageMessage = (kind: 'status' | 'alert', text: string) => void

/** Reads the plan, the queue and the operations again after an action. */
function useRefresh(planId: string): () => Promise<void> {
  const queryClient = useQueryClient()
  return async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: planKeys.detail(planId) }),
      queryClient.invalidateQueries({ queryKey: approvalKeys.queue() }),
      queryClient.invalidateQueries({ queryKey: operationKeys.all }),
    ])
  }
}

function later(a: string, b: string): boolean {
  const left = Date.parse(a)
  const right = Date.parse(b)
  return !Number.isNaN(left) && !Number.isNaN(right) && left > right
}

export interface DecisionActionsProps {
  /** What the approvals block hands over: the plan hash it shows and the acknowledgement. */
  readonly binding: ApprovalBinding
  readonly plan: PlanView
  /** The server says approving is a self-approval (`ApprovalQueueItem.ownPlan`). */
  readonly selfApproval: boolean
  /**
   * The person's own critical self-approval that waits for its cooling period:
   * the plan is applied again by its actor from `notBefore`, with a fresh proof.
   */
  readonly release: { readonly notBefore: string } | undefined
  readonly onMessage: PageMessage
}

/** Approve and reject (and the release of a cooled-down self-approval) for an eligible person. */
export function DecisionActions({
  binding,
  plan,
  selfApproval,
  release,
  onMessage,
}: DecisionActionsProps): ReactNode {
  const { client, confirmIdentity } = useApi()
  const refresh = useRefresh(plan.id)
  const reasonId = useId()
  // The facts the dialogs show: the hash exactly as the approvals block showed it.
  const facts = { ...confirmFactsOf(plan), planHash: binding.planHash }
  const blocked = selfApproval && !binding.acknowledgedSelfApproval

  const approve = async (planHash: string): Promise<void> => {
    try {
      const approval = await withReauth(client, confirmIdentity, () =>
        client.operation('approveOperation', {
          params: { operationId: binding.operationId },
          body: {
            planHash,
            ...(selfApproval && binding.acknowledgedSelfApproval
              ? { acknowledgeSelfApproval: true as const }
              : {}),
          },
        }),
      )
      onMessage(
        'status',
        later(approval.notBefore, approval.decidedAt)
          ? t('plans.approve.doneCooling', {
              time: formatUtc(approval.notBefore) ?? approval.notBefore,
            })
          : t('plans.approve.done'),
      )
    } catch (error) {
      throw actionError(error)
    }
    // The dialog closes now; the page reads the plan, the queue and the operation again.
    void refresh()
  }

  const reject = async (): Promise<void> => {
    try {
      await withReauth(client, confirmIdentity, () =>
        client.operation('rejectOperation', {
          params: { operationId: binding.operationId },
          body: { planHash: binding.planHash },
        }),
      )
      onMessage('status', t('plans.reject.done'))
    } catch (error) {
      throw actionError(error)
    }
    // The dialog closes now; the page reads the plan, the queue and the operation again.
    void refresh()
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <PlanConfirmDialog
          trigger={
            <Button
              variant="primary"
              size="small"
              // The class the browser suites select the decision by (order Appendix C).
              className="primary"
              disabled={blocked}
              focusableWhenDisabled
              aria-describedby={blocked ? reasonId : undefined}
            >
              {t('plans.approve.button')}
            </Button>
          }
          title={t('plans.approve.title')}
          description={t('plans.approve.description')}
          actionLabel={t('plans.approve.action')}
          plan={facts}
          onConfirm={(shown) => approve(shown.planHash)}
        />
        <ConfirmDialog
          trigger={
            <Button variant="default" size="small">
              {t('plans.reject.button')}
            </Button>
          }
          title={t('plans.reject.title')}
          description={t('plans.reject.description')}
          actionLabel={t('plans.reject.action')}
          destructive
          tier={facts.tier}
          onConfirm={reject}
        />
      </div>
      {blocked ? (
        <p id={reasonId} className="text-sm text-foreground-light">
          {t('plans.approve.acknowledgeFirst')}
        </p>
      ) : null}
      {release === undefined ? null : (
        <div className="flex flex-col items-start gap-2 text-sm">
          <p>
            {t('plans.release.hint', {
              time: formatUtc(release.notBefore) ?? release.notBefore,
            })}
          </p>
          <ApplyAction plan={plan} planHash={binding.planHash} onMessage={onMessage} />
        </div>
      )}
    </div>
  )
}

export interface ApplyActionProps {
  readonly plan: PlanView
  /** The plan hash the page shows next to the action. */
  readonly planHash: string
  readonly onMessage: PageMessage
  readonly variant?: 'primary' | 'default'
}

/**
 * Applies the plan (`POST /plans/{id}/apply`): the first apply of an active
 * plan, or the actor's release of a cooled-down critical self-approval. The
 * plan confirmation asks for the typed target path for `high` and `critical`
 * plans and the typed effect for `critical` ones.
 */
export function ApplyAction({
  plan,
  planHash,
  onMessage,
  variant = 'default',
}: ApplyActionProps): ReactNode {
  const { client, confirmIdentity } = useApi()
  const refresh = useRefresh(plan.id)
  const apply = async (): Promise<void> => {
    try {
      const operation = await withReauth(client, confirmIdentity, () =>
        client.operation('applyPlan', { params: { planId: plan.id }, body: {} }),
      )
      onMessage(
        'status',
        t('plans.apply.done', { id: operation.id, state: operation.state.replaceAll('_', ' ') }),
      )
    } catch (error) {
      throw actionError(error)
    }
    // The dialog closes now; the page reads the plan, the queue and the operation again.
    void refresh()
  }
  return (
    <PlanConfirmDialog
      trigger={
        <Button variant={variant} size="small">
          {t('plans.apply.button')}
        </Button>
      }
      title={t('plans.apply.title')}
      description={t('plans.apply.description')}
      actionLabel={t('plans.apply.action')}
      plan={{ ...confirmFactsOf(plan), planHash }}
      onConfirm={apply}
    />
  )
}
