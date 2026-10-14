import { Button, Textarea } from '@exponetdb/ui'
import { Admonition, ConfirmDialog, useNavigate } from '@exponetdb/ui-patterns'
import { type ReactNode, useId, useState } from 'react'
import { useApi } from '../../lib/api/context.tsx'
import { ApiError } from '../../lib/api/errors.ts'
import { withReauth } from '../../lib/api/reauth.ts'
import { t } from '../../lib/i18n/i18n.ts'
import { actionError } from '../plans/failure.ts'
import { planPath } from '../plans/plan-model.ts'
import { isFindingId } from '../target-ops/ids.ts'

/** The reason of a drift acceptance: 10 to 1,000 characters (`DriftAcceptRequest`). */
export const REASON_MIN_LENGTH = 10
export const REASON_MAX_LENGTH = 1000

/** Whether the server's refusal is the one that asks for a reason (`/reason`, `reason_required`). */
export function isReasonRequired(error: unknown): boolean {
  if (!(error instanceof ApiError) || error.code !== 'VALIDATION_FAILED') return false
  const details = error.details
  if (typeof details !== 'object' || details === null || !('errors' in details)) return false
  const errors = (details as { readonly errors: unknown }).errors
  return (
    Array.isArray(errors) &&
    errors.some(
      (entry: unknown) =>
        typeof entry === 'object' &&
        entry !== null &&
        (entry as { readonly code?: unknown }).code === 'reason_required',
    )
  )
}

export interface AcceptDriftProps {
  /** An open drift finding of the target (`fnd_…`); the plan covers every open drift finding of the target. */
  readonly findingId: string
  /** How many open drift findings the plan will resolve, when the page knows. */
  readonly covered?: number
  /** The finding the person clicked is critical or security-relevant: a reason is expected. */
  readonly reasonExpected?: boolean
  /** The tier of the target: production gets the production frame in the dialog. */
  readonly tier: 'prod' | 'nonprod'
}

/**
 * "Accept drift" (`POST /findings/{finding}/accept`): adopts the target's
 * current complete schema as its baseline and resolves its open drift
 * findings as accepted, without DDL. It only creates a plan; the plan is
 * reviewed, approved and applied on its own page, so nothing changes here.
 * The reason is optional unless a covered finding is critical or
 * security-relevant: then the server answers `422` (`reason_required`) and
 * the dialog says so and stays open. The reason is stored in the audit log
 * and cannot be removed.
 */
export function AcceptDrift({
  findingId,
  covered,
  reasonExpected = false,
  tier,
}: AcceptDriftProps): ReactNode {
  const { client, confirmIdentity } = useApi()
  const navigate = useNavigate()
  const [reason, setReason] = useState('')
  const reasonId = useId()
  const hintId = useId()
  if (!isFindingId(findingId)) return null
  const trimmed = reason.trim()
  const tooShort = trimmed.length > 0 && trimmed.length < REASON_MIN_LENGTH

  const accept = async (): Promise<void> => {
    if (tooShort) {
      throw new ApiError('VALIDATION_FAILED', 422, t('drift.accept.reasonShort'))
    }
    try {
      const plan = await withReauth(client, confirmIdentity, () =>
        client.operation('planDriftAcceptance', {
          params: { finding: findingId },
          body: trimmed.length === 0 ? {} : { reason: trimmed },
        }),
      )
      const href = planPath(plan.id)
      if (href !== undefined) navigate(href)
    } catch (error) {
      if (isReasonRequired(error)) {
        throw new ApiError('VALIDATION_FAILED', 422, t('drift.accept.reasonRequired'))
      }
      throw actionError(error)
    }
  }

  return (
    <ConfirmDialog
      onOpenChange={(open) => {
        if (!open) setReason('')
      }}
      trigger={
        <Button variant="default" size="small" data-accept-drift={findingId}>
          {t('drift.accept.button')}
        </Button>
      }
      title={t('drift.accept.title')}
      description={
        covered === undefined
          ? t('drift.accept.description')
          : t('drift.accept.descriptionCount', { count: covered })
      }
      actionLabel={t('drift.accept.action')}
      tier={tier}
      onConfirm={accept}
    >
      <div className="flex flex-col gap-3 py-2">
        <Admonition type="warning" title={t('drift.accept.permanent.title')}>
          {t('drift.accept.permanent.body')}
        </Admonition>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={reasonId} className="text-sm font-medium">
            {reasonExpected ? t('drift.accept.reason.required') : t('drift.accept.reason.optional')}
          </label>
          <Textarea
            id={reasonId}
            value={reason}
            maxLength={REASON_MAX_LENGTH}
            rows={3}
            aria-describedby={hintId}
            onChange={(event) => setReason(event.target.value)}
          />
          <p id={hintId} className="m-0 text-xs text-foreground-light">
            {t('drift.accept.reason.hint', { min: REASON_MIN_LENGTH, max: REASON_MAX_LENGTH })}
          </p>
        </div>
      </div>
    </ConfirmDialog>
  )
}
