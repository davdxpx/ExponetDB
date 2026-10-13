import type { AccessRole, CredentialView } from '@exponetdb/sdk/operations'
import { queryOptions } from '@tanstack/react-query'
import type { ApiClient } from '../../lib/api/client.ts'

/**
 * The submissions of ExponetDB's role passwords on one cluster
 * (`GET /clusters/{id}/credentials`): versions and states only. No password
 * or verifier is ever in a view, so the cache holds nothing secret.
 */
export const ACCESS_ROLES: readonly AccessRole[] = [
  'observer',
  'reader',
  'verifier',
  'operator',
  'migrator',
]

export function isAccessRole(value: unknown): value is AccessRole {
  return typeof value === 'string' && (ACCESS_ROLES as readonly string[]).includes(value)
}

const CLUSTER_ID = /^cls_[0-7][0-9A-HJKMNP-TV-Z]{25}$/

export function isClusterId(value: unknown): value is string {
  return typeof value === 'string' && CLUSTER_ID.test(value)
}

export const credentialKeys = {
  list: (clusterId: string) => ['clusters', 'credentials', clusterId] as const,
}

/** How often the page asks again while a submission is pending (the worker verifies it). */
export const CREDENTIAL_POLL_MS = 10_000

export function credentialListQuery(client: ApiClient, clusterId: string) {
  return queryOptions({
    queryKey: credentialKeys.list(clusterId),
    queryFn: ({ signal }) =>
      client.operation('listClusterCredentials', { params: { clusterId }, signal }),
    enabled: isClusterId(clusterId),
    refetchInterval: (query) =>
      query.state.data?.items.some((item) => item.state === 'pending') === true
        ? CREDENTIAL_POLL_MS
        : false,
  })
}

/** The latest submission for a role: the highest version among the read and the page's own. */
export function latestOf(
  items: readonly CredentialView[],
  role: AccessRole,
): CredentialView | undefined {
  let latest: CredentialView | undefined
  for (const item of items) {
    if (item.accessRole !== role) continue
    if (latest === undefined || item.version > latest.version) latest = item
  }
  return latest
}
