import { queryOptions } from '@tanstack/react-query'
import type { ApiClient, ResponseOf } from '../../lib/api/client.ts'
import { ACCESS_PAGE_LIMIT } from './keys.ts'

/**
 * The reads that name what an ID stands for: products, projects, the
 * environments of a product, targets and people. The administration forms use them
 * to offer a choice by name (a role binding's scope, an audit filter, the
 * targets an API key is limited to); the value that is sent stays the typed
 * ID, and the server checks that it exists and that the person may use it.
 *
 * Each read asks for one page of the API's maximum. When more exist the
 * answer's cursor says so and the form says that only the first part is
 * listed (the ID can still be typed). Registry data changes rarely and
 * nothing here polls: the lists are read when a form needs them and again
 * after a minute.
 */
export type ProductChoice = ResponseOf<'listProducts'>['items'][number]
export type ProjectChoice = ResponseOf<'listProjects'>['items'][number]
export type EnvironmentChoice = ResponseOf<'listProductEnvironments'>['items'][number]
export type TargetChoice = ResponseOf<'listTargets'>['items'][number]
export type IdentityChoice = ResponseOf<'listIdentities'>['items'][number]

export const choiceKeys = {
  products: ['access', 'choices', 'products'] as const,
  projects: ['access', 'choices', 'projects'] as const,
  environments: (productId: string) => ['access', 'choices', 'environments', productId] as const,
  targets: ['access', 'choices', 'targets'] as const,
  identities: ['access', 'choices', 'identities'] as const,
}

/** A list the choice forms read stays fresh for a minute; the label of a stale read says so after five. */
export const CHOICE_STALE_MS = 60_000
export const CHOICE_OLD_AFTER_MS = 5 * 60_000

export function productChoicesQuery(client: ApiClient) {
  return queryOptions({
    queryKey: choiceKeys.products,
    staleTime: CHOICE_STALE_MS,
    queryFn: ({ signal }) =>
      client.operation('listProducts', { query: { limit: ACCESS_PAGE_LIMIT }, signal }),
  })
}

export function projectChoicesQuery(client: ApiClient) {
  return queryOptions({
    queryKey: choiceKeys.projects,
    staleTime: CHOICE_STALE_MS,
    queryFn: ({ signal }) =>
      client.operation('listProjects', { query: { limit: ACCESS_PAGE_LIMIT }, signal }),
  })
}

export function environmentChoicesQuery(client: ApiClient, productId: string) {
  return queryOptions({
    queryKey: choiceKeys.environments(productId),
    staleTime: CHOICE_STALE_MS,
    queryFn: ({ signal }) =>
      client.operation('listProductEnvironments', {
        params: { productId },
        query: { limit: ACCESS_PAGE_LIMIT },
        signal,
      }),
  })
}

export function targetChoicesQuery(client: ApiClient) {
  return queryOptions({
    queryKey: choiceKeys.targets,
    staleTime: CHOICE_STALE_MS,
    queryFn: ({ signal }) =>
      client.operation('listTargets', { query: { limit: ACCESS_PAGE_LIMIT }, signal }),
  })
}

/** The people and service accounts of the installation, for choosing one by name (needs `access.read`). */
export function identityChoicesQuery(client: ApiClient, enabled = true) {
  return queryOptions({
    queryKey: choiceKeys.identities,
    staleTime: CHOICE_STALE_MS,
    enabled,
    queryFn: ({ signal }) =>
      client.operation('listIdentities', { query: { limit: ACCESS_PAGE_LIMIT }, signal }),
  })
}
