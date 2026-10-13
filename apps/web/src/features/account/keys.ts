import { queryOptions } from '@tanstack/react-query'
import type { ApiClient } from '../../lib/api/client.ts'

/**
 * Query keys and query options of the account page: the person's own
 * factors, sessions and connected applications. The cache holds the
 * server's answers as they came (lists of factors, sessions and grants;
 * never a secret: recovery codes and TOTP secrets are answers to writes and
 * stay in the page's state, never here).
 */
export const accountKeys = {
  all: ['account'] as const,
  factors: ['account', 'factors'] as const,
  sessions: ['account', 'sessions'] as const,
  grants: ['account', 'grants'] as const,
}

export function factorsQuery(client: ApiClient) {
  return queryOptions({
    queryKey: accountKeys.factors,
    queryFn: ({ signal }) => client.operation('listMyFactors', { signal }),
  })
}

export function sessionsQuery(client: ApiClient) {
  return queryOptions({
    queryKey: accountKeys.sessions,
    queryFn: ({ signal }) => client.operation('listMySessions', { signal }),
  })
}

/** Connected applications; not read in a recovery session (it may only replace factors). */
export function grantsQuery(client: ApiClient, enabled: boolean) {
  return queryOptions({
    queryKey: accountKeys.grants,
    queryFn: ({ signal }) => client.operation('listMyGrants', { signal }),
    enabled,
  })
}
