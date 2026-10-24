import { ApiError, CLIENT_CODES } from '../../lib/api/errors.ts'
import { usePlanAction } from '../../lib/api/plan-action.ts'
import { t } from '../../lib/i18n/i18n.ts'
import { actionError } from '../plans/failure.ts'
import { planPath } from '../plans/plan-model.ts'

/**
 * Creates a plan for a registry change and opens its review page (C-9: there
 * is no "do it now" path). It is `usePlanAction` (re-authentication when the
 * server asks, then the review page) with two additions the forms and dialogs
 * of the registry pages need:
 *
 * - an answer without a plan id the page can open is a failure the person
 *   sees (the server's answer cannot be read), not a silent stay;
 * - every failure is turned into catalog text with a stable code
 *   (`actionError`), because a confirmation dialog prints the message and the
 *   code and must never print exception text.
 *
 * Nothing is applied here: the review page shows what would run and who must
 * approve it.
 */
export type GuardedPlan = <P extends { readonly id: string }>(
  create: () => Promise<P>,
) => Promise<P>

export function useGuardedPlan(): GuardedPlan {
  const createPlan = usePlanAction()
  return async <P extends { readonly id: string }>(create: () => Promise<P>): Promise<P> => {
    try {
      const plan = await createPlan(create)
      if (planPath(plan.id) === undefined) {
        throw new ApiError(CLIENT_CODES.RESPONSE_INVALID, 0, t('error.responseInvalid'))
      }
      return plan
    } catch (error) {
      throw actionError(error)
    }
  }
}
