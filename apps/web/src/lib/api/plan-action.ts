import { useNavigate } from '@exponetdb/ui-patterns'
import { useCallback } from 'react'
import { planPath } from '../../features/plans/plan-model.ts'
import { useApi } from './context.tsx'
import { withReauth } from './reauth.ts'

/**
 * Creates a plan and opens its review page (C-9: a consequential change is a
 * plan, never a "run this now"). The request runs with re-authentication when
 * the server asks for a fresh proof; the answer's id must be a plan id, or
 * the page stays where it is (the caller still receives the plan). Nothing is
 * applied here: the review page shows what would run and who must approve.
 */
export type CreatePlan = <P extends { readonly id: string }>(create: () => Promise<P>) => Promise<P>

export function usePlanAction(): CreatePlan {
  const { client, confirmIdentity } = useApi()
  const navigate = useNavigate()
  return useCallback(
    async <P extends { readonly id: string }>(create: () => Promise<P>): Promise<P> => {
      const plan = await withReauth(client, confirmIdentity, create)
      const path = planPath(plan.id)
      if (path !== undefined) navigate(path)
      return plan
    },
    [client, confirmIdentity, navigate],
  )
}
