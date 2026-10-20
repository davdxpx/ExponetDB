import { queryOptions } from '@tanstack/react-query'
import type { ApiClient } from '../../lib/api/client.ts'
import { classifyFailure } from '../../lib/query/errors.ts'

/**
 * Query keys and query options of access administration. The cache holds
 * the server's lists as they came: client metadata and service accounts
 * with their grants and API keys, which never carry a secret (an API key's
 * secret exists only in the answer that created it, and that answer is never
 * cached).
 */
export const accessKeys = {
  all: ['access'] as const,
  oauthClients: ['access', 'oauth-clients'] as const,
  serviceAccounts: ['access', 'service-accounts'] as const,
  /** Under the service accounts' key: a change of an account or a key reads the overview again too. */
  apiKeys: ['access', 'service-accounts', 'api-keys'] as const,
}

/** The most items one list read asks for (the API's page maximum). */
export const ACCESS_PAGE_LIMIT = 200

/**
 * How often an open, visible administration page reads its list again, so a
 * client waiting for review or a key used elsewhere shows up, and a list
 * that stays open never turns stale (`toReadable` counts 60 seconds).
 */
export const ACCESS_POLL_MS = 30_000

function pollUnless(error: unknown): number | false {
  const kind = classifyFailure(error).kind
  return kind === 'not_permitted' || kind === 'session' ? false : ACCESS_POLL_MS
}

export type ClientStateFilter = 'all' | 'pending' | 'active' | 'rejected' | 'disabled'

/**
 * The OAuth client list, all states or one (`state` is the API's own filter).
 * The key of a state sits under the list's key, so a decision on a client
 * reads every state again.
 */
export function oauthClientsQuery(client: ApiClient, state: ClientStateFilter = 'all') {
  return queryOptions({
    queryKey: state === 'all' ? accessKeys.oauthClients : [...accessKeys.oauthClients, state],
    queryFn: ({ signal }) =>
      client.operation('listOAuthClients', {
        query: state === 'all' ? { limit: ACCESS_PAGE_LIMIT } : { state, limit: ACCESS_PAGE_LIMIT },
        signal,
      }),
    refetchInterval: (query) => pollUnless(query.state.error),
  })
}

export function serviceAccountsQuery(client: ApiClient) {
  return queryOptions({
    queryKey: accessKeys.serviceAccounts,
    queryFn: ({ signal }) =>
      client.operation('listServiceAccounts', { query: { limit: ACCESS_PAGE_LIMIT }, signal }),
    refetchInterval: (query) => pollUnless(query.state.error),
  })
}

/** Every API key of every service account (metadata only; a secret is shown once, at creation). */
export function apiKeysQuery(client: ApiClient) {
  return queryOptions({
    queryKey: accessKeys.apiKeys,
    queryFn: ({ signal }) =>
      client.operation('listApiKeys', { query: { limit: ACCESS_PAGE_LIMIT }, signal }),
    refetchInterval: (query) => pollUnless(query.state.error),
  })
}
