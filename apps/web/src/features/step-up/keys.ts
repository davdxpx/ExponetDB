import type { StepUp } from '@exponetdb/sdk/operations'
import { queryOptions } from '@tanstack/react-query'
import type { ApiClient } from '../../lib/api/client.ts'

/**
 * The step-up a CLI asked for (ADR-0026), read by its id from the link's
 * fragment. The view kept in the query cache never holds the user code: the
 * person types the code their terminal shows (a code is a secret of the
 * ceremony, C-20), so the field is dropped before the answer is cached.
 */
export type StepUpView = Omit<StepUp, 'userCode'>

const STEP_UP_ID = /^stu_[0-7][0-9A-HJKMNP-TV-Z]{25}$/

export function isStepUpId(value: unknown): value is string {
  return typeof value === 'string' && STEP_UP_ID.test(value)
}

export const stepUpKeys = {
  detail: (stepUpId: string) => ['step-ups', 'detail', stepUpId] as const,
}

/** The view without the user code. */
export function withoutCode(view: StepUp): StepUpView {
  return {
    action: view.action,
    bindingDigest: view.bindingDigest,
    clientName: view.clientName,
    expiresAt: view.expiresAt,
    id: view.id,
    planHash: view.planHash,
    receiptExpiresAt: view.receiptExpiresAt,
    state: view.state,
    verificationUri: view.verificationUri,
  }
}

export function stepUpQuery(client: ApiClient, stepUpId: string) {
  return queryOptions({
    queryKey: stepUpKeys.detail(stepUpId),
    queryFn: async ({ signal }) =>
      withoutCode(await client.operation('getStepUp', { params: { stepUpId }, signal })),
    enabled: isStepUpId(stepUpId),
    // The confirmation decides on what the page showed when it opened: no refetch replaces it.
    refetchOnWindowFocus: false,
    staleTime: Number.POSITIVE_INFINITY,
  })
}
