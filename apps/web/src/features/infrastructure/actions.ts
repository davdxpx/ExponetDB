import type { PlanView } from '@exponetdb/sdk/operations'
import { useNavigate } from '@exponetdb/ui-patterns'
import type { ApiClient } from '../../lib/api/client.ts'
import { useApi } from '../../lib/api/context.tsx'
import { withReauth } from '../../lib/api/reauth.ts'
import { actionError } from '../plans/failure.ts'
import { planPath } from '../plans/plan-model.ts'

/**
 * Every change of the infrastructure pages is a plan (C-9, operations-engine
 * §2): the page asks the server for the plan through `withReauth` (a fresh
 * passkey or authenticator proof when the server asks for one) and opens its
 * review page (`/changes/plans/<id>`), where it is applied. Nothing here
 * applies anything. A failure is turned into catalog text for the dialog or
 * form that shows it (`actionError`); the person's input is never part of it.
 */
export function usePlanRequest(): (
  create: (client: ApiClient) => Promise<PlanView>,
) => Promise<PlanView> {
  const { client, confirmIdentity } = useApi()
  const navigate = useNavigate()
  return async (create) => {
    let plan: PlanView
    try {
      plan = await withReauth(client, confirmIdentity, () => create(client))
    } catch (error) {
      throw actionError(error)
    }
    const path = planPath(plan.id)
    if (path !== undefined) navigate(path)
    return plan
  }
}
