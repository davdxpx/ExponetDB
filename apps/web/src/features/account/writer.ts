import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useState } from 'react'
import { useApi } from '../../lib/api/context.tsx'
import { withReauth } from '../../lib/api/reauth.ts'
import { SESSION_QUERY_KEY } from '../../lib/session/guard.tsx'
import type { Feedback } from '../sign-in/feedback.tsx'
import { accountKeys } from './keys.ts'

/**
 * Every change on the account page goes through one writer: one change at a
 * time (the others wait disabled), each inside `withReauth` (the server
 * decides whether it needs a fresh proof; the dialog asks and the change is
 * sent once more), its outcome on the page's message lines, and the page's
 * reads (and the session, which says whether a recovery is still open)
 * refreshed afterwards. Changes are not TanStack mutations: a mutation keeps
 * its variables and result in the mutation cache, and some of these carry a
 * password, a code or recovery codes.
 */
export type Reauth = <T>(action: () => Promise<T>) => Promise<T>

export interface AccountWriter {
  /** The change running now, by its id. */
  readonly busy: string | undefined
  /**
   * Runs a change; `action` returns the status text to show, or undefined
   * for none. Ignored while another change runs.
   */
  readonly write: (id: string, action: (reauth: Reauth) => Promise<string | undefined>) => void
}

export function useAccountWriter(feedback: Feedback): AccountWriter {
  const { client, confirmIdentity } = useApi()
  const queryClient = useQueryClient()
  const [busy, setBusy] = useState<string | undefined>(undefined)
  const { say, fail, clear } = feedback

  const write = useCallback(
    (id: string, action: (reauth: Reauth) => Promise<string | undefined>): void => {
      if (busy !== undefined) return
      setBusy(id)
      clear()
      const reauth: Reauth = (step) => withReauth(client, confirmIdentity, step)
      action(reauth)
        .then(
          (message) => {
            if (message !== undefined) say(message)
          },
          (error: unknown) => fail(error),
        )
        .finally(() => {
          setBusy(undefined)
          void queryClient.invalidateQueries({ queryKey: accountKeys.all })
          void queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY })
        })
    },
    [busy, clear, client, confirmIdentity, fail, queryClient, say],
  )

  return { busy, write }
}
