import { queryOptions } from '@tanstack/react-query'
import type { ApiClient } from '../../lib/api/client.ts'
import { classifyFailure } from '../../lib/query/errors.ts'
import { isOperationId, isPlanId, operationActive } from './plan-model.ts'

/**
 * Query keys and options of plans, the approvals queue and operations. Keys
 * are built from validated ids only, and every query is disabled for
 * anything else, so an id that failed its grammar never reaches the server.
 * The cache holds the server's answers as they came; nothing in them is a
 * secret (plan views, the queue, operation views).
 */
export const planKeys = {
  all: ['plans'] as const,
  detail: (planId: string) => ['plans', 'detail', planId] as const,
  list: () => ['plans', 'list'] as const,
}

export const approvalKeys = {
  queue: () => ['approvals', 'queue'] as const,
}

export const operationKeys = {
  all: ['operations'] as const,
  detail: (operationId: string) => ['operations', 'detail', operationId] as const,
}

/** How often an open plan page asks again (plan, queue): a decision elsewhere shows up soon. */
export const PLAN_POLL_MS = 30_000
/** How often it asks for an operation that is still at work (queued, running, verifying). */
export const OPERATION_ACTIVE_POLL_MS = 5_000
/** The plans one list read asks for. */
export const PLAN_LIST_LIMIT = 50

const stopWhenNotFound = (error: unknown, interval: number): number | false =>
  classifyFailure(error).kind === 'not_found' ? false : interval

export function planQuery(client: ApiClient, planId: string) {
  return queryOptions({
    queryKey: planKeys.detail(planId),
    queryFn: ({ signal }) => client.operation('getPlan', { params: { planId }, signal }),
    enabled: isPlanId(planId),
    refetchInterval: (query) => stopWhenNotFound(query.state.error, PLAN_POLL_MS),
  })
}

export function approvalQueueQuery(client: ApiClient) {
  return queryOptions({
    queryKey: approvalKeys.queue(),
    queryFn: ({ signal }) => client.operation('listApprovals', { signal }),
    refetchInterval: PLAN_POLL_MS,
  })
}

export function operationQuery(client: ApiClient, operationId: string) {
  return queryOptions({
    queryKey: operationKeys.detail(operationId),
    queryFn: ({ signal }) => client.operation('getOperation', { params: { operationId }, signal }),
    enabled: isOperationId(operationId),
    // Often while the operation is at work, so applied and verified show up soon.
    refetchInterval: (query) =>
      stopWhenNotFound(
        query.state.error,
        operationActive(query.state.data) ? OPERATION_ACTIVE_POLL_MS : PLAN_POLL_MS,
      ),
  })
}

export function planListQuery(client: ApiClient) {
  return queryOptions({
    queryKey: planKeys.list(),
    queryFn: ({ signal }) =>
      client.operation('listPlans', { query: { limit: PLAN_LIST_LIMIT }, signal }),
    refetchInterval: PLAN_POLL_MS,
  })
}
