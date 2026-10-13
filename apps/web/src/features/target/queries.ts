import type { Readable } from '@exponetdb/ui-patterns'
import { useQuery } from '@tanstack/react-query'
import { useCallback } from 'react'
import type { ResponseOf } from '../../lib/api/client.ts'
import { useApi } from '../../lib/api/context.tsx'
import { classifyFailure } from '../../lib/query/errors.ts'
import { toReadable } from '../../lib/query/readable.ts'
import { type EnvironmentList, toEnvironmentList } from './environments.ts'
import { environmentsQuery, targetHealthQuery, targetQuery } from './keys.ts'

export type Target = ResponseOf<'getTarget'>
export type TargetHealth = ResponseOf<'getTargetHealth'>

/** A read of the target domain: the truthful state, whether the server said "not found", and a way to read again. */
export interface TargetRead<T> {
  readonly readable: Readable<T>
  /**
   * The server answered that the thing does not exist or is not visible
   * (`NOT_FOUND`, `TARGET_NOT_FOUND`, HTTP 404). One answer for both, so the
   * page never says which. A failed read of any other kind is `readable`
   * with state `failed`, never this.
   */
  readonly notFound: boolean
  readonly refetch: () => void
  /** A read is running (the first one or a refresh). */
  readonly fetching: boolean
}

function notFoundOf(query: { readonly isError: boolean; readonly error: unknown }): boolean {
  return query.isError && classifyFailure(query.error).kind === 'not_found'
}

/** The target at `path` (three validated slugs). Nothing is requested for anything else. */
export function useTarget(path: string): TargetRead<Target> {
  const { client } = useApi()
  const query = useQuery(targetQuery(client, path))
  return {
    readable: toReadable(query),
    notFound: notFoundOf(query),
    refetch: () => void query.refetch(),
    fetching: query.isFetching,
  }
}

/**
 * The latest health sample of the target. The page never probes: it reads
 * what the sampler wrote (health.md section 7). `enabled: false` reads nothing,
 * for pages whose requirements do not need health.
 */
export function useTargetHealth(path: string, enabled = true): TargetRead<TargetHealth> {
  const { client } = useApi()
  const query = useQuery(targetHealthQuery(client, path, enabled))
  return {
    readable: toReadable(query),
    notFound: notFoundOf(query),
    refetch: () => void query.refetch(),
    fetching: query.isFetching,
  }
}

/**
 * The environments of a product and project (the targets that share both),
 * for the environment switcher. Partial when the list is longer than one
 * read or an item cannot be shown; a failed read is a failed state, never an
 * empty list.
 */
export function useProjectEnvironments(
  product: string,
  project: string,
): TargetRead<EnvironmentList> {
  const { client } = useApi()
  const select = useCallback(
    (page: ResponseOf<'listTargets'>) => toEnvironmentList(page, product, project),
    [product, project],
  )
  const query = useQuery({ ...environmentsQuery(client, product, project), select })
  return {
    readable: toReadable(query, {
      missing: (list) => (list.missing.length === 0 ? undefined : list.missing),
    }),
    notFound: false,
    refetch: () => void query.refetch(),
    fetching: query.isFetching,
  }
}
