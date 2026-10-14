import { queryOptions } from '@tanstack/react-query'
import type { ApiClient, ResponseOf } from '../../lib/api/client.ts'

/**
 * Query keys and options of the settings pages: the registry structure
 * (products and their environments), the policy rules, the installation and
 * its health, and the break-glass grants. Every read keeps what the server
 * sent; a change is always a plan created elsewhere (`usePlanAction`), or the
 * one inline record the API defines (the post-incident review of a grant).
 */
export const SETTINGS_PAGE_LIMIT = 200

export type Product = ResponseOf<'listProducts'>['items'][number]
export type Environment = ResponseOf<'listProductEnvironments'>['items'][number]
export type PolicyRule = ResponseOf<'getPolicySettings'>['rules'][number]
export type TargetItem = ResponseOf<'listTargets'>['items'][number]
export type Installation = ResponseOf<'getInstallation'>
export type InstallationHealth = ResponseOf<'getInstallationHealth'>
export type BreakGlassList = ResponseOf<'listBreakGlassGrants'>
export type BreakGlassGrant = BreakGlassList['items'][number]

export type ReviewFilter = 'all' | 'open' | 'done'

export const settingsKeys = {
  products: ['settings', 'products'] as const,
  environments: (productId: string) => ['settings', 'environments', productId] as const,
  policies: ['settings', 'policies'] as const,
  targets: ['settings', 'targets'] as const,
  installation: ['settings', 'installation'] as const,
  health: ['settings', 'installation', 'health'] as const,
  breakGlass: (review: ReviewFilter) => ['settings', 'break-glass', review] as const,
  breakGlassAll: ['settings', 'break-glass'] as const,
}

export function productsQuery(client: ApiClient) {
  return queryOptions({
    queryKey: settingsKeys.products,
    queryFn: ({ signal }) =>
      client.operation('listProducts', { query: { limit: SETTINGS_PAGE_LIMIT }, signal }),
  })
}

export function environmentsQuery(client: ApiClient, productId: string) {
  return queryOptions({
    queryKey: settingsKeys.environments(productId),
    queryFn: ({ signal }) =>
      client.operation('listProductEnvironments', {
        params: { productId },
        query: { limit: SETTINGS_PAGE_LIMIT },
        signal,
      }),
  })
}

export function policiesQuery(client: ApiClient) {
  return queryOptions({
    queryKey: settingsKeys.policies,
    queryFn: ({ signal }) => client.operation('getPolicySettings', { signal }),
  })
}

export function targetsQuery(client: ApiClient) {
  return queryOptions({
    queryKey: settingsKeys.targets,
    queryFn: ({ signal }) =>
      client.operation('listTargets', { query: { limit: SETTINGS_PAGE_LIMIT }, signal }),
  })
}

export function installationQuery(client: ApiClient) {
  return queryOptions({
    queryKey: settingsKeys.installation,
    queryFn: ({ signal }) => client.operation('getInstallation', { signal }),
  })
}

/** Health is read every 30 seconds while the page is open (a stale health is shown as such). */
export function healthQuery(client: ApiClient) {
  return queryOptions({
    queryKey: settingsKeys.health,
    queryFn: ({ signal }) => client.operation('getInstallationHealth', { signal }),
    refetchInterval: 30_000,
  })
}

export function breakGlassQuery(client: ApiClient, review: ReviewFilter) {
  return queryOptions({
    queryKey: settingsKeys.breakGlass(review),
    queryFn: ({ signal }) =>
      client.operation('listBreakGlassGrants', {
        query:
          review === 'all'
            ? { limit: SETTINGS_PAGE_LIMIT }
            : { review, limit: SETTINGS_PAGE_LIMIT },
        signal,
      }),
  })
}
