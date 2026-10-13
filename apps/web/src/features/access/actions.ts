import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useMemo } from 'react'
import type { ApiClient } from '../../lib/api/client.ts'
import { useApi } from '../../lib/api/context.tsx'
import { withReauth } from '../../lib/api/reauth.ts'

/**
 * Runs a change of access administration: with re-authentication when the
 * server asks for a fresh proof (the dialog opens, the change runs once
 * more), then the list it belongs to is read again. Changes are plain calls,
 * never cached mutations: an answer that carries a secret (a new API key)
 * stays with the caller and never enters the query or mutation cache.
 */
export interface AccessAction {
  readonly client: ApiClient
  /** The change, with re-authentication; nothing is read again. */
  readonly change: <T>(change: () => Promise<T>) => Promise<T>
  /** Reads a list again (a failed read shows on the page, it never throws here). */
  readonly refresh: (list: readonly unknown[]) => Promise<void>
  /** `change`, then `refresh` of the list. */
  readonly run: <T>(change: () => Promise<T>, list: readonly unknown[]) => Promise<T>
}

export function useAccessAction(): AccessAction {
  const { client, confirmIdentity } = useApi()
  const queryClient = useQueryClient()
  const change = useCallback(
    <T>(run: () => Promise<T>): Promise<T> => withReauth(client, confirmIdentity, run),
    [client, confirmIdentity],
  )
  const refresh = useCallback(
    (list: readonly unknown[]) => queryClient.invalidateQueries({ queryKey: list }),
    [queryClient],
  )
  const run = useCallback(
    async <T>(run: () => Promise<T>, list: readonly unknown[]): Promise<T> => {
      const result = await change(run)
      await refresh(list)
      return result
    },
    [change, refresh],
  )
  return useMemo(() => ({ client, change, refresh, run }), [client, change, refresh, run])
}
