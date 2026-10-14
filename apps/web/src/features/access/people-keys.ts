import { queryOptions } from '@tanstack/react-query'
import type { ApiClient } from '../../lib/api/client.ts'
import { classifyFailure } from '../../lib/query/errors.ts'
import { ACCESS_PAGE_LIMIT, ACCESS_POLL_MS } from './keys.ts'

/**
 * Query keys and options of People, Roles and Connected applications. The
 * cache holds the lists as the server sent them; an invitation link is never
 * in it (it exists only in the answer that issued it, which is not cached).
 */
export const peopleKeys = {
  identities: ['access', 'identities'] as const,
  bindings: ['access', 'role-bindings'] as const,
  roles: ['access', 'roles'] as const,
  grants: (state: string) => ['access', 'grants', state] as const,
  grantsAll: ['access', 'grants'] as const,
}

function pollUnless(error: unknown): number | false {
  const kind = classifyFailure(error).kind
  return kind === 'not_permitted' || kind === 'session' ? false : ACCESS_POLL_MS
}

export function identitiesQuery(client: ApiClient) {
  return queryOptions({
    queryKey: peopleKeys.identities,
    queryFn: ({ signal }) =>
      client.operation('listIdentities', { query: { limit: ACCESS_PAGE_LIMIT }, signal }),
    refetchInterval: (query) => pollUnless(query.state.error),
  })
}

export function bindingsQuery(client: ApiClient) {
  return queryOptions({
    queryKey: peopleKeys.bindings,
    queryFn: ({ signal }) =>
      client.operation('listRoleBindings', {
        query: { state: 'active', limit: ACCESS_PAGE_LIMIT },
        signal,
      }),
    refetchInterval: (query) => pollUnless(query.state.error),
  })
}

export function rolesQuery(client: ApiClient) {
  return queryOptions({
    queryKey: peopleKeys.roles,
    queryFn: ({ signal }) => client.operation('listRoles', { signal }),
    staleTime: 5 * 60_000,
  })
}

export type GrantFilter = 'active' | 'revoked' | 'expired' | 'all'

export function grantsQuery(client: ApiClient, state: GrantFilter) {
  return queryOptions({
    queryKey: peopleKeys.grants(state),
    queryFn: ({ signal }) =>
      client.operation('listGrants', {
        query: state === 'all' ? { limit: ACCESS_PAGE_LIMIT } : { state, limit: ACCESS_PAGE_LIMIT },
        signal,
      }),
    refetchInterval: (query) => pollUnless(query.state.error),
  })
}
