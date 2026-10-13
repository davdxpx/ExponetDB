import { Button, Skeleton } from '@exponetdb/ui'
import { useQuery } from '@tanstack/react-query'
import { createContext, type ReactNode, useContext } from 'react'
import type { ResponseOf } from '../api/client.ts'
import { useApi } from '../api/context.tsx'
import { isSessionGone } from '../api/errors.ts'
import { describeError, t } from '../i18n/i18n.ts'
import { isRetryable } from '../query/errors.ts'

/**
 * The signed-in person, read once per page from `GET /api/v1/me` and kept in
 * the in-memory query cache. Pages behind `RequireSession` read it with
 * `useMe()`. When the server says the session is gone the API client already
 * leaves for the sign-in page with a safe return target (ADR-0032 §4); this
 * guard only renders what is true meanwhile: a skeleton while reading, a
 * failed read with a retry when the server could not be asked (which says
 * nothing about being signed out), and nothing of the page without a person.
 */
export type Me = ResponseOf<'getMe'>

export const SESSION_QUERY_KEY = ['session', 'me'] as const

const MeContext = createContext<Me | undefined>(undefined)

export function useMe(): Me {
  const me = useContext(MeContext)
  if (me === undefined) {
    throw new Error('useMe() outside <RequireSession>')
  }
  return me
}

export function useSession() {
  const { client } = useApi()
  return useQuery({
    queryKey: SESSION_QUERY_KEY,
    queryFn: ({ signal }) => client.operation('getMe', { signal }),
    staleTime: 60_000,
    retry: (failures, error) => failures < 2 && !isSessionGone(error) && isRetryable(error),
  })
}

export function RequireSession({ children }: { readonly children: ReactNode }): ReactNode {
  const session = useSession()
  if (session.data !== undefined) {
    return <MeContext.Provider value={session.data}>{children}</MeContext.Provider>
  }
  if (session.isError) {
    if (isSessionGone(session.error)) {
      return (
        <p role="status" className="p-6 text-sm text-foreground-light">
          {t('session.leaving')}
        </p>
      )
    }
    return (
      <div role="alert" className="mx-auto flex max-w-md flex-col gap-3 p-6">
        <p className="text-sm">
          {t('session.readFailed', { reason: describeError(session.error) })}
        </p>
        <div>
          <Button type="button" variant="default" onClick={() => void session.refetch()}>
            {t('state.retry')}
          </Button>
        </div>
      </div>
    )
  }
  return (
    <section aria-busy="true" aria-label={t('session.reading')} className="flex flex-col gap-3 p-6">
      <Skeleton className="h-6 w-48" />
      <Skeleton className="h-4 w-full max-w-xl" />
      <Skeleton className="h-4 w-full max-w-lg" />
    </section>
  )
}
